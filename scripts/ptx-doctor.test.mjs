import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationsAdditive } from './ptx-doctor.mjs';

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
