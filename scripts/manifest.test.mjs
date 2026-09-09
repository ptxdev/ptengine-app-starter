/**
 * manifest 校验的回归测试。用 Node 内置 test runner —— 本仓没有测试框架，不为这件事引一个。
 *
 * 重点锁两件事：
 *   1. 规则来自 `scripts/rules.json`（contract 包的生成快照），不是脚本里另抄一份；
 *   2. `backend.vars` 与 `backend.secrets` 共用一套名字检查（同一个 env 命名空间）。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RULES, validateManifest } from './manifest.mjs';

/** 造一个只有 manifest.json 的临时项目根（validateManifest 会去读 backend/migrations）。 */
function rootWith(manifest) {
    const dir = mkdtempSync(join(tmpdir(), 'ptx-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
}
const withBackend = backend => ({
    schemaVersion: 2, version: '1.0.0', entry: 'index.html',
    backend: { entry: '_backend/worker.js', routes: ['/api/*'], ...backend }
});
const codes = res => res.errors.map(e => e.split('  ')[0]);

test('规则来自 rules.json，不是脚本里另抄一份', () => {
    assert.equal(RULES.appId.maxLen, 50);
    assert.equal(RULES.appId.pattern, '^[a-z0-9][a-z0-9-]{0,49}$');       // 创建规则
    assert.equal(RULES.appId.parsePattern, '^[a-z0-9][a-z0-9-]{0,62}$');  // 解析规则，starter 不用它校验 manifest.id
    assert.equal(RULES.appId.reservedPrefix, 'pt-');
    assert.equal(RULES.limits.vars, 64);
    assert.equal(RULES.name.pattern, '^[A-Z][A-Z0-9_]*$');
});

test('vars：字符串与对象两种形态都收', () => {
    const m = withBackend({ vars: ['API_BASE', { name: 'TIMEOUT_MS', required: false, default: '3000' }] });
    assert.deepEqual(validateManifest(m, rootWith(m)).errors, []);
});

test('vars：名字非法 / PT_ 保留 / 重复 / 与 secrets 同名', () => {
    const bad = [
        [{ vars: ['api_base'] }, 'BACKEND_VAR_NAME_INVALID'],
        [{ vars: ['PT_ENV'] }, 'BACKEND_VAR_NAME_RESERVED'],
        [{ vars: ['A', 'A'] }, 'BACKEND_VAR_DUPLICATED'],
        [{ vars: ['TOKEN'], secrets: ['TOKEN'] }, 'BACKEND_VAR_CONFLICTS_SECRET']
    ];
    for (const [backend, code] of bad) {
        const m = withBackend(backend);
        assert.ok(codes(validateManifest(m, rootWith(m))).includes(code), `期望 ${code}`);
    }
});

test('三项上限', () => {
    const names = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    for (const [backend, code] of [
        [{ vars: names(65, 'V') }, 'BACKEND_VARS_TOO_MANY'],
        [{ secrets: names(65, 'S') }, 'BACKEND_SECRETS_TOO_MANY'],
        [{ egress: Array.from({ length: 33 }, (_, i) => `h${i}.example.com`) }, 'BACKEND_EGRESS_TOO_MANY']
    ]) {
        const m = withBackend(backend);
        assert.ok(codes(validateManifest(m, rootWith(m))).includes(code), `期望 ${code}`);
    }
});

test('appId：50 上限与 pt- 保留前缀', () => {
    for (const [id, code] of [['a'.repeat(51), 'APP_ID_INVALID'], ['pt-shop', 'APP_ID_RESERVED']]) {
        const m = { ...withBackend({}), id };
        assert.ok(codes(validateManifest(m, rootWith(m))).includes(code), `期望 ${code}`);
    }
    const okM = { ...withBackend({}), id: 'my-shop' };
    assert.deepEqual(codes(validateManifest(okM, rootWith(okM))).filter(c => c.startsWith('APP_ID')), []);
});

test('v1（无 backend 段）不受任何新规则影响', () => {
    const m = { schemaVersion: 1, version: '1.0.0', entry: 'index.html' };
    assert.deepEqual(validateManifest(m, rootWith(m)).errors, []);
});
