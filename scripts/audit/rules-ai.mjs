/**
 * AI 成本维度规则 AI-001 … AI-007。
 *
 * 和安全规则一样「拿不准就不报」：实参是变量、对象里有展开、处理函数在别处定义……
 * 这些静态看不出确定答案的写法一律放过，宁可漏报也不让 Builder 为一条误报去解释。
 */
import {
    bindingNames, callee, eachCall, enclosingFunction, enclosingRoute, exclusive, filesIn, insideLoop, isReference, lineOf, propName,
    shadowedByParam, walk
} from './scan.mjs';

/**
 * `ctx.pt.ai.chat` / `pt.ai.stream` / `ai.chat` 等：要求 `ai` 是完整的一节。
 * 不按字符串后缀匹配 —— 否则 `mail.chat`、`gmail.chat` 也会被当成 AI 调用。
 * （`openai.chat` 因此也不算；OpenAI SDK 真正的调用是 `openai.chat.completions.create`，本来就对不上。）
 */
const AI_CALL = /(^|\.)ai\.(chat|stream)$/;
export const isAiCall = name => AI_CALL.test(name);

/** 遍历所有 AI 调用，visit(call, file)。 */
function eachAiCall(ctx, visit, area) {
    for (const file of filesIn(ctx, area)) eachCall(ctx, file, (call, name) => { if (isAiCall(name)) visit(call, file); });
}

/** manifest 里任务路由的 path 集合；没有 jobs → 空集。 */
function jobRoutes(ctx) {
    const jobs = ctx.manifest?.backend?.jobs;
    if (!Array.isArray(jobs)) return new Set();
    return new Set(jobs.filter(j => j && typeof j.route === 'string').map(j => j.route));
}

/** 路由键 `'POST /jobs/daily'` → `'/jobs/daily'`（没写方法就原样）。 */
const routePath = key => key.replace(/^[A-Z]+\s+/, '');

/** 对象字面量里有没有叫 name 的属性（含简写、方法、带引号的键）。 */
function hasProp(ts, obj, name) {
    return obj.properties.some(p => p.name && propName(ts, p.name) === name);
}

/**
 * 第一个实参是「看得全」的对象字面量才返回它：实参是变量、或对象里有 `...base` 展开时，
 * 属性可能在别处给了，按拿不准返回 null。
 */
function literalOptions(ts, call) {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
    if (arg.properties.some(p => ts.isSpreadAssignment(p))) return null;
    return arg;
}

const unwrap = (ts, n) => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
    return n;
};

// ─── AI-001 循环里调 AI ───
function ai001(ctx) {
    const out = [];
    eachAiCall(ctx, (call, file) => {
        if (insideLoop(ctx.ts, call)) out.push({ rule: 'AI-001', file: file.rel, line: lineOf(file.sf, call) });
    });
    return out;
}

// ─── AI-002 任务路由里调 AI 却没上限 ───
// 名字任意位置含 MAX_ / _MAX / LIMIT 即算上限常量（DAILY_MAX_ITEMS、ITEMS_MAX、DAILY_LIMIT），与 fix 文案的说法一致
const CAP_NAME = /MAX_|_MAX|LIMIT/;

/**
 * 路由函数体里有没有看得出来的「上限」：`.slice(` 截断、名字含 MAX_ / _MAX / LIMIT 的常量、
 * 或 `if (n < 10)` 这种和数字字面量比大小的判断。只认这三种，任一存在就当已经设了上限
 * （不去证明上限真的作用在 AI 调用上 —— 那需要数据流分析，做不准反而误报）。
 */
function hasCap(ts, node) {
    let found = false;
    walk(ts, node, n => {
        if (found) return;
        if (ts.isCallExpression(n) && /(^|\.)slice$/.test(callee(ts, n))) found = true;
        else if (ts.isIdentifier(n) && CAP_NAME.test(n.text)) found = true;
        else if (ts.isIfStatement(n)) {
            walk(ts, n.expression, m => {
                if (ts.isBinaryExpression(m)
                    && (m.operatorToken.kind === ts.SyntaxKind.LessThanToken || m.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken)
                    && (ts.isNumericLiteral(m.left) || ts.isNumericLiteral(m.right))) found = true;
            });
        }
    });
    return found;
}

function ai002(ctx) {
    const jobs = jobRoutes(ctx);
    if (jobs.size === 0) return [];
    const { ts } = ctx;
    const out = [];
    eachAiCall(ctx, (call, file) => {
        const route = enclosingRoute(ts, call);
        if (!route || !jobs.has(routePath(route.key)) || hasCap(ts, route.node)) return;
        out.push({ rule: 'AI-002', file: file.rel, line: lineOf(file.sf, call) });
    });
    return out;
}

// ─── AI-003 没设 max_tokens ───
function ai003(ctx) {
    const { ts } = ctx;
    const out = [];
    eachAiCall(ctx, (call, file) => {
        const opts = literalOptions(ts, call);
        // 只认平台入参的 snake_case：写成 maxTokens 平台不认，等于没设
        if (opts && !hasProp(ts, opts, 'max_tokens')) out.push({ rule: 'AI-003', file: file.rel, line: lineOf(file.sf, call) });
    });
    return out;
}

// ─── AI-004 查询结果整段拼进 prompt ───
const RESULT_NAME = /^(rows|result|results|data|records)$/;

/** 插进 prompt 的表达式是不是「整份查询结果」：`rows` 本身，或 `JSON.stringify(rows)`。 */
function isWholeResult(ts, expr, sf) {
    const e = unwrap(ts, expr);
    if (e.getText(sf).includes('.slice(')) return false;
    if (ts.isIdentifier(e)) return RESULT_NAME.test(e.text);
    if (ts.isCallExpression(e) && callee(ts, e) === 'JSON.stringify') {
        const a = e.arguments[0] && unwrap(ts, e.arguments[0]);
        return !!a && ts.isIdentifier(a) && RESULT_NAME.test(a.text);
    }
    return false;
}

const isConcat = (ts, n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** content 里被插进去的表达式：模板的 `${…}`，或 `a + b` 里不是字面量的操作数。 */
function insertedExprs(ts, n) {
    n = unwrap(ts, n);
    if (ts.isTemplateExpression(n)) return n.templateSpans.map(s => s.expression);
    if (isConcat(ts, n)) {
        const side = x => (ts.isTemplateExpression(unwrap(ts, x)) || isConcat(ts, unwrap(ts, x)) ? insertedExprs(ts, x) : [x]);
        return [...side(n.left), ...side(n.right)];
    }
    return [];
}

function ai004(ctx) {
    const { ts } = ctx;
    const out = [];
    eachAiCall(ctx, (call, file) => {
        const opts = call.arguments[0];
        if (!opts || !ts.isObjectLiteralExpression(opts)) return;
        const messages = opts.properties.find(p => ts.isPropertyAssignment(p) && propName(ts, p.name) === 'messages');
        if (!messages || !ts.isArrayLiteralExpression(messages.initializer)) return;
        for (const msg of messages.initializer.elements) {
            if (!ts.isObjectLiteralExpression(msg)) continue;
            for (const p of msg.properties) {
                if (!ts.isPropertyAssignment(p) || propName(ts, p.name) !== 'content') continue;
                // 只看「拼」出来的 content（模板 / +）；整个 content 就是一个变量（`content: prompt`）时
                // 看不出里面装了什么，不报
                const tpl = unwrap(ts, p.initializer);
                if (!ts.isTemplateExpression(tpl) && !isConcat(ts, tpl)) continue;
                if (insertedExprs(ts, tpl).some(e => isWholeResult(ts, e, file.sf))) {
                    out.push({ rule: 'AI-004', file: file.rel, line: lineOf(file.sf, p) });
                }
            }
        }
    });
    return out;
}

// ─── AI-005 同一函数里多次互不依赖的 AI 调用 ───
/** 调用结果赋给了哪些变量：`const a = await ai.chat()`、`const { content } = (await ai.chat()).x`、`a = await ai.chat()`。 */
function resultVars(ts, call) {
    let n = call;
    while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAwaitExpression(n.parent) || ts.isAsExpression(n.parent)
        || ts.isNonNullExpression(n.parent) || (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n))) n = n.parent;
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p) && p.initializer === n) return bindingNames(ts, p.name);
    if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n && ts.isIdentifier(p.left)) {
        return [p.left.text];
    }
    return [];
}

/** node 里读到的变量名（不含属性名、被回调参数遮蔽的）。 */
function referencedNames(ts, node, fn) {
    const names = new Set();
    walk(ts, node, m => {
        if (ts.isIdentifier(m) && isReference(ts, m) && !shadowedByParam(ts, m, fn, m.text)) names.add(m.text);
    });
    return names;
}

/** `a.b.c` / `a[i].b` 最左边的变量名；不是变量开头 → null。 */
function rootName(ts, n) {
    while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = n.expression;
    return ts.isIdentifier(n) ? n.text : null;
}

/**
 * 从 seeds 出发，把函数里「由它们算出来」的变量也算进去（算到不再变为止）：
 * - `const text = first.content;` → text；
 * - `history.push({ content: first.content })`、`state.last = first` → history / state 被写进了结果。
 * 多轮对话最常见的写法就是把上一轮回复 push 进 messages 再问，漏掉它会把真依赖误报成「互不依赖」。
 */
function derivedVars(ts, fn, seeds) {
    const vars = new Set(seeds);
    const edges = []; // [读的表达式, 被写的变量名[]]
    walk(ts, fn, n => {
        if (ts.isVariableDeclaration(n) && n.initializer && enclosingFunction(ts, n) === fn) {
            edges.push([n.initializer, bindingNames(ts, n.name)]);
        } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const target = rootName(ts, n.expression.expression);
            if (target) edges.push([n.arguments, [target]]);
        } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const target = rootName(ts, n.left);
            if (target) edges.push([n.right, [target]]);
        }
    });
    for (let changed = true; changed;) {
        changed = false;
        for (const [from, to] of edges) {
            const refs = new Set();
            for (const node of Array.isArray(from) ? from : [from]) for (const r of referencedNames(ts, node, fn)) refs.add(r);
            if (![...refs].some(r => vars.has(r))) continue;
            for (const name of to) if (!vars.has(name)) { vars.add(name); changed = true; }
        }
    }
    return vars;
}

function isAncestor(a, b) {
    for (let p = b.parent; p; p = p.parent) if (p === a) return true;
    return false;
}

function ai005(ctx) {
    const { ts } = ctx;
    const byFn = new Map(); // fn -> { file, calls }
    eachAiCall(ctx, (call, file) => {
        const fn = enclosingFunction(ts, call);
        if (!fn) return;
        const g = byFn.get(fn) ?? { file, calls: [] };
        g.calls.push(call);
        byFn.set(fn, g);
    });
    const out = [];
    for (const [fn, { file, calls }] of byFn) {
        if (calls.length < 2) continue;
        for (let j = 1; j < calls.length; j++) {
            // 前一处是后一处的祖先（`ai.chat({ content: (await ai.chat(x)).content })` 里外层先被遍历到）：
            // 内层的结果直接喂给外层，是依赖关系，不是两次独立调用
            const earlier = calls.slice(0, j).filter(i => !isAncestor(i, calls[j]) && !exclusive(ts, i, calls[j], fn));
            if (earlier.length === 0) continue;
            const deps = derivedVars(ts, fn, earlier.flatMap(i => resultVars(ts, i)));
            const used = new Set();
            for (const a of calls[j].arguments) for (const r of referencedNames(ts, a, fn)) used.add(r);
            if (![...used].some(r => deps.has(r))) out.push({ rule: 'AI-005', file: file.rel, line: lineOf(file.sf, calls[j]) });
        }
    }
    return out;
}

// ─── AI-006 前端每次渲染 / 每次输入都打后端 ───
const isBackendCall = name => name === 'fetch' || name === 'window.fetch' || /(^|\.)api\.call$/.test(name) || /(^|\.)callApi$/.test(name);
const THROTTLE = /(^|\.)(setTimeout|\w*[dD]ebounce\w*|\w*[tT]hrottle\w*)$/;

/** fn 是不是直接作为 setTimeout / debounce / throttle 的实参：这样的请求已经被节流过。 */
function isThrottledCallback(ts, fn) {
    const call = fn.parent;
    return !!call && ts.isCallExpression(call) && call.arguments.includes(fn) && THROTTLE.test(callee(ts, call));
}

/**
 * body 里的后端请求。deep = true 时也看嵌套函数（effect 里常见 `const load = async () => {…}; load()`），
 * 但跳过交给 setTimeout / debounce 的回调；deep = false 只看 body 自己这一层。
 */
function backendCallsIn(ts, body, deep) {
    const found = [];
    const visit = n => {
        if (ts.isFunctionLike(n) && (!deep || isThrottledCallback(ts, n))) return;
        if (ts.isCallExpression(n) && isBackendCall(callee(ts, n))) found.push(n);
        ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
}

function ai006(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        walk(ts, file.sf, n => {
            if (ts.isCallExpression(n) && /^(React\.)?useEffect$/.test(callee(ts, n))) {
                const [cb, deps] = n.arguments;
                if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return;
                // 缺依赖数组 = 每次渲染都跑；依赖里有变量 = 变量一变就跑（比如跟着输入框的值）。`[]` 只跑一次，不报
                const everyTime = deps === undefined
                    || (ts.isArrayLiteralExpression(deps) && deps.elements.some(e => ts.isIdentifier(e)));
                if (everyTime && backendCallsIn(ts, cb.body, true).length > 0) {
                    out.push({ rule: 'AI-006', file: file.rel, line: lineOf(file.sf, n) });
                }
            } else if (ts.isJsxAttribute(n) && n.name.getText(file.sf) === 'onChange') {
                const fn = n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : null;
                if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
                // 只算直接写在 onChange 里的请求；套了一层函数（`debounced(() => fetch(…))`）多半是节流过的
                for (const c of backendCallsIn(ts, fn.body, false)) out.push({ rule: 'AI-006', file: file.rel, line: lineOf(file.sf, c) });
            }
        });
    }
    return out;
}

// ─── AI-007 面向用户的 AI 调用没有超时 ───
function ai007(ctx) {
    const { ts } = ctx;
    const jobs = jobRoutes(ctx);
    const out = [];
    eachAiCall(ctx, (call, file) => {
        // 只报内联在 createApp routes 里的非任务路由：不在路由里的辅助函数可能是被定时任务调的，拿不准
        const route = enclosingRoute(ts, call);
        if (!route || jobs.has(routePath(route.key))) return;
        const opts = literalOptions(ts, call);
        if (!opts || hasProp(ts, opts, 'signal')) return;
        // 路由里任何地方建了 AbortSignal.timeout 就当已经处理了超时（可能换了个名字传进去）
        let timeout = false;
        walk(ts, route.node, n => { if (ts.isCallExpression(n) && callee(ts, n) === 'AbortSignal.timeout') timeout = true; });
        if (!timeout) out.push({ rule: 'AI-007', file: file.rel, line: lineOf(file.sf, call) });
    });
    return out;
}

/** @type {import('./run.mjs').Rule[]} */
export const rules = [
    { id: 'AI-001', check: ai001 },
    { id: 'AI-002', check: ai002 },
    { id: 'AI-003', check: ai003 },
    { id: 'AI-004', check: ai004 },
    { id: 'AI-005', check: ai005 },
    { id: 'AI-006', check: ai006 },
    { id: 'AI-007', check: ai007 }
];
