import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAudit } from './run.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const WITH_BACKEND = scopes => ({ schemaVersion: 2, scopes, backend: { egress: [] } });
const WEB_ONLY = scopes => ({ schemaVersion: 1, scopes });

/** 临时项目：manifest 为 null 时不写 manifest.json；files 是 { 相对路径: 内容 }。 */
function fixture(manifest, files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-des-'));
    roots.push(root);
    if (manifest) writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}

async function hits(rule, manifest, files) {
    const { findings } = await runAudit({ root: fixture(manifest, files) });
    return findings.filter(f => f.rule === rule);
}

/** [文件, 行号, scope]：DES-001 要连 scope 一起比。 */
const scoped = async (manifest, files) => (await hits('DES-001', manifest, files)).map(f => [f.file, f.line, f.args?.scope]);
const lines = async (rule, manifest, files) => (await hits(rule, manifest, files)).map(f => [f.file, f.line]);

const src = (...ls) => ls.join('\n') + '\n';
/** 前端有调用后端的写法，免得 DES-002 干扰别的用例的输出（各用例只过滤自己的规则，这里只是让夹具像真项目）。 */
const WEB_CALLS_API = { 'web/src/main.ts': 'fetch("/api/ping");\n' };

// ─── DES-001 ───
test('DES-001：声明了但源码没用 → manifest.json:0；analytics:read 等不查', async () => {
    const h = await scoped(WITH_BACKEND(['analytics:read', 'ui:notify', 'ai:invoke', 'asset:read']), {
        ...WEB_CALLS_API,
        'backend/src/index.ts': src(
            'export default createApp({ routes: {',
            '  "GET /x": async ctx => ctx.json(await ctx.pt.asset.list({ type: "page" })),',
            '} });'
        )
    });
    assert.deepEqual(h, [['manifest.json', 0, 'ai:invoke']]);
});

test('DES-001：用了但没声明 → 首次出现处（各 scope 一条）；requireScope 的字面量也算使用', async () => {
    const h = await scoped(WITH_BACKEND(['analytics:read']), {
        ...WEB_CALLS_API,
        'backend/src/index.ts': src(
            'export default createApp({ routes: {',
            '  "POST /a": async ctx => {',
            '    ctx.requireTrigger("job");',
            '    const r = await ctx.pt.ai.chat({ model: "m", messages: [] });',
            '    await ctx.pt.ai.chat({ model: "m", messages: [] });',
            '    await ctx.pt.notify.send({ text: "x" });',
            '    await ctx.pt.asset.uploadSource(f);',
            '    const u = ctx.pt.openApiUrl;',
            '    ctx.requireScope("asset:read");',
            '    return ctx.json(r);',
            '  },',
            '} });'
        )
    });
    assert.deepEqual(h.sort((a, b) => a[1] - b[1]), [
        ['backend/src/index.ts', 3, 'jobs:run'],
        ['backend/src/index.ts', 4, 'ai:invoke'],
        ['backend/src/index.ts', 6, 'notify:send'],
        ['backend/src/index.ts', 7, 'asset:write'],
        ['backend/src/index.ts', 8, 'openapi:read'],
        ['backend/src/index.ts', 9, 'asset:read']
    ]);
});

test('DES-001：不命中 —— 声明与使用一致、注释里的字样、ctx.pt 被转手或解构时不报「未使用」、没有 manifest', async () => {
    const backend = src(
        'export default createApp({ routes: {',
        '  "POST /a": async ctx => {',
        '    ctx.requireTrigger("job");',
        '    // ctx.pt.notify.send 以后再加',
        '    const r = await ctx.pt.ai.chat({});',
        '    return ctx.json(await ctx.pt.asset.get("id"), r);',
        '  },',
        '} });'
    );
    assert.deepEqual(await scoped(WITH_BACKEND(['ai:invoke', 'jobs:run', 'asset:read']), { ...WEB_CALLS_API, 'backend/src/index.ts': backend }), []);
    // 解构 / 转手后认不出调用：拿不准就不报「声明了没用」
    for (const body of [
        'const { ai } = ctx.pt; await ai.chat({});',
        'await helper(ctx.pt);',
        'const n = ctx.pt.notify; await n.send({});',
        'await c.pt.ai.chat({});'
    ]) {
        const h = await scoped(WITH_BACKEND(['ai:invoke', 'notify:send']), {
            ...WEB_CALLS_API,
            'backend/src/index.ts': src('export async function h(ctx, c) {', `  ${body}`, '}')
        });
        assert.deepEqual(h, [], body);
    }
    // 处理函数参数解构出 pt
    assert.deepEqual(await scoped(WITH_BACKEND(['ai:invoke']), {
        ...WEB_CALLS_API,
        'backend/src/index.ts': 'export const h = async ({ pt }) => pt.ai.chat({});\n'
    }), []);
    // asset:read 只在前端经 PtApp.asset 用、notify:send 只用 ctx.pt.render.chart：都算在用
    assert.deepEqual(await scoped(WITH_BACKEND(['asset:read', 'notify:send']), {
        'web/src/a.ts': 'fetch("/api/x"); await window.PtApp.asset.list({ type: "page" });\n',
        'backend/src/index.ts': 'export async function h(ctx) { return ctx.pt.render.chart({}); }\n'
    }), []);
    // 这些额外写法只用来放过「声明了没用」，不会反过来报「用了未声明」
    assert.deepEqual(await scoped(WITH_BACKEND([]), {
        'web/src/a.ts': 'fetch("/api/x"); await PtApp.asset.get("id");\n',
        'backend/src/index.ts': 'export async function h(ctx) { return ctx.pt.render.chart({}); }\n'
    }), []);
    // 只扫了前端（没有后端文件）时不报「声明了没用」
    assert.deepEqual(await scoped(WEB_ONLY(['ai:invoke']), { 'web/src/a.ts': 'export const x = 1;\n' }), []);
    // 没有 manifest：整条不跑
    assert.deepEqual(await scoped(null, { 'backend/src/index.ts': 'await ctx.pt.ai.chat({});\n' }), []);
});

// ─── DES-002 ───
test('DES-002：有后端但前端从不调 /api/ → manifest.json:0', async () => {
    const h = await lines('DES-002', WITH_BACKEND([]), {
        'web/src/App.tsx': 'export const App = () => <div>{"/apis/x"}</div>;\n',
        'backend/src/index.ts': 'export default {};\n'
    });
    assert.deepEqual(h, [['manifest.json', 0]]);
});

test('DES-002：没后端但前端 fetch("/api/…") → 首次出现处', async () => {
    const h = await lines('DES-002', WEB_ONLY([]), {
        'web/src/a.ts': src('const x = 1;', 'fetch(`/api/orders`).then(r => r.json());', 'fetch("/api/b");')
    });
    assert.deepEqual(h, [['web/src/a.ts', 2]]);
});

test('DES-002：不命中 —— 前端有 /api/ 字面量、`/api${p}` 模板、api.call / callApi；没后端也没 fetch /api/；没有 manifest', async () => {
    for (const web of [
        'const u = "/api/orders";\n',
        'export const get = p => fetch(`/api${p}`);\n',
        'client.api.call("orders");\n',
        'callApi("orders");\n',
        'const BASE = "/api"; fetch(BASE + "/orders");\n'
    ]) {
        assert.deepEqual(await lines('DES-002', WITH_BACKEND([]), { 'web/src/a.ts': web, 'backend/src/index.ts': 'export default {};\n' }), [], web);
    }
    assert.deepEqual(await lines('DES-002', WEB_ONLY([]), { 'web/src/a.ts': 'fetch("https://x.com/api/a"); const u = "/api/doc";\n' }), []);
    assert.deepEqual(await lines('DES-002', null, { 'web/src/a.ts': 'fetch("/api/a");\n' }), []);
});

// ─── DES-003 ───
test('DES-003：组件里 fetch().then 没有 catch、await 不在 try 且没有错误状态 → 命中', async () => {
    const h = await lines('DES-003', WEB_ONLY([]), {
        'web/src/A.tsx': src(
            'import { useEffect, useState } from "react";',
            'export function A() {',
            '  const [rows, setRows] = useState([]);',
            '  useEffect(() => {',
            '    fetch("/x").then(r => r.json()).then(setRows);',
            '  }, []);',
            '  return <ul>{rows.length}</ul>;',
            '}',
            'export const B = () => {',
            '  const [rows, setRows] = useState([]);',
            '  useEffect(() => { (async () => { setRows(await client.api.list()); })(); }, []);',
            '  return rows.length ? <ul /> : null;',
            '};',
            'export function C() {',
            '  useEffect(() => { void fetch("/x").then(r => r.json()); }, []);',
            '  return <div />;',
            '}'
        )
    });
    assert.deepEqual(h, [['web/src/A.tsx', 5], ['web/src/A.tsx', 11], ['web/src/A.tsx', 15]]);
});

test('DES-003：不命中 —— 有 catch / then 第二参、链被返回或 await、await 在 try 里、有 error 状态、不是组件、后端文件', async () => {
    const h = await lines('DES-003', WEB_ONLY([]), {
        'web/src/A.tsx': src(
            'export function A() {',
            '  useEffect(() => { fetch("/x").then(r => r.json()).catch(() => {}); }, []);',
            '  useEffect(() => { fetch("/x").then(ok, fail); }, []);',
            '  const load = () => fetch("/x").then(r => r.json());',
            '  useEffect(() => { (async () => { try { await fetch("/x"); } catch {} })(); }, []);',
            '  return <div />;',
            '}',
            'export function B() {',
            '  const [loadErr, setLoadErr] = useState(null);',
            '  useEffect(() => { (async () => { await fetch("/x"); })(); }, []);',
            '  return <div>{loadErr}</div>;',
            '}',
            'export function D() {',
            '  const { data, error } = useQuery({ queryKey: ["x"], queryFn: async () => { await fetch("/x"); } });',
            '  return <div>{error ? "err" : data}</div>;',
            '}',
            'export async function notComponent() {',
            '  fetch("/x").then(r => r.json());',
            '  await fetch("/y");',
            '  return 1;',
            '}'
        ),
        'backend/src/b.tsx': 'export function C() { fetch("/x").then(f); return <div />; }\n'
    });
    assert.deepEqual(h, []);
});
