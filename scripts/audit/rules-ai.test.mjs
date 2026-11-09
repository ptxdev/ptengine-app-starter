import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAudit } from './run.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const V2 = (backend = {}) => ({ schemaVersion: 2, backend: { egress: [], ...backend } });
const JOBS = V2({ jobs: [{ name: 'daily', schedule: '0 1 * * *', route: '/jobs/daily' }] });

/** 临时项目：files 是 { 相对路径: 内容 }，manifest 写进 manifest.json。 */
function fixture(manifest, files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-ai-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}

/** 只看某条规则命中的行号。 */
async function lines(rule, manifest, files) {
    const { findings } = await runAudit({ root: fixture(manifest, files) });
    return findings.filter(f => f.rule === rule).map(f => [f.file, f.line]);
}

/** 拼一个 createApp 后端：routes 是 { 路由键: 处理函数源码 }。 */
const app = routes => [
    "import { createApp } from '@ptengine/app-backend';",
    'export default createApp({',
    '  routes: {',
    ...Object.entries(routes).map(([k, v]) => `    '${k}': ${v},`),
    '  }',
    '});'
].join('\n') + '\n';

// ─── AI-001 ───
test('AI-001：for-of 体内、map 回调里的 AI 调用命中', async () => {
    const h = await lines('AI-001', V2(), {
        'backend/src/a.ts': [
            'async function f(ctx, rows) {',
            '  for (const r of rows) {',
            '    await ctx.pt.ai.chat({ messages: [] });',
            '  }',
            '  await Promise.all(rows.map(r => pt.ai.stream({ messages: [] })));',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, [['backend/src/a.ts', 3], ['backend/src/a.ts', 5]]);
});

test('AI-001：不命中 —— 循环外调用、rows.map(r => r.id) 之后再调用、mail.chat', async () => {
    const h = await lines('AI-001', V2(), {
        'backend/src/a.ts': [
            'async function f(ctx, rows) {',
            '  const ids = rows.map(r => r.id);',
            '  await ctx.pt.ai.chat({ messages: [{ role: "user", content: ids.join(",") }] });',
            '  for (const m of rows) await mail.chat(m);',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

// ─── AI-002 ───
test('AI-002：任务路由里调 AI 且没有上限 → 命中', async () => {
    const h = await lines('AI-002', JOBS, {
        'backend/src/index.ts': app({
            'POST /jobs/daily': 'async (req, ctx) => {\n      const sites = await load();\n      return ctx.pt.ai.chat({ messages: sites, max_tokens: 100 });\n    }'
        })
    });
    assert.deepEqual(h, [['backend/src/index.ts', 6]]);
});

test('AI-002：不命中 —— .slice / MAX_ 常量 / if (n < 10) 任一存在，或不是任务路由', async () => {
    const body = cap => `async (req, ctx) => {\n      ${cap}\n      return ctx.pt.ai.chat({ messages: [], max_tokens: 1 });\n    }`;
    for (const cap of ['const s = all.slice(0, 20);', 'const n = Math.min(all.length, MAX_SITES);', 'if (count <= 10) {}', 'const x = DAILY_LIMIT;']) {
        const h = await lines('AI-002', JOBS, { 'backend/src/index.ts': app({ 'POST /jobs/daily': body(cap) }) });
        assert.deepEqual(h, [], cap);
    }
    const h = await lines('AI-002', JOBS, { 'backend/src/index.ts': app({ 'POST /api/ask': body('') }) });
    assert.deepEqual(h, []);
    // manifest 没有 jobs：规则不跑
    const h2 = await lines('AI-002', V2(), { 'backend/src/index.ts': app({ 'POST /jobs/daily': body('') }) });
    assert.deepEqual(h2, []);
});

// ─── AI-003 ───
test('AI-003：对象字面量缺 max_tokens 命中', async () => {
    const h = await lines('AI-003', V2(), {
        'backend/src/a.ts': 'await ctx.pt.ai.chat({ messages: [] });\nawait ai.chat({ messages: [], maxTokens: 10 });\n'
    });
    assert.deepEqual(h, [['backend/src/a.ts', 1], ['backend/src/a.ts', 2]]);
});

test('AI-003：不命中 —— 有 max_tokens、实参是变量、有展开', async () => {
    const h = await lines('AI-003', V2(), {
        'backend/src/a.ts': 'await ctx.pt.ai.chat({ messages: [], max_tokens: 200 });\nawait ctx.pt.ai.chat(opts);\nawait ctx.pt.ai.chat({ ...base, messages: [] });\n'
    });
    assert.deepEqual(h, []);
});

// ─── AI-004 ───
test('AI-004：模板 / + 拼接里直接塞 rows、JSON.stringify(data) 命中', async () => {
    const h = await lines('AI-004', V2(), {
        'backend/src/a.ts': [
            'await ctx.pt.ai.chat({ max_tokens: 1, messages: [',
            '  { role: "user", content: `数据：${rows}` },',
            '  { role: "user", content: "数据：" + JSON.stringify(data) }',
            '] });'
        ].join('\n')
    });
    assert.deepEqual(h, [['backend/src/a.ts', 2], ['backend/src/a.ts', 3]]);
});

test('AI-004：带引号的 "messages" / "content" 键一样认', async () => {
    const h = await lines('AI-004', V2(), {
        'backend/src/a.ts': 'await ctx.pt.ai.chat({ max_tokens: 1, "messages": [{ role: "user", \'content\': `数据：${records}` }] });\n'
    });
    assert.deepEqual(h, [['backend/src/a.ts', 1]]);
});

test('AI-004：不命中 —— 截断过、别的变量名、属性访问', async () => {
    const h = await lines('AI-004', V2(), {
        'backend/src/a.ts': [
            'await ctx.pt.ai.chat({ max_tokens: 1, messages: [',
            '  { role: "user", content: `数据：${JSON.stringify(rows.slice(0, 50))}` },',
            '  { role: "user", content: `问题：${question}` },',
            '  { role: "user", content: "总数" + result.total },',
            '  { role: "user", content: prompt }',
            '] });'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

// ─── AI-005 ───
test('AI-005：同一函数里第二次调用不依赖第一次 → 命中第二处', async () => {
    const h = await lines('AI-005', V2(), {
        'backend/src/a.ts': [
            'async function f(ctx) {',
            '  const a = await ctx.pt.ai.chat({ messages: [{ role: "user", content: "x" }] });',
            '  const b = await ctx.pt.ai.chat({ messages: [{ role: "user", content: "y" }] });',
            '  return [a, b];',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, [['backend/src/a.ts', 3]]);
});

test('AI-005：同一条 return 里的 Promise.all 两次调用照样命中第二处', async () => {
    const h = await lines('AI-005', V2(), {
        'backend/src/a.ts': 'async function f(ctx) {\n  return Promise.all([\n    ctx.pt.ai.chat({ messages: [] }),\n    ctx.pt.ai.chat({ messages: [] })\n  ]);\n}\n'
    });
    assert.deepEqual(h, [['backend/src/a.ts', 4]]);
});

test('AI-005：不命中 —— 第二次用了第一次的结果（含转手变量、push 进 history、嵌套）、if/else 两支、提前 return、try/catch 兜底、?? 兜底、不同函数', async () => {
    const h = await lines('AI-005', V2(), {
        'backend/src/a.ts': [
            'async function f(ctx) {',
            '  const first = await ctx.pt.ai.chat({ messages: [] });',
            '  const text = first.content;',
            '  return ctx.pt.ai.chat({ messages: [{ role: "user", content: text }] });',
            '}',
            'async function g(ctx, x) {',
            '  if (x) return ctx.pt.ai.chat({ messages: [] });',
            '  else return ctx.pt.ai.chat({ messages: [] });',
            '}',
            'async function h(ctx, x) {',
            '  if (x) return ctx.pt.ai.chat({ messages: [] });',
            '  return ctx.pt.ai.chat({ messages: [] });',
            '}',
            'async function k(ctx) { return ctx.pt.ai.chat({ messages: [] }); }',
            'async function t(ctx) {',
            '  let r;',
            '  try { r = await ctx.pt.ai.chat({ messages: [] }); }',
            '  catch { r = await ctx.pt.ai.chat({ messages: [] }); }',
            '  return r;',
            '}',
            'async function n(ctx) {',
            '  return (await ctx.pt.ai.chat({ messages: [] })) ?? (await ctx.pt.ai.chat({ messages: [] }));',
            '}',
            'async function o(ctx, x) {',
            '  return ctx.pt.ai.chat({ messages: [{ role: "user", content: (await ctx.pt.ai.chat({ messages: x })).content }] });',
            '}',
            'async function m(ctx, history) {',
            '  const reply = await ctx.pt.ai.chat({ messages: history });',
            '  history.push({ role: "assistant", content: reply.content });',
            '  return ctx.pt.ai.chat({ messages: history });',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

// ─── AI-006 ───
test('AI-006：useEffect 无依赖 / 依赖含标识符且里面 fetch；onChange 里直接 api.call → 命中', async () => {
    const h = await lines('AI-006', V2(), {
        'web/src/App.tsx': [
            'export function App({ q }) {',
            '  useEffect(() => { fetch("/api/ask"); });',
            '  useEffect(() => { const load = async () => { await PtApp.api.call("/ask"); }; load(); }, [q]);',
            '  return <input onChange={e => callApi("/ask", e.target.value)} />;',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, [['web/src/App.tsx', 2], ['web/src/App.tsx', 3], ['web/src/App.tsx', 4]]);
});

test('AI-006：不命中 —— 依赖 []、onChange 走 debounce、后端文件、effect 里只 setState', async () => {
    const h = await lines('AI-006', V2(), {
        'web/src/App.tsx': [
            'export function App({ q }) {',
            '  useEffect(() => { fetch("/api/ask"); }, []);',
            '  useEffect(() => { setX(q); }, [q]);',
            '  useEffect(() => { const t = setTimeout(() => fetch("/api/ask"), 300); return () => clearTimeout(t); }, [q]);',
            '  return <input onChange={e => debounced(() => fetch("/api/ask"))} />;',
            '}'
        ].join('\n'),
        'backend/src/a.ts': 'useEffect(() => { fetch("/x"); });\n'
    });
    assert.deepEqual(h, []);
});

// ─── AI-007 ───
test('AI-007：用户路由里的 AI 调用没 signal 也没 AbortSignal.timeout → 命中', async () => {
    const h = await lines('AI-007', JOBS, {
        'backend/src/index.ts': app({
            'POST /api/ask': 'async (req, ctx) => ctx.pt.ai.chat({ messages: [], max_tokens: 1 })'
        })
    });
    assert.deepEqual(h, [['backend/src/index.ts', 4]]);
});

test('AI-007：不命中 —— 有 signal、有 AbortSignal.timeout、任务路由、不在路由里', async () => {
    const h = await lines('AI-007', JOBS, {
        'backend/src/index.ts': app({
            'POST /api/a': 'async (req, ctx) => ctx.pt.ai.chat({ messages: [], signal: req.signal })',
            'POST /api/b': 'async (req, ctx) => {\n      const s = AbortSignal.timeout(20000);\n      return ctx.pt.ai.chat({ messages: [], s });\n    }',
            'POST /jobs/daily': 'async (req, ctx) => ctx.pt.ai.chat({ messages: [] })'
        }),
        'backend/src/helper.ts': 'export const ask = ctx => ctx.pt.ai.chat({ messages: [] });\n'
    });
    assert.deepEqual(h, []);
});
