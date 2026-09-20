import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationsAdditive, checkTailwindContent, checkPackageFloors, PACKAGE_FLOORS } from './ptx-doctor.mjs';

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
    const root = floorFixture({ '@ptengine/app-sdk': '^2.4.0', '@ptengine/app-backend': '^0.4.0' });
    const rs = checkPackageFloors(root, { installedVersion: n => (n.endsWith('app-sdk') ? '2.4.0' : '0.4.1') });
    assert.equal(byLevel(rs), 'ok,ok');
});

test('包版本 floor：区间下界低于 floor → bad，并给出 npm i 修法', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.2.0', '@ptengine/app-backend': '^0.4.0' });
    const rs = checkPackageFloors(root, { installedVersion: () => '9.9.9' });
    assert.equal(rs[0].level, 'bad');
    assert.match(rs[0].msg, /\^2\.2\.0/);
    assert.match(rs[0].why, /npm i @ptengine\/app-sdk@\^2\.4\.0/);
    assert.equal(rs[1].level, 'ok');
});

test('包版本 floor：区间对但 node_modules 里装的是老包 → bad（lock 落后）', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.4.0' });
    const rs = checkPackageFloors(root, { installedVersion: () => '2.2.1' });
    assert.equal(rs.length, 1);
    assert.equal(rs[0].level, 'bad');
    assert.match(rs[0].msg, /2\.2\.1/);
});

test('包版本 floor：没装 → warn；没声明的包跳过（轻应用可以没有 app-backend）', () => {
    const root = floorFixture({ '@ptengine/app-sdk': '^2.4.0' });
    const rs = checkPackageFloors(root, { installedVersion: () => null });
    assert.equal(byLevel(rs), 'warn');
});

test('包版本 floor：floor 表与 package.json 模板的区间一致（改一处必须改另一处）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const [name, floor] of Object.entries(PACKAGE_FLOORS)) {
        assert.equal(pkg.dependencies[name], `^${floor.min}`, `${name} 的模板区间应为 ^${floor.min}`);
    }
});
