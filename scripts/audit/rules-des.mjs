/**
 * 合理性（设计）维度规则 DES-001 … DES-003。
 *
 * 这几条看的是「整体搭得对不对」，误报的代价比漏报大（会让人去删一个其实在用的权限 / 后端），
 * 所以一律「拿不准就不报」：认不出调用方式（解构、转手、换了参数名）就当作用到了。
 */
import { bindingNames, callee, eachCall, filesIn, lineOf, nameChain, stringLiteralsIn, unwrapParens, walk } from './scan.mjs';

// ─── DES-001 scopes 与代码不一致 ───
/**
 * scope → 用到它的写法。analytics:read / profile:read / user:read / ui:notify 不在表里：
 * 它们在前端经 window.PtApp 以多种形态使用，或由宿主隐式使用，静态看不准。
 */
const SCOPE_USES = {
    'ai:invoke': /ctx\.pt\.ai\./,
    'notify:send': /ctx\.pt\.notify\./,
    'jobs:run': /requireTrigger\(/,
    'asset:write': /ctx\.pt\.asset\.(ensureFolder|create|update|uploadSource)/,
    'asset:read': /ctx\.pt\.asset\.(list|sharedWithMe|get)\(/,
    'openapi:read': /ctx\.pt\.openApiUrl/
};
/**
 * 只用于「声明了没用」方向的额外在用认定（「用了未声明」仍只认 SCOPE_USES）：
 * asset:read 前端也能用（`window.PtApp.asset.list()` 等，见 AGENTS.md）；notify:send 还覆盖 `ctx.pt.render.*`。
 * 不认这些会让只在前端读资产、只用 render.chart 的项目被劝删掉在用的权限。
 */
const ALSO_USED_BY = {
    'asset:read': /(^|\.)asset\.(list|sharedWithMe|get)\(/,
    'notify:send': /ctx\.pt\.render\./
};
/** 换了写法也能看出「大概在用」的标识符：出现了就不报「声明了没用」。 */
const SCOPE_IDENTS = { 'jobs:run': 'requireTrigger', 'openapi:read': 'openApiUrl' };
/** ctx.pt 下按命名空间调用的几组：`ctx.pt.ai` 后面不再接 `.方法` 就是被转手了。 */
const PT_NAMESPACES = new Set(['ai', 'notify', 'asset', 'render']);

/**
 * ctx.pt 是否以认不出的方式被使用：换了参数名（`c.pt`）、整个转手 / 解构（`helper(ctx.pt)`、`const { ai } = ctx.pt`、
 * `({ pt }) =>`）、命名空间转手（`const n = ctx.pt.notify`）。这时正则对不上不代表没用。
 */
function ptOpaque(ts, node) {
    let opaque = false;
    walk(ts, node, n => {
        if (opaque) return;
        if (ts.isBindingElement(n) && bindingNames(ts, n.name).includes('pt')) opaque = true;
        else if (ts.isBindingElement(n) && n.propertyName && ts.isIdentifier(n.propertyName) && n.propertyName.text === 'pt') opaque = true;
        if (!ts.isPropertyAccessExpression(n)) return;
        const usedAsObject = ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n;
        if (n.name.text === 'pt') {
            if (!ts.isIdentifier(n.expression) || n.expression.text !== 'ctx' || !usedAsObject) opaque = true;
        } else if (PT_NAMESPACES.has(n.name.text) && nameChain(ts, n.expression) === 'ctx.pt' && !usedAsObject) {
            opaque = true;
        }
    });
    return opaque;
}

/**
 * 逐个调用 / 名字链去比正则（而不是对全文跑正则）：注释和字符串里的同样字样不算用到。
 * 调用比 `被调用者(`，所以带 `\(` 的正则（asset:read、jobs:run）只认真的调用。
 * `requireScope('x')` 的字面量也算用到 x —— 与 ptx doctor 的 checkScopeConsistency 同一口径。
 * 返回 scope → 首次出现的 { file, line }（文件按扫描顺序，文件内按先序遍历）。
 * table 换成 ALSO_USED_BY 时只看正则，不看 requireScope。
 */
function scopeUses(ctx, table = SCOPE_USES) {
    const { ts } = ctx;
    const first = new Map();
    const mark = (scope, file, node) => { if (!first.has(scope)) first.set(scope, { file: file.rel, line: lineOf(file.sf, node) }); };
    for (const file of ctx.files) {
        walk(ts, file.sf, n => {
            let text = null;
            if (ts.isCallExpression(n)) {
                const name = callee(ts, n);
                text = `${name}(`;
                if (table === SCOPE_USES && /(^|\.)requireScope$/.test(name)) {
                    for (const a of n.arguments) {
                        if ((ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text in SCOPE_USES) mark(a.text, file, n);
                    }
                }
            } else if (ts.isPropertyAccessExpression(n)) {
                text = nameChain(ts, n);
            }
            if (text === null) return;
            for (const [scope, re] of Object.entries(table)) if (re.test(text)) mark(scope, file, n);
        });
    }
    return first;
}

function hasIdentifier(ts, files, name) {
    return files.some(f => {
        let found = false;
        walk(ts, f.sf, n => { if (!found && ts.isIdentifier(n) && n.text === name) found = true; });
        return found;
    });
}

/**
 * 「声明了没用」只在扫到了后端文件时才报：表里的写法都是后端 ctx.pt 的，
 * `--src web/src` 只扫前端时看不到后端，不能据此说没用。
 */
function des001(ctx) {
    if (!ctx.manifest) return [];
    const { ts } = ctx;
    const declared = new Set(Array.isArray(ctx.manifest.scopes) ? ctx.manifest.scopes : []);
    const used = scopeUses(ctx);
    const out = [];
    for (const [scope, at] of used) {
        if (!declared.has(scope)) out.push({ rule: 'DES-001', file: at.file, line: at.line, args: { scope } });
    }
    const unusedCandidates = [...declared].filter(s => s in SCOPE_USES && !used.has(s));
    if (unusedCandidates.length === 0 || filesIn(ctx, 'backend').length === 0) return out;
    if (ctx.files.some(f => ptOpaque(ts, f.sf))) return out;
    const alsoUsed = scopeUses(ctx, ALSO_USED_BY);
    for (const scope of unusedCandidates) {
        if (alsoUsed.has(scope)) continue;
        if (SCOPE_IDENTS[scope] && hasIdentifier(ts, ctx.files, SCOPE_IDENTS[scope])) continue;
        out.push({ rule: 'DES-001', file: 'manifest.json', line: 0, args: { scope } });
    }
    return out;
}

// ─── DES-002 前后端只接了一半 ───
/**
 * 前端调后端的痕迹：`'/api/…'` / `'/api'` 字面量（`const BASE = '/api'; fetch(BASE + p)`）、`/api${path}` 这种模板开头（starter 自带的 web/src/api.ts 就是这么拼的，
 * 不认它会把所有只走 api() 封装的项目误报成「前端没调后端」）、`api.call(` / `callApi(`。
 */
const API_PREFIX = /^\/api(\/|$)/;

function webCallsApi(ctx) {
    const { ts } = ctx;
    return filesIn(ctx, 'web').some(file => {
        if (stringLiteralsIn(ts, file.sf).some(s => API_PREFIX.test(s.text))) return true;
        let found = false;
        walk(ts, file.sf, n => {
            if (found) return;
            if (ts.isTemplateExpression(n) && API_PREFIX.test(n.head.text)) found = true;
            else if (ts.isCallExpression(n) && /(^|\.)(api\.call|callApi)$/.test(callee(ts, n))) found = true;
        });
        return found;
    });
}

/** fetch 的第一个实参是不是以 /api/ 开头的字面量（含 `/api/x/${id}` 模板）。 */
function fetchesApi(ts, call, name) {
    if (name !== 'fetch' && name !== 'window.fetch') return false;
    const a = unwrapParens(ts, call.arguments[0]);
    if (!a) return false;
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text.startsWith('/api/');
    return ts.isTemplateExpression(a) && a.head.text.startsWith('/api/');
}

/** 没扫到前端文件（`--src backend/src`）时不报「前端没调」：看不到不等于没有。 */
function des002(ctx) {
    if (!ctx.manifest) return [];
    const { ts } = ctx;
    const web = filesIn(ctx, 'web');
    if (ctx.backend.enabled) {
        return web.length > 0 && !webCallsApi(ctx) ? [{ rule: 'DES-002', file: 'manifest.json', line: 0 }] : [];
    }
    for (const file of web) {
        let at = null;
        eachCall(ctx, file, (call, name) => { if (!at && fetchesApi(ts, call, name)) at = call; });
        if (at) return [{ rule: 'DES-002', file: file.rel, line: lineOf(file.sf, at) }];
    }
    return [];
}

// ─── DES-003 组件取数没处理出错 ───
const isJsx = (ts, n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);
const isFn = (ts, n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

/** expr 里（不进内层函数）有没有 JSX：`return ok ? <A /> : null` 也算返回 JSX。 */
function containsJsx(ts, expr) {
    let found = false;
    const visit = n => {
        if (found || isFn(ts, n)) return;
        if (isJsx(ts, n)) { found = true; return; }
        ts.forEachChild(n, visit);
    };
    visit(expr);
    return found;
}

/** 组件函数：自己这一层的 return（或表达式体箭头函数）返回 JSX。 */
function isComponent(ts, fn) {
    if (!isFn(ts, fn) || !fn.body) return false;
    if (!ts.isBlock(fn.body)) return containsJsx(ts, fn.body);
    let found = false;
    const visit = n => {
        if (found || isFn(ts, n)) return;
        if (ts.isReturnStatement(n) && n.expression && containsJsx(ts, n.expression)) { found = true; return; }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return found;
}

/**
 * node 所在的最外层组件：useEffect 回调、事件处理函数都算在组件里；
 * 取最外层是因为错误状态（useState）写在组件顶层，`renderRow = () => <tr/>` 这类返回 JSX 的小函数不是独立组件。
 */
function outerComponent(ts, node) {
    let comp = null;
    for (let p = node.parent; p; p = p.parent) if (isComponent(ts, p)) comp = p;
    return comp;
}

/** 取数调用：`fetch(` / `window.fetch(` / `xxx.api.<方法>(`。 */
const isFetchLike = name => name === 'fetch' || name === 'window.fetch' || /(^|\.)api\.[\w$]+$/.test(name);

/** call 往外接的整条链（`.then(…).catch(…)`）：返回 { top, methods: [{ name, call }] }。 */
function chainOf(ts, call) {
    const methods = [];
    let top = call;
    while (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top
        && ts.isCallExpression(top.parent.parent) && top.parent.parent.expression === top.parent) {
        methods.push({ name: top.parent.name.text, call: top.parent.parent });
        top = top.parent.parent;
    }
    return { top, methods };
}

/** 链里有没有处理错误：`.catch(` 或带第二个参数的 `.then(ok, fail)`。 */
const chainHandlesError = methods => methods.some(m => m.name === 'catch' || (m.name === 'then' && m.call.arguments.length >= 2));

/** 链的结果是否被丢掉（独立一条语句 / `void …`）：被 return、await、赋值的，错误交给了调用方，这里看不出有没有处理。 */
function discarded(ts, top) {
    let n = top;
    while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
    return ts.isExpressionStatement(n.parent) || ts.isVoidExpression(n.parent);
}

/**
 * 组件里有没有错误状态：解构自 use* 调用、名字含 err / error 的变量 ——
 * `const [loadErr, setLoadErr] = useState()`，也认 `const { error } = useQuery()` 这类数据 hook 给出的错误。
 */
function hasErrorState(ts, comp) {
    let found = false;
    walk(ts, comp, n => {
        if (found || !ts.isVariableDeclaration(n) || !n.initializer || ts.isIdentifier(n.name)) return;
        const init = unwrapParens(ts, n.initializer);
        if (!ts.isCallExpression(init) || !/(^|\.)use[A-Z]\w*$/.test(callee(ts, init))) return;
        const names = ts.isArrayBindingPattern(n.name)
            ? bindingNames(ts, n.name.elements[0]?.name ?? n.name).slice(0, 1)
            : bindingNames(ts, n.name);
        if (names.some(x => /err|error/i.test(x))) found = true;
    });
    return found;
}

/** node 到 comp 之间有没有包着它的 try 块（catch / finally 里的不算）。 */
function insideTry(ts, node, comp) {
    for (let child = node, p = node.parent; p && p !== comp; child = p, p = p.parent) {
        if (ts.isTryStatement(p) && p.tryBlock === child) return true;
    }
    return false;
}

/** await 的取数调用：操作数本身，或链的起点（`await fetch(u).then(r => r.json())`）。链里自带 catch 的不算。 */
function awaitedFetch(ts, aw) {
    let n = unwrapParens(ts, aw.expression);
    if (!ts.isCallExpression(n)) return null;
    const methods = [];
    while (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && !isFetchLike(callee(ts, n))) {
        methods.push({ name: n.expression.name.text, call: n });
        n = n.expression.expression;
    }
    if (!ts.isCallExpression(n) || !isFetchLike(callee(ts, n)) || chainHandlesError(methods)) return null;
    return n;
}

function des003(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        const errState = new Map(); // comp -> boolean
        walk(ts, file.sf, n => {
            if (ts.isCallExpression(n) && isFetchLike(callee(ts, n))) {
                const { top, methods } = chainOf(ts, n);
                if (!methods.some(m => m.name === 'then') || chainHandlesError(methods) || !discarded(ts, top)) return;
                if (outerComponent(ts, n)) out.push({ rule: 'DES-003', file: file.rel, line: lineOf(file.sf, n) });
            } else if (ts.isAwaitExpression(n) && awaitedFetch(ts, n)) {
                const comp = outerComponent(ts, n);
                if (!comp || insideTry(ts, n, comp)) return;
                if (!errState.has(comp)) errState.set(comp, hasErrorState(ts, comp));
                if (!errState.get(comp)) out.push({ rule: 'DES-003', file: file.rel, line: lineOf(file.sf, n) });
            }
        });
    }
    return out;
}

/** @type {import('./run.mjs').Rule[]} */
export const rules = [
    { id: 'DES-001', check: des001 },
    { id: 'DES-002', check: des002 },
    { id: 'DES-003', check: des003 }
];
