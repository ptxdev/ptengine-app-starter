import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAudit } from './run.mjs';
import { AUDIT_RULES, localize } from '../ptx-audit.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const V1 = { schemaVersion: 1 };
const V2 = (backend = {}) => ({ schemaVersion: 2, backend: { egress: [], ...backend } });

/** 临时项目：files 是 { 相对路径: 内容 }，manifest 写进 manifest.json。 */
function fixture(manifest, files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-sec-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}

/** 只看某条规则的命中。 */
async function hits(rule, manifest, files) {
    const { findings } = await runAudit({ root: fixture(manifest, files) });
    return findings.filter(f => f.rule === rule);
}

// ─── SEC-001 ───
test('SEC-001：已知前缀的密钥字面量命中，line 指向字面量', async () => {
    const h = await hits('SEC-001', V1, { 'web/src/a.ts': 'const x = 1;\nconst k = "sk-abcdefghij1234567890KLMN";\n' });
    assert.deepEqual(h.map(f => [f.file, f.line]), [['web/src/a.ts', 2]]);
});

test('SEC-001：sk- 要带数字且（大小写混合或 ≥ 32 位）才算密钥；sk- 开头的长 class 名不报', async () => {
    const h = await hits('SEC-001', V1, {
        'web/src/a.ts': [
            `const a = "sk-proj-${'Ab3'.repeat(8)}";`,
            `const b = "sk-${'a1'.repeat(16)}";`,
            'const c = "sk-skeleton-loading-item";',
            'const d = "sk-skeleton-loading-item-v2";',
            'const e = "sk-abcdefghijklmnopqrstuvwxyzabcdefgh";'
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [1, 2]);
});

test('SEC-001：长随机串 + 变量 / 属性名像密钥才命中', async () => {
    const long = 'A'.repeat(20) + 'b9_-'.repeat(4);
    const h = await hits('SEC-001', V1, {
        'web/src/a.ts': `const apiToken = '${long}';\nconst cfg = {\n  clientSecret: '${long}' };\n`
    });
    assert.deepEqual(h.map(f => f.line), [1, 3]);
});

test('SEC-001：不命中 —— 长串但名字无关、后端文件、短串', async () => {
    const long = 'A'.repeat(40);
    const h = await hits('SEC-001', V2(), {
        'web/src/a.ts': `const className = '${long}';\nconst token = 'short';\n`,
        'backend/src/b.ts': 'const k = "sk-abcdefghijklmnopqrstuv";\n'
    });
    assert.deepEqual(h, []);
});

// ─── SEC-002 ───
test('SEC-002：未声明的 host 命中（severe + args.host），已声明 / 子域 / 相对路径不报', async () => {
    const h = await hits('SEC-002', V2({ egress: ['api.ok.com', 'ok2.com'] }), {
        'backend/src/a.ts': [
            "await fetch('https://evil.example.com/x');",
            "await ctx.fetch('https://api.ok.com/y');",
            "await fetch(`https://sub.ok2.com/z`);",
            "await fetch('/api/local');",
            "await ctx.fetch(`https://bad.io/${id}`);",
            "await fetch(`/api/${id}`);"
        ].join('\n')
    });
    assert.deepEqual(h.map(f => [f.line, f.args?.host, f.severity]), [
        [1, 'evil.example.com', undefined],
        [5, 'bad.io', undefined]
    ]);
});

test('SEC-002：目标是变量 → normal，localize 后不残留 {host}', async () => {
    const h = await hits('SEC-002', V2(), { 'backend/src/a.ts': 'const url = make();\nawait fetch(url);\n' });
    assert.equal(h.length, 1);
    assert.equal(h[0].line, 2);
    const loc = localize(h[0], AUDIT_RULES, 'zh-CN');
    assert.equal(loc.severity, 'normal');
    assert.ok(!loc.title.includes('{host}'), loc.title);
});

test('SEC-002：没开后端不报', async () => {
    const h = await hits('SEC-002', V1, { 'backend/src/a.ts': "await fetch('https://evil.example.com/x');\n" });
    assert.deepEqual(h, []);
});

// ─── SEC-003 ───
test('SEC-003：prepare 的 SQL 带插值 / 拼接变量命中', async () => {
    const h = await hits('SEC-003', V2(), {
        'backend/src/a.ts': [
            'db.prepare(`SELECT * FROM t WHERE id = ${id}`);',
            "env.DB.exec('DELETE FROM t WHERE n = ' + name);",
            'db.prepare(`SELECT 1`);',
            "db.prepare('SELECT * FROM t WHERE id = ?').bind(id);",
            "db.prepare('SELECT ' + 'x');"
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [1, 2]);
});

test('SEC-003：不命中 —— IN 查询只插 ? 占位（map(() => \'?\').join / \'?\'.repeat / fill(\'?\')）', async () => {
    const h = await hits('SEC-003', V2(), {
        'backend/src/a.ts': [
            "db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids);",
            "db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(_ => \"?\").join(', ')})`).bind(...ids);",
            "db.prepare(`DELETE FROM t WHERE id IN (${'?,'.repeat(ids.length - 1)}?)`).bind(...ids);",
            "db.prepare('SELECT * FROM t WHERE id IN (' + Array(n).fill('?').join(',') + ')').bind(...ids);"
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

test('SEC-003：不命中 —— 插值是同文件内以字面量初始化的 const（表名常量）', async () => {
    const h = await hits('SEC-003', V2(), {
        'backend/src/a.ts': [
            "const TABLE = 'reports';",
            'const LIMIT = 50;',
            'export function f(db) {',
            '  db.prepare(`SELECT * FROM ${TABLE} LIMIT ${LIMIT}`);',
            "  return db.prepare('DELETE FROM ' + TABLE);",
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

test('SEC-003：照报 —— 占位生成器里混了值、const 不是字面量初始化、let 变量', async () => {
    const h = await hits('SEC-003', V2(), {
        'backend/src/a.ts': [
            "const T = req.query.table;",
            "let U = 'users';",
            "db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(i => `'${i}'`).join(',')})`);",
            'db.prepare(`SELECT * FROM ${T}`);',
            'db.prepare(`SELECT * FROM ${U}`);'
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [3, 4, 5]);
});

// ─── SEC-004 ───
test('SEC-004：dangerouslySetInnerHTML / eval / new Function / postMessage(*) 命中，限定 origin 不报', async () => {
    const h = await hits('SEC-004', V1, {
        'web/src/a.tsx': [
            'export const A = () => <div dangerouslySetInnerHTML={{ __html: x }} />;',
            'eval(code);',
            "const f = new Function('a', 'return a');",
            "window.parent.postMessage(msg, '*');",
            "window.parent.postMessage(msg, 'https://app.ptengine.ai');",
            'const g = new Map();'
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [1, 2, 3, 4]);
});

// ─── SEC-005 ───
test('SEC-005：轻应用前端请求非平台域 / VITE_* 地址命中，平台域不报', async () => {
    const h = await hits('SEC-005', V1, {
        'web/src/a.ts': [
            "fetch('https://api.other.com/x');",
            "axios.get('https://api.ptengine.ai/x');",
            'fetch(`${import.meta.env.VITE_API}/x`);',
            "fetch('/local');",
            "axios.post(`https://hook.other.io/${id}`, body);"
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [1, 3, 5]);
});

test('SEC-005：schemaVersion 2 不报', async () => {
    const h = await hits('SEC-005', V2(), { 'web/src/a.ts': "fetch('https://api.other.com/x');\n" });
    assert.deepEqual(h, []);
});

// ─── SEC-006 ───
test('SEC-006：user_* 查询结果写进 KV / 日志命中；非 user_ 查询、别的函数里的同名变量不报', async () => {
    const h = await hits('SEC-006', V2(), {
        'backend/src/a.ts': [
            'async function a(ctx) {',
            "  const users = await ctx.pt.query('user_list', {});",
            "  await ctx.env.KV.put('k', JSON.stringify(users));",
            '  console.log(users.rows);',
            '}',
            'async function b(ctx) {',
            "  const t = await ctx.pt.query('traffic_insight', {});",
            "  await ctx.env.KV.put('k', JSON.stringify(t));",
            '}',
            'async function c(ctx, users) {',
            '  console.log(users);',
            '}'
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [3, 4]);
});

test('SEC-006：不命中 —— 只读 .length（条数不是用户数据）', async () => {
    const h = await hits('SEC-006', V2(), {
        'backend/src/a.ts': [
            'async function a(ctx) {',
            "  const users = await ctx.pt.query('user_list', {});",
            "  const { rows } = await ctx.pt.query('user_list', {});",
            '  console.log(users.rows.length);',
            "  console.log('n =', rows.length, users.length);",
            "  await ctx.env.KV.put('count', String(rows.length));",
            '}'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

// ─── SEC-007 ───
const JOBS = V2({ jobs: [{ type: 'daily', route: 'POST /jobs/daily', schedule: '0 0 * * *' }] });

test('SEC-007：任务路由没调 requireTrigger 命中，line 指向路由键', async () => {
    const h = await hits('SEC-007', JOBS, {
        'backend/src/index.ts': [
            'export default createApp({',
            '  routes: {',
            "    'GET /hello': async () => ({ ok: true }),",
            "    'POST /jobs/daily': async (ctx) => {",
            '      return { ok: true };',
            '    }',
            '  }',
            '});'
        ].join('\n')
    });
    assert.deepEqual(h.map(f => [f.file, f.line]), [['backend/src/index.ts', 4]]);
});

test('SEC-007：调了 requireTrigger 不报', async () => {
    const h = await hits('SEC-007', JOBS, {
        'backend/src/index.ts': [
            'export default createApp({',
            '  routes: {',
            "    'POST /jobs/daily': async (ctx) => {",
            "      requireTrigger(ctx, 'job');",
            '      return { ok: true };',
            '    }',
            '  }',
            '});'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});

test('SEC-006：user_* 查询结果进 .bind 实参（D1 最常见写法）命中', async () => {
    const h = await hits('SEC-006', V2(), {
        'backend/src/a.ts': [
            'async function a(ctx, db) {',
            "  const { rows } = await ctx.pt.query('user_list', {});",
            "  await db.prepare('INSERT INTO t (v) VALUES (?)')",
            '    .bind(JSON.stringify(rows)).run();',
            "  await db.prepare('SELECT 1').bind(1).run();",
            '}'
        ].join('\n')
    });
    assert.deepEqual(h.map(f => f.line), [3]);
});

test('SEC-006：属性名 / 对象键 / 回调参数遮蔽的同名标识符不算引用', async () => {
    const h = await hits('SEC-006', V2(), {
        'backend/src/a.ts': [
            'async function a(ctx, db, stats, list, n) {',
            "  const { rows } = await ctx.pt.query('user_list', {});",
            '  console.log(stats.rows);',
            "  await db.prepare('INSERT INTO t (v) VALUES (?)').bind(JSON.stringify({ rows: n })).run();",
            '  list.map(rows => console.log(rows));',
            '  console.log({ rows });',
            '}'
        ].join('\n')
    });
    // 只有第 6 行的简写属性 { rows } 是真引用
    assert.deepEqual(h.map(f => f.line), [6]);
});

test('SEC-007：处理函数在别处定义（标识符 / 成员引用）不报；requireTrigger 与括号间有空白也算调过', async () => {
    const h = await hits('SEC-007', V2({ jobs: [
        { type: 'a', route: 'POST /jobs/a', schedule: '0 0 * * *' },
        { type: 'b', route: 'POST /jobs/b', schedule: '0 0 * * *' },
        { type: 'c', route: 'POST /jobs/c', schedule: '0 0 * * *' }
    ] }), {
        'backend/src/index.ts': [
            'export default createApp({',
            '  routes: {',
            "    'POST /jobs/a': dailyJob,",
            "    'POST /jobs/b': async (ctx) => { requireTrigger (ctx, 'job'); return {}; },",
            "    'POST /jobs/c': jobs.weekly",
            '  }',
            '});'
        ].join('\n')
    });
    assert.deepEqual(h, []);
});
