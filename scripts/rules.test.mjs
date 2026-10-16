/**
 * 规则快照里定时任务 1b 的三段（brief §1.5）。starter 的本地桩、doctor、ptx job run 全部读它们，不写字面量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from './manifest.mjs';

test('validScopes 末尾是 notify:send（manifest 校验据此放行）', () => {
    assert.equal(RULES.validScopes.at(-1), 'notify:send');
});

test('notify 段：数值上限齐全，三语 locale，ref / replyTo 正则能编译且口径正确', () => {
    const n = RULES.notify;
    for (const k of ['maxRefsPerCall', 'maxRecipientsPerRun', 'maxCallsPerRun', 'subjectMax', 'htmlMaxBytes', 'textMaxBytes']) {
        assert.equal(typeof n[k], 'number', k);
        assert.ok(n[k] > 0, k);
    }
    assert.deepEqual(n.locales, ['zh-CN', 'en-US', 'ja-JP']);
    assert.ok(n.locales.includes(n.defaultLocale));
    assert.deepEqual(n.roles, ['owner', 'admin', 'member']);
    const ref = new RegExp(n.refPattern);
    for (const ok of ['user:abc', 'user:A_b-9', 'role:owner', 'role:admin', 'role:member']) assert.ok(ref.test(ok), ok);
    for (const bad of ['a@b.c', 'role:guest', 'user:', 'user:a b', 'group:x']) assert.ok(!ref.test(bad), bad);
    const reply = new RegExp(n.replyToPattern);
    assert.ok(reply.test('user:u1'));
    assert.ok(!reply.test('role:admin'));
});

test('render 段与 jobLog 段', () => {
    const r = RULES.render;
    for (const k of ['optionMaxBytes', 'minDimension', 'maxDimension', 'defaultWidth', 'defaultHeight', 'maxPerRun']) assert.equal(typeof r[k], 'number', k);
    assert.ok(r.minDimension <= r.defaultWidth && r.defaultWidth <= r.maxDimension);
    assert.deepEqual(r.themes, ['light', 'dark']);
    // option 白名单（一致性评审 S10）：与平台 sanitizeChartOption 同一组 contract 常量
    assert.equal(typeof r.maxDepth, 'number');
    assert.ok(Array.isArray(r.forbiddenKeys) && r.forbiddenKeys.includes('image'));
    assert.ok(Array.isArray(r.forbiddenStringPrefixes) && r.forbiddenStringPrefixes.includes('image://'));
    assert.ok(Array.isArray(r.droppedTopLevelKeys) && r.droppedTopLevelKeys.length > 0);
    const j = RULES.jobLog;
    assert.equal(j.headerName, 'x-pt-job-log');
    // 日志头解码（一致性评审 S9）：与平台 parseRunLogHeader 同一组上限
    for (const k of ['headerMaxBytes', 'maxEntries', 'entryMessageMax', 'entryFieldsMaxBytes']) assert.equal(typeof j[k], 'number', k);
});
