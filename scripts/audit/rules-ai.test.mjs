import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAudit } from './run.mjs';
import { validateManifest } from '../manifest.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// manifest 用真实形状（与 AGENTS.md 的 backend.jobs 示例一致：route 带方法），fixture() 里先过一遍 validateManifest，防止以后漂
const V2 = (backend = {}, extra = {}) => ({
    schemaVersion: 2, version: '1.0.0', entry: 'index.html', ...extra,
    backend: { entry: '_backend/worker.js', routes: ['/api/*'], egress: [], ...backend }
});
const JOBS = V2({ jobs: [{ type: 'daily', route: 'POST /jobs/daily', title: '日报', defaultCron: '0 1 * * *' }] }, { scopes: ['jobs:run'] });
/** 兼容：route 没写方法的旧写法，按路径比。 */
const JOBS_PATH_ONLY = V2({ jobs: [{ type: 'daily', route: '/jobs/daily', title: '日报' }] }, { scopes: ['jobs:run'] });

/** 临时项目：files 是 { 相对路径: 内容 }，manifest 写进 manifest.json。 */
function fixture(manifest, files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-ai-'));
    roots.push(root);
    const { errors } = validateManifest(manifest, root);
    assert.deepEqual(errors, [], 'fixture 的 manifest 必须是平台认的形状');
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

test('AI-001：不命中 —— 循环对象先用 .slice(0, 数字 / MAX_ 常量) 截断过（fix 推荐的写法）', async () => {
    const h = await lines('AI-001', V2(), {
        'backend/src/a.ts': [
            'const MAX_ITEMS = 20;',
            'async function f(ctx, rows) {',
            '  for (const r of rows.slice(0, MAX_ITEMS)) await ctx.pt.ai.chat({ messages: [] });',
            '  await Promise.all(rows.slice(0, 5).map(r => ctx.pt.ai.chat({ messages: [] })));',
            '  rows.slice(0, DAILY_LIMIT).filter(r => r.ok).forEach(r => ctx.pt.ai.chat({ messages: [] }));',
            '  const top = rows.slice(0, 10);',
            '  for (const r of top) await ctx.pt.ai.chat({ messages: [] });',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

test('AI-001：截断不算数时照报 —— slice 上限是变量、外层还有一层没截断的循环、while', async () => {
    const h = await lines('AI-001', V2(), {
        'backend/src/a.ts': [
            'async function f(ctx, rows, sites, n) {',
            '  for (const r of rows.slice(0, n)) await ctx.pt.ai.chat({ messages: [] });',
            '  for (const s of sites) for (const r of s.rows.slice(0, 5)) await ctx.pt.ai.chat({ messages: [] });',
            '  while (more()) await ctx.pt.ai.chat({ messages: [] });',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, [['backend/src/a.ts', 2], ['backend/src/a.ts', 3], ['backend/src/a.ts', 4]]);
});

test('AI-001：照报 —— 别的函数里同名的截断 const 不算（参数遮蔽）、接收者链上有 flatMap', async () => {
    const h = await lines('AI-001', V2(), {
        'backend/src/a.ts': [
            'function prep(rows) { const top = rows.slice(0, 10); return top; }',
            'async function run(ctx, top) {',
            '  for (const r of top) await ctx.pt.ai.chat({ messages: [] });',
            '}',
            'async function g(ctx, sites) {',
            '  await Promise.all(sites.slice(0, 5).flatMap(s => s.pages).map(p => ctx.pt.ai.chat({ messages: [] })));',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, [['backend/src/a.ts', 3], ['backend/src/a.ts', 6]]);
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

test('AI-002：manifest 的 route 没写方法（旧写法）也按路径认出任务路由', async () => {
    const h = await lines('AI-002', JOBS_PATH_ONLY, {
        'backend/src/index.ts': app({
            'POST /jobs/daily': 'async (req, ctx) => ctx.pt.ai.chat({ messages: [], max_tokens: 100 })'
        })
    });
    assert.deepEqual(h, [['backend/src/index.ts', 4]]);
});

test('AI-002：方法不同的同路径路由不是任务路由（manifest 写的是 POST）', async () => {
    const h = await lines('AI-002', JOBS, {
        'backend/src/index.ts': app({
            'GET /jobs/daily': 'async (req, ctx) => ctx.pt.ai.chat({ messages: [], max_tokens: 100 })'
        })
    });
    assert.deepEqual(h, []);
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

test('AI-002：BATCH_SIZE 这类名字不算上限（fix 文案里明说了，两边要一致）', async () => {
    const h = await lines('AI-002', JOBS, {
        'backend/src/index.ts': app({
            'POST /jobs/daily': 'async (req, ctx) => {\n      const n = BATCH_SIZE;\n      return ctx.pt.ai.chat({ messages: [], max_tokens: 1 });\n    }'
        })
    });
    assert.deepEqual(h, [['backend/src/index.ts', 6]]);
});

test('AI-002：名字中间带 MAX_ 的常量也算上限（如 DAILY_MAX_ITEMS）', async () => {
    const h = await lines('AI-002', JOBS, {
        'backend/src/index.ts': [
            'const DAILY_MAX_ITEMS = 20;',
            app({
                'POST /jobs/daily': 'async (req, ctx) => {\n      let n = 0;\n      for (const r of rows) { if (n++ >= DAILY_MAX_ITEMS) break; await ctx.pt.ai.chat({ messages: [], max_tokens: 1 }); }\n    }'
            })
        ].join('\n')
    });
    assert.deepEqual(h, []);
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
test('AI-006：useEffect 没有依赖数组且里面请求（含嵌套的 load）；onChange 里直接 api.call → 命中', async () => {
    const h = await lines('AI-006', V2(), {
        'web/src/App.tsx': [
            'export function App({ q }) {',
            '  useEffect(() => { fetch("/api/ask"); });',
            '  useEffect(() => { const load = async () => { await PtApp.api.call("/ask"); }; load(); });',
            '  return <input onChange={e => callApi("/ask", e.target.value)} />;',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, [['web/src/App.tsx', 2], ['web/src/App.tsx', 3], ['web/src/App.tsx', 4]]);
});

test('AI-006：不命中 —— 有依赖数组（[] / [page] / [q]）、onChange 走 debounce、后端文件、effect 里只 setState', async () => {
    const h = await lines('AI-006', V2(), {
        'web/src/App.tsx': [
            'export function App({ q, page }) {',
            '  useEffect(() => { fetch("/api/ask"); }, []);',
            '  useEffect(() => { fetch(`/api/list?page=${page}`); }, [page]);',
            '  useEffect(() => { const load = async () => { await PtApp.api.call("/ask"); }; load(); }, [q]);',
            '  useEffect(() => { setX(q); });',
            '  return <input onChange={e => debounced(() => fetch("/api/ask"))} />;',
            '}'
        ].join('\n'),
        'backend/src/a.ts': 'useEffect(() => { fetch("/x"); });\n'
    });
    assert.deepEqual(h, []);
});

test('AI-006：不命中 —— 无依赖 effect 里只有 setTimeout 回调、return 的清理函数、addEventListener 回调里请求', async () => {
    const h = await lines('AI-006', V2(), {
        'web/src/App.tsx': [
            'export function App() {',
            '  useEffect(() => { const t = setTimeout(() => fetch("/api/ask"), 300); return () => clearTimeout(t); });',
            '  useEffect(() => { return () => { fetch("/api/leave"); }; });',
            '  useEffect(() => { const on = () => fetch("/api/ping"); window.addEventListener("focus", on); el.addEventListener("click", () => fetch("/api/x")); return () => window.removeEventListener("focus", on); });',
            '  return null;',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

// ─── AI-007 ───
// AI-007 暂停：app-backend 0.10.0 的 ctx.pt.ai.chat 不支持 signal（会被序列化透传给网关），规则 check 恒返回空。
// SDK 支持超时参数后恢复检测，届时把下面这条改回「命中」。
test('AI-007（暂停）：用户路由里的 AI 调用没 signal 也不报', async () => {
    const h = await lines('AI-007', JOBS, {
        'backend/src/index.ts': app({
            'POST /api/ask': 'async (req, ctx) => ctx.pt.ai.chat({ messages: [], max_tokens: 1 })'
        })
    });
    assert.deepEqual(h, []);
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
