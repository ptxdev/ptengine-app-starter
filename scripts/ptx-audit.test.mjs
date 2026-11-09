import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { exitCodeOf, localize, localizeAll } from './ptx-audit.mjs';

// 与 manifest.mjs 读 rules.json 同一种方式：不依赖 import attributes，老一点的 Node 也能跑
const rules = createRequire(import.meta.url)('./audit-rules.json');

test('exitCodeOf：severe→2，只有 normal→1，空→0', () => {
    assert.equal(exitCodeOf([]), 0);
    assert.equal(exitCodeOf([{ severity: 'normal' }]), 1);
    assert.equal(exitCodeOf([{ severity: 'normal' }, { severity: 'severe' }]), 2);
});

test('audit-rules.json：23 条、三语齐全、维度与严重度合法', () => {
    const ids = Object.keys(rules);
    assert.equal(ids.length, 23);
    for (const [id, r] of Object.entries(rules)) {
        assert.ok(['security', 'ai-cost', 'efficiency', 'design'].includes(r.dimension), id);
        assert.ok(['severe', 'normal'].includes(r.severity), id);
        for (const k of ['title', 'detail', 'fix']) for (const l of ['zh-CN', 'en-US', 'ja-JP']) assert.ok(r[k]?.[l], `${id}.${k}.${l}`);
    }
});

test('localize：id = rule:file:line，占位符按 args 替换；localizeAll 三语全带', () => {
    const raw = { rule: 'SEC-002', file: 'backend/src/index.ts', line: 12, args: { host: 'api.example.com' } };
    const f = localize(raw, rules, 'zh-CN');
    assert.equal(f.id, 'SEC-002:backend/src/index.ts:12');
    assert.equal(f.severity, 'severe');
    assert.ok(f.title.includes('api.example.com'));
    const all = localizeAll(raw, rules);
    assert.ok(all.title['ja-JP'].includes('api.example.com'));
    assert.equal(localize({ ...raw, severity: 'normal' }, rules, 'en-US').severity, 'normal');
});
