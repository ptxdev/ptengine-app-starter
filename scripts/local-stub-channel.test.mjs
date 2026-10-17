import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES } from './manifest.mjs';
import { LINK_PATH_DOT_SEGMENT, LINK_PATH_SCHEME, channelRules, handleListChannels, handleNotifyChannel, loadLocalChannels, validateChannelMessage } from './local-stub/channel.mjs';
import { createStubState, runCounters } from './local-stub/notify.mjs';

const C = RULES.notifyChannel;
const codeOf = r => r?.body?.error?.code;
const MSG = { title: '首页 CVR 异常', text: '比上周同期下降 23%' };
const PREVIEW = { sub: 'local-user', trg: 'job', job: 'local', run: 'run-1', mode: 'preview', scopes: ['notify:send'] };
const RUN = { ...PREVIEW, run: 'run-2', mode: 'run' };
const USER = { sub: 'local-user', scopes: ['notify:send'] };
const HEX = 'a'.repeat(32);
const LOCAL_IMG = `http://localhost:8788/__ptx/media/${HEX}.png`;
const call = (state, claims, body, channels = null) => handleNotifyChannel(state, { claims, body, appName: '我的应用', channels });

test('validateChannelMessage：合法 → 规范化（title / label trim、text CRLF/CR→LF、缺省或 null 的 text 为 ""、link 去一个前导 #/ 或 /）', () => {
    const v = validateChannelMessage({ channel: 'alerts', message: { title: '  标题  ', text: 'a\r\nb\rc\td', imageUrl: LOCAL_IMG, link: { label: ' 查看 ', path: '#/reports/42?x=1' } } });
    assert.deepEqual(v.message, { title: '标题', text: 'a\nb\nc\td', imageUrl: LOCAL_IMG, link: { label: '查看', path: 'reports/42?x=1' } });
    assert.deepEqual(v.warnings, []);
    assert.deepEqual(validateChannelMessage({ channel: 'a', message: { title: 't' } }).message, { title: 't', text: '', imageUrl: null, link: null });
    assert.deepEqual(validateChannelMessage({ channel: 'a', message: { title: 't', imageUrl: null, link: null } }).message, { title: 't', text: '', imageUrl: null, link: null });
    // RU4：text: null 视同缺省（与平台 parseChannelMessage 同口径）
    assert.deepEqual(validateChannelMessage({ channel: 'a', message: { title: 't', text: null } }).message, { title: 't', text: '', imageUrl: null, link: null });
    assert.equal(validateChannelMessage({ channel: 'a', message: { title: 't', link: { label: 'x', path: '/a/b' } } }).message.link.path, 'a/b');
    // `:` 不在首段开头照收
    assert.equal(validateChannelMessage({ channel: 'a', message: { title: 't', link: { label: 'x', path: 'reports/a:b' } } }).message.link.path, 'reports/a:b');
});

test('validateChannelMessage：上限读 rules（按码点计；恰在上限内通过）', () => {
    assert.ok(validateChannelMessage({ channel: 'a', message: { title: '😀'.repeat(C.titleMax) } }).message);
    assert.ok(validateChannelMessage({ channel: 'a', message: { title: 't', text: '中'.repeat(C.textMax) } }).message);
    assert.ok(validateChannelMessage({ channel: 'a', message: { title: 't', link: { label: 'l'.repeat(C.linkLabelMax), path: `#/${'p'.repeat(C.linkPathMax)}` } } }).message);
});

test('validateChannelMessage：不合规 → 400 NOTIFY_CHANNEL_MESSAGE_INVALID（与平台 §4.3 同口径，可以更严、不能更宽）', () => {
    const m = patch => ({ channel: 'a', message: { title: 't', ...patch } });
    const p = path => m({ link: { label: 'x', path } });
    const bad = [
        null, 'x', [1], { message: MSG }, { channel: 1, message: MSG }, { channel: null, message: MSG }, { channel: 'a' }, { channel: 'a', message: 'x' }, { channel: 'a', message: [MSG] },
        { channel: 'a', message: {} }, m({ title: '   ' }), m({ title: 'a\nb' }), m({ title: 'a\u0007' }), m({ title: 'a\u007f' }),
        m({ title: '😀'.repeat(C.titleMax + 1) }), m({ title: 1 }),
        m({ text: 1 }), m({ text: 'x'.repeat(C.textMax + 1) }), m({ text: 'a\u0000b' }), m({ text: 'a\u001bb' }),
        m({ imageUrl: 'https://evil.example/x.png' }), m({ imageUrl: 'data:image/png;base64,AA' }), m({ imageUrl: 1 }),
        m({ imageUrl: `http://localhost:8788/__ptx/media/${HEX}.jpg` }), m({ imageUrl: `http://evil.example/media/w/a/${HEX}.png` }),
        // 平台对原串切片后测路径，不做 URL 规范化：空 ? / #、.. / . 段、显式端口、带账号都拒
        m({ imageUrl: `https://m.x/media/w/a/${HEX}.png?` }), m({ imageUrl: `https://m.x/media/w/a/${HEX}.png#` }),
        m({ imageUrl: `https://m.x/z/../media/w/a/${HEX}.png` }), m({ imageUrl: `https://m.x/media/w/a/./${HEX}.png` }),
        m({ imageUrl: `https://m.x:443/media/w/a/${HEX}.png` }), m({ imageUrl: `https://u@m.x/media/w/a/${HEX}.png` }),
        m({ link: 'x' }), m({ link: [1] }), m({ link: { label: '', path: 'a' } }), m({ link: { label: 'a\nb', path: 'a' } }),
        m({ link: { label: 'l'.repeat(C.linkLabelMax + 1), path: 'a' } }), m({ link: { label: 'x' } }), m({ link: { label: 'x', path: 1 } }),
        p('a b'), p('a#b'), p('p'.repeat(C.linkPathMax + 1)),
        // RU1 / P15：带 scheme、去前导后仍以 / 开头、原值以 // 开头 → 拒（平台同判）
        p('//a'), p('https://evil.example.com/x'), p('https:x'), p('HTTPS:x'), p('javascript:alert(1)'), p('#/javascript:alert(1)'),
        p('//evil.example.com/x'), p('//x'), p('#//evil.example.com'), p('#//x'), p('///x'), p('reports:42')
    ];
    for (const body of bad) assert.equal(codeOf(validateChannelMessage(body).error), 'NOTIFY_CHANNEL_MESSAGE_INVALID', JSON.stringify(body)?.slice(0, 70));
});

test('400 NOTIFY_CHANNEL_MESSAGE_INVALID 带 details.field，字段名与平台 parseChannelMessage 一致', () => {
    const m = patch => ({ channel: 'a', message: { title: 't', ...patch } });
    const cases = [
        [{ channel: 1, message: MSG }, 'channel'], [{ channel: 'a', message: 'x' }, 'message'], [m({ title: '' }), 'message.title'],
        [m({ text: 1 }), 'message.text'], [m({ imageUrl: 'https://evil.example/x.png' }), 'message.imageUrl'], [m({ link: 'x' }), 'message.link'],
        [m({ link: { label: '', path: 'a' } }), 'message.link.label'], [m({ link: { label: 'x', path: '//a' } }), 'message.link.path']
    ];
    for (const [body, field] of cases) assert.deepEqual(validateChannelMessage(body).error.body.error.details, { field }, field);
    assert.equal(validateChannelMessage(null).error.body.error.details, undefined);
});

test('LINK_PATH_SCHEME / LINK_PATH_DOT_SEGMENT 锁值 = contract NOTIFY_CHANNEL_LINK_PATH_SCHEME_PATTERN / NOTIFY_CHANNEL_LINK_PATH_DOT_SEGMENT_PATTERN（未进 rules.json 的本地副本，R11）', () => {
    assert.equal(LINK_PATH_SCHEME.source, '^[a-z][a-z0-9+.-]*:');
    assert.equal(LINK_PATH_SCHEME.flags, 'i');
    assert.equal(LINK_PATH_DOT_SEGMENT.source, '^(?:[^?]*\\/)?(?:\\.|%2e){1,2}(?:[/?]|$)');
    assert.equal(LINK_PATH_DOT_SEGMENT.flags, 'i');
});

test('link.path 点段（R11）：? 之前的 . / .. 段（含任意大小写 %2e，含 #/ 或 / 前导之后）→ 400 message.link.path', () => {
    const p = path => validateChannelMessage({ channel: 'a', message: { title: 't', link: { label: 'x', path } } });
    // 平台 channel-message.spec.ts 与 contract notify-channel-constants.test.ts 的命中用例
    const hits = ['..', '.', '../x', './x', 'a/../b', 'a/./b', 'x/.', 'x/..', '%2e%2e/x', '%2E%2e/x', '.%2e/x', '%2e./x', 'a/%2E/b', 'a/..?q=1',
        '../../other/settings', '%2e%2e/%2E%2E/%2e%2e/%2e%2e/login?next=x', '#/../x', '/../x', '#/./x', '/%2e/x'];
    for (const s of hits) {
        const r = p(s);
        assert.equal(codeOf(r.error), 'NOTIFY_CHANNEL_MESSAGE_INVALID', s);
        assert.deepEqual(r.error.body.error.details, { field: 'message.link.path' }, s);
    }
});

test('link.path 点段只在路径部分拒：文件名里的点、query 里的 .. 不误伤（与平台同口径放行）', () => {
    const p = path => validateChannelMessage({ channel: 'a', message: { title: 't', link: { label: 'x', path } } }).message?.link?.path;
    for (const s of ['a.b/c..d', '...', '.../x', '.a', '.well', 'a..', 'reports/a.b', '?q=..', 'a?x=/../', 'a/b?x=..', 'reports/x?tab=./', 'r/x?next=../../y', '%2e%2e%2e', '..%2f']) {
        assert.equal(p(s), s, s);
    }
    assert.equal(p('#/a.b/c..d'), 'a.b/c..d');
});

test('validateChannelMessage：https 且路径是平台 media 形状 → 放行但给一条提示（线上还要核主机与工作区 / 应用段）', () => {
    const v = validateChannelMessage({ channel: 'a', message: { title: 't', imageUrl: `https://media.app.ptengine.ai/media/ws-1/my-app/${HEX}.png` } });
    assert.ok(v.message);
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /线上/);
});

test('无渠道目录（channels = null）：任何合法名字都接受，type 记 webhook；不合规名字 → 404', () => {
    const s = createStubState();
    const r = call(s, USER, { channel: 'alerts', message: MSG });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { preview: false, status: 'sent', channel: { name: 'alerts', type: 'webhook' } });
    assert.equal(r.outbox.dir, 'interactive');
    for (const name of ['Alerts', '-x', 'a b', '', 'a'.repeat(65)]) {
        assert.equal(codeOf(call(s, USER, { channel: name, message: MSG })), 'NOTIFY_CHANNEL_NOT_FOUND', name);
    }
});

test('有渠道目录：名字不在其中 → 404（含大小写不同的 Alerts）；在 → 用目录里的 type', () => {
    const s = createStubState();
    const channels = [{ name: 'alerts', type: 'slack' }];
    assert.equal(call(s, USER, { channel: 'alerts', message: MSG }, channels).body.channel.type, 'slack');
    assert.equal(codeOf(call(s, USER, { channel: 'ops', message: MSG }, channels)), 'NOTIFY_CHANNEL_NOT_FOUND');
    assert.equal(codeOf(call(s, USER, { channel: 'Alerts', message: MSG }, channels)), 'NOTIFY_CHANNEL_NOT_FOUND');
    assert.equal(codeOf(call(s, USER, { channel: null, message: MSG }, channels)), 'NOTIFY_CHANNEL_MESSAGE_INVALID');
});

test('判定顺序同平台（§4.5 第 3 步先于第 5 步）：坏消息 + 不存在的名字 → 400 而不是 404', () => {
    assert.equal(codeOf(call(createStubState(), USER, { channel: 'ops', message: { title: '' } }, [])), 'NOTIFY_CHANNEL_MESSAGE_INVALID');
});

test('预览：intercepted / preview true，outbox 按 runId；载荷 rendered 为 null、没有任何凭据字段', () => {
    const r = call(createStubState(), PREVIEW, { channel: 'alerts', message: { ...MSG, imageUrl: LOCAL_IMG } });
    assert.deepEqual(r.body, { preview: true, status: 'intercepted', channel: { name: 'alerts', type: 'webhook' } });
    assert.equal(r.outbox.dir, 'run-1');
    assert.deepEqual(r.outbox.payload, {
        v: 1, channel: { name: 'alerts', type: 'webhook', isTest: false }, appName: '我的应用',
        message: { ...MSG, imageUrl: LOCAL_IMG, link: null }, status: 'intercepted', rendered: null, delivery: null, mediaUrls: [LOCAL_IMG]
    });
});

test(`每 run ≤ ${C.maxPerRun} 次（含预览）；超出 → 409 NOTIFY_RUN_LIMIT_EXCEEDED；按 run 分开计；交互调用不计；与邮件计数互不影响`, () => {
    const s = createStubState();
    runCounters(s, 'run-1').emailCalls = 999;
    for (let i = 0; i < C.maxPerRun; i++) assert.equal(call(s, PREVIEW, { channel: 'a', message: MSG }).status, 200, String(i));
    assert.equal(codeOf(call(s, PREVIEW, { channel: 'a', message: MSG })), 'NOTIFY_RUN_LIMIT_EXCEEDED');
    assert.equal(call(s, RUN, { channel: 'a', message: MSG }).status, 200);
    for (let i = 0; i < C.maxPerRun + 1; i++) assert.equal(call(s, USER, { channel: 'a', message: MSG }).status, 200);
    // 被消息校验 / 查渠道拒掉的调用不计次（与平台第 3、5 步先于第 6 步一致）
    const s2 = createStubState();
    for (let i = 0; i < C.maxPerRun; i++) call(s2, PREVIEW, { channel: 'a', message: { title: '' } });
    for (let i = 0; i < C.maxPerRun; i++) call(s2, PREVIEW, { channel: 'A', message: MSG });
    assert.equal(call(s2, PREVIEW, { channel: 'a', message: MSG }).status, 200);
});

test('job 令牌的 run 不合法 → 不按 run 计数，outbox 落 interactive', () => {
    const r = call(createStubState(), { ...PREVIEW, run: '../../escape' }, { channel: 'a', message: MSG });
    assert.equal(r.status, 200);
    assert.equal(r.outbox.dir, 'interactive');
});

test('loadLocalChannels：没有文件 → null；合法 → [{ name, type }]（多余键丢弃）；坏文件 → 抛错点名 .ptx/channels.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'ptx-ch-'));
    assert.equal(loadLocalChannels(root), null);
    mkdirSync(join(root, '.ptx'));
    const f = join(root, '.ptx', 'channels.json');
    writeFileSync(f, JSON.stringify([{ name: 'ops', type: 'teams', extra: 1 }, { name: 'alerts', type: 'slack' }]));
    assert.deepEqual(loadLocalChannels(root), [{ name: 'ops', type: 'teams' }, { name: 'alerts', type: 'slack' }]);
    for (const bad of ['{', '{}', '[1]', '[{"name":"A","type":"slack"}]', '[{"name":"a","type":"email"}]', '[{"name":"a","type":"slack"},{"name":"a","type":"teams"}]']) {
        writeFileSync(f, bad);
        assert.throws(() => loadLocalChannels(root), /\.ptx\/channels\.json/, bad);
    }
});

test('handleListChannels：按 name 升序、只回 name / type；没有目录 → []', () => {
    assert.deepEqual(handleListChannels({ channels: null }), { status: 200, body: { channels: [] } });
    assert.deepEqual(handleListChannels({ channels: [{ name: 'ops', type: 'teams' }, { name: 'alerts', type: 'slack' }] }).body.channels,
        [{ name: 'alerts', type: 'slack' }, { name: 'ops', type: 'teams' }]);
});

test('rules 缺 notifyChannel 段 / 缺键 → 抛「规则快照过旧」，不写字面量兜底', () => {
    assert.throws(() => channelRules(undefined), /notifyChannel[\s\S]*规则快照过旧/);
    const { titleMax: _t, ...stale } = C;
    assert.throws(() => validateChannelMessage({ channel: 'a', message: MSG }, stale), /titleMax[\s\S]*规则快照过旧/);
    assert.throws(() => handleNotifyChannel(createStubState(), { claims: USER, body: { channel: 'a', message: MSG }, appName: 'x', channels: null, rules: stale }), /规则快照过旧/);
});
