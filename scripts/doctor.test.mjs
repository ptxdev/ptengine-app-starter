/**
 * `ptx doctor` 的配置项体检回归测试。
 *
 * 锁的是两个"违反后不报错"的坑（见 checkVars 的注释）：必填 var 没落到本地
 * `.dev.vars`，以及 `.dev.vars` 里有 manifest 没声明的名字。
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkVars } from './ptx-doctor.mjs';

function project({ devVars = null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ptx-doc-'));
    mkdirSync(join(dir, 'backend'), { recursive: true });
    if (devVars !== null) writeFileSync(join(dir, 'backend', '.dev.vars'), devVars);
    return dir;
}
const manifest = vars => ({ schemaVersion: 2, version: '1.0.0', entry: 'index.html', backend: { entry: '_backend/worker.js', routes: ['/api/*'], vars } });

test('必填 var 没在 .dev.vars 里 → warn，并说清是本地跑不起来而不是发布会失败', () => {
    const res = checkVars(project({ devVars: '' }), manifest(['API_BASE']));
    assert.equal(res.level, 'warn');
    assert.match(res.why, /API_BASE/);
    assert.match(res.why, /\.dev\.vars/);
});

test('填了就通过；有 default 的可选项不填也通过', () => {
    assert.equal(checkVars(project({ devVars: 'API_BASE=https://a.test\n' }), manifest(['API_BASE'])).level, 'ok');
    assert.equal(checkVars(project({ devVars: '' }), manifest([{ name: 'T', required: false, default: '1' }])).level, 'ok');
});

test('.dev.vars 里有 manifest 没声明的名字 → warn（线上不会注入，只在本地"能跑"）', () => {
    const res = checkVars(project({ devVars: 'GHOST=1\n' }), manifest([]));
    assert.equal(res.level, 'warn');
    assert.match(res.why, /GHOST/);
});

test('没有 backend 段（v1）→ ok，且不去读 .dev.vars', () => {
    assert.equal(checkVars(project(), { schemaVersion: 1, version: '1.0.0', entry: 'index.html' }).level, 'ok');
});

// ── 下面几条不在 brief 里，是实现时发现的边界 ──────────────────────────────

test('ptx dev 自己写进去的 PT_JWKS_JSON 不算"多余的名字"', () => {
    const res = checkVars(project({ devVars: '# --- 以下由 ptx dev 自动生成 ---\nPT_JWKS_JSON={"keys":[]}\n' }), manifest([]));
    assert.equal(res.level, 'ok');
});

test('声明成密钥的名字填在 .dev.vars 里也算"声明过"（同一个文件、同一个命名空间）', () => {
    const m = manifest([]);
    m.backend.secrets = [{ name: 'SHOPIFY_TOKEN', required: true }];
    assert.equal(checkVars(project({ devVars: 'SHOPIFY_TOKEN=shpat_x\n' }), m).level, 'ok');
});

test('.dev.vars 整个不存在时，必填 var 一样报 warn（不是静默通过）', () => {
    assert.equal(checkVars(project(), manifest(['API_BASE'])).level, 'warn');
});
