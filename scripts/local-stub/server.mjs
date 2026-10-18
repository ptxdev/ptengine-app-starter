/**
 * ptx dev 的本地推送 / 图表桩服务（定时任务 1b）。跑在 ptx dev 的 Node 进程里，监听 127.0.0.1:8788。
 *
 * 为什么不在 wrangler 的本地网关桩里直接做：那是 workerd，写不了本地文件、加载不了 @resvg/resvg-js（原生模块）。
 * 所以网关桩（scripts/local-gateway/worker.mjs）只把 /notify/email、/notify/channel、/notify/channels、/render/chart 原样转过来（修订建议 S8）。
 *
 *   POST /notify/email                  → 写 .ptx/outbox/<runId|interactive>/<seq>.json + .html，打印一行
 *   POST /notify/channel                → 写 .ptx/outbox/<runId|interactive>/<seq>.channel.json（与邮件共用序号），打印一行；永不投递
 *   POST /notify/channels               → 读 .ptx/channels.json，回 { channels: [{ name, type }] }（没有文件回 []）
 *   POST /render/chart                  → 写 .ptx/media/<hex>.png，返回 http://localhost:<port>/__ptx/media/<hex>.png
 *   GET  /__ptx/media/<hex>.png         → 图片
 *   GET  /__ptx/outbox/<id>             → 这次运行写下的邮件与渠道消息列表（本地推送预览页）
 *   GET  /__ptx/outbox/<id>/<seq>.html  → 单封邮件（退订链接已换成 #）
 *
 * 令牌只解不验（本机开发桩；验签由 app-backend 在路由那一侧真做）。scope 与线上一致：没有 notify:send → 403。
 *
 * 安全边界（两条，都不靠 notify.mjs 的 sanitizeLocally —— 那只是「平台会删什么」的提示，不是清洗）：
 *   1. 所有 HTML 响应带 CSP `sandbox; script-src 'none'; …`：邮件 HTML 里的任何脚本（含 `<a href=javascript:…>`
 *      无引号写法、on* 属性）在预览页都执行不了；sandbox 不含 allow-scripts / allow-same-origin。
 *   2. 写盘 / 读盘路径只用通过校验的 runId（[A-Za-z0-9_-]{1,64}）、自己生成的 32 hex 文件名与数字序号（渠道名只进文件内容、绝不进路径），
 *      拼接后再确认仍在 .ptx 目录内（insidePtx），防穿越。
 *   3. Host 只认 127.0.0.1:<port> / localhost:<port>，其余 421（防 DNS rebinding 读 outbox）。
 *
 * 并发闸（与线上网关同口径，最终评审 I1）：邮件、渲染各一道「每应用在途数」闸，上限读 rules.json 的
 * `notify.maxConcurrentPerApp` / `render.maxConcurrentPerApp`；打满回 429 `TOO_MANY_CONCURRENT_QUERIES` + 闸头
 * （头名与取值读 rules.json 的 `gateway.gateHeader`，即 contract 的 `GATEWAY_GATE_HEADER` / `GATEWAY_GATE_CONCURRENCY`；
 * 与线上网关一致，app-backend 只对带这个头的 429 有界退避重试）。
 * 规则快照里没有两个并发上限时**不模拟**这道闸（不写字面量兜底），启动时提示一行；有上限却缺 `gateway.gateHeader`
 * 时启动即报「规则快照过旧」（不带头的本地 429 会让新 app-backend 永不重试，与线上不一致）。
 * 渠道消息（定时任务 1c）与邮件共用 notify 那道闸（线上 notifyInflight，话术「邮件与渠道合计」）；/notify/channels 是读闸档，本地不模拟。
 * /notify/channel 的体积上限读 rules.json 的 notifyChannel.maxBodyBytes（= 线上网关的渠道档上限），超了 413 GATEWAY_BAD_REQUEST。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeClaims } from '../local-gateway/jobs-store.mjs';
import { RUN_ID_RE, createStubState, handleNotifyEmail, jobRunOf } from './notify.mjs';
import { channelRules, handleListChannels, handleNotifyChannel, loadLocalChannels } from './channel.mjs';
import { handleRenderChart } from './render.mjs';
import { RULES } from '../manifest.mjs';

export const LOCAL_STUB_PORT = 8788;
export const LOCAL_STUB_ORIGIN = `http://127.0.0.1:${LOCAL_STUB_PORT}`;

/** 本地桩自己的读体上限；业务上限（html 256 KiB / option 512 KiB）由 notify.mjs / render.mjs 按 rules 判。 */
const MAX_BODY_BYTES = 1_048_576;
const HEX32_RE = /^[0-9a-f]{32}$/;
const MEDIA_RE = /^\/__ptx\/media\/([0-9a-f]{32})\.png$/;
const OUTBOX_LIST_RE = /^\/__ptx\/outbox\/([A-Za-z0-9_-]{1,64})\/?$/;
const OUTBOX_ITEM_RE = /^\/__ptx\/outbox\/([A-Za-z0-9_-]{1,64})\/(\d{1,9})\.html$/;
/** 本地桩接的 POST 路径（与线上网关同名）→ 内部种类。 */
const POST_ROUTES = { '/notify/email': 'email', '/notify/channel': 'channel', '/notify/channels': 'listChannels', '/render/chart': 'render' };
/** 请求体不是合法 JSON 时回的码（与线上平台对同一输入的码一致）。 */
const BAD_JSON_CODE = { email: 'NOTIFY_CONTENT_INVALID', channel: 'NOTIFY_CHANNEL_MESSAGE_INVALID', render: 'RENDER_OPTION_INVALID' };
/** 闸满 429 的话术：通知档是邮件与渠道合计（与线上网关 1c 话术同口径）。 */
const GATE_MESSAGE = {
    notify: max => `该应用通知并发过高(>${max})（邮件与渠道合计），请减少同时发起的发送`,
    render: max => `该应用图表渲染并发过高(>${max})，请减少同时发起的渲染`
};
/**
 * 预览页的 CSP：邮件 HTML 是应用写的、不可信，预览页上一律不许跑脚本。
 * 图片放行 http(s)（本地图表是 http://localhost:8788/__ptx/media/…），样式只放行内联（邮件只能用内联 style）。
 * sandbox 只放 popups（邮件里 target=_blank 的链接能在新标签页正常打开），绝不放 allow-scripts / allow-same-origin。
 */
const PREVIEW_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 线上网关并发闸 429 的专属头：读 rules.json 的 `gateway.gateHeader`（contract 的 `GATEWAY_GATE_HEADER` /
 * `GATEWAY_GATE_CONCURRENCY`），不写字面量。app-backend 只对「429 + TOO_MANY_CONCURRENT_QUERIES + 这个头」退避重试，
 * 本地闸不带它的话本地永远看不到重试。缺键 / 形状不对 → 抛「规则快照过旧」。
 */
function gateHeadersFrom(rules) {
    const g = rules?.gateway?.gateHeader;
    if (!(typeof g?.name === 'string' && g.name && typeof g?.concurrencyValue === 'string' && g.concurrencyValue)) {
        throw new Error('scripts/rules.json 缺 gateway.gateHeader（name / concurrencyValue）（规则快照过旧）。维护者请跑 npm run sync-rules。');
    }
    return { [g.name]: g.concurrencyValue };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders };
    if (type.startsWith('text/html')) headers['content-security-policy'] = PREVIEW_CSP;
    res.writeHead(status, headers);
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });

function readBody(req, max = MAX_BODY_BYTES) {
    return new Promise((resolveBody, reject) => {
        // 超限后不断连（断连时客户端只看到 ECONNRESET / fetch failed，拿不到 413）：停止收集、把剩余读完，end 时再回 413。
        const chunks = [];
        let total = 0;
        req.on('data', c => {
            total += c.length;
            if (total <= max) chunks.push(c);
            else chunks.length = 0;
        });
        req.on('end', () => total > max
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

/** 邮件（<seq>.json）与渠道消息（<seq>.channel.json）共用一个序号空间：新条目取两者最大值 + 1。 */
const allSeqs = dir => readdirSync(dir).map(f => /^(\d+)\.(?:channel\.)?json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);

function outboxIndex(ptxDir, dir, id) {
    const items = allSeqs(dir).map(seq => {
        const channelFile = insidePtx(ptxDir, 'outbox', id, `${seq}.channel.json`);
        if (existsSync(channelFile)) {
            const p = JSON.parse(readFileSync(channelFile, 'utf8'));
            const status = p.status === 'intercepted' ? '预览拦截' : '本地未真实投递';
            return `<li>渠道 <b>${escapeHtml(p.channel?.name ?? '')}</b>（${escapeHtml(p.channel?.type ?? '')}）「${escapeHtml(p.message?.title ?? '')}」 — ${status}` +
                `<pre style="font:12px monospace;white-space:pre-wrap;margin:4px 0 12px">${escapeHtml(JSON.stringify(p.message, null, 2))}</pre></li>`;
        }
        const p = JSON.parse(readFileSync(insidePtx(ptxDir, 'outbox', id, `${seq}.json`), 'utf8'));
        const status = p.recipients?.[0]?.status === 'intercepted' ? '预览拦截' : '本地未真实发送';
        return `<li><a href="/__ptx/outbox/${id}/${seq}.html">${escapeHtml(p.subject)}</a> — ${p.recipients?.length ?? 0} 人 · ${status}</li>`;
    });
    return `<!doctype html><meta charset="utf-8"><title>ptx outbox ${escapeHtml(id)}</title>` +
        `<h1 style="font:bold 18px sans-serif">运行 ${escapeHtml(id)} 的推送（${items.length} 条：邮件与渠道消息）</h1><ol>${items.join('')}</ol>` +
        '<p style="color:#888;font:12px sans-serif">本地简化外框；逐字的最终邮件、各渠道的实际卡片以产品里的预览面板为准（本地渠道消息不渲染、不投递）。</p>';
}

/** rules 段里的每应用并发上限；没有（快照过旧 / 平台未导出）返回 null = 不模拟闸。 */
const concurrencyLimit = section => (Number.isInteger(section?.maxConcurrentPerApp) && section.maxConcurrentPerApp > 0
    ? section.maxConcurrentPerApp : null);

export function createLocalStub({ root, appName = 'local-dev', loadRenderer, log = m => console.log(m), rules = RULES }) {
    // notifyChannel 段在启动时就校验一遍（缺段 / 缺键 → 抛「规则快照过旧」），而不是等第一次 /notify/channel 请求才 500（ST-05）。
    channelRules(rules.notifyChannel);
    const state = createStubState();
    const gateMax = { notify: concurrencyLimit(rules.notify), render: concurrencyLimit(rules.render) };
    const inflight = { notify: 0, render: 0 };
    // 只要模拟了任意一道闸就必须有闸头（否则本地 429 不带头，新 app-backend 不会重试）；一道都不模拟时用不到它。
    const gateHeaders = Object.values(gateMax).some(v => v !== null) ? gateHeadersFrom(rules) : {};
    const missingGate = Object.keys(gateMax).filter(k => gateMax[k] === null);
    if (missingGate.length) {
        log(`[ptx] [!] scripts/rules.json 没有 ${missingGate.map(k => `${k}.maxConcurrentPerApp`).join(' / ')}：` +
            '本地不模拟线上「每应用在途邮件与渠道 / 渲染数」并发闸（线上超出会 429 TOO_MANY_CONCURRENT_QUERIES）。请顺序调用，不要 Promise.all。');
    }
    const ptxDir = join(root, '.ptx');
    /** job 令牌带了不合法的 run：打一行警告（这次调用不按 run 计数，落 interactive/）。 */
    const warnBadRun = (claims, what) => {
        const { isJob, runId } = jobRunOf(claims);
        if (isJob && !runId) {
            log(`[ptx] [!] job 令牌的 run 不合法（${JSON.stringify(claims.run ?? null).slice(0, 80)}）：` +
                `不按 run 计数，${what}写进 .ptx/outbox/interactive/`);
        }
    };
    /**
     * 取下一个 outbox 槽位：目录名只用校验过的 runId（否则 interactive），序号是邮件与渠道共用空间里的最大值 + 1。
     * 渠道名等应用给的字符串绝不进路径；file(后缀) 再经 insidePtx 确认仍在 .ptx 内。
     */
    const nextOutboxSlot = dirHint => {
        const id = RUN_ID_RE.test(dirHint) ? dirHint : 'interactive';
        const dir = insidePtx(ptxDir, 'outbox', id);
        mkdirSync(dir, { recursive: true });
        const seq = (allSeqs(dir).at(-1) ?? 0) + 1;
        return { id, seq, file: suffix => insidePtx(ptxDir, 'outbox', id, `${seq}${suffix}`) };
    };
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

            const post = req.method === 'POST' && Object.hasOwn(POST_ROUTES, url.pathname) ? POST_ROUTES[url.pathname] : null;
            if (post) {
                const claims = decodeClaims(req.headers.authorization);
                if (!claims) return fail(res, 401, 'APP_TOKEN_INVALID', '缺少或无法解析 App Token');
                const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
                if (!scopes.includes('notify:send')) {
                    return fail(res, 403, 'SCOPE_DENIED',
                        '令牌里没有 notify:send。在 manifest.json 的 scopes 里声明 notify:send 后重启 ptx dev（本地令牌的 scopes 照抄 manifest）。',
                        { requiredScope: 'notify:send' });
                }
                if (post === 'listChannels') {
                    req.resume();
                    return send(res, 200, handleListChannels({ channels: loadLocalChannels(root, rules.notifyChannel) }).body);
                }
                // 并发闸：线上网关在读体、转发之前判，这里同样在读体之前占位，响应发出后释放。邮件与渠道共用 notify 闸。
                const kind = post === 'render' ? 'render' : 'notify';
                if (gateMax[kind] !== null) {
                    if (inflight[kind] >= gateMax[kind]) {
                        req.resume();
                        return send(res, 429, { error: { code: 'TOO_MANY_CONCURRENT_QUERIES', message: GATE_MESSAGE[kind](gateMax[kind]) } },
                            undefined, gateHeaders);
                    }
                    inflight[kind]++;
                    let released = false;
                    const releaseGate = () => { if (!released) { released = true; inflight[kind]--; } };
                    res.once('finish', releaseGate);
                    res.once('close', releaseGate);
                }
                const maxBody = post === 'channel' ? channelRules(rules.notifyChannel).maxBodyBytes : MAX_BODY_BYTES;
                let body;
                try {
                    body = JSON.parse(await readBody(req, maxBody));
                } catch (e) {
                    return e.status === 413
                        ? fail(res, 413, 'GATEWAY_BAD_REQUEST', post === 'channel'
                            ? `渠道消息请求体超过线上网关上限 ${maxBody} 字节`
                            : `请求体超过本地桩上限 ${maxBody} 字节`)
                        : fail(res, 400, BAD_JSON_CODE[post], '请求体不是合法 JSON');
                }

                if (post === 'email') {
                    warnBadRun(claims, '邮件');
                    const r = handleNotifyEmail(state, { claims, body, appName });
                    if (r.outbox) {
                        const { id, seq, file } = nextOutboxSlot(r.outbox.dir);
                        writeFileSync(file('.json'), `${JSON.stringify(r.outbox.payload, null, 2)}\n`);
                        writeFileSync(file('.html'), r.outbox.previewHtml);
                        const how = r.body.preview ? '预览，平台会拦截' : '本地桩，未真实发送';
                        log(`[ptx] 邮件（${how}）「${r.outbox.payload.subject}」→ ${r.body.recipients.length} 人：${publicBase}/__ptx/outbox/${id}/${seq}.html`);
                        for (const w of r.removed) log(`[ptx]   平台会去掉 ${w} —— 样式请写内联 style，链接与图片用 https`);
                    }
                    return send(res, r.status, r.body);
                }

                if (post === 'channel') {
                    warnBadRun(claims, '渠道消息');
                    const r = handleNotifyChannel(state, {
                        claims, body, appName, channels: loadLocalChannels(root, rules.notifyChannel), rules: rules.notifyChannel
                    });
                    if (r.outbox) {
                        const { id, file } = nextOutboxSlot(r.outbox.dir);
                        writeFileSync(file('.channel.json'), `${JSON.stringify(r.outbox.payload, null, 2)}\n`);
                        const how = r.body.preview ? '预览，平台会拦截' : '本地桩，未真实投递';
                        log(`[ptx] 渠道消息（${how}）→ ${r.body.channel.name}（${r.body.channel.type}）「${r.outbox.payload.message.title}」：` +
                            `${publicBase}/__ptx/outbox/${id}`);
                        for (const w of r.warnings) log(`[ptx]   [!] ${w}`);
                    }
                    return send(res, r.status, r.body);
                }

                const r = await handleRenderChart(state, { claims, body, ...(loadRenderer ? { loadRenderer } : {}) });
                if (r.png) {
                    if (r.warning) log(`[ptx] [!] ${r.warning}`);
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
                    return existsSync(dir) ? send(res, 200, outboxIndex(ptxDir, dir, m[1]), 'text/html; charset=utf-8') : fail(res, 404, 'NOT_FOUND', '这次运行没有推送（邮件 / 渠道消息）');
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
