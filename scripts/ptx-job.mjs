/**
 * ptx job run —— 在本地以「定时任务」的身份调一次任务路由。
 *
 *   npx ptx job run <type> [--params '<json>'] [--preview]
 *
 * 读 manifest.backend.jobs 找到 route，用 ptx dev 生成的本地开发密钥（web/.ptx-dev-key.json）签一枚
 * 任务模式 token（trg='job'、job='local'、run=<uuid>、mode），POST 到本地 worker，打印状态码、响应体，
 * 以及平台会把这次返回判成什么（stored / none / invalid（原因）/ too_large，口径见 job-result.mjs）。
 *
 * 身份（iss / aud / kid / sub / wid / sid / ver）全部取自 dev key —— 与 vite 的 /__ptx/token 签发同源，
 * 所以本地 worker 的 app-backend 用 backend/.dev.vars 里的 JWKS 能验过。
 * scopes 取 devTokenScopes(manifest)（照抄 manifest.scopes）：线上任务 token 的 scopes = manifest ∩ 同意，
 * 本地按「全部同意」处理，与 ptx dev 的交互 token 同一口径（没声明的 scope 本地同样拿不到）。
 *
 * --preview 时另打印应用响应头（名字取 rules.json 的 jobLog.headerName）的解码内容（ctx.log 与取数 / 邮件 / 图表次数）
 * —— 按平台 parseRunLogHeader 同口径校验，不合规时说明线上会被丢弃的原因 —— 以及本地桩写下的邮件预览页地址。
 */
import { createPrivateKey, randomUUID, sign as nodeSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devTokenScopes } from './dev-keys.mjs';
import { classifyJobResponse } from './job-result.mjs';
import { LOCAL_STUB_PORT } from './local-stub/server.mjs';
import { readManifest, RULES } from './manifest.mjs';

/** = 平台 JOB_TOKEN_TTL_SEC（JOB_RUN_BUDGET_SEC + 60）。 */
export const LOCAL_JOB_TOKEN_TTL_SEC = 360;
/** = 平台 JOB_RUN_BUDGET_SEC × 1000（scheduler 调应用时的超时）。 */
export const LOCAL_JOB_TIMEOUT_MS = 300_000;

const USAGE = "用法：npx ptx job run <type> [--params '<json>'] [--preview]";

export function parseJobArgs(args) {
    const [sub, type, ...rest] = args;
    if (sub !== 'run') throw new Error(USAGE);
    if (!type || type.startsWith('--')) throw new Error(`缺少任务类型 <type>。${USAGE}`);
    let params = {};
    let preview = false;
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--preview') { preview = true; continue; }
        if (a === '--params') {
            const raw = rest[++i];
            if (raw === undefined) throw new Error('--params 后面要跟一段 JSON 对象，例如 --params \'{"channel":"email"}\'');
            try { params = JSON.parse(raw); } catch { throw new Error(`--params 不是合法 JSON：${raw}`); }
            if (params === null || typeof params !== 'object' || Array.isArray(params)) {
                throw new Error('--params 必须是 JSON 对象（平台传给任务路由的 body 就是这个对象）');
            }
            continue;
        }
        throw new Error(`不认识的参数：${a}。${USAGE}`);
    }
    return { type, params, preview };
}

/** 找任务类型对应的路由。path 的算法与 scheduler 一致：去掉 "POST " 前缀，调用时拼成 /api + path。 */
export function findJobRoute(manifest, type) {
    const jobs = manifest?.backend?.jobs;
    if (!Array.isArray(jobs) || jobs.length === 0) {
        throw new Error('manifest.json 的 backend.jobs 里没有声明任何任务类型（先在 manifest 里声明，再用 ptx job run 调）');
    }
    const job = jobs.find(j => j?.type === type);
    if (!job) throw new Error(`manifest.backend.jobs 里没有类型 "${type}"。已声明：${jobs.map(j => j?.type).join(' / ')}`);
    if (typeof job.route !== 'string' || !job.route.startsWith('POST /')) {
        throw new Error(`任务 ${type} 的 route ${JSON.stringify(job.route)} 不是 "POST /…" 的形状`);
    }
    const path = job.route.slice('POST '.length);
    // 与 contract validateManifestJobs 一致：路径不能含 "." / ".." 段（上传会被拒）。
    if (path.split('/').some(seg => seg === '.' || seg === '..')) {
        throw new Error(`任务 ${type} 的 route 路径不能含 "." 或 ".." 段，收到 ${JSON.stringify(job.route)}`);
    }
    return { job, path };
}

export function buildJobClaims(devKey, scopes, { preview, runId, now = Math.floor(Date.now() / 1000) }) {
    return {
        iss: devKey.iss, aud: devKey.aud, sub: devKey.sub, wid: devKey.wid, sid: devKey.sid,
        scopes: [...scopes],
        ver: devKey.ver, iat: now, exp: now + LOCAL_JOB_TOKEN_TTL_SEC, jti: randomUUID(),
        trg: 'job', job: 'local', run: runId, mode: preview ? 'preview' : 'run'
    };
}

/** 与 web/vite.config.ts 的 /__ptx/token 同一种签法：EdDSA(Ed25519)，header 带 dev key 的 kid。 */
export function signDevToken(devKey, claims) {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: devKey.kid })}.${b64(claims)}`;
    const key = createPrivateKey({ key: devKey.privateJwk, format: 'jwk' });
    return `${input}.${nodeSign(null, Buffer.from(input), key).toString('base64url')}`;
}

export function formatVerdict(v) {
    switch (v.status) {
        case 'stored': return 'stored（平台会采集这份结果）';
        case 'invalid': return `invalid（${v.reason}）—— 不影响运行成败，但平台不会采集`;
        case 'too_large': return 'too_large（响应体超过上限，平台不会采集）';
        default: return v.note ? `none（${v.note}）` : 'none（没有返回 archive）';
    }
}

function jobLogRules(rules) {
    const keys = ['headerName', 'headerMaxBytes', 'maxEntries', 'entryMessageMax', 'entryFieldsMaxBytes'];
    if (!rules || keys.some(k => rules[k] === undefined)) {
        throw new Error('scripts/rules.json 里没有完整的 jobLog 段（规则快照过旧）。维护者请跑 npm run sync-rules。');
    }
    return rules;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const isCount = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 解 app-backend 的预览日志头（base64url(UTF-8 JSON)，brief §7.7 / 修订 1 第 5 条）。
 * 判定**逐条照**平台 contract 的 parseRunLogHeader（本仓是公开仓、装不了 contract 包；判定顺序、解码方式都照抄），
 * 所有上限读 rules.jobLog —— 本地解得开、线上却被平台当 job-log-invalid 丢掉的情况，在这里就能看到原因。
 * 返回 { log, reason: null }（log 为解出的原对象）或 { log: null, reason }（reason 指出第一个不合规点）。
 */
export function decodeJobLogHeader(value, rules = RULES.jobLog) {
    const j = jobLogRules(rules);
    const no = reason => ({ log: null, reason });
    if (typeof value !== 'string' || value.length === 0) return no('不是 base64url 字符串（空）');
    // 平台按 raw.length 比；合法头只含 base64url 字符（ASCII），长度即字节数。
    if (value.length > j.headerMaxBytes) return no(`超过 ${j.headerMaxBytes} 字节`);
    if (!B64URL.test(value)) return no('不是 base64url 字符串');
    let o;
    try {
        // 与平台同法：补齐 padding 后 atob（长度 %4 === 1 会抛），再严格 UTF-8 解码。
        const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        return no('解不开（不是 base64url 编码的 UTF-8 JSON）');
    }
    if (!isPlainObject(o) || o.v !== 1) return no('v 不是 1（或整体不是对象）');
    if (typeof o.truncated !== 'boolean') return no('truncated 不是布尔值');
    if (!Array.isArray(o.entries)) return no('entries 不是数组');
    if (o.entries.length > j.maxEntries) return no(`entries 超过 ${j.maxEntries} 条`);
    const s = o.stats;
    if (!isPlainObject(s) || !isCount(s.query) || !isCount(s.notifyEmail) || !isCount(s.renderChart)) {
        return no('stats 不是三个非负整数（query / notifyEmail / renderChart）');
    }
    for (const [i, e] of o.entries.entries()) {
        if (!isPlainObject(e) || typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) return no(`第 ${i + 1} 条的 t 不是非负数`);
        if (typeof e.m !== 'string' || e.m.length > j.entryMessageMax) return no(`第 ${i + 1} 条的 m 不是 ≤ ${j.entryMessageMax} 的字符串`);
        if (e.f !== undefined && (!isPlainObject(e.f) || Buffer.byteLength(JSON.stringify(e.f)) > j.entryFieldsMaxBytes)) {
            return no(`第 ${i + 1} 条的 f 不是 ≤ ${j.entryFieldsMaxBytes} 字节的对象`);
        }
    }
    return { log: o, reason: null };
}

export function formatJobLog(log) {
    const s = log.stats ?? {};
    const lines = [`  预览日志（${jobLogRules(RULES.jobLog).headerName}）：取数 ${s.query ?? 0} 次 · 邮件 ${s.notifyEmail ?? 0} 次 · 图表 ${s.renderChart ?? 0} 次` +
        `${log.truncated ? ' · 已截断（线上同样只保留前面能放进上限的部分）' : ''}`];
    if (log.entries.length === 0) lines.push('    （没有 ctx.log）');
    for (const e of log.entries) lines.push(`    +${e.t}ms  ${e.m}${e.f ? ` ${JSON.stringify(e.f)}` : ''}`);
    return lines.join('\n');
}

function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export async function run(args, root) {
    const { type, params, preview } = parseJobArgs(args);
    const manifest = readManifest(root);
    const { path } = findJobRoute(manifest, type);

    const keyPath = join(root, 'web', '.ptx-dev-key.json');
    if (!existsSync(keyPath)) {
        throw new Error('没找到本地开发密钥 web/.ptx-dev-key.json。先在另一个终端跑 npm run dev（ptx dev），再执行本命令。');
    }
    const devKey = JSON.parse(readFileSync(keyPath, 'utf8'));
    const runId = randomUUID();
    const token = signDevToken(devKey, buildJobClaims(devKey, devTokenScopes(manifest), { preview, runId }));

    const port = process.env.PTX_API_PORT || '8787';
    const url = `http://127.0.0.1:${port}/api${path}`;
    console.log(`\n  POST ${url}\n  runId = ${runId}${preview ? '（预览模式：ctx.auth.preview === true）' : ''}\n`);

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(LOCAL_JOB_TIMEOUT_MS)
        });
    } catch (e) {
        const why = e?.name === 'TimeoutError'
            ? '超过 300 秒没有返回（线上同样会记 RUN_TIMEOUT）'
            : (e?.cause?.code ?? e?.message ?? String(e));
        throw new Error(`请求本地 worker 失败：${why}。确认另一个终端里 npm run dev 正在跑、后端端口是 ${port}（PTX_API_PORT）。`);
    }
    const text = await res.text();
    console.log(`  状态码：${res.status}`);
    console.log(`  响应体：\n${pretty(text)}`);
    console.log(`  结果：${formatVerdict(classifyJobResponse({ status: res.status, contentType: res.headers.get('content-type'), text }))}\n`);
    const headerName = jobLogRules(RULES.jobLog).headerName;
    const rawLog = res.headers.get(headerName);
    if (preview) {
        if (rawLog) {
            const { log, reason } = decodeJobLogHeader(rawLog);
            console.log(log ? formatJobLog(log) : `  [!] 预览日志 ${headerName} 不合平台口径（${reason}）—— 线上会被平台丢弃，预览面板里看不到日志`);
        } else {
            console.log(`  预览日志：响应里没有 ${headerName}（@ptengine/app-backend 版本不含预览日志，或这条路由没经 createApp 返回）`);
        }
        console.log(existsSync(join(root, '.ptx', 'outbox', runId))
            ? `  本地邮件预览：http://localhost:${LOCAL_STUB_PORT}/__ptx/outbox/${runId}`
            : '  这次运行没有调用 ctx.pt.notify.email。');
        console.log('');
    } else if (rawLog) {
        console.log(`  [!] 非预览运行的响应带了 ${headerName}：@ptengine/app-backend 不该这样，请升级或报告。\n`);
    }
    if (res.status < 200 || res.status >= 300) process.exitCode = 1;
}
