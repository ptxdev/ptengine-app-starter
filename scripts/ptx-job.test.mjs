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
import { generateDevKeys, DEFAULT_DEV_SCOPES } from './dev-keys.mjs';
import { buildJobClaims, findJobRoute, formatVerdict, parseJobArgs, run, signDevToken, LOCAL_JOB_TOKEN_TTL_SEC } from './ptx-job.mjs';

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
    assert.throws(() => parseJobArgs([]), /ptx job run/);
    assert.throws(() => parseJobArgs(['list']), /ptx job run/);
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
    // scopes = devScopes(root)：默认列表 ∪ manifest.scopes
    assert.ok(claims.scopes.includes('jobs:run'));
    for (const s of DEFAULT_DEV_SCOPES) assert.ok(claims.scopes.includes(s), s);
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
