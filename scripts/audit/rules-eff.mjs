/**
 * 效率维度规则 EFF-001 … EFF-006。
 *
 * 同其他维度「拿不准就不报」：实参是变量、对象里有展开、看不出循环变量……一律放过。
 */
import { basename } from 'node:path';
import {
    callee, eachCall, enclosingFunction, filesIn, insideLoop, isReference, lineOf, loopVariables, propName,
    shadowedByParam, walk
} from './scan.mjs';

/**
 * `window.PtApp.data.query` / `PtApp.data.query` / `ctx.pt.query`：要求 data / pt 是完整的一节，
 * 不按字符串后缀匹配 —— 否则 `metadata.query`、`rpt.query` 也会被当成取数。
 */
const DATA_QUERY = /(^|\.)(data|pt)\.query$/;
export const isDataQuery = name => DATA_QUERY.test(name);

function eachDataQuery(ctx, visit, area) {
    for (const file of filesIn(ctx, area)) eachCall(ctx, file, (call, name) => { if (isDataQuery(name)) visit(call, file); });
}

const unwrapParens = (ts, n) => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };

// ─── EFF-001 循环里按循环变量逐个查询 ───
/**
 * 只在实参真的读了循环变量时报：循环里重试同一个查询、或查询只用到外层常量，不是「拆成 N 次」。
 * `.c` 属性名、`{ c: 1 }` 的键、内层回调的同名形参（`other.map(c => c.id)`）都不算读循环变量。
 */
function eff001(ctx) {
    const { ts } = ctx;
    const out = [];
    eachDataQuery(ctx, (call, file) => {
        if (!insideLoop(ts, call)) return;
        const vars = new Set(loopVariables(ts, call));
        if (vars.size === 0) return;
        let uses = false;
        for (const arg of call.arguments) {
            walk(ts, arg, n => {
                if (!uses && ts.isIdentifier(n) && vars.has(n.text) && isReference(ts, n) && !shadowedByParam(ts, n, call, n.text)) uses = true;
            });
        }
        if (uses) out.push({ rule: 'EFF-001', file: file.rel, line: lineOf(file.sf, call) });
    });
    return out;
}

// ─── EFF-002 params 里没有 timeRange ───
/**
 * 只认 `data.query({ params: { … } })` 两层都是字面量、且 params 里没有展开的写法：
 * params 是变量或带 `...base` 时 timeRange 可能在别处给了。
 * 后端 `ctx.pt.query(queryType, params)` 第一个实参是字符串，自然不进这条（见报告里的说明）。
 */
function eff002(ctx) {
    const { ts } = ctx;
    const out = [];
    eachDataQuery(ctx, (call, file) => {
        const arg = call.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) return;
        const params = arg.properties.find(p => ts.isPropertyAssignment(p) && propName(ts, p.name) === 'params');
        const obj = params && unwrapParens(ts, params.initializer);
        if (!obj || !ts.isObjectLiteralExpression(obj) || obj.properties.some(p => ts.isSpreadAssignment(p))) return;
        if (obj.properties.some(p => p.name && propName(ts, p.name) === 'timeRange')) return;
        out.push({ rule: 'EFF-002', file: file.rel, line: lineOf(file.sf, call) });
    });
    return out;
}

// ─── EFF-003 页面组件里整包静态引入大库 ───
const HEAVY = new Set(['echarts', 'd3', 'framer-motion']);

function hasJsx(ts, sf) {
    let found = false;
    walk(ts, sf, n => { if (!found && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))) found = true; });
    return found;
}

/** 编译后会被整个删掉的 import：`import type …`，或花括号里全是 `type X`（且没有默认导入）。 */
function typeOnly(ts, decl) {
    const clause = decl.importClause;
    if (!clause) return false; // `import 'd3'`：副作用导入，照样整包打进来
    if (clause.isTypeOnly) return true;
    const nb = clause.namedBindings;
    return !clause.name && !!nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every(e => e.isTypeOnly);
}

/**
 * 只看有 JSX 的前端文件：专门包一层 `lazy.ts` 再 `import()` 它，是推荐的按需加载写法，不能报。
 * 子路径（`echarts/core`、`d3-scale`）本来就是按需引入，不报。
 */
function eff003(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        const heavy = file.sf.statements.filter(s => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
            && HEAVY.has(s.moduleSpecifier.text) && !typeOnly(ts, s));
        if (heavy.length === 0 || !hasJsx(ts, file.sf)) continue;
        for (const s of heavy) out.push({ rule: 'EFF-003', file: file.rel, line: lineOf(file.sf, s) });
    }
    return out;
}

// ─── EFF-004 构建产物里单个 JS 包过大 ───
const CHUNK_LIMIT = 800 * 1024;

/** 没 build 过（distChunks 为空）就什么都不报 —— 不替用户跑构建。 */
function eff004(ctx) {
    return ctx.distChunks
        .filter(c => c.bytes > CHUNK_LIMIT)
        .map(c => ({ rule: 'EFF-004', file: c.file, line: 0, args: { kb: String(Math.round(c.bytes / 1024)) } }));
}

// ─── EFF-005 首屏串行 await 多次查询 ───
/**
 * 首屏入口：按完整文件名比，`MyApp.tsx` 不算 `App.tsx`；`pages/Report.tsx` 这类子页面不在首屏，不看。
 */
function isFirstScreen(rel) {
    const name = basename(rel);
    return name === 'App.tsx' || name === 'main.tsx' || rel.endsWith('/pages/index.tsx') || rel.endsWith('/routes/index.tsx');
}

/** await 是不是写在 `Promise.all(…)` / `Promise.allSettled(…)` 的实参里（到 fn 为止）：那已经是并发的。 */
function inPromiseAll(ts, node, fn) {
    for (let p = node.parent, child = node; p && p !== fn; child = p, p = p.parent) {
        if (ts.isCallExpression(p) && p.arguments.includes(child) && /^Promise\.(all|allSettled)$/.test(callee(ts, p))) return true;
    }
    return false;
}

function eff005(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        if (!isFirstScreen(file.rel)) continue;
        const byFn = new Map(); // fn -> await[]（按源码顺序）
        walk(ts, file.sf, n => {
            if (!ts.isAwaitExpression(n)) return;
            const op = unwrapParens(ts, n.expression);
            if (!ts.isCallExpression(op) || !isDataQuery(callee(ts, op))) return;
            // 只按「同一层函数」计数：嵌套的 async 回调各自是一次独立执行，不和外层串在一起
            const fn = enclosingFunction(ts, n);
            if (!fn || inPromiseAll(ts, n, fn)) return;
            byFn.set(fn, [...(byFn.get(fn) ?? []), n]);
        });
        for (const awaits of byFn.values()) {
            if (awaits.length >= 3) out.push({ rule: 'EFF-005', file: file.rel, line: lineOf(file.sf, awaits[0]) });
        }
    }
    return out;
}

// ─── EFF-006 循环里逐条查 D1 ───
/** `db.prepare(…).bind(x).first()` 这条链的最外层表达式：用来看这条语句最后交给了谁。 */
function chainTop(ts, call) {
    let n = call;
    while (n.parent && ((ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
        || (ts.isCallExpression(n.parent) && n.parent.expression === n))) n = n.parent;
    return n;
}

/**
 * 循环里只是攒语句、最后交给 db.batch 的（`stmts.push(db.prepare(…).bind(id))`、
 * `ids.map(id => db.prepare(…).bind(id))`、`flatMap(id => [db.prepare…])`），正是这条规则建议的改法，不报。
 */
function collectedForBatch(ts, call) {
    const top = chainTop(ts, call);
    const p = top.parent;
    if (!p) return false;
    if (ts.isArrayLiteralExpression(p)) return true;
    if (ts.isCallExpression(p) && p.arguments.includes(top) && /(^|\.)push$/.test(callee(ts, p))) return true;
    // 箭头函数直接返回语句本身（没 await、没执行）：多半是 map 出一组语句给 batch
    return ts.isArrowFunction(p) && p.body === top && !/\.(first|all|run|raw)$/.test(callee(ts, top) ?? '');
}

function eff006(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'backend')) {
        eachCall(ctx, file, (call, name) => {
            if (!name.endsWith('.prepare') || !insideLoop(ts, call) || collectedForBatch(ts, call)) return;
            out.push({ rule: 'EFF-006', file: file.rel, line: lineOf(file.sf, call) });
        });
    }
    return out;
}

/** @type {import('./run.mjs').Rule[]} */
export const rules = [
    { id: 'EFF-001', check: eff001 },
    { id: 'EFF-002', check: eff002 },
    { id: 'EFF-003', check: eff003 },
    { id: 'EFF-004', check: eff004 },
    { id: 'EFF-005', check: eff005 },
    { id: 'EFF-006', check: eff006 }
];
