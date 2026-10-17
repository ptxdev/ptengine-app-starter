import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLocalStub } from './local-stub/server.mjs';
import { maybeStartLocalStub } from './ptx-dev.mjs';

const tok = claims => `Bearer h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const PREVIEW = tok({ sub: 'local-user', scopes: ['notify:send'], trg: 'job', job: 'local', run: 'run-1', mode: 'preview' });
const NO_SCOPE = tok({ sub: 'local-user', scopes: ['jobs:run'] });
const fakeRenderer = async () => ({
    echarts: { init: () => ({ setOption() {}, getZr: () => ({ painter: { renderToString: () => '<svg/>' } }), dispose() {} }) },
    Resvg: class { render() { return { asPng: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; } }
});

async function withStub(fn) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-stub-'));
    const logs = [];
    const server = createLocalStub({ root, appName: '我的应用', loadRenderer: fakeRenderer, log: m => logs.push(m) });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { return await fn({ root, base, logs, port: server.address().port }); } finally { await new Promise(r => server.close(r)); }
}
const post = (base, path, auth, body) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const MAIL = { to: ['role:admin'], subject: '周报', html: '<p>本周</p><style>p{}</style>' };

test('POST /notify/email：写 .ptx/outbox/<runId>/<seq>.json + .html，seq 递增；打印一行带本地预览地址与清洗提示', () => withStub(async ({ root, base, logs, port }) => {
    const r1 = await post(base, '/notify/email', PREVIEW, MAIL);
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).preview, true);
    await post(base, '/notify/email', PREVIEW, MAIL);
    for (const f of ['1.json', '1.html', '2.json', '2.html']) assert.ok(existsSync(join(root, '.ptx', 'outbox', 'run-1', f)), f);
    const payload = JSON.parse(readFileSync(join(root, '.ptx', 'outbox', 'run-1', '1.json'), 'utf8'));
    assert.equal(payload.subject, '周报');
    assert.ok(!readFileSync(join(root, '.ptx', 'outbox', 'run-1', '1.html'), 'utf8').includes('%%'));
    assert.ok(logs.some(l => l.includes(`http://localhost:${port}/__ptx/outbox/run-1/1.html`) && l.includes('预览')));
    assert.ok(logs.some(l => l.includes('<style>')));
}));

test('GET /__ptx/outbox/<runId> 列出这次运行的邮件；GET …/<seq>.html 返回单封', () => withStub(async ({ base }) => {
    await post(base, '/notify/email', PREVIEW, MAIL);
    const list = await fetch(`${base}/__ptx/outbox/run-1`);
    assert.equal(list.status, 200);
    assert.match(list.headers.get('content-type'), /text\/html/);
    const html = await list.text();
    assert.ok(html.includes('/__ptx/outbox/run-1/1.html') && html.includes('周报'));
    const one = await fetch(`${base}/__ptx/outbox/run-1/1.html`);
    assert.equal(one.status, 200);
    assert.ok((await one.text()).includes('<!--pt-body-start-->'));
    assert.equal((await fetch(`${base}/__ptx/outbox/nope`)).status, 404);
    assert.equal((await fetch(`${base}/__ptx/outbox/..%2F..%2Fetc/1.html`)).status, 404);
}));

test('POST /render/chart：写 .ptx/media/<hex>.png，返回 http://localhost:<port>/__ptx/media/<hex>.png，GET 能取回字节', () => withStub(async ({ base, port }) => {
    const r = await post(base, '/render/chart', PREVIEW, { option: { series: [] }, width: 300, height: 200 });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.match(out.url, new RegExp(`^http://localhost:${port}/__ptx/media/[0-9a-f]{32}\\.png$`));
    assert.deepEqual([out.width, out.height], [300, 200]);
    const img = await fetch(out.url.replace('localhost', '127.0.0.1'));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
}));

test('令牌没有 notify:send → 403 SCOPE_DENIED；令牌缺失 → 401；未知路径 → 404', () => withStub(async ({ base }) => {
    const denied = await post(base, '/notify/email', NO_SCOPE, MAIL);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'SCOPE_DENIED');
    assert.equal((await post(base, '/render/chart', '', { option: {} })).status, 401);
    assert.equal((await post(base, '/notify/sms', PREVIEW, {})).status, 404);
}));

test('预览页禁脚本：列表页与单封邮件都带 CSP（sandbox 只放 popups + script-src \'none\'）与 nosniff；javascript: 无引号写法也执行不了', () => withStub(async ({ base }) => {
    await post(base, '/notify/email', PREVIEW, { ...MAIL, html: '<a href=javascript:alert(1)>x</a><img src=x onerror=alert(1)>' });
    for (const p of ['/__ptx/outbox/run-1', '/__ptx/outbox/run-1/1.html']) {
        const res = await fetch(`${base}${p}`);
        assert.equal(res.status, 200, p);
        const csp = res.headers.get('content-security-policy') ?? '';
        assert.match(csp, /script-src 'none'/, p);
        assert.match(csp, /(^|;\s*)sandbox allow-popups allow-popups-to-escape-sandbox(;|$)/, p);
        assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/, p);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    }
}));

test('job 令牌的 run 不合法（含路径穿越）→ 打一条警告，邮件写进 .ptx/outbox/interactive/，.ptx 外不落任何文件', () => withStub(async ({ root, base, logs }) => {
    const BAD = tok({ sub: 'local-user', scopes: ['notify:send'], trg: 'job', job: 'local', run: '../../escape', mode: 'preview' });
    const r = await post(base, '/notify/email', BAD, MAIL);
    assert.equal(r.status, 200);
    assert.ok(existsSync(join(root, '.ptx', 'outbox', 'interactive', '1.json')));
    assert.deepEqual(readdirSync(root), ['.ptx']);
    assert.deepEqual(readdirSync(join(root, '.ptx', 'outbox')), ['interactive']);
    assert.equal(logs.filter(l => l.includes('run') && l.includes('不合法')).length, 1);
    // 合法 run / 非 job 令牌不报警
    await post(base, '/notify/email', PREVIEW, MAIL);
    await post(base, '/notify/email', tok({ sub: 'u', scopes: ['notify:send'] }), MAIL);
    assert.equal(logs.filter(l => l.includes('不合法')).length, 1);
}));

test('请求体超过 1 MiB → 413（不断连，读完再回），.ptx 下不落文件', () => withStub(async ({ root, base }) => {
    const big = { ...MAIL, html: 'x'.repeat(1_100_000) };
    const r = await post(base, '/notify/email', PREVIEW, big);
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'GATEWAY_BAD_REQUEST');
    assert.ok(!existsSync(join(root, '.ptx')));
}));

const rawGet = (port, path, host) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
});

test('Host 只认 127.0.0.1:<port> / localhost:<port>，其余 421（防 DNS rebinding）', () => withStub(async ({ base, port }) => {
    await post(base, '/notify/email', PREVIEW, MAIL);
    assert.equal(await rawGet(port, '/__ptx/outbox/run-1', `127.0.0.1:${port}`), 200);
    assert.equal(await rawGet(port, '/__ptx/outbox/run-1', `localhost:${port}`), 200);
    for (const h of ['evil.example', `evil.example:${port}`, 'localhost', `127.0.0.1:${port + 1}`]) {
        assert.equal(await rawGet(port, '/__ptx/outbox/run-1', h), 421, h);
    }
}));

test('maybeStartLocalStub：没有后端不起；起不来（端口被占）只返回提示，不抛', async () => {
    let called = 0;
    assert.equal(await maybeStartLocalStub({}, '/tmp', { hasBackend: false }, async () => { called++; }), '');
    assert.equal(called, 0);
    const ok = await maybeStartLocalStub({ id: 'my-app' }, '/tmp', { hasBackend: true }, async opts => { called++; assert.equal(opts.appName, 'my-app'); });
    assert.match(ok, /8788/);
    const busy = await maybeStartLocalStub({}, '/tmp', { hasBackend: true }, async () => { throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }); });
    assert.match(busy, /EADDRINUSE/);
    assert.match(busy, /8788 被占（可能是另一个 ptx dev）：notify \/ render 可能写到别处或 503/);
});

// ── 最终评审 I1：每应用并发闸（与线上网关同口径，上限读 rules.json 的 notify / render 段 maxConcurrentPerApp） ──
import { RULES as STUB_RULES } from './manifest.mjs';

async function withGatedStub(rules, loadRenderer, fn) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-stub-'));
    const logs = [];
    const server = createLocalStub({ root, appName: 'a', loadRenderer, log: m => logs.push(m), rules });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { return await fn({ base, logs }); } finally { await new Promise(r => server.close(r)); }
}

test('并发闸：render 在途数达到 rules.render.maxConcurrentPerApp → 429 TOO_MANY_CONCURRENT_QUERIES；完成后释放', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slowRenderer = async () => { await gate; return fakeRenderer(); };
    const rules = { ...STUB_RULES, render: { ...STUB_RULES.render, maxConcurrentPerApp: 1 } };
    await withGatedStub(rules, slowRenderer, async ({ base }) => {
        const first = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        await new Promise(r => setTimeout(r, 50));
        const second = await Promise.race([post(base, '/render/chart', PREVIEW, { option: { series: [] } }), new Promise(r => setTimeout(() => r(null), 2000))]);
        release();   // 先放行：断言失败时也不让第一个请求挂住服务器
        assert.ok(second, '第二个渲染应被闸立即拒绝，而不是排队等待');
        assert.equal(second.status, 429);
        assert.equal((await second.json()).error.code, 'TOO_MANY_CONCURRENT_QUERIES');
        assert.equal((await first).status, 200);
        assert.equal((await post(base, '/render/chart', PREVIEW, { option: { series: [] } })).status, 200);
    });
});

test('并发闸：notify 与 render 各走各的闸（render 打满不挡邮件）', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slowRenderer = async () => { await gate; return fakeRenderer(); };
    const rules = { ...STUB_RULES, notify: { ...STUB_RULES.notify, maxConcurrentPerApp: 1 }, render: { ...STUB_RULES.render, maxConcurrentPerApp: 1 } };
    await withGatedStub(rules, slowRenderer, async ({ base }) => {
        const first = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        await new Promise(r => setTimeout(r, 50));
        assert.equal((await post(base, '/notify/email', PREVIEW, MAIL)).status, 200);
        release();
        await first;
    });
});

test('并发闸：rules.json 缺 maxConcurrentPerApp → 不模拟闸（不写字面量兜底），启动时打一行提示', async () => {
    const strip = ({ maxConcurrentPerApp, ...rest }) => rest;
    const rules = { ...STUB_RULES, notify: strip(STUB_RULES.notify), render: strip(STUB_RULES.render) };
    let release;
    const gate = new Promise(r => { release = r; });
    const slowRenderer = async () => { await gate; return fakeRenderer(); };
    await withGatedStub(rules, slowRenderer, async ({ base, logs }) => {
        assert.equal(logs.filter(l => l.includes('maxConcurrentPerApp')).length, 1);
        const a = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        const b = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        const c = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        await new Promise(r => setTimeout(r, 50));
        release();
        for (const r of await Promise.all([a, b, c])) assert.equal(r.status, 200);
    });
});

test('并发闸：真实 rules.json 快照（platform 2da3983 导出）已带 notify / render 的 maxConcurrentPerApp 与 render.timeoutMs，默认即生效、不打缺键提示', async () => {
    for (const k of ['notify', 'render']) {
        assert.ok(Number.isInteger(STUB_RULES[k].maxConcurrentPerApp) && STUB_RULES[k].maxConcurrentPerApp > 0, `${k}.maxConcurrentPerApp`);
    }
    assert.ok(Number.isInteger(STUB_RULES.render.timeoutMs) && STUB_RULES.render.timeoutMs > 0, 'render.timeoutMs');
    let release;
    const gate = new Promise(r => { release = r; });
    const slowRenderer = async () => { await gate; return fakeRenderer(); };
    const max = STUB_RULES.render.maxConcurrentPerApp;
    await withGatedStub(STUB_RULES, slowRenderer, async ({ base, logs }) => {
        assert.equal(logs.filter(l => l.includes('maxConcurrentPerApp')).length, 0);
        const held = Array.from({ length: max }, () => post(base, '/render/chart', PREVIEW, { option: { series: [] } }));
        await new Promise(r => setTimeout(r, 50));
        const over = await Promise.race([post(base, '/render/chart', PREVIEW, { option: { series: [] } }), new Promise(r => setTimeout(() => r(null), 2000))]);
        release();
        assert.ok(over, `第 ${max + 1} 个渲染应被闸立即拒绝`);
        assert.equal(over.status, 429);
        assert.equal((await over.json()).error.code, 'TOO_MANY_CONCURRENT_QUERIES');
        for (const r of await Promise.all(held)) assert.equal(r.status, 200);
    });
});

test('并发闸的 429 带 x-pt-gate: concurrency（与线上网关同口径：app-backend 只对带这个头的 429 退避重试）；其它错误不带', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slowRenderer = async () => { await gate; return fakeRenderer(); };
    const rules = { ...STUB_RULES, render: { ...STUB_RULES.render, maxConcurrentPerApp: 1 } };
    await withGatedStub(rules, slowRenderer, async ({ base }) => {
        const first = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        await new Promise(r => setTimeout(r, 50));
        const over = await post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        release();
        assert.equal(over.status, 429);
        assert.equal(over.headers.get('x-pt-gate'), 'concurrency');
        assert.equal((await first).status, 200);
        const bad = await post(base, '/render/chart', PREVIEW, { option: 'not-an-object' });
        assert.equal(bad.status, 400);
        assert.equal(bad.headers.get('x-pt-gate'), null);
    });
});

test('闸头读 rules.json 的 gateway.gateHeader（真实快照 = x-pt-gate: concurrency；换值即跟着换，证明不是字面量）', async () => {
    assert.deepEqual(STUB_RULES.gateway?.gateHeader, { name: 'x-pt-gate', concurrencyValue: 'concurrency' });
    let release;
    const gate = new Promise(r => { release = r; });
    const slowRenderer = async () => { await gate; return fakeRenderer(); };
    const rules = { ...STUB_RULES, render: { ...STUB_RULES.render, maxConcurrentPerApp: 1 },
        gateway: { gateHeader: { name: 'x-test-gate', concurrencyValue: 'probe' } } };
    await withGatedStub(rules, slowRenderer, async ({ base }) => {
        const first = post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        await new Promise(r => setTimeout(r, 50));
        const over = await post(base, '/render/chart', PREVIEW, { option: { series: [] } });
        release();
        assert.equal(over.status, 429);
        assert.equal(over.headers.get('x-test-gate'), 'probe');
        assert.equal(over.headers.get('x-pt-gate'), null);
        assert.equal((await first).status, 200);
    });
});

test('快照有并发上限却缺 gateway.gateHeader → 启动即报「规则快照过旧」，不写字面量兜底', () => {
    const root = mkdtempSync(join(tmpdir(), 'ptx-stub-gate-'));
    const { gateway: _drop, ...stale } = STUB_RULES;
    assert.throws(() => createLocalStub({ root, rules: stale, log: () => {} }), /gateway\.gateHeader[\s\S]*规则快照过旧/);
    const halfStale = { ...STUB_RULES, gateway: { gateHeader: { name: 'x-pt-gate' } } };
    assert.throws(() => createLocalStub({ root, rules: halfStale, log: () => {} }), /规则快照过旧/);
    // 快照旧到连并发上限都没有：本来就不模拟闸，也就用不到闸头，不报错（与既有「缺键不模拟」口径一致）
    const ancient = { ...stale, notify: { ...STUB_RULES.notify, maxConcurrentPerApp: undefined }, render: { ...STUB_RULES.render, maxConcurrentPerApp: undefined } };
    assert.doesNotThrow(() => createLocalStub({ root, rules: ancient, log: () => {} }));
});

// ── 定时任务 1c：通知渠道本地桩 ─────────────────────────────────────────
const CH = { channel: 'alerts', message: { title: '首页 CVR 异常', text: '比上周同期下降 23%' } };

test('POST /notify/channel：写 .ptx/outbox/<runId>/<seq>.channel.json（与邮件共用序号）；打印一行带本地预览地址；预览 → intercepted', () => withStub(async ({ root, base, logs, port }) => {
    await post(base, '/notify/email', PREVIEW, MAIL);
    const r = await post(base, '/notify/channel', PREVIEW, CH);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { preview: true, status: 'intercepted', channel: { name: 'alerts', type: 'webhook' } });
    const dir = join(root, '.ptx', 'outbox', 'run-1');
    assert.deepEqual(readdirSync(dir).sort(), ['1.html', '1.json', '2.channel.json']);
    const payload = JSON.parse(readFileSync(join(dir, '2.channel.json'), 'utf8'));
    assert.equal(payload.rendered, null);
    assert.equal(payload.message.title, '首页 CVR 异常');
    await post(base, '/notify/email', PREVIEW, MAIL);
    assert.ok(existsSync(join(dir, '3.json')), '邮件接着用下一个序号');
    assert.ok(logs.some(l => l.includes('渠道消息') && l.includes('alerts') && l.includes(`http://localhost:${port}/__ptx/outbox/run-1`) && l.includes('预览')));
}));

test('POST /notify/channel 非预览：status sent，终端写明「本地桩，未真实投递」；交互调用落 interactive/', () => withStub(async ({ root, base, logs }) => {
    const r = await post(base, '/notify/channel', tok({ sub: 'u', scopes: ['notify:send'] }), CH);
    assert.equal((await r.json()).status, 'sent');
    assert.ok(existsSync(join(root, '.ptx', 'outbox', 'interactive', '1.channel.json')));
    assert.ok(logs.some(l => l.includes('未真实投递')));
}));

test('POST /notify/channels：无 .ptx/channels.json → []；有 → 按 name 升序只回 name / type；文件坏 → 500 PTX_STUB_FAILED 点名文件', () => withStub(async ({ root, base }) => {
    assert.deepEqual(await (await post(base, '/notify/channels', PREVIEW, {})).json(), { channels: [] });
    mkdirSync(join(root, '.ptx'), { recursive: true });
    writeFileSync(join(root, '.ptx', 'channels.json'), JSON.stringify([{ name: 'ops', type: 'teams' }, { name: 'alerts', type: 'slack' }]));
    assert.deepEqual(await (await post(base, '/notify/channels', PREVIEW, {})).json(),
        { channels: [{ name: 'alerts', type: 'slack' }, { name: 'ops', type: 'teams' }] });
    writeFileSync(join(root, '.ptx', 'channels.json'), '{');
    const bad = await post(base, '/notify/channels', PREVIEW, {});
    assert.equal(bad.status, 500);
    const e = (await bad.json()).error;
    assert.equal(e.code, 'PTX_STUB_FAILED');
    assert.match(e.message, /\.ptx\/channels\.json/);
}));

test('.ptx/channels.json 存在时名字不在其中 → 404 NOTIFY_CHANNEL_NOT_FOUND；改文件即时生效（不用重启）', () => withStub(async ({ root, base }) => {
    mkdirSync(join(root, '.ptx'), { recursive: true });
    const f = join(root, '.ptx', 'channels.json');
    writeFileSync(f, JSON.stringify([{ name: 'ops', type: 'teams' }]));
    const miss = await post(base, '/notify/channel', PREVIEW, CH);
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error.code, 'NOTIFY_CHANNEL_NOT_FOUND');
    writeFileSync(f, JSON.stringify([{ name: 'alerts', type: 'chatwork' }]));
    assert.equal((await (await post(base, '/notify/channel', PREVIEW, CH)).json()).channel.type, 'chatwork');
}));

test('两条渠道路径：无 notify:send → 403 SCOPE_DENIED（requiredScope）；无令牌 → 401；坏 JSON → 400 NOTIFY_CHANNEL_MESSAGE_INVALID', () => withStub(async ({ base }) => {
    for (const p of ['/notify/channel', '/notify/channels']) {
        const denied = await post(base, p, NO_SCOPE, CH);
        assert.equal(denied.status, 403, p);
        assert.deepEqual((await denied.json()).error.requiredScope, 'notify:send');
        assert.equal((await post(base, p, '', CH)).status, 401, p);
    }
    const bad = await fetch(`${base}/notify/channel`, { method: 'POST', headers: { authorization: PREVIEW, 'content-type': 'application/json' }, body: '{' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'NOTIFY_CHANNEL_MESSAGE_INVALID');
}));

test(`渠道消息体超过 rules.notifyChannel.maxBodyBytes → 413 GATEWAY_BAD_REQUEST（与线上网关同上限），不写文件`, () => withStub(async ({ root, base }) => {
    const big = { channel: 'alerts', message: { title: 't', text: 'x'.repeat(STUB_RULES.notifyChannel.maxBodyBytes) } };
    const r = await post(base, '/notify/channel', PREVIEW, big);
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'GATEWAY_BAD_REQUEST');
    assert.ok(!existsSync(join(root, '.ptx')));
}));

test('job 令牌的 run 不合法 → 渠道消息落 .ptx/outbox/interactive/，.ptx 外不落文件；渠道名不进任何路径', () => withStub(async ({ root, base }) => {
    const BAD = tok({ sub: 'u', scopes: ['notify:send'], trg: 'job', job: 'local', run: '../../escape', mode: 'preview' });
    mkdirSync(join(root, '.ptx'), { recursive: true });
    writeFileSync(join(root, '.ptx', 'channels.json'), JSON.stringify([{ name: 'alerts', type: 'slack' }]));
    assert.equal((await post(base, '/notify/channel', BAD, CH)).status, 200);
    assert.deepEqual(readdirSync(root), ['.ptx']);
    assert.deepEqual(readdirSync(join(root, '.ptx', 'outbox')), ['interactive']);
    assert.deepEqual(readdirSync(join(root, '.ptx', 'outbox', 'interactive')), ['1.channel.json']);
}));

test('本地推送预览页同时列出邮件与渠道消息；渠道消息以转义后的 JSON 展示；页面仍带 CSP', () => withStub(async ({ base }) => {
    await post(base, '/notify/email', PREVIEW, MAIL);
    await post(base, '/notify/channel', PREVIEW, { channel: 'alerts', message: { title: '<script>alert(1)</script>', text: 'a&b' } });
    const res = await fetch(`${base}/__ptx/outbox/run-1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes('/__ptx/outbox/run-1/1.html') && html.includes('周报'));
    assert.ok(html.includes('alerts') && html.includes('webhook') && html.includes('预览拦截'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.match(html, /2 条/);
}));

/** 发出请求头与半截请求体后挂住（闸在读体之前占位，这个请求一直在途）；finish(rest) 发完剩余部分并取状态码。 */
function holdOpen(port, path, auth, head) {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST',
        headers: { host: `127.0.0.1:${port}`, authorization: auth, 'content-type': 'application/json' } });
    const status = new Promise((resolve, reject) => {
        req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
    });
    req.write(head);
    return { finish: rest => { req.end(rest); return status; } };
}

test('并发闸：渠道与邮件共用 notify 闸（线上 notifyInflight；429 话术「邮件与渠道合计」、带闸头）；/notify/channels 不占这道闸', async () => {
    const rules = { ...STUB_RULES, notify: { ...STUB_RULES.notify, maxConcurrentPerApp: 1 } };
    const root = mkdtempSync(join(tmpdir(), 'ptx-stub-'));
    const server = createLocalStub({ root, appName: 'a', log: () => {}, rules });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
        const held = holdOpen(port, '/notify/channel', PREVIEW, '{"channel":"alerts",');
        await new Promise(r => setTimeout(r, 50));
        const mail = await post(base, '/notify/email', PREVIEW, MAIL);
        assert.equal(mail.status, 429);
        assert.equal(mail.headers.get('x-pt-gate'), 'concurrency');
        assert.match((await mail.json()).error.message, /邮件与渠道合计/);
        assert.equal((await post(base, '/notify/channels', PREVIEW, {})).status, 200);
        assert.equal(await held.finish('"message":{"title":"t"}}'), 200);
        assert.equal((await post(base, '/notify/email', PREVIEW, MAIL)).status, 200);
    } finally {
        await new Promise(r => server.close(r));
    }
});
