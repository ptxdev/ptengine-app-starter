/**
 * 本地 dev token 的 scopes 必须照抄 manifest.json。
 *
 * 以前它写死 `['analytics:read','profile:read','user:read','ui:notify']`：声明了
 * `asset:read` / `asset:write` / `ai:invoke` 的应用本地一调就 403 `SCOPE_REQUIRED`，
 * 线上却是通的 —— 本地与线上不一致，正是 dev 密钥这套机制本来要消灭的东西。
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { devTokenScopes, generateDevKeys } from './dev-keys.mjs';

/** 最小可用的有后端项目：manifest + backend/wrangler.jsonc + web/。 */
function project(manifestExtra) {
    const dir = mkdtempSync(join(tmpdir(), 'ptx-devkeys-'));
    mkdirSync(join(dir, 'backend'), { recursive: true });
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'wrangler.jsonc'), JSON.stringify({
        vars: { PT_TOKEN_ISS: 'https://iss.test', PT_TOKEN_AUD: 'app:test' }
    }));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        schemaVersion: 2, version: '1.0.0', entry: 'index.html',
        backend: { entry: '_backend/worker.js', routes: ['/api/*'] },
        ...manifestExtra
    }));
    return dir;
}
const devKey = dir => JSON.parse(readFileSync(join(dir, 'web', '.ptx-dev-key.json'), 'utf8'));

test('token scopes 照抄 manifest.scopes（含 asset:read / asset:write / ai:invoke）', () => {
    const declared = ['analytics:read', 'asset:read', 'asset:write', 'ai:invoke'];
    const dir = project({ scopes: declared });
    const res = generateDevKeys(dir);
    assert.deepEqual(res.scopes, declared);
    assert.deepEqual(devKey(dir).scopes, declared);
});

test('没声明的 scope 不会出现在 token 里（本地照样 403，与线上一致）', () => {
    const dir = project({ scopes: ['ui:notify'] });
    generateDevKeys(dir);
    assert.deepEqual(devKey(dir).scopes, ['ui:notify']);
});

test('没有 scopes 字段 / 空数组 → 空 scopes，不报错', () => {
    assert.deepEqual(devTokenScopes({}), []);
    assert.deepEqual(devTokenScopes({ scopes: [] }), []);
    const dir = project({});
    generateDevKeys(dir);
    assert.deepEqual(devKey(dir).scopes, []);
});

test('重复项去重', () => {
    assert.deepEqual(devTokenScopes({ scopes: ['asset:read', 'asset:read'] }), ['asset:read']);
});

test('scopes 形状不对 → 明确报错，且不留下半套密钥文件', () => {
    for (const bad of ['analytics:read', { a: 1 }, [1], ['']]) {
        assert.throws(() => devTokenScopes({ scopes: bad }), /scopes 必须是字符串数组/);
    }
    const dir = project({ scopes: 'analytics:read' });
    assert.throws(() => generateDevKeys(dir), /scopes 必须是字符串数组/);
    assert.equal(existsSync(join(dir, 'web', '.ptx-dev-key.json')), false);
    assert.equal(existsSync(join(dir, 'backend', '.dev.vars')), false);
});
