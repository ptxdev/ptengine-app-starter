import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES } from './manifest.mjs';
import { DEFAULT_LOCAL_TARGET, handleNotifySend, loadLocalTargets, resolveLocalTargets, sendRules, validateSendMessage } from './local-stub/send.mjs';
import { createStubState, runCounters } from './local-stub/notify.mjs';

const C = RULES.notifySend;
const codeOf = r => r?.body?.error?.code;
const MSG = { title: '首页 CVR 异常', text: '比上周同期下降 23%' };
const PREVIEW = { sub: 'local-user', trg: 'job', job: 'local', run: 'run-1', mode: 'preview', scopes: ['notify:send'] };
const RUN = { ...PREVIEW, run: 'run-2', mode: 'run' };
const USER = { sub: 'local-user', scopes: ['notify:send'] };
const HEX = 'a'.repeat(32);
const LOCAL_IMG = `http://localhost:8788/__ptx/media/${HEX}.png`;
const T2 = [{ name: 'alerts', type: 'slack' }, { name: 'ops', type: 'teams' }];
const call = (state, claims, body, targets = null, instant = true) => handleNotifySend(state, { claims, body, appName: '我的应用', targets, instant });

test('validateSendMessage：合法 → 规范化（title / label trim、text CRLF/CR→LF、缺省或 null 的 text 为 ""、link 去一个前导 #/ 或 /）', () => {
    const v = validateSendMessage({ message: { title: '  标题  ', text: 'a\r\nb\rc\td', imageUrl: LOCAL_IMG, link: { label: ' 查看 ', path: '#/reports/42?x=1' } } });
    assert.deepEqual(v.message, { title: '标题', text: 'a\nb\nc\td', imageUrl: LOCAL_IMG, link: { label: '查看', path: 'reports/42?x=1' } });
    assert.deepEqual(v.warnings, []);
    assert.deepEqual(validateSendMessage({ message: { title: 't' } }).message, { title: 't', text: '', imageUrl: null, link: null });
    assert.deepEqual(validateSendMessage({ message: { title: 't', imageUrl: null, link: null } }).message, { title: 't', text: '', imageUrl: null, link: null });
    // RU4：text: null 视同缺省（与平台 parseChannelMessage 同口径）
    assert.deepEqual(validateSendMessage({ message: { title: 't', text: null } }).message, { title: 't', text: '', imageUrl: null, link: null });
    assert.equal(validateSendMessage({ message: { title: 't', link: { label: 'x', path: '/a/b' } } }).message.link.path, 'a/b');
    // `:` 不在首段开头照收
    assert.equal(validateSendMessage({ message: { title: 't', link: { label: 'x', path: 'reports/a:b' } } }).message.link.path, 'reports/a:b');
});

test('validateSendMessage：上限读 rules（按码点计；恰在上限内通过）', () => {
    assert.ok(validateSendMessage({ message: { title: '😀'.repeat(C.titleMax) } }).message);
    assert.ok(validateSendMessage({ message: { title: 't', text: '中'.repeat(C.textMax) } }).message);
    assert.ok(validateSendMessage({ message: { title: 't', link: { label: 'l'.repeat(C.linkLabelMax), path: `#/${'p'.repeat(C.linkPathMax)}` } } }).message);
});

test('validateSendMessage：不合规 → 400 NOTIFY_CHANNEL_MESSAGE_INVALID（与平台 §4.3 同口径，可以更严、不能更宽）', () => {
    const m = patch => ({ message: { title: 't', ...patch } });
    const p = path => m({ link: { label: 'x', path } });
    const bad = [
        null, 'x', [1], {}, { channel: 'a' }, { message: 'x' }, { message: [MSG] }, { message: null },
        { message: {} }, m({ title: '   ' }), m({ title: 'a\nb' }), m({ title: 'a\u0007' }), m({ title: 'a\u007f' }),
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
    for (const body of bad) assert.equal(codeOf(validateSendMessage(body).error), 'NOTIFY_CHANNEL_MESSAGE_INVALID', JSON.stringify(body)?.slice(0, 70));
});

test('400 NOTIFY_CHANNEL_MESSAGE_INVALID 带 details.field，字段名与平台同口径（message / message.title / …）；非对象请求体不带 details', () => {
    const m = patch => ({ message: { title: 't', ...patch } });
    const cases = [
        [{ message: 'x' }, 'message'], [{}, 'message'], [m({ title: '' }), 'message.title'],
        [m({ text: 1 }), 'message.text'], [m({ imageUrl: 'https://evil.example/x.png' }), 'message.imageUrl'], [m({ link: 'x' }), 'message.link'],
        [m({ link: { label: '', path: 'a' } }), 'message.link.label'], [m({ link: { label: 'x', path: '//a' } }), 'message.link.path']
    ];
    for (const [body, field] of cases) assert.deepEqual(validateSendMessage(body).error.body.error.details, { field }, field);
    assert.equal(validateSendMessage(null).error.body.error.details, undefined);
});

test('rules.json 的 linkPathSchemePattern / linkPathDotSegmentPattern = contract NOTIFY_CHANNEL_LINK_PATH_SCHEME_PATTERN / NOTIFY_CHANNEL_LINK_PATH_DOT_SEGMENT_PATTERN（{ source, flags }，R11 / R13）', () => {
    assert.deepEqual(C.linkPathSchemePattern, { source: '^[a-z][a-z0-9+.-]*:', flags: 'i' });
    assert.deepEqual(C.linkPathDotSegmentPattern, { source: '^(?:[^?]*\\/)?(?:\\.|%2e){1,2}(?:[/?]|$)', flags: 'i' });
});

test('link.path 点段（R11）：? 之前的 . / .. 段（含任意大小写 %2e，含 #/ 或 / 前导之后）→ 400 message.link.path', () => {
    const p = path => validateSendMessage({ message: { title: 't', link: { label: 'x', path } } });
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
    const p = path => validateSendMessage({ message: { title: 't', link: { label: 'x', path } } }).message?.link?.path;
    for (const s of ['a.b/c..d', '...', '.../x', '.a', '.well', 'a..', 'reports/a.b', '?q=..', 'a?x=/../', 'a/b?x=..', 'reports/x?tab=./', 'r/x?next=../../y', '%2e%2e%2e', '..%2f']) {
        assert.equal(p(s), s, s);
    }
    assert.equal(p('#/a.b/c..d'), 'a.b/c..d');
});

test('validateSendMessage：https 且路径是平台 media 形状 → 放行但给一条提示（线上还要核主机与工作区 / 应用段）', () => {
    const v = validateSendMessage({ message: { title: 't', imageUrl: `https://media.app.ptengine.ai/media/ws-1/my-app/${HEX}.png` } });
    assert.ok(v.message);
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /线上/);
});

test('消息里多余的键（含 channel / channelIds）不影响校验、也不进 outbox（应用不指定渠道）', () => {
    const r = call(createStubState(), USER, { channel: 'alerts', channelIds: ['x'], message: { ...MSG, channel: 'alerts' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.outbox.payload.message, { ...MSG, imageUrl: null, link: null });
});

test('没有 .ptx/notify-targets.json（targets = null）→ 一个虚拟目标 local / webhook，本地默认走通 sent 分支（裁定 N30）', () => {
    assert.deepEqual(DEFAULT_LOCAL_TARGET, { name: 'local', type: 'webhook' });
    assert.deepEqual(resolveLocalTargets(null), [DEFAULT_LOCAL_TARGET]);
    const r = call(createStubState(), USER, { message: MSG });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { preview: false, status: 'sent', targets: 1, sent: 1, failed: 0, noTargetsReason: null });
    assert.equal(r.outbox.dir, 'interactive');
    assert.deepEqual(r.outbox.payload.targets, [{ name: 'local', type: 'webhook' }]);
});

test('多个目标：扇出到每个目标（本地不投递），结果只有计数、没有渠道名；outbox 记 targets', () => {
    const r = call(createStubState(), RUN, { message: MSG }, T2);
    assert.deepEqual(r.body, { preview: false, status: 'sent', targets: 2, sent: 2, failed: 0, noTargetsReason: null });
    assert.equal(r.outbox.dir, 'run-2');
    assert.deepEqual(r.outbox.payload, {
        v: 2, appName: '我的应用', message: { ...MSG, imageUrl: null, link: null }, targets: T2,
        status: 'sent', noTargetsReason: null, mediaUrls: []
    });
});

test('目标为 []：任务 run → no_targets / JOB_TARGETS_EMPTY（outbox 记 skipped）；交互 → APP_DEFAULT_EMPTY；不报错', () => {
    const job = call(createStubState(), RUN, { message: MSG }, []);
    assert.deepEqual(job.body, { preview: false, status: 'no_targets', targets: 0, sent: 0, failed: 0, noTargetsReason: 'JOB_TARGETS_EMPTY' });
    assert.equal(job.outbox.payload.status, 'skipped');
    assert.deepEqual(job.outbox.payload.targets, []);
    const user = call(createStubState(), USER, { message: MSG }, []);
    assert.deepEqual(user.body, { preview: false, status: 'no_targets', targets: 0, sent: 0, failed: 0, noTargetsReason: 'APP_DEFAULT_EMPTY' });
    assert.equal(user.outbox.dir, 'interactive');
});

test('预览：intercepted，targets = 将发到的数目；[] 时也给 noTargetsReason；outbox 按 runId，没有任何凭据字段', () => {
    const r = call(createStubState(), PREVIEW, { message: { ...MSG, imageUrl: LOCAL_IMG } }, T2);
    assert.deepEqual(r.body, { preview: true, status: 'intercepted', targets: 2, sent: 0, failed: 0, noTargetsReason: null });
    assert.equal(r.outbox.dir, 'run-1');
    assert.deepEqual(r.outbox.payload, {
        v: 2, appName: '我的应用', message: { ...MSG, imageUrl: LOCAL_IMG, link: null }, targets: T2,
        status: 'intercepted', noTargetsReason: null, mediaUrls: [LOCAL_IMG]
    });
    const empty = call(createStubState(), PREVIEW, { message: MSG }, []);
    assert.deepEqual(empty.body, { preview: true, status: 'intercepted', targets: 0, sent: 0, failed: 0, noTargetsReason: 'JOB_TARGETS_EMPTY' });
});

test(`每 run 单位 ≤ ${C.maxUnitsPerRun}，每次消耗 max(1, 目标数)（含预览、含 no_targets）；超出 → 409 整次不发；交互不计；与邮件计数互不影响`, () => {
    const s = createStubState();
    runCounters(s, 'run-1').emailCalls = 999;
    const four = [...T2, { name: 'c', type: 'chatwork' }, { name: 'd', type: 'webhook' }];
    // 4 + 4 = 8 ≤ 10；第 3 次 4 + 8 = 12 > 10 → 409（brief §12.3 第 29 条）
    assert.equal(call(s, PREVIEW, { message: MSG }, four).status, 200);
    assert.equal(call(s, PREVIEW, { message: MSG }, four).status, 200);
    const over = call(s, PREVIEW, { message: MSG }, four);
    assert.equal(codeOf(over), 'NOTIFY_RUN_LIMIT_EXCEEDED');
    assert.equal(over.outbox, undefined);
    // 剩 2 个单位：无目标（计 1）× 2 正好用完，再来一次 409
    assert.equal(call(s, PREVIEW, { message: MSG }, []).status, 200);
    assert.equal(call(s, PREVIEW, { message: MSG }, []).status, 200);
    assert.equal(codeOf(call(s, PREVIEW, { message: MSG }, [])), 'NOTIFY_RUN_LIMIT_EXCEEDED');
    // 另一个 run 单独计；交互调用不计
    assert.equal(call(s, RUN, { message: MSG }, four).status, 200);
    for (let i = 0; i < C.maxUnitsPerRun + 1; i++) assert.equal(call(s, USER, { message: MSG }, four).status, 200);
    // 被消息校验拒掉的调用不计
    const s2 = createStubState();
    for (let i = 0; i < C.maxUnitsPerRun; i++) call(s2, PREVIEW, { message: { title: '' } });
    assert.equal(call(s2, PREVIEW, { message: MSG }).status, 200);
});

test('job 令牌的 run 不合法 → 不按 run 计数，outbox 落 interactive；仍按任务口径给 JOB_TARGETS_EMPTY', () => {
    const r = call(createStubState(), { ...PREVIEW, run: '../../escape' }, { message: MSG });
    assert.equal(r.status, 200);
    assert.equal(r.outbox.dir, 'interactive');
    const none = call(createStubState(), { ...RUN, run: '../../escape' }, { message: MSG }, []);
    assert.equal(none.body.noTargetsReason, 'JOB_TARGETS_EMPTY');
});

test(`loadLocalTargets：没有文件 → null；合法 → [{ name, type }]（多余键丢弃）；[] → []；坏文件 / 超过 ${C.maxTargets} 个 → 抛错点名 .ptx/notify-targets.json`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ptx-tg-'));
    assert.equal(loadLocalTargets(root), null);
    mkdirSync(join(root, '.ptx'));
    const f = join(root, '.ptx', 'notify-targets.json');
    writeFileSync(f, JSON.stringify([{ name: 'ops', type: 'teams', extra: 1 }, { name: 'Alerts 频道', type: 'slack' }]));
    assert.deepEqual(loadLocalTargets(root), [{ name: 'ops', type: 'teams' }, { name: 'Alerts 频道', type: 'slack' }]);
    writeFileSync(f, '[]');
    assert.deepEqual(loadLocalTargets(root), []);
    const many = JSON.stringify(Array.from({ length: C.maxTargets + 1 }, (_, i) => ({ name: `c${i}`, type: 'slack' })));
    for (const bad of ['{', '{}', '[1]', '[{"name":"","type":"slack"}]', '[{"name":1,"type":"slack"}]', '[{"name":"a","type":"email"}]',
        '[{"name":"a","type":"slack"},{"name":"a","type":"teams"}]', many]) {
        writeFileSync(f, bad);
        assert.throws(() => loadLocalTargets(root), /\.ptx\/notify-targets\.json/, bad.slice(0, 60));
    }
});

test('rules 缺 notifySend 段 / 缺键 → 抛「规则快照过旧」，不写字面量兜底', () => {
    assert.throws(() => sendRules(undefined), /notifySend[\s\S]*规则快照过旧/);
    const { titleMax: _t, ...stale } = C;
    assert.throws(() => validateSendMessage({ message: MSG }, stale), /titleMax[\s\S]*规则快照过旧/);
    assert.throws(() => handleNotifySend(createStubState(), { claims: USER, body: { message: MSG }, appName: 'x', targets: null, rules: stale }), /规则快照过旧/);
    for (const key of ['maxUnitsPerRun', 'maxTargets', 'types']) {
        const { [key]: _drop, ...s2 } = C;
        assert.throws(() => sendRules(s2), new RegExp(`${key}[\\s\\S]*规则快照过旧`), key);
    }
});

test('rules 缺 linkPathSchemePattern / linkPathDotSegmentPattern → 抛「规则快照过旧」（不留本地正则兜底）', () => {
    const body = { message: { title: 't', link: { label: 'x', path: 'reports/1' } } };
    for (const key of ['linkPathSchemePattern', 'linkPathDotSegmentPattern']) {
        const { [key]: _drop, ...stale } = C;
        assert.throws(() => sendRules(stale), new RegExp(`${key}[\\s\\S]*规则快照过旧`), key);
        assert.throws(() => validateSendMessage(body, stale), /规则快照过旧/, key);
    }
});

test('linkPathSchemePattern / linkPathDotSegmentPattern 形状不是 { source: string, flags: string } → 抛「规则快照过旧」（不还原成意外正则）', () => {
    const body = { message: { title: 't', link: { label: 'x', path: 'reports/1' } } };
    for (const key of ['linkPathSchemePattern', 'linkPathDotSegmentPattern']) {
        for (const bad of [{}, { source: 'x' }, { flags: 'i' }, { source: 1, flags: 'i' }, { source: 'x', flags: null }, '^x', 42]) {
            const stale = { ...C, [key]: bad };
            assert.throws(() => sendRules(stale), new RegExp(`${key}[\\s\\S]*规则快照过旧`), `${key}=${JSON.stringify(bad)}`);
            assert.throws(() => validateSendMessage(body, stale), /规则快照过旧/, `${key}=${JSON.stringify(bad)}`);
        }
    }
    assert.doesNotThrow(() => sendRules(C));
});

test('即时发送未声明（instant: false / 缺省）：交互 → no_targets / APP_INSTANT_NOT_DECLARED，不读目标、targets 0；outbox 记空目标；任务 run 不受影响', () => {
    const user = call(createStubState(), USER, { message: MSG }, T2, false);
    assert.deepEqual(user.body, { preview: false, status: 'no_targets', targets: 0, sent: 0, failed: 0, noTargetsReason: 'APP_INSTANT_NOT_DECLARED' });
    assert.equal(user.outbox.dir, 'interactive');
    assert.deepEqual(user.outbox.payload.targets, []);
    assert.equal(user.outbox.payload.status, 'no_targets');
    assert.equal(user.outbox.payload.noTargetsReason, 'APP_INSTANT_NOT_DECLARED');
    // 缺省 instant = 未声明（与平台「当前版本没声明就不投」同口径）
    const omitted = handleNotifySend(createStubState(), { claims: USER, body: { message: MSG }, appName: 'x', targets: null });
    assert.equal(omitted.body.noTargetsReason, 'APP_INSTANT_NOT_DECLARED');
    // 消息不合规照旧先 400（第 3 步在前）
    assert.equal(call(createStubState(), USER, { message: {} }, T2, false).status, 400);
    // 任务 run / 预览与 instant 无关
    assert.equal(call(createStubState(), RUN, { message: MSG }, T2, false).body.status, 'sent');
    assert.equal(call(createStubState(), PREVIEW, { message: MSG }, T2, false).body.status, 'intercepted');
});

test('本地桩可能产出的 noTargetsReason 全部在 RULES.notifySend.noTargetsReasons 内（与 contract NOTIFY_NO_TARGETS_REASONS 同源）', () => {
    const known = RULES.notifySend.noTargetsReasons;
    assert.ok(Array.isArray(known) && known.length > 0, 'rules.json 缺 notifySend.noTargetsReasons（跑 npm run sync-rules）');
    const produced = new Set();
    for (const claims of [USER, RUN, PREVIEW]) {
        for (const instant of [true, false]) {
            for (const targets of [[], null, T2]) {
                const r = call(createStubState(), claims, { message: MSG }, targets, instant);
                if (r.body.noTargetsReason !== null) produced.add(r.body.noTargetsReason);
            }
        }
    }
    assert.deepEqual([...produced].sort(), ['APP_DEFAULT_EMPTY', 'APP_INSTANT_NOT_DECLARED', 'JOB_TARGETS_EMPTY']);
    for (const reason of produced) assert.ok(known.includes(reason), reason);
});

test('validateSendMessage：热图截图 jpg（rules.notifySend.mediaPathPatterns）同样放行；形状不对的拒', () => {
    const base = `https://media.app.ptengine.ai/media/ws-1/my-app/hm/${HEX}`;
    for (const ok of [`${base}/clickMap/full.jpg`, `${base}/attentionMap/part-01.jpg`, `${base}/conversionBlockMap/part-123.jpg`]) {
        const v = validateSendMessage({ message: { title: 't', imageUrl: ok } });
        assert.equal(v.message?.imageUrl, ok, ok);
        assert.equal(v.warnings.length, 1, ok);
    }
    for (const bad of [
        `${base}/clickMap/full.png`, `${base}/clickMap/part-1.jpg`, `${base}/clickMap/part-1234.jpg`, `${base}/scrollMap/full.jpg`,
        `${base}/clickMap/thumb.jpg`, `${base}/full.jpg`, `https://m.x/media/ws-1/my-app/hm/${'a'.repeat(31)}/clickMap/full.jpg`,
        `https://m.x/media/ws-1/my-app/hm/${'A'.repeat(32)}/clickMap/full.jpg`, `https://m.x/media/ws-1/my-app/${HEX}.jpg`,
        `${base}/clickMap/full.jpg?x=1`, `https://m.x:443/media/ws-1/my-app/hm/${HEX}/clickMap/full.jpg`,
        `http://m.x/media/ws-1/my-app/hm/${HEX}/clickMap/full.jpg`
    ]) {
        assert.equal(codeOf(validateSendMessage({ message: { title: 't', imageUrl: bad } }).error), 'NOTIFY_CHANNEL_MESSAGE_INVALID', bad);
    }
});

test('validateSendMessage：旧快照没有 mediaPathPatterns → 退回 mediaPathPattern（只收图表 png）；有但形状不对 → 规则快照过旧', () => {
    const { mediaPathPatterns, ...old } = C;
    assert.ok(Array.isArray(mediaPathPatterns), '当前快照应有 mediaPathPatterns（跑 npm run sync-rules）');
    const hm = `https://m.x/media/ws-1/my-app/hm/${HEX}/clickMap/full.jpg`;
    assert.ok(validateSendMessage({ message: { title: 't', imageUrl: `https://m.x/media/ws-1/my-app/${HEX}.png` } }, old).message);
    assert.equal(codeOf(validateSendMessage({ message: { title: 't', imageUrl: hm } }, old).error), 'NOTIFY_CHANNEL_MESSAGE_INVALID');
    for (const bad of [[], 'x', [1], {}]) {
        assert.throws(() => sendRules({ ...C, mediaPathPatterns: bad }), /mediaPathPatterns[\s\S]*规则快照过旧/, JSON.stringify(bad));
    }
});
