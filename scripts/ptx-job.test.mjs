/**
 * ptx job run —— 本地以「定时任务」身份调一次任务路由（接口约定 §5 / §8 / §10）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify as nodeVerify, webcrypto } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDevKeys } from './dev-keys.mjs';
import { buildJobClaims, decodeJobLogHeader, findJobRoute, formatJobLog, formatVerdict, parseJobArgs, run, signDevToken, LOCAL_JOB_TOKEN_TTL_SEC } from './ptx-job.mjs';
import { RULES } from './manifest.mjs';

const MANIFEST = {
    schemaVersion: 2, version: '1.0.0', entry: 'index.html', scopes: ['analytics:read', 'jobs:run'],
    backend: { entry: '_backend/worker.js', routes: ['/api/*'], jobs: [{ type: 'weekly-report', route: 'POST /jobs/weekly-report', title: '周报' }] }
};

function devKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        key: { kid: 'k1', privateJwk: privateKey.export({ format: 'jwk' }), iss: 'https://auth.ptengine.ai', aud: 'app:local-dev', sub: 'local-user', sid: 'local-site', wid: 'local-ws', scopes: ['analytics:read'], ver: 'local' },
        publicKey
    };
}

const decode = t => JSON.parse(Buffer.from(t.replace(/^Bearer /, '').split('.')[1], 'base64url'));

test('parseJobArgs', () => {
    assert.deepEqual(parseJobArgs(['run', 'weekly-report']), { type: 'weekly-report', params: {}, preview: false });
    assert.deepEqual(parseJobArgs(['run', 'w', '--params', '{"a":1}', '--preview']), { type: 'w', params: { a: 1 }, preview: true });
    assert.throws(() => parseJobArgs([]), /npm run ptx -- job run/);
    assert.throws(() => parseJobArgs(['list']), /npm run ptx -- job run/);
    assert.throws(() => parseJobArgs(['run']), /<type>/);
    assert.throws(() => parseJobArgs(['run', '--preview']), /<type>/);
    assert.throws(() => parseJobArgs(['run', 'w', '--params', '{x']), /不是合法 JSON/);
    assert.throws(() => parseJobArgs(['run', 'w', '--params', '[1]']), /JSON 对象/);
    assert.throws(() => parseJobArgs(['run', 'w', '--params', 'null']), /JSON 对象/);
    assert.throws(() => parseJobArgs(['run', 'w', '--params', '"s"']), /JSON 对象/);
    assert.throws(() => parseJobArgs(['run', 'w', '--params']), /--params/);
    assert.throws(() => parseJobArgs(['run', 'w', '--wat']), /--wat/);
});

test('findJobRoute：path = 去掉 "POST " 前缀；未知类型 / 无 jobs / 非 POST / 含 . 或 .. 段都报错', () => {
    assert.equal(findJobRoute(MANIFEST, 'weekly-report').path, '/jobs/weekly-report');
    assert.equal(findJobRoute(MANIFEST, 'weekly-report').job.title, '周报');
    assert.throws(() => findJobRoute(MANIFEST, 'nope'), /"nope".*weekly-report/s);
    assert.throws(() => findJobRoute({ backend: {} }, 'x'), /backend\.jobs/);
    assert.throws(() => findJobRoute({}, 'x'), /backend\.jobs/);
    assert.throws(() => findJobRoute({ backend: { jobs: [] } }, 'x'), /backend\.jobs/);
    assert.throws(() => findJobRoute({ backend: { jobs: [{ type: 'x', route: 'GET /x' }] } }, 'x'), /POST/);
    assert.throws(() => findJobRoute({ backend: { jobs: [{ type: 'x', route: 'POST /a/../b' }] } }, 'x'), /"\.\."|"\."/);
    assert.throws(() => findJobRoute({ backend: { jobs: [{ type: 'x', route: 'POST /a/./b' }] } }, 'x'), /"\.\."|"\."/);
    // 段里带点但不是整段 . / ..（比如 v1.2）是合法的
    assert.equal(findJobRoute({ backend: { jobs: [{ type: 'x', route: 'POST /v1.2/run' }] } }, 'x').path, '/v1.2/run');
});

test('buildJobClaims：任务模式四个 claim、scopes 用传入的、TTL 360、身份字段取 dev key', () => {
    const { key } = devKey();
    const scopes = ['analytics:read', 'jobs:run'];
    const c = buildJobClaims(key, scopes, { preview: false, runId: 'R', now: 1000 });
    assert.equal(c.trg, 'job');
    assert.equal(c.job, 'local');
    assert.equal(c.run, 'R');
    assert.equal(c.mode, 'run');
    assert.deepEqual(c.scopes, scopes);
    assert.equal(c.iat, 1000);
    assert.equal(c.exp - c.iat, 360);
    assert.equal(LOCAL_JOB_TOKEN_TTL_SEC, 360);
    assert.equal(typeof c.jti, 'string');
    assert.deepEqual([c.iss, c.aud, c.sub, c.wid, c.sid, c.ver], [key.iss, key.aud, key.sub, key.wid, key.sid, key.ver]);
    assert.equal(buildJobClaims(key, scopes, { preview: true, runId: 'R' }).mode, 'preview');
});

test('signDevToken：EdDSA，header 带 dev key 的 kid，用 dev 公钥能验过', () => {
    const { key, publicKey } = devKey();
    const t = signDevToken(key, { a: 1 });
    const [h, p, s] = t.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { a: 1 });
    assert.ok(nodeVerify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('formatVerdict', () => {
    assert.equal(formatVerdict({ status: 'stored' }), 'stored（平台会采集这份结果）');
    assert.match(formatVerdict({ status: 'invalid', reason: '缺 markdown' }), /^invalid（缺 markdown）/);
    assert.match(formatVerdict({ status: 'too_large' }), /^too_large/);
    assert.match(formatVerdict({ status: 'none', note: '非 2xx' }), /^none（非 2xx）/);
    assert.match(formatVerdict({ status: 'none' }), /^none（/);
});

async function withServer(handler, fn) {
    const server = createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const prev = process.env.PTX_API_PORT;
    process.env.PTX_API_PORT = String(port);
    try { return await fn(); } finally {
        if (prev === undefined) delete process.env.PTX_API_PORT; else process.env.PTX_API_PORT = prev;
        await new Promise(r => server.close(r));
    }
}

/** 一个最小项目：manifest + wrangler.jsonc；withKey 时用真的 generateDevKeys 生成 dev key 与 .dev.vars。 */
function project({ withKey = true, manifest = MANIFEST } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ptx-job-'));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    mkdirSync(join(root, 'web'), { recursive: true });
    mkdirSync(join(root, 'backend'), { recursive: true });
    writeFileSync(join(root, 'backend', 'wrangler.jsonc'),
        '{ "vars": { "PT_TOKEN_AUD": "app:local-dev", "PT_TOKEN_ISS": "https://auth.ptengine.ai" } }');
    if (withKey) generateDevKeys(root);
    return root;
}

async function captureLogs(fn) {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try { await fn(); } finally { console.log = orig; }
    return logs.join('\n');
}

test('run：POST 到本地 worker 的 /api<path>，带任务 token，打印状态码 / 响应体 / 结果', async () => {
    const seen = {};
    const root = project();
    const out = await captureLogs(() => withServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, ct: req.headers['content-type'], body });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ archive: { markdown: '# ok' } }));
        });
    }, () => run(['run', 'weekly-report', '--params', '{"channel":"c"}'], root)));
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/jobs/weekly-report');
    assert.equal(seen.ct, 'application/json');
    assert.equal(seen.body, '{"channel":"c"}');
    const claims = decode(seen.auth);
    assert.deepEqual([claims.trg, claims.job, claims.mode], ['job', 'local', 'run']);
    assert.match(claims.run, /^[0-9a-f-]{36}$/);
    // scopes 照抄 manifest.scopes（与 ptx dev 的交互 token 同一口径，没有额外默认项）
    assert.deepEqual(claims.scopes, MANIFEST.scopes);
    assert.match(out, /状态码：200/);
    assert.match(out, /# ok/);
    assert.match(out, /结果：stored/);
    assert.equal(process.exitCode ?? 0, 0);
});

test('run：token 能用 ptx dev 写进 backend/.dev.vars 的 JWKS 验过，iss / aud / kid 与后端配置一致', async () => {
    let auth;
    const root = project();
    await captureLogs(() => withServer((req, res) => {
        auth = req.headers.authorization;
        req.resume();
        req.on('end', () => { res.writeHead(204); res.end(); });
    }, () => run(['run', 'weekly-report', '--preview'], root)));
    const token = auth.replace(/^Bearer /, '');
    const [h, p, s] = token.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const devVars = readFileSync(join(root, 'backend', '.dev.vars'), 'utf8');
    const jwks = JSON.parse(devVars.match(/^PT_JWKS_JSON=(.*)$/m)[1]);
    const jwk = jwks.keys.find(k => k.kid === header.kid);
    assert.ok(jwk, 'kid 要在 .dev.vars 的 JWKS 里');
    assert.equal(header.alg, 'EdDSA');
    const { kid, alg, use, ...pub } = jwk;
    const key = await webcrypto.subtle.importKey('jwk', pub, { name: 'Ed25519' }, false, ['verify']);
    assert.ok(await webcrypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`)));
    const claims = decode(token);
    assert.equal(claims.iss, 'https://auth.ptengine.ai');
    assert.equal(claims.aud, 'app:local-dev');
    assert.equal(claims.mode, 'preview');
    assert.ok(claims.exp > Math.floor(Date.now() / 1000));
});

test('run：非 2xx → 结果 none、exitCode 1', async () => {
    const root = project();
    try {
        const out = await captureLogs(() => withServer((_req, res) => {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end('{"error":{"code":"JOB_ONLY"}}');
        }, () => run(['run', 'weekly-report'], root)));
        assert.match(out, /状态码：403/);
        assert.match(out, /JOB_ONLY/);
        assert.match(out, /结果：none/);
        assert.equal(process.exitCode, 1);
    } finally { process.exitCode = 0; }
});

test('run：2xx 但 archive 不合规 → 结果 invalid（原因），exitCode 仍为 0', async () => {
    const root = project();
    const out = await captureLogs(() => withServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"archive":{}}');
    }, () => run(['run', 'weekly-report'], root)));
    assert.match(out, /结果：invalid（.+）/);
    assert.equal(process.exitCode ?? 0, 0);
});

test('run：没有 dev key → 提示先 npm run dev', async () => {
    await assert.rejects(run(['run', 'weekly-report'], project({ withKey: false })), /npm run dev/);
});

test('run：本地 worker 没起来 → 提示先 npm run dev', async () => {
    const root = project();
    // 起一个端口再关掉，拿到一个确定没人听的端口
    const server = createServer();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise(r => server.close(r));
    const prev = process.env.PTX_API_PORT;
    process.env.PTX_API_PORT = String(port);
    try {
        await assert.rejects(captureLogs(() => run(['run', 'weekly-report'], root)), /npm run dev/);
    } finally {
        if (prev === undefined) delete process.env.PTX_API_PORT; else process.env.PTX_API_PORT = prev;
    }
});

test('run：未知 type / 无 backend.jobs 时在发请求前报错', async () => {
    await assert.rejects(run(['run', 'nope'], project()), /"nope"/);
    const { jobs, ...backend } = MANIFEST.backend;
    await assert.rejects(run(['run', 'weekly-report'], project({ manifest: { ...MANIFEST, backend } })), /backend\.jobs/);
});

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const LOG = { v: 1, entries: [{ t: 3, m: '开始', f: { step: 1 } }, { t: 120, m: '结束' }], truncated: false, stats: { query: 2, notifyEmail: 1, renderChart: 1 } };
const J = RULES.jobLog;
/** @ptengine/app-backend（src/job-log.ts）真实产出的头，与平台 contract 测试的 APP_BACKEND_SAMPLE 逐字相同：
 *  含日文 / 中文、一条被截到 1 999 + '…' 的 m、一条因 f 过大被丢掉 f 的条目。 */
const APP_BACKEND_SAMPLE = 'eyJ2IjoxLCJlbnRyaWVzIjpbeyJ0Ijo3LCJtIjoi5byA5aeL5Y-W5pWwIiwiZiI6eyJyb3dzIjoyLCJzaXRlIjoiYWJjIn19LHsidCI6MTQsIm0iOiLjg6zjg53jg7zjg4jpgIHkv6EgZG9uZSJ9LHsidCI6MjEsIm0iOiJ5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl54oCmIn0seyJ0IjoyOCwibSI6ImJpZyBmIGRyb3BwZWQifV0sInRydW5jYXRlZCI6ZmFsc2UsInN0YXRzIjp7InF1ZXJ5IjoyLCJub3RpZnlFbWFpbCI6MSwicmVuZGVyQ2hhcnQiOjB9fQ';

test('decodeJobLogHeader：合法 → { log, reason: null }', () => {
    assert.deepEqual(decodeJobLogHeader(b64(LOG)), { log: LOG, reason: null });
});

test('decodeJobLogHeader：接受 app-backend 真实产出的头（与平台 parseRunLogHeader 同一样例）', () => {
    const { log, reason } = decodeJobLogHeader(APP_BACKEND_SAMPLE);
    assert.equal(reason, null);
    assert.deepEqual(log, {
        v: 1,
        entries: [
            { t: 7, m: '开始取数', f: { rows: 2, site: 'abc' } },
            { t: 14, m: 'レポート送信 done' },
            { t: 21, m: `${'y'.repeat(1999)}…` },
            { t: 28, m: 'big f dropped' }
        ],
        truncated: false,
        stats: { query: 2, notifyEmail: 1, renderChart: 0 }
    });
    assert.match(formatJobLog(log), /取数 2 次 · 邮件 1 次 · 图表 0 次/);
});

// 合法日志的 base64url（JSON 长度凑成 3 的倍数 → 编码长度 %4 === 0）再多一个字符。
const lenMod4Is1 = (() => {
    let pad = '';
    while (Buffer.byteLength(JSON.stringify({ ...LOG, pad })) % 3 !== 0) pad += 'p';
    return `${b64({ ...LOG, pad })}A`;
})();

test('decodeJobLogHeader：与平台 parseRunLogHeader 同口径地拒绝，并给出原因（上限全部读 rules.jobLog）', () => {
    const bad = [
        ['%%%', /base64url/],
        ['', /base64url/],
        ['A'.repeat(J.headerMaxBytes + 1), /字节/],
        [lenMod4Is1, /解不开/],                                 // 长度 %4 === 1：Buffer 会宽松地解出合法日志，平台的 atob 会抛
        [Buffer.from([0xff, 0xfe]).toString('base64url'), /解不开/],
        [b64([1]), /v/],
        [b64({ ...LOG, v: 2 }), /v/],
        [b64({ ...LOG, truncated: 'no' }), /truncated/],
        [b64({ ...LOG, entries: {} }), /entries/],
        [b64({ ...LOG, stats: { query: -1, notifyEmail: 0, renderChart: 0 } }), /stats/],
        [b64({ ...LOG, stats: { query: 1.5, notifyEmail: 0, renderChart: 0 } }), /stats/],
        [b64({ ...LOG, entries: Array.from({ length: J.maxEntries + 1 }, () => ({ t: 0, m: 'x' })) }), /条/],
        [b64({ ...LOG, entries: [{ t: -1, m: 'x' }] }), /t/],
        [b64({ ...LOG, entries: [{ t: '1', m: 'x' }] }), /t/],
        [b64({ ...LOG, entries: [{ t: 0 }] }), /m/],
        [b64({ ...LOG, entries: [{ t: 0, m: 'x'.repeat(J.entryMessageMax + 1) }] }), /m/],
        [b64({ ...LOG, entries: [{ t: 0, m: 'x', f: { pad: 'y'.repeat(J.entryFieldsMaxBytes) } }] }), /f/],
        [b64({ ...LOG, entries: [{ t: 0, m: 'x', f: [1] }] }), /f/],
        [b64({ ...LOG, entries: [{ t: 0, m: 'x', f: null }] }), /f/]
    ];
    for (const [raw, why] of bad) {
        const r = decodeJobLogHeader(raw);
        assert.equal(r.log, null, String(raw).slice(0, 30));
        assert.match(r.reason, why, String(raw).slice(0, 30));
    }
    // 恰好在上限内的条目通过
    assert.equal(decodeJobLogHeader(b64({ ...LOG, entries: [{ t: 0, m: 'x'.repeat(J.entryMessageMax) }] })).reason, null);
    assert.equal(decodeJobLogHeader(b64({ ...LOG, entries: Array.from({ length: J.maxEntries }, () => ({ t: 0, m: 'x' })) })).reason, null);
});

test('decodeJobLogHeader：上限读传入的 rules（换一组规则行为跟着变）；rules 缺键 → 抛「npm run sync-rules」', () => {
    assert.match(decodeJobLogHeader(b64(LOG), { ...J, maxEntries: 1 }).reason, /条/);
    assert.throws(() => decodeJobLogHeader(b64(LOG), { headerName: J.headerName }), /npm run sync-rules/);
    assert.throws(() => decodeJobLogHeader(b64(LOG), null), /npm run sync-rules/);
});

test('formatJobLog：首行三项计数，逐行 +<t>ms 消息 字段；截断与空日志有提示', () => {
    const s = formatJobLog(LOG);
    assert.match(s, /取数 2 次 · 邮件 1 次 · 图表 1 次/);
    assert.match(s, /\+3ms\s+开始 \{"step":1\}/);
    assert.match(s, /\+120ms\s+结束$/m);
    assert.match(formatJobLog({ ...LOG, truncated: true }), /已截断/);
    assert.match(formatJobLog({ ...LOG, entries: [] }), /没有 ctx\.log/);
});

test('run --preview：打印解码后的预览日志与本地推送预览地址（邮件 / 渠道消息，.ptx/outbox/<runId> 存在时）', async () => {
    const root = project();
    const out = await captureLogs(() => withServer((req, res) => {
        const claims = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url'));
        mkdirSync(join(root, '.ptx', 'outbox', claims.run), { recursive: true });       // 模拟本地桩写下的邮件 / 渠道消息
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json', [J.headerName]: b64(LOG) });
            res.end('{}');
        });
    }, () => run(['run', 'weekly-report', '--preview'], root)));
    assert.match(out, /预览日志（x-pt-job-log）：取数 2 次/);
    assert.match(out, /\+3ms\s+开始/);
    assert.match(out, /本地推送预览（邮件 \/ 渠道消息）：http:\/\/localhost:8788\/__ptx\/outbox\/[0-9a-f-]{36}/);
});

test('run --preview：头不合平台口径 → 打印原因与「线上会被平台丢弃」', async () => {
    const root = project();
    const out = await captureLogs(() => withServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json', [J.headerName]: b64({ ...LOG, entries: [{ t: 0, m: 'x'.repeat(J.entryMessageMax + 1) }] }) });
            res.end('{}');
        });
    }, () => run(['run', 'weekly-report', '--preview'], root)));
    assert.match(out, /线上会被平台丢弃/);
    assert.match(out, /第 1 条的 m/);
});

test('run --preview 但响应没有头 → 提示 app-backend 版本；没调 notify.email / notify.channel → 明说', async () => {
    const root = project();
    const out = await captureLogs(() => withServer((req, res) => {
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    }, () => run(['run', 'weekly-report', '--preview'], root)));
    assert.match(out, /响应里没有 x-pt-job-log/);
    assert.match(out, /这次运行没有调用 ctx\.pt\.notify\.email \/ notify\.channel。/);
});

test('非预览运行的响应带了头 → 警告（app-backend 不该这样）', async () => {
    const root = project();
    const out = await captureLogs(() => withServer((req, res) => {
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', [J.headerName]: b64(LOG) }); res.end('{}'); });
    }, () => run(['run', 'weekly-report'], root)));
    assert.match(out, /非预览运行的响应带了 x-pt-job-log/);
});

test('decodeJobLogHeader：1c 的可选 stats.notifyChannel —— 缺省照收，非负整数照收，出现但不合规整头作废（与平台同口径）', () => {
    assert.equal(decodeJobLogHeader(b64(LOG)).reason, null);
    assert.equal(decodeJobLogHeader(b64({ ...LOG, stats: { ...LOG.stats, notifyChannel: 3 } })).reason, null);
    assert.equal(decodeJobLogHeader(b64({ ...LOG, stats: { ...LOG.stats, notifyChannel: 0 } })).reason, null);
    for (const bad of [-1, 1.5, '2', null, true]) {
        const r = decodeJobLogHeader(b64({ ...LOG, stats: { ...LOG.stats, notifyChannel: bad } }));
        assert.equal(r.log, null, String(bad));
        assert.match(r.reason, /notifyChannel/, String(bad));
    }
});

test('formatJobLog：首行末尾追加「渠道 n 次」（缺省按 0），不打乱前三项的顺序', () => {
    assert.match(formatJobLog({ ...LOG, stats: { ...LOG.stats, notifyChannel: 4 } }), /取数 2 次 · 邮件 1 次 · 图表 1 次 · 渠道 4 次/);
    assert.match(formatJobLog(LOG), /图表 1 次 · 渠道 0 次/);
});
