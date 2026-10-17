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

test('notifyChannel 段（1c brief §1.6）：键齐全、数值与 brief 一致、正则能编译且口径正确、并发上限与邮件共用', () => {
    const c = RULES.notifyChannel;
    assert.ok(c, '缺 notifyChannel 段（跑 npm run sync-rules）');
    assert.deepEqual(c.types, ['slack', 'teams', 'chatwork', 'webhook']);
    assert.deepEqual(
        { titleMax: c.titleMax, textMax: c.textMax, linkLabelMax: c.linkLabelMax, linkPathMax: c.linkPathMax,
          maxPerRun: c.maxPerRun, maxPerWorkspacePerMinute: c.maxPerWorkspacePerMinute, maxBodyBytes: c.maxBodyBytes },
        { titleMax: 150, textMax: 3000, linkLabelMax: 50, linkPathMax: 512, maxPerRun: 10, maxPerWorkspacePerMinute: 30, maxBodyBytes: 16384 }
    );
    // 渠道与邮件共用网关的 notifyInflight（brief §1.3 / C21）
    assert.equal(c.maxConcurrentPerApp, RULES.notify.maxConcurrentPerApp);
    const name = new RegExp(c.namePattern);
    for (const ok of ['alerts', 'ops-team_1', '0', 'a'.repeat(64)]) assert.ok(name.test(ok), ok);
    for (const bad of ['', 'Alerts', '-x', '_x', 'a b', 'a'.repeat(65), 'チャンネル', 'a.b']) assert.ok(!name.test(bad), bad);
    const path = new RegExp(c.linkPathPattern);
    for (const ok of ['', 'reports/42', 'r?x=1&y=2', "a-b._~!$&'()*+,;=:@/%20"]) assert.ok(path.test(ok), ok);
    for (const bad of ['#x', 'a b', 'a\nb', 'こ', 'a"b', 'a<b']) assert.ok(!path.test(bad), bad);
    const media = new RegExp(c.mediaPathPattern);
    assert.ok(media.test(`/media/ws-1/my-app/${'a'.repeat(32)}.png`));
    assert.ok(!media.test(`/media/ws-1/my-app/${'a'.repeat(31)}.png`));
    assert.equal(c.testTitlePrefix, '[TEST] ');
    assert.deepEqual(Object.keys(c.webhookHeaders).sort(), ['id', 'signature', 'timestamp']);
    assert.ok(Object.values(c.webhookHeaders).every(v => typeof v === 'string' && v.startsWith('x-pt-webhook-')));
    assert.equal(c.signatureVersion, 'v1');
});
