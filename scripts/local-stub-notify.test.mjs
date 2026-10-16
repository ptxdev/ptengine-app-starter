import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from './manifest.mjs';
import {
    createStubState, frameLocally, handleNotifyEmail, localAppName, resolveRecipientsLocally,
    extractBody, filterStyle, frameTextLocally, neutralizePlaceholders, sanitizeLocally, textFromHtml, validateNotifyInput
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
    assert.equal(validateNotifyInput({ ...OK, replyTo: null }), null);                       // 与 backend 一致：replyTo:null 合法
});

test('validateNotifyInput：收件人形状 → NOTIFY_RECIPIENT_INVALID（先于内容判）', () => {
    for (const to of [undefined, 'role:admin', [], ['a@b.c'], ['role:guest'], Array.from({ length: RULES.notify.maxRefsPerCall + 1 }, (_, i) => `user:u${i}`)]) {
        assert.equal(codeOf(validateNotifyInput({ ...OK, to, subject: '' })), 'NOTIFY_RECIPIENT_INVALID', JSON.stringify(to)?.slice(0, 40));
    }
    assert.equal(codeOf(validateNotifyInput({ ...OK, replyTo: 'role:admin' })), 'NOTIFY_RECIPIENT_INVALID');
    for (const body of [null, 'x', 42, [OK]]) {                                               // 与 backend 同序：非对象先按收件人判
        assert.equal(codeOf(validateNotifyInput(body)), 'NOTIFY_RECIPIENT_INVALID', JSON.stringify(body)?.slice(0, 20));
    }
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

test('frameLocally：三语页脚、正文锚点、退订占位符；「退订此任务」按 hasJob（草稿预览有标题、没有任务链接）', () => {
    const job = frameLocally({ subject: '周报<x>', bodyHtml: '<p>B</p>', appName: '我的应用', jobTitle: '每周报告', hasJob: true, locale: 'zh-CN' });
    assert.ok(job.includes('<!--pt-body-start--><p>B</p><!--pt-body-end-->'));
    assert.ok(job.includes('%%PT_UNSUBSCRIBE_JOB_URL%%') && job.includes('%%PT_UNSUBSCRIBE_APP_URL%%'));
    assert.ok(job.includes('本邮件由 Ptengine 应用「我的应用」发送 · 任务：每周报告'));
    assert.ok(job.includes('<title>周报&lt;x&gt;</title>'));
    assert.ok(job.includes('退订此任务</a> &nbsp;|&nbsp; <a href="%%PT_UNSUBSCRIBE_APP_URL%%" target="_blank" rel="noopener noreferrer"'));
    const draft = frameLocally({ subject: 's', bodyHtml: 'b', appName: 'A', jobTitle: '草稿标题', hasJob: false, locale: 'zh-CN' });
    assert.ok(draft.includes(' · 任务：草稿标题') && !draft.includes('%%PT_UNSUBSCRIBE_JOB_URL%%'));
    const user = frameLocally({ subject: 's', bodyHtml: 'b', appName: 'A', jobTitle: null, hasJob: false, locale: 'en-US' });
    assert.ok(!user.includes('%%PT_UNSUBSCRIBE_JOB_URL%%') && user.includes('%%PT_UNSUBSCRIBE_APP_URL%%'));
    assert.ok(user.includes('lang="en-US"'));
});

test('frameLocally / frameTextLocally：文案与平台 email-layout.ts 逐字一致；法定页脚占位', () => {
    const en = frameLocally({ subject: 's', bodyHtml: 'b', appName: 'A', jobTitle: null, hasJob: false, locale: 'en-US' });
    assert.ok(en.includes('This email was sent by the Ptengine app &quot;A&quot;'));
    assert.ok(en.includes('Unsubscribe from all emails from this app'));
    const ja = frameLocally({ subject: 's', bodyHtml: 'b', appName: 'A', jobTitle: 't', hasJob: true, locale: 'ja-JP' });
    assert.ok(ja.includes('このアプリからのメールをすべて停止') && ja.includes('このタスクの配信を停止'));
    assert.ok(ja.includes('法定表示'));
    const text = frameTextLocally({ bodyText: '正文\n\n\n', appName: 'A', jobTitle: 't', hasJob: false, locale: 'zh-CN' });
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['正文', '', '-- ', '本邮件由 Ptengine 应用「A」发送 · 任务：t']);
    assert.equal(lines[4], '退订此应用的全部邮件: %%PT_UNSUBSCRIBE_APP_URL%%');
    assert.ok(lines[5].includes('法定表示'));
    assert.ok(!text.includes('%%PT_UNSUBSCRIBE_JOB_URL%%'));
});

test('frameLocally：规则快照有、本地文案没有的语言 → 抛可读错误', () => {
    assert.throws(() => frameLocally({ subject: 's', bodyHtml: 'b', appName: 'A', jobTitle: null, locale: 'ko-KR' }),
        /规则快照的语言比本地文案新：ko-KR/);
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

test('extractBody：与平台同口径 —— 不要求 </body> 闭合（没闭合取到结尾）', () => {
    assert.equal(extractBody('<html><body class="x"><p>a</p></body></html>'), '<p>a</p>');
    assert.equal(extractBody('<html><body><p>a</p>'), '<p>a</p>');
    assert.equal(extractBody('<p>a</p>'), '<p>a</p>');
    assert.equal(sanitizeLocally('<head><title>t</title></head><body><p>正文</p>').html, '<p>正文</p>');
});

test('filterStyle：与平台同口径 —— --* / var( / attr( / @ / expression / behavior / 非 https url 整条丢，其余保留', () => {
    assert.equal(filterStyle('color:red; --x: 1; background:var(--x); content:attr(title); width:10px').style, 'color:red; width:10px');
    assert.equal(filterStyle('background:url(http://x/a.png); color:red').style, 'color:red');
    assert.equal(filterStyle('background:url(https://x/a.png)').style, 'background:url(https://x/a.png)');
    assert.equal(filterStyle('background-image:image-set("http://x" 1x)').style, '');
    assert.equal(filterStyle('width:expr/**/ession(1); color:red').style, 'color:red');
    assert.equal(filterStyle('-ms-behavior:url(#x); color:red').style, 'color:red');
    assert.equal(filterStyle('color:red; @import x').style, 'color:red');
    assert.equal(filterStyle('u\\72l(x); color:red').style, '');                        // 反斜杠整段丢
    assert.equal(filterStyle('color:red; }').style, '');                              // 词法异常整段丢
    assert.equal(filterStyle('color:red').dropped, false);
    assert.equal(filterStyle('color:red; --x:1').dropped, true);
});

test('sanitizeLocally：不比平台宽 —— 允许名单外的标签 / 属性、相对与协议相对链接、实体混淆的 javascript:、style 实体都处理掉', () => {
    const { html, removed } = sanitizeLocally(
        '<div data-x="1" class="c" id="i"><custom>文本</custom>' +
        '<a href="/rel">r</a><a href="//evil.test">p</a><a href="jav&#97;script:alert(1)">e</a><a href="mailto:a@b.c" target="_self">m</a>' +
        '<img src="http://localhost:8788/x.png"><img src="http://127.0.0.1:8788/__ptx/media/0123456789abcdef0123456789abcdef.png">' +
        '<p style="background:var(--a)">v</p><p style="u&#92;72l(x)">s</p><!-- c --><noscript>n</noscript>a < b</div>');
    for (const gone of ['data-x', 'class=', 'id=', '<custom', '/rel', '//evil.test', 'javascript', 'alert', 'localhost:8788/x.png',
        '127.0.0.1', 'var(', 'style="u', '<!--', 'noscript', '>n<']) {
        assert.ok(!html.includes(gone), gone);
    }
    assert.ok(html.includes('文本') && html.includes('a &lt; b'));
    assert.ok(html.includes('<a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">m</a>'));
    assert.ok(removed.some(w => w.includes('内联样式')));
});

test('handleNotifyEmail：hasJob 口径、正文与标题里伪造的退订占位符被中和、text 用平台结构、mediaUrls 只收本地桩图表', () => {
    const body = { ...OK, locale: 'zh-CN', subject: '周报%%PT_UNSUBSCRIBE_APP_URL%%',
        html: '<p>%%PT_UNSUBSCRIBE_JOB_URL%%</p><img src="http://localhost:8788/__ptx/media/0123456789abcdef0123456789abcdef.png">' };
    const r = handleNotifyEmail(createStubState(), { claims: PREVIEW, body, appName: 'A' });
    const p = r.outbox.payload;
    assert.equal(p.html.split('%%PT_UNSUBSCRIBE_JOB_URL%%').length, 2);            // 只剩外框里那一个
    assert.equal(p.html.split('%%PT_UNSUBSCRIBE_APP_URL%%').length, 2);
    assert.ok(p.text.includes('退订此任务: %%PT_UNSUBSCRIBE_JOB_URL%%'));
    assert.ok(p.text.includes('-- \n'));
    assert.deepEqual(p.mediaUrls, ['http://localhost:8788/__ptx/media/0123456789abcdef0123456789abcdef.png']);
    const user = handleNotifyEmail(createStubState(), { claims: USER, body: OK, appName: 'A' });
    assert.ok(!user.outbox.payload.html.includes('%%PT_UNSUBSCRIBE_JOB_URL%%'));
    assert.equal(neutralizePlaceholders('%%%PT_UNSUBSCRIBE_APP_URL%%'), '%PT_UNSUBSCRIBE_APP_URL%%');
});
