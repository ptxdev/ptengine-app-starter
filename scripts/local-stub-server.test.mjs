import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
    assert.equal((await post(base, '/notify/channel', PREVIEW, {})).status, 404);
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
