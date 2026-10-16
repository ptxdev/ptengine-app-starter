/**
 * ptx dev 的本地推送 / 图表桩服务（定时任务 1b）。跑在 ptx dev 的 Node 进程里，监听 127.0.0.1:8788。
 *
 * 为什么不在 wrangler 的本地网关桩里直接做：那是 workerd，写不了本地文件、加载不了 @resvg/resvg-js（原生模块）。
 * 所以网关桩（scripts/local-gateway/worker.mjs）只把 /notify/email、/render/chart 原样转过来（修订建议 S8）。
 *
 *   POST /notify/email                  → 写 .ptx/outbox/<runId|interactive>/<seq>.json + .html，打印一行
 *   POST /render/chart                  → 写 .ptx/media/<hex>.png，返回 http://localhost:<port>/__ptx/media/<hex>.png
 *   GET  /__ptx/media/<hex>.png         → 图片
 *   GET  /__ptx/outbox/<id>             → 这次运行写下的邮件列表（本地预览页）
 *   GET  /__ptx/outbox/<id>/<seq>.html  → 单封邮件（退订链接已换成 #）
 *
 * 令牌只解不验（本机开发桩；验签由 app-backend 在路由那一侧真做）。scope 与线上一致：没有 notify:send → 403。
 *
 * 安全边界（两条，都不靠 notify.mjs 的 sanitizeLocally —— 那只是「平台会删什么」的提示，不是清洗）：
 *   1. 所有 HTML 响应带 CSP `sandbox; script-src 'none'; …`：邮件 HTML 里的任何脚本（含 `<a href=javascript:…>`
 *      无引号写法、on* 属性）在预览页都执行不了；sandbox 不含 allow-scripts / allow-same-origin。
 *   2. 写盘 / 读盘路径只用通过校验的 runId（[A-Za-z0-9_-]{1,64}）、自己生成的 32 hex 文件名与数字序号，
 *      拼接后再确认仍在 .ptx 目录内（insidePtx），防穿越。
 *   3. Host 只认 127.0.0.1:<port> / localhost:<port>，其余 421（防 DNS rebinding 读 outbox）。
 *
 * 并发闸（与线上网关同口径，最终评审 I1）：邮件、渲染各一道「每应用在途数」闸，上限读 rules.json 的
 * `notify.maxConcurrentPerApp` / `render.maxConcurrentPerApp`；打满回 429 `TOO_MANY_CONCURRENT_QUERIES` + 头 `x-pt-gate: concurrency`
 * （与线上网关一致；app-backend 只对带这个头的 429 有界退避重试）。
 * 规则快照里没有这两个键时**不模拟**这道闸（不写字面量兜底），启动时提示一行。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeClaims } from '../local-gateway/jobs-store.mjs';
import { createStubState, handleNotifyEmail } from './notify.mjs';
import { handleRenderChart } from './render.mjs';
import { RULES } from '../manifest.mjs';

export const LOCAL_STUB_PORT = 8788;
export const LOCAL_STUB_ORIGIN = `http://127.0.0.1:${LOCAL_STUB_PORT}`;

/** 本地桩自己的读体上限；业务上限（html 256 KiB / option 512 KiB）由 notify.mjs / render.mjs 按 rules 判。 */
const MAX_BODY_BYTES = 1_048_576;
/** outbox 目录名：与 notify.mjs 判 runId 的规则一致（ptx job run 的 runId 是 UUID）。 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const MEDIA_RE = /^\/__ptx\/media\/([0-9a-f]{32})\.png$/;
const OUTBOX_LIST_RE = /^\/__ptx\/outbox\/([A-Za-z0-9_-]{1,64})\/?$/;
const OUTBOX_ITEM_RE = /^\/__ptx\/outbox\/([A-Za-z0-9_-]{1,64})\/(\d{1,9})\.html$/;
/**
 * 预览页的 CSP：邮件 HTML 是应用写的、不可信，预览页上一律不许跑脚本。
 * 图片放行 http(s)（本地图表是 http://localhost:8788/__ptx/media/…），样式只放行内联（邮件只能用内联 style）。
 * sandbox 只放 popups（邮件里 target=_blank 的链接能在新标签页正常打开），绝不放 allow-scripts / allow-same-origin。
 */
const PREVIEW_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 线上网关并发闸 429 的专属头（逐字等于 workers `shared/contract.ts` 的 `GATEWAY_GATE_HEADER` / `GATEWAY_GATE_CONCURRENCY`，
 * 待 contract 登记；rules.json 目前不导出它）。app-backend 只对「429 + TOO_MANY_CONCURRENT_QUERIES + 这个头」退避重试，
 * 本地闸不带它的话本地永远看不到重试。
 */
const GATE_HEADERS = { 'x-pt-gate': 'concurrency' };

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders };
    if (type.startsWith('text/html')) headers['content-security-policy'] = PREVIEW_CSP;
    res.writeHead(status, headers);
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        // 超限后不断连（断连时客户端只看到 ECONNRESET / fetch failed，拿不到 413）：停止收集、把剩余读完，end 时再回 413。
        const chunks = [];
        let total = 0;
        req.on('data', c => {
            total += c.length;
            if (total <= MAX_BODY_BYTES) chunks.push(c);
            else chunks.length = 0;
        });
        req.on('end', () => total > MAX_BODY_BYTES
            ? reject(Object.assign(new Error('too large'), { status: 413 }))
            : resolveBody(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** 拼出 .ptx 下的路径，并确认解析后仍在 .ptx 目录内；不在就抛（调用方只传校验过的片段，这里是第二道闸）。 */
function insidePtx(ptxDir, ...parts) {
    const base = resolve(ptxDir);
    const p = resolve(base, ...parts);
    if (!p.startsWith(base + sep)) throw new Error(`拒绝写到 .ptx 之外：${p}`);
    return p;
}

const seqsIn = dir => readdirSync(dir).map(f => /^(\d+)\.json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);

function outboxIndex(ptxDir, dir, id) {
    const items = seqsIn(dir).map(seq => {
        const p = JSON.parse(readFileSync(insidePtx(ptxDir, 'outbox', id, `${seq}.json`), 'utf8'));
        const status = p.recipients?.[0]?.status === 'intercepted' ? '预览拦截' : '本地未真实发送';
        return `<li><a href="/__ptx/outbox/${id}/${seq}.html">${escapeHtml(p.subject)}</a> — ${p.recipients?.length ?? 0} 人 · ${status}</li>`;
    });
    return `<!doctype html><meta charset="utf-8"><title>ptx outbox ${escapeHtml(id)}</title>` +
        `<h1 style="font:bold 18px sans-serif">运行 ${escapeHtml(id)} 的邮件（${items.length} 封）</h1><ol>${items.join('')}</ol>` +
        '<p style="color:#888;font:12px sans-serif">本地简化外框；逐字的最终邮件以产品里的预览面板为准。</p>';
}

/** rules 段里的每应用并发上限；没有（快照过旧 / 平台未导出）返回 null = 不模拟闸。 */
const concurrencyLimit = section => (Number.isInteger(section?.maxConcurrentPerApp) && section.maxConcurrentPerApp > 0
    ? section.maxConcurrentPerApp : null);

export function createLocalStub({ root, appName = 'local-dev', loadRenderer, log = m => console.log(m), rules = RULES }) {
    const state = createStubState();
    const gateMax = { notify: concurrencyLimit(rules.notify), render: concurrencyLimit(rules.render) };
    const inflight = { notify: 0, render: 0 };
    const missingGate = Object.keys(gateMax).filter(k => gateMax[k] === null);
    if (missingGate.length) {
        log(`[ptx] [!] scripts/rules.json 没有 ${missingGate.map(k => `${k}.maxConcurrentPerApp`).join(' / ')}：` +
            '本地不模拟线上「每应用在途邮件 / 渲染数」并发闸（线上超出会 429 TOO_MANY_CONCURRENT_QUERIES）。请顺序调用，不要 Promise.all。');
    }
    const ptxDir = join(root, '.ptx');
    const server = createServer(async (req, res) => {
        try {
            const port = server.address().port;
            // 只认本机 Host：浏览器经 DNS rebinding 打进来的请求 Host 是攻击者域名，一律 421。
            const host = String(req.headers.host ?? '').toLowerCase();
            if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
                return fail(res, 421, 'PTX_STUB_BAD_HOST', `本地桩只接受 Host 为 127.0.0.1:${port} 或 localhost:${port} 的请求`);
            }
            const url = new URL(req.url, 'http://local');
            const publicBase = `http://localhost:${port}`;

            if (req.method === 'POST' && (url.pathname === '/notify/email' || url.pathname === '/render/chart')) {
                const isMail = url.pathname === '/notify/email';
                const claims = decodeClaims(req.headers.authorization);
                if (!claims) return fail(res, 401, 'APP_TOKEN_INVALID', '缺少或无法解析 App Token');
                const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
                if (!scopes.includes('notify:send')) {
                    return fail(res, 403, 'SCOPE_DENIED',
                        '令牌里没有 notify:send。在 manifest.json 的 scopes 里声明 notify:send 后重启 ptx dev（本地令牌的 scopes 照抄 manifest）。',
                        { requiredScope: 'notify:send' });
                }
                // 并发闸：线上网关在读体、转发之前判，这里同样在读体之前占位，响应发出后释放。
                const kind = isMail ? 'notify' : 'render';
                if (gateMax[kind] !== null) {
                    if (inflight[kind] >= gateMax[kind]) {
                        req.resume();
                        return send(res, 429, { error: { code: 'TOO_MANY_CONCURRENT_QUERIES',
                            message: `该应用${isMail ? '通知' : '图表渲染'}并发过高(>${gateMax[kind]})，请减少同时发起的${isMail ? '邮件发送' : '渲染'}` } },
                        undefined, GATE_HEADERS);
                    }
                    inflight[kind]++;
                    let released = false;
                    const releaseGate = () => { if (!released) { released = true; inflight[kind]--; } };
                    res.once('finish', releaseGate);
                    res.once('close', releaseGate);
                }
                let body;
                try {
                    body = JSON.parse(await readBody(req));
                } catch (e) {
                    return e.status === 413
                        ? fail(res, 413, 'GATEWAY_BAD_REQUEST', `请求体超过本地桩上限 ${MAX_BODY_BYTES} 字节`)
                        : fail(res, 400, isMail ? 'NOTIFY_CONTENT_INVALID' : 'RENDER_OPTION_INVALID', '请求体不是合法 JSON');
                }

                if (isMail) {
                    if (claims.trg === 'job' && !(typeof claims.run === 'string' && RUN_ID_RE.test(claims.run))) {
                        log(`[ptx] [!] job 令牌的 run 不合法（${JSON.stringify(claims.run ?? null).slice(0, 80)}）：` +
                            '不按 run 计数，邮件写进 .ptx/outbox/interactive/');
                    }
                    const r = handleNotifyEmail(state, { claims, body, appName });
                    if (r.outbox) {
                        const id = RUN_ID_RE.test(r.outbox.dir) ? r.outbox.dir : 'interactive';
                        const dir = insidePtx(ptxDir, 'outbox', id);
                        mkdirSync(dir, { recursive: true });
                        const seq = (seqsIn(dir).at(-1) ?? 0) + 1;
                        writeFileSync(insidePtx(ptxDir, 'outbox', id, `${seq}.json`), `${JSON.stringify(r.outbox.payload, null, 2)}\n`);
                        writeFileSync(insidePtx(ptxDir, 'outbox', id, `${seq}.html`), r.outbox.previewHtml);
                        const how = r.body.preview ? '预览，平台会拦截' : '本地桩，未真实发送';
                        log(`[ptx] 邮件（${how}）「${r.outbox.payload.subject}」→ ${r.body.recipients.length} 人：${publicBase}/__ptx/outbox/${id}/${seq}.html`);
                        for (const w of r.removed) log(`[ptx]   平台会去掉 ${w} —— 样式请写内联 style，链接与图片用 https`);
                    }
                    return send(res, r.status, r.body);
                }

                const r = await handleRenderChart(state, { claims, body, ...(loadRenderer ? { loadRenderer } : {}) });
                if (r.png) {
                    const hex = randomBytes(16).toString('hex');
                    if (!HEX32_RE.test(hex)) throw new Error('媒体文件名生成异常');
                    mkdirSync(insidePtx(ptxDir, 'media'), { recursive: true });
                    writeFileSync(insidePtx(ptxDir, 'media', `${hex}.png`), r.png);
                    return send(res, 200, { url: `${publicBase}/__ptx/media/${hex}.png`, width: r.width, height: r.height });
                }
                return send(res, r.status, r.body);
            }

            if (req.method === 'GET') {
                let m = MEDIA_RE.exec(url.pathname);
                if (m) {
                    const p = insidePtx(ptxDir, 'media', `${m[1]}.png`);
                    return existsSync(p) ? send(res, 200, readFileSync(p), 'image/png') : fail(res, 404, 'NOT_FOUND', '图片不存在');
                }
                m = OUTBOX_ITEM_RE.exec(url.pathname);
                if (m) {
                    const p = insidePtx(ptxDir, 'outbox', m[1], `${Number(m[2])}.html`);
                    return existsSync(p) ? send(res, 200, readFileSync(p, 'utf8'), 'text/html; charset=utf-8') : fail(res, 404, 'NOT_FOUND', '邮件不存在');
                }
                m = OUTBOX_LIST_RE.exec(url.pathname);
                if (m) {
                    const dir = insidePtx(ptxDir, 'outbox', m[1]);
                    return existsSync(dir) ? send(res, 200, outboxIndex(ptxDir, dir, m[1]), 'text/html; charset=utf-8') : fail(res, 404, 'NOT_FOUND', '这次运行没有邮件');
                }
            }
            return fail(res, 404, 'NOT_FOUND', '本地桩没有这个路径');
        } catch (e) {
            return fail(res, 500, 'PTX_STUB_FAILED', String(e?.message ?? e));
        }
    });
    return server;
}

export function startLocalStub(opts) {
    const server = createLocalStub(opts);
    return new Promise((resolveServer, reject) => {
        server.once('error', reject);
        server.listen(opts.port ?? LOCAL_STUB_PORT, '127.0.0.1', () => resolveServer(server));
    });
}
