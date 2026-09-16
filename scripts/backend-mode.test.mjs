/**
 * "这个项目有没有后端" 的判定，以及 build / dev 两条命令对它的反应。
 *
 * 锁的是轻应用（删掉 backend/、manifest 去掉 backend 段）那条路：
 * 以前 `ptx build` 会以 TS5083 挂在根 tsconfig 的 `{ "path": "./backend" }` 上，
 * `ptx dev` 会以 ENOENT backend/wrangler.jsonc 挂在 wrangler 上 —— 两个都与用户
 * 写的任何一行代码无关，纯粹是脚手架自己的假设没跟上。
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveBackend } from './manifest.mjs';
import { typeCheckArgs } from './ptx-build.mjs';
import { planDev } from './ptx-dev.mjs';

/** 临时项目根。`withDir` 决定 backend/ 目录在不在（判定源仍然是 manifest）。 */
function project({ withDir }) {
    const dir = mkdtempSync(join(tmpdir(), 'ptx-mode-'));
    if (withDir) mkdirSync(join(dir, 'backend'), { recursive: true });
    return dir;
}
const full = { schemaVersion: 2, version: '1.0.0', entry: 'index.html', backend: { entry: '_backend/worker.js', routes: ['/api/*'] } };
const light = { schemaVersion: 1, version: '1.0.0', entry: 'index.html' };

// ── 判定 ────────────────────────────────────────────────────────────────

test('manifest 有 backend + 目录在 → 有后端', () => {
    const res = resolveBackend(full, project({ withDir: true }));
    assert.equal(res.enabled, true);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
});

test('manifest 没 backend + 目录也没了 → 纯前端，安安静静', () => {
    const res = resolveBackend(light, project({ withDir: false }));
    assert.equal(res.enabled, false);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
});

test('不一致（manifest 有 backend、目录不在）→ 报错，且说得出怎么修', () => {
    const res = resolveBackend(full, project({ withDir: false }));
    assert.equal(res.enabled, false);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /backend\/ 目录不存在/);
    assert.match(res.errors[0], /schemaVersion/);
});

test('不一致（manifest 没 backend、目录还在）→ 只警告，按纯前端继续', () => {
    const res = resolveBackend(light, project({ withDir: true }));
    assert.equal(res.enabled, false);
    assert.deepEqual(res.errors, []);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /backend\//);
});

test('声明了 backend 却不是 schemaVersion 2 → 报错（与 BACKEND_REQUIRES_SCHEMA_2 同口径）', () => {
    const res = resolveBackend({ ...full, schemaVersion: 1 }, project({ withDir: true }));
    assert.equal(res.enabled, false);
    assert.ok(res.errors.some(e => /schemaVersion/.test(e)));
});

// ── ptx build ───────────────────────────────────────────────────────────

test('build：有后端走根 tsconfig；无后端只构建 web（绕开那条 ./backend 引用）', () => {
    assert.deepEqual(typeCheckArgs(true), ['tsc', '-b']);
    assert.deepEqual(typeCheckArgs(false), ['tsc', '-b', 'web']);
});

// ── ptx dev ─────────────────────────────────────────────────────────────

test('dev：无后端时只起 vite，一个 wrangler 都不起', () => {
    const root = project({ withDir: false });
    const { hasBackend, procs } = planDev(light, root);
    assert.equal(hasBackend, false);
    assert.deepEqual(procs.map(p => p.name), ['web']);
    assert.equal(procs.length, 1);
    assert.ok(!JSON.stringify(procs).includes('wrangler'));
    assert.deepEqual(procs[0].args.slice(0, 1), ['vite']);
});

test('dev：有后端时 worker 先起、vite 后起（顺序是有意的）', () => {
    const root = project({ withDir: true });
    const { hasBackend, procs } = planDev(full, root, { webPort: '5273', apiPort: '8887' });
    assert.equal(hasBackend, true);
    assert.deepEqual(procs.map(p => p.name), ['worker', 'web']);
    assert.deepEqual(procs[0].args, ['wrangler', 'dev', '--port', '8887', '--local']);
    assert.equal(procs[0].cwd, `${root}/backend`);
    assert.deepEqual(procs[1].args, ['vite', '--port', '5273', '--strictPort']);
});

test('dev：透传参数只给 wrangler；无后端时不会被偷偷塞给 vite', () => {
    const withBe = planDev(full, project({ withDir: true }), { extraArgs: ['--inspect'] });
    assert.ok(withBe.procs[0].args.includes('--inspect'));
    const light1 = planDev(light, project({ withDir: false }), { extraArgs: ['--inspect'] });
    assert.ok(!light1.procs[0].args.includes('--inspect'));
});

test('dev：manifest 说有后端但目录没了 → 直接抛，而不是等 wrangler 报 ENOENT', () => {
    assert.throws(() => planDev(full, project({ withDir: false })), /backend\/ 目录不存在/);
});
