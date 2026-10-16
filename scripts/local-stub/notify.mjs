/**
 * ptx dev 的本地「邮件」桩逻辑（定时任务 1b，brief §13.3）。纯函数；server.mjs 包一层 HTTP 并负责写文件。
 *
 * 判定顺序与线上一致：收件人形状（backend）→ 内容（平台）→ 本 run 的调用次数 / 收件人累计（平台）。
 * 上限全部读 scripts/rules.json 的 notify 段；错误码与线上同名，方便本地写错误分支。
 *
 * ⚠️ 本地没有成员目录：`user:<id>` 解析成 `<id>@local.ptx`，`role:*` 一律解析成当前 dev 用户 —— 只用来看
 *    「这封信长什么样」，不代表线上会发给谁。
 * ⚠️ sanitizeLocally 不是安全边界，也不是平台清洗的复刻（平台用 sanitize-html 白名单）：它只删掉平台**一定**会删的
 *    东西并告诉你，让「<style> 块会被去掉」这类差异在本地就现形。逐字的最终邮件以产品里的预览面板为准。
 */
import { RULES } from '../manifest.mjs';

const enc = new TextEncoder();
const codePoints = s => [...s].length;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (status, code, message) => ({ status, body: { error: { code, message } } });

/** 本模块读到的 notify 规则键；缺任何一个都视为快照过旧，不用字面量兜底。 */
const REQUIRED_NOTIFY_KEYS = ['maxRefsPerCall', 'maxRecipientsPerRun', 'maxCallsPerRun', 'subjectMax', 'htmlMaxBytes',
    'textMaxBytes', 'locales', 'defaultLocale', 'refPattern', 'replyToPattern', 'roles'];

function notifyRules(rules) {
    const missing = rules ? REQUIRED_NOTIFY_KEYS.filter(k => rules[k] == null) : ['notify'];
    if (missing.length) {
        throw new Error(`scripts/rules.json 的 notify 段缺 ${missing.join(' / ')}（规则快照过旧）。维护者请跑 npm run sync-rules。`);
    }
    return rules;
}

export function createStubState() {
    return { runs: new Map() };
}

export function runCounters(state, runId) {
    let c = state.runs.get(runId);
    if (!c) { c = { emailCalls: 0, emailRecipients: 0, charts: 0 }; state.runs.set(runId, c); }
    return c;
}

export function validateNotifyInput(body, rules = RULES.notify) {
    const n = notifyRules(rules);
    if (!isObj(body)) return err(400, 'NOTIFY_CONTENT_INVALID', '请求体必须是 JSON 对象');
    const ref = new RegExp(n.refPattern);
    if (!Array.isArray(body.to) || body.to.length < 1 || body.to.length > n.maxRefsPerCall ||
        !body.to.every(x => typeof x === 'string' && ref.test(x))) {
        return err(400, 'NOTIFY_RECIPIENT_INVALID',
            `to 必须是 1..${n.maxRefsPerCall} 项的数组，每项形如 user:<accountId> 或 role:${n.roles.join('|')}（不能写邮箱）`);
    }
    if (body.replyTo !== undefined && (typeof body.replyTo !== 'string' || !new RegExp(n.replyToPattern).test(body.replyTo))) {
        return err(400, 'NOTIFY_RECIPIENT_INVALID', 'replyTo 只能是单个 user:<accountId>');
    }
    if (typeof body.subject !== 'string' || body.subject.trim() === '' || /[\r\n]/.test(body.subject) || codePoints(body.subject) > n.subjectMax) {
        return err(400, 'NOTIFY_CONTENT_INVALID', `subject 必须是 1..${n.subjectMax} 字符、不含换行`);
    }
    if (typeof body.html !== 'string' || enc.encode(body.html).byteLength > n.htmlMaxBytes) {
        return err(400, 'NOTIFY_CONTENT_INVALID', `html 必须是字符串且 ≤ ${n.htmlMaxBytes} 字节`);
    }
    if (body.text != null && (typeof body.text !== 'string' || enc.encode(body.text).byteLength > n.textMaxBytes)) {
        return err(400, 'NOTIFY_CONTENT_INVALID', `text 必须是字符串且 ≤ ${n.textMaxBytes} 字节`);
    }
    if (body.locale != null && !n.locales.includes(body.locale)) {
        return err(400, 'NOTIFY_CONTENT_INVALID', `locale 只能是 ${n.locales.join(' / ')}`);
    }
    return null;
}

export function resolveRecipientsLocally(to, claims) {
    const me = String(claims?.sub ?? 'local-user');
    const seen = new Set();
    const out = [];
    for (const ref of to) {
        const accountId = ref.startsWith('user:') ? ref.slice('user:'.length) : me;
        if (seen.has(accountId)) continue;
        seen.add(accountId);
        out.push({ ref, accountId, email: `${accountId}@local.ptx` });
    }
    return out;
}

/** 连同内容一起删的块级标签（平台同样整块删除）。 */
const DROP_BLOCKS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'select', 'textarea', 'button', 'svg', 'math', 'video', 'audio', 'title'];
/** 没有闭合的空元素。 */
const DROP_VOID = ['input', 'link', 'meta', 'base'];
/** href / src 里平台不放行的协议；本地桩自己的 http://localhost 图片例外（线上是 https 的 media 地址）。 */
const BAD_URL = /\s(href|src)\s*=\s*(["'])\s*(?:javascript:|vbscript:|data:|http:(?!\/\/(?:localhost|127\.0\.0\.1)[:/]))[^"']*\2/gi;

export function sanitizeLocally(html) {
    const removed = new Set();
    const src = String(html);
    let s = src;
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(s);
    if (body) s = body[1];
    if (/<head[\s>]/i.test(src)) removed.add('<head>');
    if (/<style[\s>]/i.test(src)) removed.add('<style>');
    const strip = (re, label) => {
        const next = s.replace(re, '');
        if (next !== s) { removed.add(label); s = next; }
    };
    for (const t of DROP_BLOCKS) {
        strip(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), `<${t}>`);
        strip(new RegExp(`<\\/?${t}\\b[^>]*>`, 'gi'), `<${t}>`);               // 落单的开 / 闭标签
    }
    for (const t of DROP_VOID) strip(new RegExp(`<${t}\\b[^>]*>`, 'gi'), `<${t}>`);
    strip(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, 'on* 事件属性');
    strip(BAD_URL, '非 https 的链接 / 图片（javascript: / data: / http:）');
    return { html: s.trim(), removed: [...removed] };
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FOOTER = {
    'zh-CN': (app, job) => `本邮件由 Ptengine 应用「${app}」发送${job ? ` · 任务：${job}` : ''}`,
    'en-US': (app, job) => `Sent by the Ptengine app "${app}"${job ? ` · Job: ${job}` : ''}`,
    'ja-JP': (app, job) => `このメールは Ptengine アプリ「${app}」から送信されました${job ? ` · タスク：${job}` : ''}`
};
const UNSUB = {
    'zh-CN': ['退订此任务', '退订此应用的全部邮件'],
    'en-US': ['Unsubscribe from this job', 'Unsubscribe from all emails of this app'],
    'ja-JP': ['このタスクの配信を停止', 'このアプリのメールをすべて停止']
};

/** 简化外框：结构（页眉 / 正文锚点 / 页脚 / 两个退订占位符）与平台一致，样式不是。 */
export function frameLocally({ subject, bodyHtml, appName, jobTitle, locale }) {
    const [unsubJob, unsubApp] = UNSUB[locale];
    const links = `${jobTitle ? `<a href="%%PT_UNSUBSCRIBE_JOB_URL%%">${unsubJob}</a> · ` : ''}<a href="%%PT_UNSUBSCRIBE_APP_URL%%">${unsubApp}</a>`;
    return '<!doctype html>' +
        `<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#f5f6f8">` +
        '<div style="padding:6px 16px;background:#fff3cd;font:12px sans-serif">ptx 本地预览 —— 简化外框，最终样式以产品里的预览面板为准</div>' +
        '<table role="presentation" width="100%" style="max-width:720px;margin:0 auto;background:#fff">' +
        '<tr><td style="padding:16px 24px;font:bold 16px sans-serif">Ptengine</td></tr>' +
        `<tr><td style="padding:0 24px 24px"><!--pt-body-start-->${bodyHtml}<!--pt-body-end--></td></tr>` +
        `<tr><td style="padding:16px 24px;color:#888;font:12px sans-serif">${escapeHtml(FOOTER[locale](appName, jobTitle))}<br>${links}</td></tr>` +
        '</table></body></html>';
}

export function textFromHtml(html) {
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n')
        .trim();
}

export function localAppName(manifest) {
    return manifest?.display_name?.['zh-CN'] ?? manifest?.id ?? 'local-dev';
}

const MEDIA_SRC = /\ssrc\s*=\s*["']([^"']*\/__ptx\/media\/[0-9a-f]{32}\.png)["']/gi;

export function handleNotifyEmail(state, { claims, body, appName, rules = RULES.notify }) {
    const bad = validateNotifyInput(body, rules);
    if (bad) return bad;
    const n = notifyRules(rules);
    const isJob = claims?.trg === 'job';
    const runId = isJob && typeof claims.run === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(claims.run) ? claims.run : null;
    const preview = isJob && claims.mode === 'preview';
    const recipients = resolveRecipientsLocally(body.to, claims);

    if (runId) {
        const c = runCounters(state, runId);
        if (c.emailCalls + 1 > n.maxCallsPerRun || c.emailRecipients + recipients.length > n.maxRecipientsPerRun) {
            return err(409, 'NOTIFY_RUN_LIMIT_EXCEEDED',
                `一次运行最多 ${n.maxCallsPerRun} 次 notify.email、累计 ${n.maxRecipientsPerRun} 个收件人`);
        }
        c.emailCalls++;
        c.emailRecipients += recipients.length;
    }

    const { html: bodyHtml, removed } = sanitizeLocally(body.html);
    const locale = body.locale ?? n.defaultLocale;                    // = contract NOTIFY_EMAIL_DEFAULT_LOCALE（S16，不写字面量兜底）
    const jobTitle = isJob ? (claims.job === 'local' ? '（本地任务）' : String(claims.job ?? '')) : null;
    const html = frameLocally({ subject: body.subject, bodyHtml, appName, jobTitle, locale });
    const text = `${body.text ?? textFromHtml(bodyHtml)}\n\n-- \n${FOOTER[locale](appName, jobTitle)}\n` +
        `${jobTitle ? `${UNSUB[locale][0]}: %%PT_UNSUBSCRIBE_JOB_URL%%\n` : ''}${UNSUB[locale][1]}: %%PT_UNSUBSCRIBE_APP_URL%%`;
    const status = preview ? 'intercepted' : 'sent';
    const replyTo = body.replyTo ? { accountId: body.replyTo.slice('user:'.length), email: `${body.replyTo.slice('user:'.length)}@local.ptx` } : null;
    const mediaUrls = [...new Set([...bodyHtml.matchAll(MEDIA_SRC)].map(m => m[1]))];

    return {
        status: 200,
        body: {
            preview,
            sent: preview ? 0 : recipients.length,
            recipients: recipients.map(({ ref, accountId }) => ({ ref, accountId, status })),
            unresolved: [],
            replyToDropped: false
        },
        outbox: {
            dir: runId ?? 'interactive',
            payload: {
                v: 1, from: 'Ptengine <noreply@local.ptx>', replyTo, subject: body.subject, html, text, locale, appName,
                recipients: recipients.map(r => ({ ...r, status })), unresolved: [], mediaUrls
            },
            previewHtml: html.replace(/%%PT_UNSUBSCRIBE_(?:JOB|APP)_URL%%/g, '#')
        },
        removed
    };
}
