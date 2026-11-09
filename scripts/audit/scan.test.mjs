import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectFiles, loadTs, parseFile, walk, callee, insideLoop, loopVariables, enclosingRouteKey, lineOf, stringLiteralsIn } from './scan.mjs';
import { runAudit, runRules } from './run.mjs';

/** 临时项目：files 是 { 相对路径: 内容 }。 */
function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-scan-'));
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}

// 临时目录里没有 node_modules：loadTs 要回退到脚本旁的 typescript，顺带把回退测了
const tsRoot = mkdtempSync(join(tmpdir(), 'ptx-audit-ts-'));
after(() => rmSync(tsRoot, { recursive: true, force: true }));
const ts = loadTs(tsRoot);

/** 把一段代码解析成语法树，返回所有满足 pred 的节点。 */
function nodesOf(code, pred, rel = 'backend/src/x.ts') {
    const root = fixture({ [rel]: code });
    try {
        const { sf } = parseFile(ts, { abs: join(root, rel), rel });
        const out = [];
        walk(ts, sf, n => { if (pred(n)) out.push(n); });
        return { sf, nodes: out };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}
const callsNamed = (code, name) => nodesOf(code, n => ts.isCallExpression(n) && callee(ts, n) === name);

test('collectFiles：缺省三目录、跳过 node_modules/dist、area 按首段、unscanned 按扩展名去重', () => {
    const root = fixture({
        'web/src/a.tsx': 'export const a = 1;',
        'backend/src/b.ts': 'export const b = 1;',
        'shared/c.ts': 'export const c = 1;',
        'web/node_modules/x.js': 'x',
        'web/src/node_modules/y.js': 'y',
        'web/src/dist/z.js': 'z',
        'web/src/readme.md': '#',
        'tools/t.py': 'print(1)',
        'tools/u.py': 'print(2)'
    });
    try {
        const { files, unscanned } = collectFiles(root, undefined);
        assert.deepEqual(files.map(f => f.rel).sort(), ['backend/src/b.ts', 'shared/c.ts', 'web/src/a.tsx']);
        const area = Object.fromEntries(files.map(f => [f.rel, f.area]));
        assert.deepEqual(area, { 'backend/src/b.ts': 'backend', 'shared/c.ts': 'shared', 'web/src/a.tsx': 'web' });
        assert.ok(files.every(f => f.abs === join(root, f.rel)));
        assert.deepEqual(unscanned, ['.py']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('collectFiles：--src 给了就只扫给的', () => {
    const root = fixture({
        'web/src/a.tsx': 'export const a = 1;',
        'backend/src/b.ts': 'export const b = 1;',
        'tools/gen.mjs': 'export {}'
    });
    try {
        assert.deepEqual(collectFiles(root, ['web/src']).files.map(f => f.rel), ['web/src/a.tsx']);
        const other = collectFiles(root, ['./tools/']).files;
        assert.deepEqual(other.map(f => [f.rel, f.area]), [['tools/gen.mjs', 'other']]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('collectFiles：unscanned 不数隐藏目录与虚拟环境、缓存、构建产物里的文件', () => {
    const root = fixture({
        'web/src/a.tsx': 'export const a = 1;',
        '.cache/x.py': 'x',
        'venv/lib/y.py': 'y',
        'tools/.venv/lib/z.py': 'z',
        'tools/__pycache__/w.py': 'w',
        'coverage/v.go': 'v',
        'build/b.rb': 'b',
        'tools/real.php': '<?php'
    });
    try {
        assert.deepEqual(collectFiles(root, undefined).unscanned, ['.php']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('runAudit：显式给的 --src 目录不存在就抛错（CLI 退出 3），不静默给一个空的 ok', async () => {
    const root = fixture({ 'web/src/a.tsx': 'export const a = 1;' });
    try {
        await assert.rejects(runAudit({ root, src: ['web/scr'] }), { message: '扫描目录不存在：web/scr' });
        // 缺省目录缺了照旧跳过：没有后端的项目本来就没有 backend/src
        assert.deepEqual((await runAudit({ root })).scanned, ['web/src']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('parseFile：语法错误返回 null，正常返回 sf', () => {
    const root = fixture({ 'web/src/ok.tsx': 'export const A = () => <div>{1}</div>;', 'web/src/bad.ts': 'const = ;' });
    try {
        const ok = parseFile(ts, { abs: join(root, 'web/src/ok.tsx'), rel: 'web/src/ok.tsx' });
        assert.ok(ok?.sf);
        assert.equal(ok.text, 'export const A = () => <div>{1}</div>;');
        assert.equal(parseFile(ts, { abs: join(root, 'web/src/bad.ts'), rel: 'web/src/bad.ts' }), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('callee：ctx.pt.ai.chat(...) → "ctx.pt.ai.chat"；fetch(...) → "fetch"；非调用 → null', () => {
    const { nodes } = nodesOf('ctx.pt.ai.chat({}); fetch("/x"); this.load(); const v = a.b;',
        n => ts.isCallExpression(n) || ts.isPropertyAccessExpression(n));
    const calls = nodes.filter(n => ts.isCallExpression(n)).map(n => callee(ts, n));
    assert.deepEqual(calls, ['ctx.pt.ai.chat', 'fetch', 'this.load']);
    const access = nodes.find(n => ts.isPropertyAccessExpression(n) && n.getText() === 'a.b');
    assert.equal(callee(ts, access), null);
});

test('insideLoop：for-of 体内 true；rows.map(r => f(r)) 内 true；rows.map(r=>r.id) 之后的调用 false；普通函数声明内的调用 false', () => {
    const at = (code) => callsNamed(code, 'f').nodes.map(n => insideLoop(ts, n));
    assert.deepEqual(at('for (const r of rows) { f(r); }'), [true]);
    assert.deepEqual(at('while (x) f();'), [true]);
    assert.deepEqual(at('rows.map(r => f(r));'), [true]);
    assert.deepEqual(at('rows.forEach(function (r) { if (r) { f(r); } });'), [true]);
    assert.deepEqual(at('const ids = rows.map(r => r.id); await f(ids);'), [false]);
    assert.deepEqual(at('for (const r of rows) { function g() { f(); } }'), [false]);
    assert.deepEqual(at('for (const r of await f()) {}'), [false]);
    assert.deepEqual(at('rows.map(r => { const h = () => f(); return h; });'), [false]);
    assert.deepEqual(at('f();'), [false]);
});

test('loopVariables：for-of / for-in 声明名（含解构）、回调元素形参（reduce 取第二个）；for(;;) 跳过往上找；函数边界停', () => {
    const at = (code) => callsNamed(code, 'f').nodes.map(n => loopVariables(ts, n));
    assert.deepEqual(at('for (const { a, b: [c] } of rows) { f(); }'), [['a', 'c']]);
    assert.deepEqual(at('for (k in obj) f();'), [['k']]);
    assert.deepEqual(at('rows.map((r, i) => f());'), [['r']]);
    assert.deepEqual(at('rows.reduce((acc, r) => f(), 0);'), [['r']]);
    assert.deepEqual(at('for (const r of rows) { for (let i = 0; i < 3; i++) f(); }'), [['r']]);
    assert.deepEqual(at('for (const r of f()) {}'), [[]]);
    assert.deepEqual(at('for (const r of rows) { const g = () => f(); }'), [[]]);
    assert.deepEqual(at('while (x) f();'), [[]]);
});

test('enclosingRouteKey：createApp({ routes: { "POST /jobs/daily": async ctx => { f() } } }) 里的 f() → "POST /jobs/daily"', () => {
    const code = `
export default createApp({
  routes: {
    "POST /jobs/daily": async ctx => { if (ctx) { f(); } },
    'GET /x': async ctx => ({ v: { w: f() } }),
  },
});
other({ routes: { "GET /y": () => f() } });
f();`;
    const keys = callsNamed(code, 'f').nodes.map(n => enclosingRouteKey(ts, n));
    assert.deepEqual(keys, ['POST /jobs/daily', 'GET /x', null, null]);
});

test('lineOf 与 stringLiteralsIn', () => {
    const { sf, nodes } = callsNamed('const a = 1;\n\nf("x", `y`, `z${a}`, 2);', 'f');
    assert.equal(lineOf(sf, nodes[0]), 3);
    assert.deepEqual(stringLiteralsIn(ts, nodes[0]).map(s => s.text), ['x', 'y']);
});

test('runAudit：没有 manifest.json 也能跑，返回 scanned 与空 findings；语法错误文件进 unparsed', async () => {
    const root = fixture({ 'web/src/a.tsx': 'export const a = 1;', 'web/src/bad.ts': 'const = ;', 'shared/c.ts': 'export {}' });
    try {
        const r = await runAudit({ root });
        assert.deepEqual(r.findings, []);
        assert.deepEqual(r.scanned, ['web/src', 'shared']);
        assert.deepEqual(r.unscanned, []);
        assert.deepEqual(r.unparsed, ['web/src/bad.ts']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('runRules：同 rule+file+line 只留一条；出错的规则跳过、其余照跑', () => {
    const rules = [
        { id: 'SEC-004', check: () => [{ rule: 'SEC-004', file: 'a.ts', line: 1 }, { rule: 'SEC-004', file: 'a.ts', line: 1 }, { rule: 'SEC-004', file: 'a.ts', line: 2 }] },
        { id: 'AI-001', check: () => { throw new Error('boom'); } },
        { id: 'AI-003', check: () => [{ rule: 'AI-003', file: 'a.ts', line: 1 }] }
    ];
    const errors = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { errors.push(String(s)); return true; };
    let findings;
    try {
        findings = runRules({}, rules);
    } finally {
        process.stderr.write = orig;
    }
    assert.deepEqual(findings.map(f => `${f.rule}:${f.line}`), ['SEC-004:1', 'SEC-004:2', 'AI-003:1']);
    assert.deepEqual(errors, ['[audit] 规则 AI-001 出错：boom\n']);
});
