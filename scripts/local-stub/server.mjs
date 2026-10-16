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
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeClaims } from '../local-gateway/jobs-store.mjs';
import { createStubState, handleNotifyEmail } from './notify.mjs';
import { handleRenderChart } from './render.mjs';

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
 */
const PREVIEW_CSP = "sandbox; default-src 'none'; script-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(res, status, body, type = 'application/json; charset=utf-8') {
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (type.startsWith('text/html')) headers['content-security-policy'] = PREVIEW_CSP;
    res.writeHead(status, headers);
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', c => {
            total += c.length;
            if (total > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
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

export function createLocalStub({ root, appName = 'local-dev', loadRenderer, log = m => console.log(m) }) {
    const state = createStubState();
    const ptxDir = join(root, '.ptx');
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://local');
            const publicBase = `http://localhost:${server.address().port}`;

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
