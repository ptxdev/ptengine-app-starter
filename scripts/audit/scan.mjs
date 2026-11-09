/**
 * ptx audit 的扫描基础设施：收集文件、解析语法树、以及各条规则共用的几个小判断。
 *
 * 只做语法层面的事（不建 Program、不跑类型检查）：规则要的都是「这里写了什么」，
 * 类型检查要整个项目的依赖都装齐，在半成品项目上既慢又容易整片报错。
 * 除了 collectFiles / parseFile 读文件，这里没有别的 I/O。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';

/** 缺省扫描目录：前端、后端、两边共享的代码。 */
export const DEFAULT_SRC = ['web/src', 'backend/src', 'shared'];
/** 构建产物和依赖：不是项目自己写的代码，扫了只会产生噪音。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.out', '.wrangler', '.git']);
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
/** 见到这些语言就在 unscanned 里点名：让读结果的人知道「没报问题」不等于「这些也查过了」。 */
const UNSCANNED_EXT = new Set(['.py', '.go', '.rb', '.php', '.java']);
/**
 * 回调会按元素逐个执行的数组方法：写在它们的回调里，等于写在循环体里。
 * find / some / every 会提前结束，但最坏情况仍是每个元素一次，照循环算。
 */
export const LOOP_CALLBACKS = ['map', 'forEach', 'flatMap', 'reduce', 'filter', 'some', 'every', 'find'];

const toPosix = p => p.split(sep).join('/');

/** 深度优先列出 dir 下的文件（跳过 SKIP_DIRS），返回绝对路径。 */
function listFiles(dir) {
    const out = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) out.push(...listFiles(join(dir, ent.name)));
        } else if (ent.isFile()) {
            out.push(join(dir, ent.name));
        }
    }
    return out;
}

function areaOf(rel) {
    const first = rel.split('/')[0];
    return first === 'web' || first === 'backend' || first === 'shared' ? first : 'other';
}

/**
 * @param {string} root
 * @param {string[] | undefined} srcDirs 相对 root 的目录；不给用 DEFAULT_SRC
 * @returns {{ files: { abs: string, rel: string, area: 'web'|'backend'|'shared'|'other' }[], unscanned: string[], scanned: string[] }}
 *   scanned 是实际存在、扫过的目录（相对 root 的 POSIX 路径），给输出里的 scanned 用。
 */
export function collectFiles(root, srcDirs) {
    const files = [];
    const scanned = [];
    const seen = new Set();
    for (const d of srcDirs ?? DEFAULT_SRC) {
        const abs = resolve(root, d);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
        scanned.push(toPosix(relative(root, abs)) || '.');
        for (const f of listFiles(abs)) {
            // --src 给了互相包含的目录（如 web 和 web/src）时同一文件只算一次
            if (!SCAN_EXT.has(extname(f)) || seen.has(f)) continue;
            seen.add(f);
            const rel = toPosix(relative(root, f));
            files.push({ abs: f, rel, area: areaOf(rel) });
        }
    }
    // 未扫语言看整个项目而不只看扫描目录：tools/ 下的 Python 脚本同样是「没查过」的代码
    const unscanned = [...new Set(listFiles(root).map(f => extname(f)).filter(e => UNSCANNED_EXT.has(e)))].sort();
    return { files, unscanned, scanned };
}

/**
 * 先用项目自己装的 typescript（与项目的语法版本一致）；项目没装（如 Builder 扫一个还没 npm install
 * 的目录）再用脚本旁边的那一份。都没有就抛，CLI 把它变成退出码 3。
 */
export function loadTs(root) {
    for (const base of [join(root, 'package.json'), import.meta.url]) {
        try {
            const req = createRequire(base);
            return req(req.resolve('typescript'));
        } catch {
            // 换下一个位置
        }
    }
    throw new Error('typescript 解析不到');
}

function scriptKind(ts, rel) {
    switch (extname(rel)) {
        case '.tsx': return ts.ScriptKind.TSX;
        case '.jsx': return ts.ScriptKind.JSX;
        case '.js':
        case '.mjs': return ts.ScriptKind.JS;
        default: return ts.ScriptKind.TS;
    }
}

/**
 * 解析单个文件。有语法错误返回 null（调用方记进 unparsed）：
 * 带错的树里节点位置不可靠，在上面跑规则容易报出指不到地方的问题，不如明确说「这个没扫」。
 */
export function parseFile(ts, file) {
    const text = readFileSync(file.abs, 'utf8');
    // setParentNodes = true：insideLoop / enclosingRouteKey 要往上走
    const sf = ts.createSourceFile(file.rel, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file.rel));
    if (sf.parseDiagnostics.length > 0) return null;
    return { sf, text };
}

/** 深度优先（先序）遍历 node 及其所有子孙。 */
export function walk(ts, node, visit) {
    visit(node);
    ts.forEachChild(node, child => walk(ts, child, visit));
}

function nameChain(ts, expr) {
    if (ts.isIdentifier(expr)) return expr.text;
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isPropertyAccessExpression(expr)) {
        const left = nameChain(ts, expr.expression);
        return left === null ? null : `${left}.${expr.name.text}`;
    }
    return null;
}

/**
 * 调用表达式的被调用者文本：`ctx.pt.ai.chat(...)` → `'ctx.pt.ai.chat'`。
 * 链里夹着调用 / 下标（`db().prepare(...)`）时退回源码原文去掉空白，规则按「以 .prepare 结尾」匹配仍然成立。
 */
export function callee(ts, node) {
    if (!ts.isCallExpression(node)) return null;
    return nameChain(ts, node.expression) ?? node.expression.getText().replace(/\s+/g, '');
}

function isFunctionLike(ts, n) {
    return ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n) && !ts.isConstructorTypeNode(n);
}

/** 函数是不是直接作为 `xs.map(...)` 一类调用的实参。 */
function isLoopCallback(ts, fn) {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
    const call = fn.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn)) return false;
    return ts.isPropertyAccessExpression(call.expression) && LOOP_CALLBACKS.includes(call.expression.name.text);
}

/**
 * node 是否会按元素重复执行：在 for / for-of / for-in / while / do 的语句体里，
 * 或在 LOOP_CALLBACKS 回调里。遇到别的函数边界就停 —— 循环里「定义」一个函数不等于在循环里「调用」它。
 * 只认语句体：`for (const r of await f())` 里的 f() 只执行一次。
 */
export function insideLoop(ts, node) {
    let child = node;
    for (let p = node.parent; p; child = p, p = p.parent) {
        if ((ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p))
            && p.statement === child) return true;
        if (isFunctionLike(ts, p)) return isLoopCallback(ts, p);
    }
    return false;
}

/** 属性 / 键名的文本（标识符、带引号的字符串、无插值模板）；计算属性名等 → null。 */
export function propName(ts, name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    return null;
}

/** obj 是不是 `createApp({ routes: obj })` 里的那个 routes 对象。 */
function isRoutesObject(ts, obj) {
    const prop = obj.parent;
    if (!prop || !ts.isPropertyAssignment(prop) || prop.initializer !== obj || propName(ts, prop.name) !== 'routes') return false;
    const call = prop.parent?.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(prop.parent)) return false;
    const name = callee(ts, call);
    return name === 'createApp' || name.endsWith('.createApp');
}

/**
 * node 所在的后端路由：{ key: 路由键（如 `'POST /jobs/daily'`）, node: 该路由的属性 / 方法节点 }；
 * 不在 createApp 的 routes 里内联写的处理函数中 → null。
 * 处理函数写成别处定义的变量时认不出来，按「拿不准就不报」返回 null。
 */
export function enclosingRoute(ts, node) {
    for (let p = node.parent; p; p = p.parent) {
        if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.parent && ts.isObjectLiteralExpression(p.parent)
            && isRoutesObject(ts, p.parent)) {
            const key = propName(ts, p.name);
            return key === null ? null : { key, node: p };
        }
    }
    return null;
}

/** node 所在的后端路由键；见 enclosingRoute。 */
export function enclosingRouteKey(ts, node) {
    return enclosingRoute(ts, node)?.key ?? null;
}

/** 节点起始所在行，1 起（不含前导注释与空白）。 */
export function lineOf(sf, node) {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** node（含自身）里所有字符串字面量与无插值模板字面量。 */
export function stringLiteralsIn(ts, node) {
    const out = [];
    walk(ts, node, n => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ text: n.text, node: n });
    });
    return out;
}

/** ctx.files 里某个区域（web / backend / …）的文件；area 不给 → 全部。 */
export const filesIn = (ctx, area) => (area ? ctx.files.filter(f => f.area === area) : ctx.files);

/** 遍历文件里的所有调用，visit(node, calleeText)。 */
export function eachCall(ctx, file, visit) {
    walk(ctx.ts, file.sf, n => { if (ctx.ts.isCallExpression(n)) visit(n, callee(ctx.ts, n)); });
}

/** 解构写法里绑定出来的全部变量名。 */
export function bindingNames(ts, name, out = []) {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(ts, el.name, out);
    }
    return out;
}

/**
 * ident 是不是在「读一个变量」：`x.rows` 的 rows、`{ rows: n }` 的键只是名字，不是对变量 rows 的引用。
 * 简写属性 `{ rows }` 读的就是变量，算引用。
 */
export function isReference(ts, ident) {
    const p = ident.parent;
    if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === ident) return false;
    return true;
}

/**
 * 从 node 往上到 fn（不含）之间，有没有哪个函数的参数也叫 name：`list.map(rows => log(rows))` 里的
 * rows 是回调参数，不是外层的查询结果。已知盲区：内层块里 `const rows = …` 的遮蔽不处理（少见，且只会多报 normal）。
 */
export function shadowedByParam(ts, node, fn, name) {
    for (let p = node.parent; p && p !== fn; p = p.parent) {
        if (ts.isFunctionLike(p) && p.parameters?.some(prm => bindingNames(ts, prm.name).includes(name))) return true;
    }
    return false;
}

/** 包住 node 的最近一层函数（含箭头函数、方法）；顶层代码 → null。 */
export function enclosingFunction(ts, node) {
    for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
    return null;
}
