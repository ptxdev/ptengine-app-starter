/**
 * 安全维度规则 SEC-001 … SEC-007。
 *
 * 总原则「拿不准就不报」：这些规则会挡 Builder 的验收，误报一条就要人工去解释一次，
 * 所以凡是静态看不出确定答案的写法（地址拼出来的、处理函数在别处定义的……）一律放过，
 * 唯一例外是 SEC-002 的变量目标 —— 后端出站是硬限制，降成 normal 提醒一下。
 */
import { findRouteHandler } from '../ptx-doctor.mjs';
import { callee, lineOf, stringLiteralsIn, walk } from './scan.mjs';

const KNOWN_SECRET = /^(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36})$/;
const SECRET_CHARS = /^[A-Za-z0-9+/=_-]+$/;
const SECRET_NAME = /key|token|secret|password/i;
const PLATFORM_HOSTS = ['ptengine.ai', 'ptengine.jp', 'ptengine.com'];

const filesIn = (ctx, area) => (area ? ctx.files.filter(f => f.area === area) : ctx.files);

/** 遍历文件里的所有调用，visit(node, calleeText)。 */
function eachCall(ctx, file, visit) {
    walk(ctx.ts, file.sf, n => { if (ctx.ts.isCallExpression(n)) visit(n, callee(ctx.ts, n)); });
}

const isPlainString = (ts, n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/**
 * 地址表达式开头那段写死的文本：字符串、模板的头部、`'…' + x` 最左边的字面量。
 * 返回 { text, whole }，whole = 整个实参就是这段字面量；开头不是字面量 → null。
 */
function staticPrefix(ts, n) {
    if (isPlainString(ts, n)) return { text: n.text, whole: true };
    if (ts.isTemplateExpression(n)) return { text: n.head.text, whole: false };
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticPrefix(ts, n.left);
        return left && { text: left.text, whole: false };
    }
    if (ts.isParenthesizedExpression(n)) return staticPrefix(ts, n.expression);
    return null;
}

/**
 * 从字面量开头取 host。只有 host 在字面量里**完整**出现（整串就是 URL，或后面紧跟 / : ? #）才算数：
 * `https://${sub}.foo.com` 的头部只有 `https://`，`https://api` + x 也可能是 `api.evil.com`，都返回 null。
 */
function hostOf(prefix, schemes = /^https?:\/\//i) {
    if (!prefix || !schemes.test(prefix.text)) return null;
    const m = /^[a-z]+:\/\/([^/:?#\s]+)([/:?#]|$)/i.exec(prefix.text);
    if (!m || (!m[2] && !prefix.whole)) return null;
    return m[1].toLowerCase();
}

/** host 等于某个域名，或是它的子域。egress 里的 `*.foo.com` 按 foo.com 处理。 */
function hostMatches(host, domains) {
    return domains.some(d => {
        const bare = String(d).toLowerCase().replace(/^\*\./, '');
        return host === bare || host.endsWith(`.${bare}`);
    });
}

/** 名字节点（标识符 / 字符串键）的文本；计算属性名等 → null。 */
function nameText(ts, name) {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
    return null;
}

/** 解构写法里绑定出来的全部变量名。 */
function bindingNames(ts, name, out = []) {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(ts, el.name, out);
    }
    return out;
}

function enclosingFunction(ts, node) {
    for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
    return null;
}

// ─── SEC-001 前端写死密钥 ───
function sec001(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        for (const { text, node } of stringLiteralsIn(ts, file.sf)) {
            let hit = KNOWN_SECRET.test(text);
            if (!hit && text.length >= 32 && SECRET_CHARS.test(text)) {
                // 只看字面量**直接**赋给的变量 / 属性名：长 base64 串在前端很常见（图片、class 名、hash），
                // 光凭长相会大量误报，名字里带 key/token/secret/password 才算
                const p = node.parent;
                const name = (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === node
                    ? nameText(ts, p.name) : null;
                hit = name !== null && SECRET_NAME.test(name);
            }
            if (hit) out.push({ rule: 'SEC-001', file: file.rel, line: lineOf(file.sf, node) });
        }
    }
    return out;
}

// ─── SEC-002 后端出站未声明 egress ───
function sec002(ctx) {
    if (!ctx.backend.enabled) return [];
    const { ts } = ctx;
    const egress = Array.isArray(ctx.manifest?.backend?.egress) ? ctx.manifest.backend.egress : [];
    const out = [];
    for (const file of filesIn(ctx, 'backend')) {
        eachCall(ctx, file, (call, name) => {
            if (name !== 'fetch' && name !== 'ctx.fetch') return;
            const arg = call.arguments[0];
            if (!arg) return;
            const line = lineOf(file.sf, call);
            const prefix = staticPrefix(ts, arg);
            if (prefix && !/^[a-z]+:\/\//i.test(prefix.text)) {
                // 字面量开头但不是绝对地址：相对路径 `/api/…` 是打自己，不出站。
                // 开头是空串（`${base}/x`）时目标其实未知，落到下面的变量分支
                if (prefix.text !== '') return;
            } else if (prefix) {
                const host = hostOf(prefix);
                if (host) {
                    if (!hostMatches(host, egress)) out.push({ rule: 'SEC-002', file: file.rel, line, args: { host } });
                    return;
                }
            }
            // 目标是变量 / 拼出来的 host：静态看不出去哪，降成 normal 提醒去核对 egress。
            // host 占位填实参原文（太长或跨行就填「(变量)」），不填文案里会露出 {host}
            const src = arg.getText(file.sf);
            const host = src.length <= 60 && !src.includes('\n') ? src : '(变量)';
            out.push({ rule: 'SEC-002', file: file.rel, line, args: { host }, severity: 'normal' });
        });
    }
    return out;
}

// ─── SEC-003 D1 SQL 拼接 ───
/** `a + b + c` 里有不是字面量的操作数。 */
function concatHasVariable(ts, n) {
    if (ts.isParenthesizedExpression(n)) return concatHasVariable(ts, n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return concatHasVariable(ts, n.left) || concatHasVariable(ts, n.right);
    }
    return !(isPlainString(ts, n) || ts.isNumericLiteral(n));
}

function sec003(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'backend')) {
        eachCall(ctx, file, (call, name) => {
            if (!/\.(prepare|exec|batch)$/.test(name)) return;
            const arg = call.arguments[0];
            if (!arg) return;
            const isConcat = ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken;
            if (ts.isTemplateExpression(arg) || (isConcat && concatHasVariable(ts, arg))) {
                out.push({ rule: 'SEC-003', file: file.rel, line: lineOf(file.sf, call) });
            }
        });
    }
    return out;
}

// ─── SEC-004 危险 API ───
function sec004(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of ctx.files) {
        walk(ts, file.sf, n => {
            let hit = false;
            if (ts.isJsxAttribute(n)) hit = nameText(ts, n.name) === 'dangerouslySetInnerHTML';
            else if (ts.isNewExpression(n)) hit = n.expression.getText(file.sf) === 'Function';
            else if (ts.isCallExpression(n)) {
                const name = callee(ts, n);
                const target = n.arguments[1];
                // 只认第二个实参就是 '*'：写了具体 origin 或变量都不报（变量多半是已校验过的 origin）
                hit = name === 'eval'
                    || (name.endsWith('.postMessage') && target !== undefined && isPlainString(ts, target) && target.text === '*');
            }
            if (hit) out.push({ rule: 'SEC-004', file: file.rel, line: lineOf(file.sf, n) });
        });
    }
    return out;
}

// ─── SEC-005 轻应用前端直连外部 ───
const SEC005_CALLEES = new Set(['fetch', 'axios', 'axios.get', 'axios.post']);

/** 表达式里有没有读 `import.meta.env.VITE_*`。 */
function readsViteEnv(ts, node, sf) {
    let found = false;
    walk(ts, node, n => {
        if (!found && ts.isPropertyAccessExpression(n) && n.name.text.startsWith('VITE_')
            && n.expression.getText(sf).replace(/\s+/g, '') === 'import.meta.env') found = true;
    });
    return found;
}

function sec005(ctx) {
    if (ctx.manifest?.schemaVersion !== 1) return [];
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'web')) {
        eachCall(ctx, file, (call, name) => {
            if (!SEC005_CALLEES.has(name)) return;
            const arg = call.arguments[0];
            if (!arg) return;
            // 只认 https:// 开头且 host 写全的字面量；host 拼出来的看不出去哪，不报
            const host = hostOf(staticPrefix(ts, arg), /^https:\/\//i);
            const external = host !== null && !hostMatches(host, PLATFORM_HOSTS);
            const viaEnv = name === 'fetch' && readsViteEnv(ts, arg, file.sf);
            if (external || viaEnv) out.push({ rule: 'SEC-005', file: file.rel, line: lineOf(file.sf, call) });
        });
    }
    return out;
}

// ─── SEC-006 用户查询结果落盘 / 进日志（汇点：.prepare / .bind / .put / console.log）───
const isUserQuery = (ts, call) => callee(ts, call) === 'ctx.pt.query'
    && call.arguments[0] !== undefined && isPlainString(ts, call.arguments[0]) && call.arguments[0].text.startsWith('user_');

/** `await ctx.pt.query('user_…')`（可带 await / 括号）。 */
function unwrapUserQuery(ts, n) {
    while (n && (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n))) n = n.expression;
    return n && ts.isCallExpression(n) && isUserQuery(ts, n);
}

function sec006(ctx) {
    const { ts } = ctx;
    const out = [];
    for (const file of filesIn(ctx, 'backend')) {
        // 每个函数体里 user_* 查询结果赋给了哪些变量（及赋值位置）。
        // 按「声明所在的最近函数」归组：别的函数里碰巧同名的参数 / 变量不算（避免跨函数误报）
        const tainted = new Map(); // fn -> [{ name, pos }]
        walk(ts, file.sf, n => {
            if (!ts.isVariableDeclaration(n) || !unwrapUserQuery(ts, n.initializer)) return;
            const fn = enclosingFunction(ts, n);
            if (!fn) return;
            const list = tainted.get(fn) ?? [];
            for (const name of bindingNames(ts, n.name)) list.push({ name, pos: n.end });
            tainted.set(fn, list);
        });
        for (const [fn, vars] of tainted) {
            walk(ts, fn, n => {
                if (!ts.isCallExpression(n)) return;
                const name = callee(ts, n);
                // .bind：D1 的 `db.prepare(sql).bind(x)` 是最常见的写法，结果出现在 bind 的实参里而不是 prepare 的
                if (!(/\.(prepare|bind|put)$/.test(name) || name === 'console.log' || name.endsWith('.console.log'))) return;
                const refs = new Set();
                for (const a of n.arguments) walk(ts, a, m => { if (ts.isIdentifier(m)) refs.add(m.text); });
                // 只算赋值之后的调用：前面的同名引用不可能是这次查询的结果
                if (vars.some(v => refs.has(v.name) && n.pos >= v.pos)) {
                    out.push({ rule: 'SEC-006', file: file.rel, line: lineOf(file.sf, n) });
                }
            });
        }
    }
    return out;
}

// ─── SEC-007 任务路由没 requireTrigger ───
function sec007(ctx) {
    const jobs = ctx.manifest?.backend?.jobs;
    if (!Array.isArray(jobs) || jobs.length === 0) return [];
    // 和 doctor 用同一个路由定位（同样先剥注释），两边对同一份代码的结论不会打架
    const sources = filesIn(ctx, 'backend').map(f => ({ rel: f.rel, text: f.text }));
    const out = [];
    for (const job of jobs) {
        if (!job || typeof job.route !== 'string') continue;
        const hit = findRouteHandler(sources, job.route);
        // 找不到路由是 doctor 的事（JOB_ROUTE_NOT_FOUND），这里不重复报
        if (!hit || hit.segment.includes('requireTrigger(')) continue;
        const line = hit.fileText.slice(0, hit.index).split('\n').length;
        out.push({ rule: 'SEC-007', file: hit.file, line });
    }
    return out;
}

/** @type {import('./run.mjs').Rule[]} */
export const rules = [
    { id: 'SEC-001', check: sec001 },
    { id: 'SEC-002', check: sec002 },
    { id: 'SEC-003', check: sec003 },
    { id: 'SEC-004', check: sec004 },
    { id: 'SEC-005', check: sec005 },
    { id: 'SEC-006', check: sec006 },
    { id: 'SEC-007', check: sec007 }
];
