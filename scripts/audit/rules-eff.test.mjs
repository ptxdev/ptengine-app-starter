import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAudit } from './run.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const V2 = { schemaVersion: 2, backend: { egress: [] } };

/** 临时项目：files 是 { 相对路径: 内容 }（内容可以是 Buffer）。 */
function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-eff-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(V2));
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}

async function hits(rule, files) {
    const { findings } = await runAudit({ root: fixture(files) });
    return findings.filter(f => f.rule === rule);
}

/** 只看某条规则命中的 [文件, 行号]。 */
const lines = async (rule, files) => (await hits(rule, files)).map(f => [f.file, f.line]);

const src = (...ls) => ls.join('\n') + '\n';

// ─── EFF-001 ───
test('EFF-001：for-of / map 回调 / reduce 回调里用循环变量发 data.query 命中', async () => {
    const h = await lines('EFF-001', {
        'web/src/a.ts': src(
            'async function f(countries) {',
            '  for (const c of countries) {',
            '    await window.PtApp.data.query({ queryType: "traffic_insight", params: { timeRange: t, country: c } });',
            '  }',
            '  await Promise.all(countries.map(({ code }) => PtApp.data.query({ queryType: "x", params: { timeRange: t, country: code } })));',
            '  for (const k in groups) await ctx.pt.query("x", { timeRange: t, k });',
            '  countries.reduce(async (acc, c) => { await acc; return app.data.query({ params: { timeRange: t, c } }); }, p);',
            '}'
        )
    });
    assert.deepEqual(h, [['web/src/a.ts', 3], ['web/src/a.ts', 5], ['web/src/a.ts', 6], ['web/src/a.ts', 7]]);
});

test('EFF-001：不命中 —— 循环里查询不含循环变量、循环外查询、.c 只是属性名、回调参数遮蔽、metadata.query', async () => {
    const h = await lines('EFF-001', {
        'web/src/a.ts': src(
            'async function f(countries, retries) {',
            '  for (const c of countries) {',
            '    await PtApp.data.query({ queryType: "x", params: { timeRange: t, country: cfg.c } });',
            '    await PtApp.data.query({ queryType: "x", params: { timeRange: t, c: 1 } });',
            '    await PtApp.data.query({ queryType: "x", params: { timeRange: t, list: other.map(c => c.id) } });',
            '    metadata.query(c);',
            '  }',
            '  for (const c of await PtApp.data.query({ queryType: "x", params: { timeRange: t } })) log(c);',
            '  const rows = countries.map(c => c.id);',
            '  await PtApp.data.query({ queryType: "x", params: { timeRange: t, ids: rows } });',
            '  for (let i = 0; i < retries; i++) await PtApp.data.query({ queryType: "x", params: { timeRange: t } });',
            '}'
        )
    });
    assert.deepEqual(h, []);
});

// ─── EFF-002 ───
test('EFF-002：params 是对象字面量且没有 timeRange 命中', async () => {
    const h = await lines('EFF-002', {
        'web/src/a.ts': src(
            'await window.PtApp.data.query({ queryType: "x", params: { steps: [] } });',
            'await PtApp.data.query({ queryType: "x", "params": {} });'
        )
    });
    assert.deepEqual(h, [['web/src/a.ts', 1], ['web/src/a.ts', 2]]);
});

test('EFF-002：不命中 —— 有 timeRange（含带引号键、简写）、params 是变量、params 里有展开、实参是变量', async () => {
    const h = await lines('EFF-002', {
        'web/src/a.ts': src(
            'await PtApp.data.query({ queryType: "x", params: { timeRange: { key: "today" } } });',
            'await PtApp.data.query({ queryType: "x", params: { "timeRange": r } });',
            'await PtApp.data.query({ queryType: "x", params: { timeRange } });',
            'await PtApp.data.query({ queryType: "x", params });',
            'await PtApp.data.query({ queryType: "x", params: { ...base, steps: [] } });',
            'await PtApp.data.query(req);',
            'await other.query({ params: {} });'
        )
    });
    assert.deepEqual(h, []);
});

// ─── EFF-003 ───
test('EFF-003：有 JSX 的前端文件整包 import echarts / d3 / framer-motion 命中', async () => {
    const h = await lines('EFF-003', {
        'web/src/Chart.tsx': src(
            "import * as echarts from 'echarts';",
            "import { motion } from 'framer-motion';",
            "import * as d3 from \"d3\";",
            'export const C = () => <div />;'
        )
    });
    assert.deepEqual(h, [['web/src/Chart.tsx', 1], ['web/src/Chart.tsx', 2], ['web/src/Chart.tsx', 3]]);
});

test('EFF-003：不命中 —— 子路径、import type、没有 JSX 的文件、后端文件', async () => {
    const h = await lines('EFF-003', {
        'web/src/Chart.tsx': src(
            "import * as echarts from 'echarts/core';",
            "import type { EChartsOption } from 'echarts';",
            "import { type ScaleLinear } from 'd3';",
            "import { scaleLinear } from 'd3-scale';",
            'export const C = () => <></>;'
        ),
        'web/src/lazy.ts': "import * as echarts from 'echarts';\nexport default echarts;\n",
        'backend/src/render.tsx': "import * as echarts from 'echarts';\nexport const X = () => <div />;\n"
    });
    assert.deepEqual(h, []);
});

// ─── EFF-004 ───
test('EFF-004：web/dist/assets 里超过 800KB 的 JS 包各报一条，带 kb', async () => {
    const f = await hits('EFF-004', {
        'web/src/a.ts': 'export {};\n',
        'web/dist/assets/x.js': Buffer.alloc(900 * 1024, 'a'),
        'web/dist/assets/small.js': Buffer.alloc(800 * 1024, 'a'),
        'web/dist/assets/big.css': Buffer.alloc(900 * 1024, 'a')
    });
    assert.deepEqual(f.map(x => [x.file, x.line, x.args]), [['web/dist/assets/x.js', 0, { kb: '900' }]]);
});

test('EFF-004：没有 web/dist 时不报', async () => {
    assert.deepEqual(await lines('EFF-004', { 'web/src/a.ts': 'export {};\n' }), []);
});

// ─── EFF-005 ───
const q = n => `  const r${n} = await window.PtApp.data.query({ queryType: "q${n}", params: { timeRange: t } });`;

test('EFF-005：首屏文件同一函数里串行 await 3 次查询 → 报第一处', async () => {
    const h = await lines('EFF-005', {
        'web/src/App.tsx': src('async function load() {', q(1), q(2), q(3), '}', 'export const A = () => <div />;'),
        'web/src/pages/index.tsx': src('const load = async () => {', q(1), '  log(1);', q(2), q(3), q(4), '};')
    });
    assert.deepEqual(h, [['web/src/App.tsx', 2], ['web/src/pages/index.tsx', 2]]);
});

test('EFF-005：不命中 —— 只有 2 次、Promise.all / allSettled 里、分散在不同函数、不是首屏文件', async () => {
    const h = await lines('EFF-005', {
        'web/src/main.tsx': src(
            'async function a() {', q(1), q(2), '}',
            'async function b() {',
            '  const [x, y, z] = await Promise.all([',
            '    (async () => await PtApp.data.query({ params: { timeRange: t } }))(),',
            '    PtApp.data.query({ params: { timeRange: t } }),',
            '    PtApp.data.query({ params: { timeRange: t } })',
            '  ]);',
            '  await Promise.allSettled([await PtApp.data.query({ params: { timeRange: t } }), await PtApp.data.query({ params: { timeRange: t } }), await PtApp.data.query({ params: { timeRange: t } })]);',
            '}',
            'async function c() {', q(1), '  const f = async () => {', q(2), q(3), '  };', '}'
        ),
        'web/src/pages/Report.tsx': src('async function load() {', q(1), q(2), q(3), '}'),
        'web/src/MyApp.tsx': src('async function load() {', q(1), q(2), q(3), '}')
    });
    assert.deepEqual(h, []);
});

// ─── EFF-006 ───
test('EFF-006：后端循环里 prepare 命中', async () => {
    const h = await lines('EFF-006', {
        'backend/src/a.ts': src(
            'async function f(env, ids) {',
            '  for (const id of ids) {',
            '    await env.DB.prepare("SELECT * FROM t WHERE id = ?").bind(id).first();',
            '  }',
            '  await Promise.all(ids.map(id => db().prepare("SELECT 1").bind(id).all()));',
            '}'
        )
    });
    assert.deepEqual(h, [['backend/src/a.ts', 3], ['backend/src/a.ts', 5]]);
});

test('EFF-006：不命中 —— 循环外 prepare、循环里只攒语句交给 db.batch、前端文件、prepared 之类的名字', async () => {
    const h = await lines('EFF-006', {
        'backend/src/a.ts': src(
            'async function f(env, ids) {',
            '  const stmt = env.DB.prepare("SELECT * FROM t WHERE id IN (?)");',
            '  for (const id of ids) prepared(id);',
            '  const stmts = [];',
            '  for (const id of ids) stmts.push(env.DB.prepare("INSERT INTO t VALUES (?)").bind(id));',
            '  await env.DB.batch(ids.map(id => env.DB.prepare("DELETE FROM t WHERE id = ?").bind(id)));',
            '  await env.DB.batch(ids.flatMap(id => [env.DB.prepare("A").bind(id), env.DB.prepare("B").bind(id)]));',
            '}'
        ),
        'web/src/a.ts': 'for (const x of xs) sql.prepare(x);\n'
    });
    assert.deepEqual(h, []);
});
