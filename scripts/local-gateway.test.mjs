import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobsStore, decodeClaims, handleJobsRequest } from './local-gateway/jobs-store.mjs';

const tok = claims => `Bearer h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const USER = tok({ sub: 'local-user', wid: 'local-ws', scopes: ['jobs:run'] });
const OTHER = tok({ sub: 'someone-else', wid: 'local-ws', scopes: ['jobs:run'] });
const JOB = tok({ sub: 'local-user', wid: 'local-ws', scopes: ['jobs:run'], trg: 'job', job: 'local', run: 'r1' });
let n = 0;
const call = (store, authorization, body) =>
    handleJobsRequest(store, { appId: 'local-dev', authorization, body, now: new Date(Date.UTC(2026, 9, 8, 0, 0, n++)), uuid: () => `id-${n}` });
const CREATE = { op: 'create', type: 'weekly-report', cron: '0 9 * * 1', timezone: 'Asia/Tokyo', params: { channel: 'c' } };

test('decodeClaims：坏令牌 → null；能解中文 claim', () => {
    assert.equal(decodeClaims(''), null);
    assert.equal(decodeClaims('Bearer abc'), null);
    assert.equal(decodeClaims(tok({ name: '魏' })).name, '魏');
});

test('create → 201 JobView（创建者 / 工作区取自令牌，title 缺省取 type）', () => {
    const s = createJobsStore();
    const r = call(s, USER, CREATE);
    assert.equal(r.status, 201);
    assert.deepEqual(
        { ...r.body, id: undefined, createdAt: undefined, updatedAt: undefined },
        { id: undefined, appId: 'local-dev', workspaceId: 'local-ws', type: 'weekly-report', title: 'weekly-report',
          cron: '0 9 * * 1', timezone: 'Asia/Tokyo', params: { channel: 'c' }, createdBy: 'local-user', status: 'active',
          pauseReason: null, consecutiveFailures: 0, nextRunAt: null, lastRunAt: null,
          archiveToAssets: false,
          scheduleDescription: { zh: '（本地桩）cron 0 9 * * 1 · Asia/Tokyo', en: '(local stub) cron 0 9 * * 1 · Asia/Tokyo', ja: '（ローカルスタブ）cron 0 9 * * 1 · Asia/Tokyo' },
          createdAt: undefined, updatedAt: undefined });
});

test('无 jobs:run → 403 SCOPE_DENIED；令牌缺失 → 401', () => {
    const s = createJobsStore();
    assert.equal(call(s, tok({ sub: 'u', scopes: [] }), CREATE).body.error.code, 'SCOPE_DENIED');
    assert.equal(call(s, '', CREATE).status, 401);
});

test('任务触发里 create → 403 JOB_CREATE_FROM_JOB；其它 op 允许（任务可以暂停自己）', () => {
    const s = createJobsStore();
    assert.equal(call(s, JOB, CREATE).body.error.code, 'JOB_CREATE_FROM_JOB');
    const id = call(s, USER, CREATE).body.id;
    assert.equal(call(s, JOB, { op: 'pause', jobId: id }).body.status, 'paused');
});

test('list 只返回本人的、按创建时间倒序；limit 生效', () => {
    const s = createJobsStore();
    const a = call(s, USER, CREATE).body.id;
    const b = call(s, USER, CREATE).body.id;
    call(s, OTHER, CREATE);
    assert.deepEqual(call(s, USER, { op: 'list' }).body.jobs.map(j => j.id), [b, a]);
    assert.deepEqual(call(s, USER, { op: 'list', limit: 1 }).body.jobs.map(j => j.id), [b]);
});

test('get / update / pause / resume / delete；非本人 403、不存在 404', () => {
    const s = createJobsStore();
    const id = call(s, USER, CREATE).body.id;
    assert.equal(call(s, USER, { op: 'get', jobId: id }).status, 200);
    assert.equal(call(s, OTHER, { op: 'get', jobId: id }).body.error.code, 'JOB_FORBIDDEN');
    assert.equal(call(s, USER, { op: 'get', jobId: 'nope' }).body.error.code, 'JOB_NOT_FOUND');
    const u = call(s, USER, { op: 'update', jobId: id, cron: '0 10 * * 1' }).body;
    assert.equal(u.cron, '0 10 * * 1');
    assert.equal(u.scheduleDescription.en, '(local stub) cron 0 10 * * 1 · Asia/Tokyo');   // 改 cron 后占位说明跟着变
    const p = call(s, USER, { op: 'pause', jobId: id }).body;
    assert.deepEqual([p.status, p.pauseReason], ['paused', 'MANUAL']);
    const r = call(s, USER, { op: 'resume', jobId: id }).body;
    assert.deepEqual([r.status, r.pauseReason, r.consecutiveFailures], ['active', null, 0]);
    assert.deepEqual(call(s, USER, { op: 'delete', jobId: id }), { status: 204, body: null });
    assert.equal(call(s, USER, { op: 'get', jobId: id }).status, 404);
});

test('入参形状错：给出与平台同名的码', () => {
    const s = createJobsStore();
    assert.equal(call(s, USER, { ...CREATE, type: '' }).body.error.code, 'JOB_TYPE_UNKNOWN');
    assert.equal(call(s, USER, { ...CREATE, cron: 1 }).body.error.code, 'JOB_CRON_INVALID');
    assert.equal(call(s, USER, { ...CREATE, timezone: undefined }).body.error.code, 'JOB_TIMEZONE_INVALID');
    assert.equal(call(s, USER, { ...CREATE, params: [] }).body.error.code, 'JOB_PARAMS_INVALID');
    assert.equal(call(s, USER, { ...CREATE, title: '' }).body.error.code, 'JOB_TITLE_INVALID');
    assert.equal(call(s, USER, { op: 'explode' }).body.error.code, 'JOB_OP_INVALID');
});

test('桩的状态只在内存里：新 store 是空的（ptx dev 重启即清空）', () => {
    const s1 = createJobsStore();
    call(s1, USER, CREATE);
    assert.equal(call(createJobsStore(), USER, { op: 'list' }).body.jobs.length, 0);
});

test('缺 jobs:run 的提示指向 manifest.json（.ptx-dev-key.json 每次 ptx dev 都会被重写，改它没用）', () => {
    const msg = call(createJobsStore(), tok({ sub: 'u', scopes: [] }), CREATE).body.error.message;
    assert.match(msg, /manifest\.json/);
    assert.match(msg, /jobs:run/);
    assert.match(msg, /重启 ptx dev/);
    assert.doesNotMatch(msg, /\.ptx-dev-key\.json/);
});

import { readFileSync } from 'node:fs';
import worker from './local-gateway/worker.mjs';
import { parseJsonc } from './jsonc.mjs';
import { LOCAL_STUB_ORIGIN } from './local-stub/server.mjs';

test('网关桩把 /notify/email、/notify/channel、/notify/channels、/render/chart 原样转给 PTX_STUB_ORIGIN（authorization / x-pt-app-id / body）', async () => {
    const seen = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }); };
    try {
        for (const p of ['/notify/email', '/notify/channel', '/notify/channels', '/render/chart']) {
            const res = await worker.fetch(new Request(`https://gateway${p}`, {
                method: 'POST', headers: { authorization: 'Bearer t', 'x-pt-app-id': 'local-dev', 'content-type': 'application/json' }, body: '{"a":1}'
            }), { PTX_STUB_ORIGIN: 'http://127.0.0.1:9999' });
            assert.equal(res.status, 200);
        }
    } finally { globalThis.fetch = orig; }
    assert.deepEqual(seen.map(s => s.url), ['http://127.0.0.1:9999/notify/email', 'http://127.0.0.1:9999/notify/channel',
        'http://127.0.0.1:9999/notify/channels', 'http://127.0.0.1:9999/render/chart']);
    const h = new Headers(seen[0].init.headers);
    assert.equal(h.get('authorization'), 'Bearer t');
    assert.equal(h.get('x-pt-app-id'), 'local-dev');
    assert.equal(seen[0].init.body, '{"a":1}');
});

test('桩服务连不上 → 503 PTX_STUB_UNAVAILABLE，提示用 npm run dev', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    try {
        const res = await worker.fetch(new Request('https://gateway/notify/email', { method: 'POST', body: '{}' }), { PTX_STUB_ORIGIN: 'http://127.0.0.1:9' });
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.error.code, 'PTX_STUB_UNAVAILABLE');
        assert.match(body.error.message, /npm run dev/);
    } finally { globalThis.fetch = orig; }
});

test('local-gateway/wrangler.jsonc 的 PTX_STUB_ORIGIN 与 server.mjs 的 LOCAL_STUB_ORIGIN 一致（改一处必须改另一处）', () => {
    const cfg = parseJsonc(readFileSync(new URL('./local-gateway/wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(cfg.vars.PTX_STUB_ORIGIN, LOCAL_STUB_ORIGIN);
});

test('PTX_STUB_ORIGIN 为空 → 直接 503 PTX_STUB_UNAVAILABLE，提示 wrangler.jsonc 缺 vars.PTX_STUB_ORIGIN，不发请求', async () => {
    const orig = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; return new Response('{}'); };
    try {
        for (const env of [{}, { PTX_STUB_ORIGIN: '' }, undefined]) {
            const res = await worker.fetch(new Request('https://gateway/render/chart', { method: 'POST', body: '{}' }), env);
            assert.equal(res.status, 503);
            const body = await res.json();
            assert.equal(body.error.code, 'PTX_STUB_UNAVAILABLE');
            assert.match(body.error.message, /wrangler\.jsonc 缺 vars\.PTX_STUB_ORIGIN/);
        }
    } finally { globalThis.fetch = orig; }
    assert.equal(called, 0);
});

test('1b+：create / update 接受 archiveToAssets（布尔）；非布尔 → 400 JOB_OP_INVALID', () => {
    const s = createJobsStore();
    const job = call(s, USER, { ...CREATE, archiveToAssets: true }).body;
    assert.equal(job.archiveToAssets, true);
    assert.equal(call(s, USER, { op: 'update', jobId: job.id, archiveToAssets: false }).body.archiveToAssets, false);
    assert.equal(call(s, USER, { op: 'update', jobId: job.id, archiveToAssets: 'yes' }).body.error.code, 'JOB_OP_INVALID');
    assert.equal(call(s, USER, { ...CREATE, archiveToAssets: 1 }).body.error.code, 'JOB_OP_INVALID');
});

test('网关桩：转发保留本地桩响应的状态与头（retry-after 等），未知路径 501 的话术点名 notify.channel', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"error":{"code":"NOTIFY_CHANNEL_RATE_LIMITED","message":"x"}}', { status: 429, headers: { 'retry-after': '7' } });
    try {
        const res = await worker.fetch(new Request('https://gateway/notify/channel', { method: 'POST', body: '{}' }), { PTX_STUB_ORIGIN: 'http://127.0.0.1:9999' });
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('retry-after'), '7');
    } finally { globalThis.fetch = orig; }
    const other = await worker.fetch(new Request('https://gateway/data-query', { method: 'POST', body: '{}' }), { PTX_STUB_ORIGIN: 'http://127.0.0.1:9999' });
    assert.equal(other.status, 501);
    assert.match((await other.json()).error.message, /notify\.channel/);
});
