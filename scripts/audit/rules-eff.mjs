/**
 * 效率维度规则 EFF-001 … EFF-006。
 *
 * 同其他维度「拿不准就不报」：实参是变量、对象里有展开、看不出循环变量……一律放过。
 */
import { basename } from 'node:path';
import {
    bindingNames, callee, eachCall, enclosingFunction, exclusive, filesIn, insideLoop, isReference, lineOf, loopVariables, propName,
    shadowedByParam, unwrapParens, walk
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

/**
 * ident 是否处在类型位置（`: X`、`as X`、`Promise<X>`、`typeof x`、`implements X`……）：这些编译后全部抹掉。
 * 类的 `extends Base` 在语法上也是 ExpressionWithTypeArguments，但它是值，单独放回来。
 */
function inTypePosition(ts, ident) {
    for (let p = ident.parent; p; p = p.parent) {
        if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent)
            && p.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(p.parent.parent)) return false;
        if (ts.isTypeNode(p)) return true;
        if (ts.isStatement(p)) return false;
    }
    return false;
}

/**
 * 文件里在「值」的位置读到的名字（不含 import 语句本身、属性名、类型位置）。同名局部变量的遮蔽不区分 ——
 * 局部变量和 import 同名时会把只在类型位置用的 import 当成值用到了，让 EFF-003 多报（不会少报）；少见，先不处理。
 */
function valueNames(ts, sf) {
    const names = new Set();
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st)) continue;
        walk(ts, st, n => { if (ts.isIdentifier(n) && isReference(ts, n) && !inTypePosition(ts, n)) names.add(n.text); });
    }
    return names;
}

/**
 * 这条 import 会不会把整包打进来。编译时被整条删掉的不算：`import type …`、花括号里全是 `type X`、
 * 以及没写 type 但每个命名绑定都只在类型位置用（`import { EChartsOption } from 'echarts'`）。
 * 默认导入 / 命名空间导入 / 副作用导入（`import 'd3'`）照旧算整包。
 */
function bundlesWhole(ts, decl, used) {
    const clause = decl.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const nb = clause.namedBindings;
    if (!nb || ts.isNamespaceImport(nb)) return true;
    return nb.elements.some(e => !e.isTypeOnly && used().has(e.name.text));
}

/**
 * 只看有 JSX 的前端文件：专门包一层 `lazy.ts` 再 `import()` 它，是推荐的按需加载写法，不能报。
 * 子路径（`echarts/core`、`d3-scale`）本来就是按需引入，不报。
 */
function eff003(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        let names = null;
        const used = () => (names ??= valueNames(ts, file.sf));
        const heavy = file.sf.statements.filter(s => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
            && HEAVY.has(s.moduleSpecifier.text) && bundlesWhole(ts, s, used));
        if (heavy.length === 0 || !hasJsx(ts, file.sf)) continue;
        for (const s of heavy) out.push({ rule: 'EFF-003', file: file.rel, line: lineOf(file.sf, s) });
    }
    return out;
}

// ─── EFF-004 构建产物里单个 JS 包过大 ───
const CHUNK_LIMIT = 800 * 1024;

/**
 * 去掉 Vite 产物名里的内容 hash（`-` 加 8 位 base64url）：`index-Clypym9M.js` → `index.js`。
 * hash 每次构建都变，留着它会让发布门禁按 rule + file 比对的 id 每次都不一样。
 */
const chunkName = file => file.replace(/-[A-Za-z0-9_-]{8}\.js$/, '.js');

/** 没 build 过（distChunks 为空）就什么都不报 —— 不替用户跑构建。 */
function eff004(ctx) {
    return ctx.distChunks
        .filter(c => c.bytes > CHUNK_LIMIT)
        .map(c => ({ rule: 'EFF-004', file: chunkName(c.file), line: 0, args: { kb: String(Math.round(c.bytes / 1024)) } }));
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

/** await 的结果绑给了哪些变量：`const r = await q()`、`const { rows } = (await q()).x`、`r = await q()`。 */
function awaitResultVars(ts, aw) {
    let n = aw;
    while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent)
        || (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n))) n = n.parent;
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p) && p.initializer === n) return bindingNames(ts, p.name);
    if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n && ts.isIdentifier(p.left)) {
        return [p.left.text];
    }
    return [];
}

/** node 里读到的变量名（属性名、键、被内层回调形参遮蔽的不算）。 */
function readNames(ts, node) {
    const names = new Set();
    walk(ts, node, n => { if (ts.isIdentifier(n) && isReference(ts, n) && !shadowedByParam(ts, n, node, n.text)) names.add(n.text); });
    return names;
}

/**
 * 由 seeds 算出来的变量（只追 fn 这一层的 `const x = <读了 seeds 的表达式>`，算到不再变）：
 * `const { rows } = await q1(); const ids = rows.map(…); await q2({ ids })` 里 q2 依赖 q1。
 */
function derivedFrom(ts, fn, seeds) {
    const vars = new Set(seeds);
    const decls = [];
    walk(ts, fn, n => {
        if (ts.isVariableDeclaration(n) && n.initializer && enclosingFunction(ts, n) === fn) decls.push(n);
    });
    for (let changed = true; changed;) {
        changed = false;
        for (const d of decls) {
            if (![...readNames(ts, d.initializer)].some(r => vars.has(r))) continue;
            for (const name of bindingNames(ts, d.name)) if (!vars.has(name)) { vars.add(name); changed = true; }
        }
    }
    return vars;
}

/**
 * 互不依赖、且会在同一次执行里先后发生的 await：
 * - 实参读了前面某次 await 的结果（含转手变量）→ 必须串行，不计；
 * - 和已选的分在 if/else 两支、switch 不同 case 等互斥位置（scan 的 exclusive）→ 不合并。
 * 返回第一组 ≥ 3 个的，没有 → null。
 */
function serialGroup(ts, fn, awaits) {
    const independent = awaits.filter((aw, j) => {
        if (j === 0) return true;
        const deps = derivedFrom(ts, fn, awaits.slice(0, j).flatMap(a => awaitResultVars(ts, a)));
        if (deps.size === 0) return true;
        const call = unwrapParens(ts, aw.expression);
        return !call.arguments.some(a => [...readNames(ts, a)].some(r => deps.has(r)));
    });
    for (let i = 0; i < independent.length; i++) {
        const group = [independent[i]];
        for (const b of independent.slice(i + 1)) if (group.every(a => !exclusive(ts, a, b, fn))) group.push(b);
        if (group.length >= 3) return group;
    }
    return null;
}

/**
 * 已知盲区：只数函数体里的 await，模块顶层的 `await q()`（main.tsx 里偶见）不看。
 */
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
        for (const [fn, awaits] of byFn) {
            const group = awaits.length >= 3 && serialGroup(ts, fn, awaits);
            if (group) out.push({ rule: 'EFF-005', file: file.rel, line: lineOf(file.sf, group[0]) });
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
 * 前提是链尾没有执行：`ps.push(db.prepare(…).bind(id).run())` 每轮已经发了一条 SQL，照样是 N+1。
 */
function collectedForBatch(ts, call) {
    const top = chainTop(ts, call);
    const p = top.parent;
    if (!p || /\.(first|all|run|raw)$/.test(callee(ts, top) ?? '')) return false;
    if (ts.isArrayLiteralExpression(p)) return true;
    if (ts.isCallExpression(p) && p.arguments.includes(top) && /(^|\.)push$/.test(callee(ts, p))) return true;
    return ts.isArrowFunction(p) && p.body === top;
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
