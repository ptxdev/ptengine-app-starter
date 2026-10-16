import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from './manifest.mjs';
import {
    createStubState, frameLocally, handleNotifyEmail, localAppName, resolveRecipientsLocally,
    sanitizeLocally, textFromHtml, validateNotifyInput
} from './local-stub/notify.mjs';

const OK = { to: ['role:admin', 'user:u2'], subject: '周报', html: '<p style="color:red">本周</p>' };
const codeOf = r => r?.body?.error?.code;
const PREVIEW = { sub: 'local-user', trg: 'job', job: 'local', run: 'run-1', mode: 'preview', scopes: ['notify:send'] };
const RUN = { ...PREVIEW, run: 'run-2', mode: 'run' };
const USER = { sub: 'local-user', scopes: ['notify:send'] };

test('validateNotifyInput：合法 → null', () => {
    assert.equal(validateNotifyInput(OK), null);
    assert.equal(validateNotifyInput({ ...OK, text: 't', replyTo: 'user:u1', locale: 'en-US' }), null);
    assert.equal(validateNotifyInput({ ...OK, text: null, locale: null }), null);
});

test('validateNotifyInput：收件人形状 → NOTIFY_RECIPIENT_INVALID（先于内容判）', () => {
    for (const to of [undefined, 'role:admin', [], ['a@b.c'], ['role:guest'], Array.from({ length: RULES.notify.maxRefsPerCall + 1 }, (_, i) => `user:u${i}`)]) {
        assert.equal(codeOf(validateNotifyInput({ ...OK, to, subject: '' })), 'NOTIFY_RECIPIENT_INVALID', JSON.stringify(to)?.slice(0, 40));
    }
    assert.equal(codeOf(validateNotifyInput({ ...OK, replyTo: 'role:admin' })), 'NOTIFY_RECIPIENT_INVALID');
});

test('validateNotifyInput：内容 → NOTIFY_CONTENT_INVALID（码点 / 字节都按 rules）', () => {
    const n = RULES.notify;
    for (const patch of [
        { subject: '' }, { subject: '   ' }, { subject: 'a\nb' }, { subject: '😀'.repeat(n.subjectMax + 1) },
        { html: 42 }, { html: '中'.repeat(Math.floor(n.htmlMaxBytes / 3) + 1) },
        { text: 1 }, { text: 'x'.repeat(n.textMaxBytes + 1) }, { locale: 'fr-FR' }
    ]) {
        assert.equal(codeOf(validateNotifyInput({ ...OK, ...patch })), 'NOTIFY_CONTENT_INVALID', Object.keys(patch)[0]);
    }
    assert.equal(validateNotifyInput({ ...OK, subject: '😀'.repeat(n.subjectMax) }), null);        // 按码点，不按 UTF-16
});

test('validateNotifyInput：上限读传入的 rules，不写字面量', () => {
    assert.equal(codeOf(validateNotifyInput({ ...OK, to: ['user:a', 'user:b', 'user:c'] }, { ...RULES.notify, maxRefsPerCall: 2 })), 'NOTIFY_RECIPIENT_INVALID');
    assert.throws(() => validateNotifyInput(OK, null), /npm run sync-rules/);
});

test('resolveRecipientsLocally：user:<id> → <id>@local.ptx；role:* → 当前 dev 用户；按 accountId 去重', () => {
    assert.deepEqual(resolveRecipientsLocally(['role:admin', 'user:u2', 'role:member', 'user:u2'], { sub: 'me' }), [
        { ref: 'role:admin', accountId: 'me', email: 'me@local.ptx' },
        { ref: 'user:u2', accountId: 'u2', email: 'u2@local.ptx' }
    ]);
});

test('sanitizeLocally：删平台一定会删的东西并报告；内联样式、表格、https 与本地桩图片保留', () => {
    const { html, removed } = sanitizeLocally(
        '<html><head><style>p{color:red}</style></head><body>' +
        '<p style="color:blue" onclick="x()">hi</p><script>alert(1)</script><iframe src="https://x"></iframe>' +
        '<a href="javascript:alert(1)">bad</a><a href="https://ok.test">ok</a>' +
        '<img src="data:image/png;base64,AAA"><img src="http://evil.test/x.png"><img src="https://ok.test/a.png">' +
        '<img src="http://localhost:8788/__ptx/media/0123456789abcdef0123456789abcdef.png"><table><tr><td>1</td></tr></table>' +
        '</body></html>');
    for (const gone of ['<script', 'alert(1)</script>', '<iframe', 'onclick', 'javascript:', 'data:image', 'http://evil.test', '<style', '<head']) {
        assert.ok(!html.includes(gone), gone);
    }
    for (const kept of ['style="color:blue"', 'https://ok.test', 'https://ok.test/a.png', 'http://localhost:8788/__ptx/media/', '<table>']) {
        assert.ok(html.includes(kept), kept);
    }
    for (const w of ['<head>', '<style>', '<script>', '<iframe>']) assert.ok(removed.includes(w), w);
    assert.ok(removed.some(w => w.includes('on*')));
    assert.ok(removed.some(w => w.includes('https')));
});

test('frameLocally：三语页脚、正文锚点、退订占位符（草稿 / 交互邮件只有应用级）', () => {
    const job = frameLocally({ subject: '周报<x>', bodyHtml: '<p>B</p>', appName: '我的应用', jobTitle: '每周报告', locale: 'zh-CN' });
    assert.ok(job.includes('<!--pt-body-start--><p>B</p><!--pt-body-end-->'));
    assert.ok(job.includes('%%PT_UNSUBSCRIBE_JOB_URL%%') && job.includes('%%PT_UNSUBSCRIBE_APP_URL%%'));
    assert.ok(job.includes('本邮件由 Ptengine 应用「我的应用」发送 · 任务：每周报告'));
    assert.ok(job.includes('<title>周报&lt;x&gt;</title>'));
    const user = frameLocally({ subject: 's', bodyHtml: 'b', appName: 'A', jobTitle: null, locale: 'en-US' });
    assert.ok(!user.includes('%%PT_UNSUBSCRIBE_JOB_URL%%') && user.includes('%%PT_UNSUBSCRIBE_APP_URL%%'));
    assert.ok(user.includes('lang="en-US"'));
});

test('textFromHtml：去标签、块级换行、实体还原', () => {
    assert.equal(textFromHtml('<h2>标题</h2><p>a &amp; b</p>x<br>y'), '标题\na & b\nx\ny');
});

test('localAppName：display_name.zh-CN → id → local-dev', () => {
    assert.equal(localAppName({ id: 'my-app', display_name: { 'zh-CN': '我的应用' } }), '我的应用');
    assert.equal(localAppName({ id: 'my-app' }), 'my-app');
    assert.equal(localAppName({}), 'local-dev');
});

test('handleNotifyEmail：预览 → intercepted / sent 0，outbox 落在 runId 目录，payload 留占位符、previewHtml 换成 #', () => {
    const r = handleNotifyEmail(createStubState(), { claims: PREVIEW, body: OK, appName: '我的应用' });
    assert.equal(r.status, 200);
    assert.equal(r.body.preview, true);
    assert.equal(r.body.sent, 0);
    assert.deepEqual(r.body.recipients.map(x => x.status), ['intercepted', 'intercepted']);
    assert.equal(r.outbox.dir, 'run-1');
    assert.ok(r.outbox.payload.html.includes('%%PT_UNSUBSCRIBE_APP_URL%%'));
    assert.ok(!r.outbox.previewHtml.includes('%%'));
    assert.equal(r.outbox.payload.subject, '周报');
    assert.deepEqual(r.outbox.payload.recipients.map(x => x.email), ['local-user@local.ptx', 'u2@local.ptx']);
    // 结果（回给应用的那份）里永远没有邮箱
    assert.ok(!JSON.stringify(r.body).includes('@'));
});

test('handleNotifyEmail：正式运行 → sent；交互调用 → interactive 目录、不计 run 次数', () => {
    const s = createStubState();
    const run = handleNotifyEmail(s, { claims: RUN, body: OK, appName: 'A' });
    assert.equal(run.body.preview, false);
    assert.equal(run.body.sent, 2);
    const user = handleNotifyEmail(s, { claims: USER, body: OK, appName: 'A' });
    assert.equal(user.outbox.dir, 'interactive');
    assert.equal(s.runs.size, 1);
});

test('handleNotifyEmail：本 run 调用次数 / 收件人累计超限 → 409 NOTIFY_RUN_LIMIT_EXCEEDED（上限读 rules）', () => {
    const rules = { ...RULES.notify, maxCallsPerRun: 2, maxRecipientsPerRun: 3 };
    const s = createStubState();
    assert.equal(handleNotifyEmail(s, { claims: RUN, body: { ...OK, to: ['user:a'] }, appName: 'A', rules }).status, 200);
    assert.equal(handleNotifyEmail(s, { claims: RUN, body: { ...OK, to: ['user:b', 'user:c'] }, appName: 'A', rules }).status, 200);
    assert.equal(codeOf(handleNotifyEmail(s, { claims: RUN, body: { ...OK, to: ['user:d'] }, appName: 'A', rules })), 'NOTIFY_RUN_LIMIT_EXCEEDED');
    const s2 = createStubState();
    assert.equal(handleNotifyEmail(s2, { claims: RUN, body: { ...OK, to: ['user:a', 'user:b'] }, appName: 'A', rules }).status, 200);
    assert.equal(codeOf(handleNotifyEmail(s2, { claims: RUN, body: { ...OK, to: ['user:c', 'user:d'] }, appName: 'A', rules })), 'NOTIFY_RUN_LIMIT_EXCEEDED');
});

test('handleNotifyEmail：校验失败原样返回，不写 outbox、不计次数', () => {
    const s = createStubState();
    const r = handleNotifyEmail(s, { claims: RUN, body: { ...OK, subject: '' }, appName: 'A' });
    assert.equal(codeOf(r), 'NOTIFY_CONTENT_INVALID');
    assert.equal(r.outbox, undefined);
    assert.equal(s.runs.size, 0);
});
