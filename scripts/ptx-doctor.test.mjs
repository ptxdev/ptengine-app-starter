import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationsAdditive, checkTailwindContent, checkPackageFloors, PACKAGE_FLOORS, checkJobs, findRouteHandler, checkNotifyScope, checkRemovedNotifyApis, checkSubscriptionItems } from './ptx-doctor.mjs';
import { RULES } from './manifest.mjs';

function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-doctor-'));
    mkdirSync(join(root, 'backend', 'migrations'), { recursive: true });
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(root, 'backend', 'migrations', name), sql);
    return root;
}
const manifest = { backend: { migrations: '_backend/migrations' } };

test('只增列的迁移通过', () => {
    const results = [];
    checkMigrationsAdditive(fixture({ '0001_init.sql': 'CREATE TABLE t (a TEXT);', '0002_add.sql': 'ALTER TABLE t ADD COLUMN b TEXT;' }), manifest, results);
    assert.equal(results.filter(r => r.level === 'warn').length, 0);
    assert.equal(results.at(-1).level, 'ok');
});

test('DROP TABLE / DROP COLUMN / ALTER … RENAME 各给一条 warn，并点名文件', () => {
    const results = [];
    checkMigrationsAdditive(fixture({
        '0001_a.sql': 'drop table old_t;',
        '0002_b.sql': 'ALTER TABLE t DROP COLUMN b;',
        '0003_c.sql': 'ALTER TABLE t RENAME TO t2;'
    }), manifest, results);
    const warns = results.filter(r => r.level === 'warn');
    assert.equal(warns.length, 3);
    assert.ok(warns.some(w => w.msg.includes('0001_a.sql') && w.msg.includes('DROP TABLE')));
    assert.ok(warns.some(w => w.msg.includes('0002_b.sql') && w.msg.includes('DROP COLUMN')));
    assert.ok(warns.some(w => w.msg.includes('0003_c.sql') && w.msg.includes('RENAME')));
});

test('注释掉的 DROP 不算（避免误报）', () => {
    const results = [];
    checkMigrationsAdditive(fixture({ '0001_a.sql': '-- DROP TABLE t;\nCREATE TABLE t (a TEXT);' }), manifest, results);
    assert.equal(results.filter(r => r.level === 'warn').length, 0);
});

test('没有 backend 段时什么都不做', () => {
    const results = [];
    checkMigrationsAdditive(fixture({}), {}, results);
    assert.equal(results.length, 0);
});

// ─── tailwind content 的 glob 必须真的能匹配到文件 ───────────────────────
//
// 这条规则原来只做字符串匹配，于是漏掉了真正的坑：相对 glob 按**配置文件所在
// 目录**（web/）解析，而带后端的布局把依赖装在**项目根** —— 没有 web/node_modules/，
// glob 一个文件都匹配不到，还完全不报错。下面的用例锁的就是这个差别。

/** 造一个假的 @ptengine/design-components 包。exports 里是否暴露 ./package.json 可选。 */
function fakeDesignComponents(nodeModulesDir, { exposePackageJson } = {}) {
    const pkgDir = join(nodeModulesDir, '@ptengine', 'design-components');
    mkdirSync(join(pkgDir, 'dist', 'components'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'index.cjs'), 'module.exports = {};');
    writeFileSync(join(pkgDir, 'dist', 'components', 'button.js'), 'export const cls = "bg-primary";');
    const exports = { '.': { require: './dist/index.cjs', import: './dist/index.cjs' }, './tailwind-preset': './tailwind.preset.js' };
    if (exposePackageJson) exports['./package.json'] = './package.json';
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@ptengine/design-components', version: '0.5.3', main: 'dist/index.cjs', exports }));
    return pkgDir;
}

const RELATIVE_CONFIG = `import designPreset from '@ptengine/design-components/tailwind-preset';
export default { presets: [designPreset], content: ['./index.html', './src/**/*.{ts,tsx}', './node_modules/@ptengine/design-components/dist/**/*.{js,cjs}'] };`;

const RESOLVED_CONFIG = `import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dcDist = path.join(path.dirname(require.resolve('@ptengine/design-components/package.json')), 'dist');
export default { presets: [designPreset], content: ['./index.html', \`\${dcDist}/**/*.{js,cjs}\`] };`;

/** 造一个项目：web/tailwind.config.js + 可选的两处 node_modules。 */
function project({ config, depsAt = 'root', exposePackageJson = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-tw-'));
    mkdirSync(join(root, 'web'), { recursive: true });
    if (config !== undefined) writeFileSync(join(root, 'web', 'tailwind.config.js'), config);
    if (depsAt === 'root') fakeDesignComponents(join(root, 'node_modules'), { exposePackageJson });
    if (depsAt === 'web') fakeDesignComponents(join(root, 'web', 'node_modules'), { exposePackageJson });
    return root;
}

test('相对 glob + 依赖装在项目根（带后端的布局）→ bad：glob 一个文件都匹配不到', () => {
    const res = checkTailwindContent(project({ config: RELATIVE_CONFIG, depsAt: 'root' }));
    assert.equal(res.level, 'bad');
    assert.equal(res.msgKey, 'nomatch');
    assert.match(res.why, /web\//);          // 指出层级原因
    assert.match(res.why, /node_modules/);
});

test('相对 glob + 依赖就在 web/ 下（老的纯前端布局）→ ok，不误报', () => {
    const res = checkTailwindContent(project({ config: RELATIVE_CONFIG, depsAt: 'web' }));
    assert.equal(res.level, 'ok');
});

test("已生成应用的最小修法 '../node_modules/…' 也判通过（docs/troubleshooting.md 里写的那条）", () => {
    const config = RELATIVE_CONFIG.replace('./node_modules/', '../node_modules/');
    assert.equal(checkTailwindContent(project({ config, depsAt: 'root' })).level, 'ok');
    // 依赖真在 web/ 下时，'../' 就退过头了 —— 仍应被判出来
    assert.equal(checkTailwindContent(project({ config, depsAt: 'web' })).level, 'bad');
});

test('按包名解析 → ok，无论依赖装在哪一层', () => {
    assert.equal(checkTailwindContent(project({ config: RESOLVED_CONFIG, depsAt: 'root' })).level, 'ok');
    assert.equal(checkTailwindContent(project({ config: RESOLVED_CONFIG, depsAt: 'web' })).level, 'ok');
});

test('组件库的 exports 没暴露 ./package.json 时也要能解析（走包根兜底）', () => {
    const res = checkTailwindContent(project({ config: RESOLVED_CONFIG, depsAt: 'root', exposePackageJson: false }));
    assert.equal(res.level, 'ok');
    // 反面：暴露了也一样能过
    assert.equal(checkTailwindContent(project({ config: RESOLVED_CONFIG, depsAt: 'root', exposePackageJson: true })).level, 'ok');
});

test('按包名解析但包根本没装 → bad，提示去 npm install', () => {
    const res = checkTailwindContent(project({ config: RESOLVED_CONFIG, depsAt: 'none' }));
    assert.equal(res.level, 'bad');
    assert.equal(res.msgKey, 'unresolved');
    assert.match(res.why, /npm install/);
});

test('content 里压根没有组件库 dist → bad', () => {
    const res = checkTailwindContent(project({ config: "export default { content: ['./src/**/*.tsx'] };" }));
    assert.equal(res.level, 'bad');
    assert.equal(res.msgKey, 'absent');
});

test('配置文件不存在 → bad', () => {
    assert.equal(checkTailwindContent(project({})).msgKey, 'missing');
});

test('只 import tailwind-preset、不算 content 覆盖（字符串匹配的旧坑）', () => {
    const res = checkTailwindContent(project({
        config: "import p from '@ptengine/design-components/tailwind-preset';\nexport default { presets: [p], content: ['./src/**/*.tsx'] };"
    }));
    assert.equal(res.msgKey, 'absent');
});

function floorFixture(deps) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-floors-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    return root;
}
const byLevel = rs => rs.map(r => r.level).join(',');

test('包版本 floor：区间与安装都满足 → 两条 ok', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.8.0', '@ptengine/app-backend': '^0.8.0' });
    const rs = checkPackageFloors(root, { installedVersion: n => (n.endsWith('app-sdk') ? '2.8.0' : '0.8.1') });
    assert.equal(byLevel(rs), 'ok,ok');
});

test('包版本 floor：区间下界低于 floor → bad，并给出 npm i 修法', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.2.0', '@ptengine/app-backend': '^0.8.0' });
    const rs = checkPackageFloors(root, { installedVersion: () => '9.9.9' });
    assert.equal(rs[0].level, 'bad');
    assert.match(rs[0].msg, /\^2\.2\.0/);
    assert.match(rs[0].why, /npm i @ptengine\/app-sdk@\^2\.8\.0/);
    assert.equal(rs[1].level, 'ok');
});

test('包版本 floor：区间对但 node_modules 里装的是老包 → bad（lock 落后）', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.8.0' });
    const rs = checkPackageFloors(root, { installedVersion: () => '2.2.1' });
    assert.equal(rs.length, 1);
    assert.equal(rs[0].level, 'bad');
    assert.match(rs[0].msg, /2\.2\.1/);
});

test('包版本 floor：没装 → warn；没声明的包跳过（轻应用可以没有 app-backend）', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.8.0' });
    const rs = checkPackageFloors(root, { installedVersion: () => null });
    assert.equal(byLevel(rs), 'warn');
});

test('包版本 floor：floor 表与 package.json 模板的区间一致（改一处必须改另一处）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const [name, floor] of Object.entries(PACKAGE_FLOORS)) {
        assert.equal(pkg.dependencies[name], `^${floor.min}`, `${name} 的模板区间应为 ^${floor.min}`);
    }
});

// ─── 定时任务（backend.jobs）────────────────────────────────────────────

function jobsProject(files) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-jobs-'));
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}
const JOB = { type: 'weekly-report', route: 'POST /jobs/weekly-report', title: '周报' };
const mf = (jobs, scopes = ['jobs:run']) => ({ schemaVersion: 2, scopes, backend: { entry: '_backend/worker.js', routes: ['/api/*'], jobs } });
const INDEX_OK = `export default createApp({ routes: {
    'GET /orders': async ctx => [],
    'POST /jobs/weekly-report': async ctx => {
        ctx.requireTrigger('job');
        return {};
    },
    'POST /settings': async ctx => ({})
} });`;

test('没有 backend.jobs：不产出任何结果', () => {
    assert.deepEqual(checkJobs(jobsProject({ 'backend/src/index.ts': INDEX_OK }), { backend: {} }), []);
});

test('全部合规 → 一条 ok', () => {
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': INDEX_OK }), mf([JOB]));
    assert.deepEqual(out.map(r => r.level), ['ok']);
});

test('声明了 jobs 却没有 jobs:run → bad', () => {
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': INDEX_OK }), mf([JOB], ['analytics:read']));
    assert.ok(out.some(r => r.level === 'bad' && /jobs:run/.test(r.msg)));
});

test('任务路由不在 routes 里 → bad，并点名任务类型', () => {
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': INDEX_OK }), mf([{ ...JOB, type: 'gone', route: 'POST /jobs/gone' }]));
    assert.ok(out.some(r => r.level === 'bad' && r.msg.includes('gone') && r.msg.includes('POST /jobs/gone')));
});

test('路由只出现在注释或普通字符串里不算（必须是对象键）', () => {
    const src = `// 'POST /jobs/weekly-report': 以后再写\nconst s = 'POST /jobs/weekly-report';\nexport default createApp({ routes: {} });`;
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
    assert.ok(out.some(r => r.level === 'bad'));
});

test('路由只出现在块注释里也不算', () => {
    const src = `/*\n  'POST /jobs/weekly-report': async ctx => { ctx.requireTrigger('job'); }\n*/\nexport default createApp({ routes: {} });`;
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
    assert.ok(out.some(r => r.level === 'bad' && r.msg.includes('POST /jobs/weekly-report')));
});

test('字符串里含 // 的 URL 不影响路由识别（剥注释不误伤字符串）', () => {
    const src = `const API = 'https://api.example.com/v1'; const B = "http://x.test//y"; export default createApp({ routes: { 'POST /jobs/weekly-report': async ctx => { ctx.requireTrigger('job'); await fetch(\`https://hook.test/\${API}\`); } } });`;
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
    assert.deepEqual(out.map(r => r.level), ['ok']);
});

test('requireTrigger / ctx.auth.preview 只写在注释里不算数', () => {
    const src = `export default createApp({ routes: {
    'POST /jobs/weekly-report': async ctx => {
        // TODO ctx.requireTrigger('job'); 以后读 ctx.auth.preview
        return {};
    }
} });`;
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': src }), mf([{ ...JOB, preview: true }]));
    assert.deepEqual(out.map(r => r.level), ['warn', 'warn']);
});

test('路由写在 backend/src 的子文件里（双引号 / 反引号键）也能找到', () => {
    const sub = 'export const jobRoutes = {\n  "POST /jobs/weekly-report": async (ctx) => { ctx.requireTrigger("job"); }\n};';
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': 'export default createApp({ routes: { ...jobRoutes } });', 'backend/src/jobs/routes.ts': sub }), mf([JOB]));
    assert.deepEqual(out.map(r => r.level), ['ok']);
    const tick = 'export const r = {\n  `POST /jobs/weekly-report`: async ctx => { ctx.requireTrigger("job"); }\n};';
    assert.deepEqual(checkJobs(jobsProject({ 'backend/src/index.ts': tick }), mf([JOB])).map(r => r.level), ['ok']);
});

test('任务路由片段里没有 requireTrigger( → warn；下一条路由里的 requireTrigger 不算数', () => {
    const src = `export default createApp({ routes: {
    'POST /jobs/weekly-report': async ctx => ({}),
    'POST /other': async ctx => { ctx.requireTrigger('user'); }
} });`;
    const out = checkJobs(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
    assert.ok(out.some(r => r.level === 'warn' && /requireTrigger/.test(r.msg)));
});

test('preview: true 但路由所在文件没读 ctx.auth.preview → warn；读了就不报', () => {
    const noPreview = checkJobs(jobsProject({ 'backend/src/index.ts': INDEX_OK }), mf([{ ...JOB, preview: true }]));
    assert.ok(noPreview.some(r => r.level === 'warn' && /ctx\.auth\.preview/.test(r.msg)));
    const withPreview = INDEX_OK.replace("ctx.requireTrigger('job');", "ctx.requireTrigger('job'); if (ctx.auth.preview) return {};");
    assert.deepEqual(checkJobs(jobsProject({ 'backend/src/index.ts': withPreview }), mf([{ ...JOB, preview: true }])).map(r => r.level), ['ok']);
});

test('findRouteHandler：路由里的正则元字符被转义（. 不当通配）', () => {
    const sources = [{ rel: 'a.ts', text: "{ 'POST /jobsXweekly': 1 }" }];
    assert.equal(findRouteHandler(sources, 'POST /jobs.weekly'), null);
});

// ─── 推送 / 图表（notify:send）──────────────────────────────────────────

test('后端没用 notify / render：不产出任何结果', () => {
    assert.deepEqual(checkNotifyScope(jobsProject({ 'backend/src/index.ts': INDEX_OK }), mf([JOB])), []);
});

test('用了 ctx.pt.notify.email 却没声明 notify:send → bad，并点名文件', () => {
    const src = "export default createApp({ routes: { 'POST /x': async ctx => ctx.pt.notify.email({ to: ['role:admin'], subject: 's', html: 'h' }) } });";
    const out = checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
    assert.equal(out.length, 1);
    assert.equal(out[0].level, 'bad');
    assert.match(out[0].msg, /notify:send/);
    assert.match(out[0].msg, /backend\/src\/index\.ts/);
});

test('只用 ctx.pt.render.chart 也要 notify:send；子文件里用到同样能找到', () => {
    const out = checkNotifyScope(jobsProject({
        'backend/src/index.ts': 'export default createApp({ routes: {} });',
        'backend/src/charts.ts': 'export const c = ctx => ctx.pt.render.chart({ series: [] });'
    }), mf([JOB]));
    assert.equal(out[0].level, 'bad');
    assert.match(out[0].msg, /charts\.ts/);
});

test('声明了 notify:send → ok', () => {
    const src = 'const r = ctx => ctx.pt.notify.email(x);';
    assert.deepEqual(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB], ['jobs:run', 'notify:send'])).map(r => r.level), ['ok']);
});

test('只出现在注释或字符串里不算', () => {
    const src = "// TODO ctx.pt.notify.email(...)\nconst s = 'ctx.pt.render.chart';\n/* ctx.pt.notify.email */";
    assert.deepEqual(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB])), []);
});

test('模板插值里的真调用 → bad', () => {
    const src = 'export const h = async (ctx, o) => `<img src="${(await ctx.pt.render.chart(o)).url}">`;';
    assert.equal(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]))[0]?.level, 'bad');
});

test('插值里嵌套对象字面量与内层模板：花括号深度正确，之后的真调用照样识别', () => {
    const src = 'const a = `x${ f({ k: `y${1}` }) }z`;\nawait ctx.pt.notify.email(x);';
    assert.equal(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]))[0]?.level, 'bad');
});

test('解构写法 → bad', () => {
    for (const src of [
        'const { notify } = ctx.pt;\nawait notify.email(x);',
        'const { render: r } = ctx.pt;\nawait r.chart(o);',
        'const { pt: { notify } } = ctx;\nawait notify.email(x);',
        "export default createApp({ routes: { 'POST /x': async ({ pt }) => pt.notify.email(x) } });"
    ]) {
        const out = checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
        assert.equal(out[0]?.level, 'bad', src);
    }
});

test('可选链 / 换行空白 → bad', () => {
    for (const src of ['await ctx.pt?.notify?.email(x);', 'await ctx?.pt\n    .render\n    .chart(o);']) {
        const out = checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
        assert.equal(out[0]?.level, 'bad', src);
    }
});

test('跨行模板正文里出现 ctx.pt.notify.email 且无真调用 → 不报', () => {
    const src = 'const doc = `\n用法：ctx.pt.notify.email({ ... })\n`;\nconst t = `x`;';
    assert.deepEqual(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB])), []);
});

test('跨行模板之后的真调用不被吞（反引号不错配）', () => {
    const src = 'const a = `\nline\n`; await ctx.pt.notify.email(x); const b = `y`;';
    assert.equal(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]))[0]?.level, 'bad');
});

test('测试文件里的 mock 不算', () => {
    const root = jobsProject({
        'backend/src/index.ts': 'export default createApp({ routes: {} });',
        'backend/src/index.test.ts': 'const ctx = { pt: { notify: { email: vi.fn() } } }; await ctx.pt.notify.email(x);',
        'backend/src/charts.spec.mjs': 'await ctx.pt.render.chart(o);'
    });
    assert.deepEqual(checkNotifyScope(root, mf([JOB])), []);
});

test('插值里先有嵌套对象字面量、同一插值内再真调用 → bad（花括号深度回归，最终评审 Minor 13）', () => {
    const src = 'const a = `x${ f({ k: 1 }) + ctx.pt.notify.email(x) }z`;';
    assert.equal(checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]))[0]?.level, 'bad');
});

test('*.d.ts 里的类型声明不算（最终评审 Minor 13）', () => {
    const root = jobsProject({
        'backend/src/index.ts': 'export default createApp({ routes: {} });',
        'backend/src/env.d.ts': 'declare const ctx: { pt: { notify: { email(x: unknown): Promise<void> } } };\ntype X = typeof ctx.pt.notify;'
    });
    assert.deepEqual(checkNotifyScope(root, mf([JOB])), []);
});

test('notify.send：四种写法（ctx.pt.notify.send / 可选链 / 解构 notify / 路由形参 ({ pt })）没声明 notify:send → bad，话术点名 notify.send；声明了 → ok，话术点名文件', () => {
    for (const src of [
        "await ctx.pt.notify.send({ title: 't' });",
        'const r = await ctx.pt?.notify?.send(msg);',
        'const { notify } = ctx.pt;\nawait notify.send(msg);',
        "export default createApp({ routes: { 'POST /notify-now': async ({ pt }) => pt.notify.send(msg) } });"
    ]) {
        const out = checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB]));
        assert.equal(out.length, 1, src);
        assert.equal(out[0].level, 'bad', src);
        assert.match(out[0].msg, /notify\.send/, src);
        assert.match(out[0].why, /通知/, src);
        const ok = checkNotifyScope(jobsProject({ 'backend/src/index.ts': src }), mf([JOB], ['jobs:run', 'notify:send']));
        assert.deepEqual(ok.map(r => r.level), ['ok'], src);
        assert.match(ok[0].msg, /已声明 notify:send（backend[\/\\]src[\/\\]index\.ts）/, src);
    }
});

// ─── 通知投递目标：已移除的 1c API 与订阅项字段 ───────────────────────

test('代码里还在用 ctx.pt.notify.channel / notify.listChannels（含可选链、解构、子文件）→ bad，点名文件与「改用 notify.send，投递目标由使用者配置」', () => {
    for (const [file, src] of [
        ['backend/src/index.ts', "await ctx.pt.notify.channel('alerts', { title: 't' });"],
        ['backend/src/index.ts', 'const list = await ctx.pt.notify.listChannels();'],
        ['backend/src/index.ts', 'await ctx.pt?.notify?.channel(name, msg);'],
        ['backend/src/jobs/ping.ts', 'const { notify } = ctx.pt;\nawait notify.channel(name, msg);']
    ]) {
        const out = checkRemovedNotifyApis(jobsProject({ 'backend/src/index.ts': '', [file]: src }));
        assert.equal(out.length, 1, src);
        assert.equal(out[0].level, 'bad', src);
        assert.match(out[0].msg, /已移除/, src);
        assert.ok(out[0].msg.includes(file.replace(/\//g, '/')) || out[0].msg.includes(file.replace(/\//g, '\\')), src);
        assert.match(out[0].why, /notify\.send/, src);
        assert.match(out[0].why, /投递目标由使用者配置/, src);
    }
});

test('已移除 API 只出现在注释 / 字符串 / 测试文件里 → 不报；用 notify.send 不报', () => {
    const root = jobsProject({
        'backend/src/index.ts': "// 以前是 ctx.pt.notify.channel('a', m)\nconst s = 'notify.listChannels()';\nawait ctx.pt.notify.send(m);",
        'backend/src/index.test.ts': 'await ctx.pt.notify.channel(a, m);'
    });
    assert.deepEqual(checkRemovedNotifyApis(root), []);
});

const J = RULES.jobs;
test('checkSubscriptionItems：没有 backend.jobs → 不产出；字段齐全 → 一条 ok', () => {
    assert.deepEqual(checkSubscriptionItems({ backend: {} }), []);
    const full = { ...JOB, displayName: { 'zh-CN': '周报', 'en-US': 'Weekly report' }, description: { 'en-US': 'x' }, defaultCron: '0 9 * * 1', defaultParams: { a: 1 } };
    assert.deepEqual(checkSubscriptionItems(mf([full, { type: 'sync', route: 'POST /sync', title: '同步', subscribable: false }])).map(r => r.level), ['ok']);
});

test('checkSubscriptionItems：订阅项没写 displayName → info（可选）；subscribable:false 的不提示', () => {
    const out = checkSubscriptionItems(mf([JOB, { ...JOB, type: 'sync', route: 'POST /sync', subscribable: false }]));
    assert.deepEqual(out.map(r => r.level), ['info']);
    assert.match(out[0].msg, /weekly-report/);
    assert.ok(!out[0].msg.includes('sync'));
    assert.match(out[0].why, /title/);
});

test('checkSubscriptionItems：字段形状不合规 → bad（上传会被拒 MANIFEST_JOBS_INVALID）；上限读 rules.jobs', () => {
    const bad = [
        { displayName: {} }, { displayName: { fr: 'x' } }, { displayName: 'x' }, { displayName: { 'zh-CN': '  ' } },
        { displayName: { 'zh-CN': 'a\nb' } }, { displayName: { 'zh-CN': 'x'.repeat(J.displayNameMax + 1) } },
        { description: { 'en-US': 'x'.repeat(J.descriptionMax + 1) } }, { description: { 'en-US': 1 } },
        { defaultCron: 9 }, { defaultCron: 'x'.repeat(J.defaultCronMax + 1) },
        { defaultParams: [] }, { defaultParams: 'x' }, { defaultParams: null },
        { subscribable: 'false' }
    ];
    for (const patch of bad) {
        const out = checkSubscriptionItems(mf([{ ...JOB, displayName: { 'zh-CN': '周报' }, ...patch }]));
        assert.ok(out.some(r => r.level === 'bad' && r.msg.includes('weekly-report')), JSON.stringify(patch));
    }
    const edge = { ...JOB, displayName: { 'ja-JP': '😀'.repeat(J.displayNameMax) }, description: { 'zh-CN': '字'.repeat(J.descriptionMax) }, defaultCron: '0 9 * * 1' };
    assert.deepEqual(checkSubscriptionItems(mf([edge])).map(r => r.level), ['ok']);
});

test('checkSubscriptionItems：defaultCron 不是 5 段 → warn（能否解析与最小间隔由平台上传时判）', () => {
    const out = checkSubscriptionItems(mf([{ ...JOB, displayName: { 'zh-CN': '周报' }, defaultCron: '0 9 * *' }]));
    assert.deepEqual(out.map(r => r.level), ['warn']);
    assert.match(out[0].msg, /defaultCron/);
});
