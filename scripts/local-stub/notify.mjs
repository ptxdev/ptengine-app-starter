/**
 * ptx dev 的本地「邮件」桩逻辑（定时任务 1b，brief §13.3）。纯函数；server.mjs 包一层 HTTP 并负责写文件。
 *
 * 判定顺序与线上一致：收件人形状（backend）→ 内容（平台）→ 本 run 的调用次数 / 收件人累计（平台）。
 * 上限全部读 scripts/rules.json 的 notify 段；错误码与线上同名，方便本地写错误分支。
 *
 * ⚠️ 本地没有成员目录：`user:<id>` 解析成 `<id>@local.ptx`，`role:*` 一律解析成当前 dev 用户 —— 只用来看
 *    「这封信长什么样」，不代表线上会发给谁。
 * ⚠️ sanitizeLocally 不是安全边界，也不是平台清洗的逐字复刻（平台用 sanitize-html）：它按平台同一份允许名单
 *    （标签 / 属性 / 协议 / 内联样式逐条规则）重建，只会比平台**严**、不会比平台宽，并报告去掉了什么，让
 *    「<style> 块会被去掉」「var() 不支持」这类差异在本地就现形。外框文案与平台 email-layout.ts 逐字一致。
 *    逐字的最终邮件以产品里的预览面板为准。
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
    if (!c) { c = { emailCalls: 0, emailRecipients: 0, charts: 0, sendUnits: 0 }; state.runs.set(runId, c); }
    return c;
}

/** 合法的 runId（ptx job run 的 runId 是 UUID）；也是 outbox 目录名的约束。 */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 从令牌 claims 推出：是否 job 令牌、按哪个 run 计数（不合法 → null，不计数）、是否预览。邮件 / 渠道桩共用。 */
export function jobRunOf(claims) {
    const isJob = claims?.trg === 'job';
    const runId = isJob && typeof claims.run === 'string' && RUN_ID_RE.test(claims.run) ? claims.run : null;
    return { isJob, runId, preview: isJob && claims.mode === 'preview' };
}

export function validateNotifyInput(body, rules = RULES.notify) {
    const n = notifyRules(rules);
    if (!isObj(body)) return err(400, 'NOTIFY_RECIPIENT_INVALID', '请求体必须是 JSON 对象（含 to 数组）');   // 与 backend 同序：先判收件人
    const ref = new RegExp(n.refPattern);
    if (!Array.isArray(body.to) || body.to.length < 1 || body.to.length > n.maxRefsPerCall ||
        !body.to.every(x => typeof x === 'string' && ref.test(x))) {
        return err(400, 'NOTIFY_RECIPIENT_INVALID',
            `to 必须是 1..${n.maxRefsPerCall} 项的数组，每项形如 user:<accountId> 或 role:${n.roles.join('|')}（不能写邮箱）`);
    }
    if (body.replyTo != null && (typeof body.replyTo !== 'string' || !new RegExp(n.replyToPattern).test(body.replyTo))) {
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

// ───────────────────────── 清洗（与平台 platform/src/notify/email-sanitize.ts 同口径的简化实现） ─────────────────────────
// 原则：可以比平台**严**（多删），不能比平台**宽**（平台会删的这里一定删）。平台用 sanitize-html（htmlparser2），这里是
// 手写的线性扫描：标签按允许名单重建、属性按允许名单逐个过滤、属性值先解实体再判、style 逐条声明按平台规则过滤。

/** 允许的标签（= 平台 ALLOWED_TAGS）。 */
const ALLOWED_TAGS = new Set([
    'a', 'b', 'i', 'u', 'em', 'strong', 'small', 'sup', 'sub', 'span', 'div', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'img', 'center', 'font'
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);
/** 属性允许名单（= 平台 allowedAttributes）。 */
const COMMON_ATTRS = ['style', 'title', 'align', 'valign', 'width', 'height', 'bgcolor', 'border', 'dir'];
const TAG_ATTRS = {
    a: ['href', 'target', 'rel'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
    table: ['cellpadding', 'cellspacing'], font: ['color', 'face', 'size']
};
/** 连同内容一起删（= 平台 DROP_WITH_CONTENT）。 */
const DROP_WITH_CONTENT = new Set([
    'script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio',
    'title', 'head', 'select', 'button', 'form', 'template', 'canvas', 'link', 'meta', 'base'
]);
const SAFE_HREF = /^(https:\/\/|mailto:)/i;
const SAFE_SRC = /^https:\/\//i;
/** 本地桩自己的图表地址（线上对应 https 的 media 地址）：只放这一种 http。渠道桩的 imageUrl 也用它。 */
export const LOCAL_MEDIA_SRC = /^http:\/\/localhost:\d{1,5}\/__ptx\/media\/[0-9a-f]{32}\.png$/;

/** 与平台 extractBody 同口径：第一个 <body…> 之后到第一个 </body>（没闭合就到结尾）。 */
export function extractBody(html) {
    const open = html.search(/<body\b/i);
    if (open < 0) return html;
    const gt = html.indexOf('>', open);
    if (gt < 0) return html;
    const rest = html.slice(gt + 1);
    const close = rest.search(/<\/body\s*>/i);
    return close < 0 ? rest : rest.slice(0, close);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/** 解属性值里的字符引用。带分号但不认识的命名实体返回 null（调用方按「不安全」处理 —— 比平台严）；不带分号的 `&name` 原样保留。 */
function decodeAttr(v) {
    let unknown = false;
    const out = v.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ref) => {
        if (ref[0] === '#') {
            const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
        }
        // 不带分号的 `&name`（查询串 `&b=2`、`&utm_source=`）按字面量保留：HTML 旧式实体规则下属性里它不是字符引用
        if (!m.endsWith(';')) return m;
        if (Object.hasOwn(NAMED_ENTITIES, ref)) return NAMED_ENTITIES[ref];
        unknown = true;                                                             // 带分号且不认识：判不安全（比平台严）
        return m;
    });
    return unknown ? null : out;
}
const escAttr = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── style 逐条声明过滤：与平台 filterStyle 逐行同口径 ──
const STYLE_MAX_BYTES = 8192;
const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isNl = c => c === '\n' || c === '\r' || c === '\f';
const isNameCode = k => (k >= 0x61 && k <= 0x7a) || (k >= 0x41 && k <= 0x5a) || (k >= 0x30 && k <= 0x39) || k === 0x2d || k === 0x5f || k >= 0x80;

function stripComments(s) {
    let out = '';
    let start = 0;
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '"' || c === "'") {
            i++;
            while (i < s.length && s[i] !== c && !isNl(s[i])) i++;
            if (s[i] === c) i++;
            continue;
        }
        if (c === '/' && s[i + 1] === '*') {
            out += s.slice(start, i);
            const e = s.indexOf('*/', i + 2);
            i = e < 0 ? s.length : e + 2;
            start = i;
            continue;
        }
        i++;
    }
    return out + s.slice(start);
}

function scanDeclarations(s) {
    const out = [];
    let cur = { text: '', fnStrings: [], urls: [], at: false };
    let declStart = 0;
    let depth = 0;
    let nameStart = -1;
    let i = 0;
    const finish = endAt => {
        cur.text = s.slice(declStart, endAt).trim();
        if (cur.text) out.push(cur);
        cur = { text: '', fnStrings: [], urls: [], at: false };
        declStart = endAt + 1;
    };
    while (i < s.length) {
        const k = s.charCodeAt(i);
        if (isNameCode(k)) {
            if (nameStart < 0) nameStart = i;
            i++;
            continue;
        }
        const name = nameStart >= 0 ? s.slice(nameStart, i).toLowerCase() : '';
        nameStart = -1;
        const c = s[i];
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < s.length && s[j] !== c) { if (isNl(s[j])) return null; j++; }
            if (j >= s.length) return null;
            if (depth > 0) cur.fnStrings.push(s.slice(i + 1, j));
            i = j + 1;
            continue;
        }
        if (c === '(') {
            if (name === 'url') {
                let j = i + 1;
                while (j < s.length && isWs(s[j])) j++;
                if (s[j] !== '"' && s[j] !== "'") {
                    const argStart = j;
                    while (j < s.length && s[j] !== ')' && !isWs(s[j])) {
                        const ch = s[j];
                        const code = s.charCodeAt(j);
                        if (ch === '"' || ch === "'" || ch === '(' || code < 0x20 || code === 0x7f) return null;
                        j++;
                    }
                    const argEnd = j;
                    while (j < s.length && isWs(s[j])) j++;
                    if (s[j] !== ')') return null;
                    cur.urls.push(s.slice(argStart, argEnd));
                    i = j + 1;
                    continue;
                }
            }
            depth++;
            i++;
            continue;
        }
        if (c === ')') { if (depth === 0) return null; depth--; i++; continue; }
        if (c === ';' && depth === 0) { finish(i); i++; continue; }
        if (c === '{' || c === '}') return null;
        if (c === '/' && s[i + 1] === '*') return null;
        if (c === '@') cur.at = true;
        i++;
    }
    if (depth > 0) return null;
    finish(s.length);
    return out;
}

const DANGEROUS_PROPS = new Set(['behavior', 'binding']);
const VENDOR_PREFIXES = ['-ms-', '-webkit-', '-moz-', '-o-'];
const isHttps = u => u.trim().toLowerCase().startsWith('https://');

function declarationOk(d) {
    if (d.at) return false;
    const lower = d.text.toLowerCase();
    if (lower.includes('expression') || lower.includes('-moz-binding')) return false;
    if (lower.includes('var(') || lower.includes('attr(')) return false;          // CSS 变量 / attr() 整条丢
    const colon = lower.indexOf(':');
    const prop = (colon >= 0 ? lower.slice(0, colon) : lower).trim();
    if (prop.startsWith('--')) return false;                                        // 自定义属性整条丢
    const vp = VENDOR_PREFIXES.find(v => prop.startsWith(v));
    if (DANGEROUS_PROPS.has(vp ? prop.slice(vp.length) : prop)) return false;
    return d.fnStrings.every(isHttps) && d.urls.every(isHttps);                     // url / 函数里的字符串须 https
}

/** 与平台 filterStyle 同口径：反斜杠 / 超长整段丢；去注释 → 词法切声明 → 逐条判定。返回过滤后的 style 与是否丢过东西。 */
export function filterStyle(style) {
    if (style.includes('\\') || enc.encode(style).byteLength > STYLE_MAX_BYTES) return { style: '', dropped: style.trim() !== '' };
    const decls = scanDeclarations(stripComments(style));
    if (!decls) return { style: '', dropped: true };
    const kept = decls.filter(declarationOk);
    return { style: kept.map(d => d.text).join('; '), dropped: kept.length !== decls.length };
}

/** 读一个标签的属性（`name`、`name=value`、`name="v"`、`name='v'`），返回 [属性数组, 标签结束位置]；没有 `>` 返回 null。 */
function readTag(h, i) {
    const attrs = [];
    const n = h.length;
    for (;;) {
        while (i < n && (isWs(h[i]) || h[i] === '/')) i++;
        if (i >= n) return null;
        if (h[i] === '>') return [attrs, i + 1];
        const ns = i;
        while (i < n && !isWs(h[i]) && h[i] !== '/' && h[i] !== '>' && h[i] !== '=') i++;
        if (i === ns) i++;                                                          // 怪字符（如落单的 =）：跳过
        const name = h.slice(ns, i).toLowerCase();
        while (i < n && isWs(h[i])) i++;
        let value = '';
        if (h[i] === '=') {
            i++;
            while (i < n && isWs(h[i])) i++;
            const q = h[i];
            if (q === '"' || q === "'") {
                const close = h.indexOf(q, i + 1);
                if (close < 0) return null;
                value = h.slice(i + 1, close);
                i = close + 1;
            } else {
                const vs = i;
                while (i < n && !isWs(h[i]) && h[i] !== '>') i++;
                value = h.slice(vs, i);
            }
        }
        if (name) attrs.push([name, value]);
    }
}

/**
 * 本地清洗：输出不比平台宽（允许名单之外的标签 / 属性 / 协议一律去掉，style 按平台规则逐条过滤），
 * 并报告去掉了哪些东西，让「<style> 块会被去掉」「var() 不支持」这类差异在本地现形。
 * ⚠️ 仍不是安全边界（预览页另有 CSP 与 sandbox）；逐字的最终邮件以产品里的预览面板为准。
 */
export function sanitizeLocally(html) {
    const removed = new Set();
    const src = String(html);
    if (/<head[\s>]/i.test(src)) removed.add('<head>');
    if (/<style[\s>]/i.test(src)) removed.add('<style>');                      // <head> 里的 <style> 随 extractBody 一起没了，照样提示
    const s = extractBody(src);
    let out = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
        const lt = s.indexOf('<', i);
        if (lt < 0) { out += s.slice(i).replace(/>/g, '&gt;'); break; }
        out += s.slice(i, lt).replace(/>/g, '&gt;');
        i = lt;
        // 注释 / DOCTYPE / CDATA / 处理指令：整段删
        if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
        if (s[i + 1] === '!' || s[i + 1] === '?') { const e = s.indexOf('>', i); i = e < 0 ? n : e + 1; continue; }
        const closing = s[i + 1] === '/';
        const ns = i + (closing ? 2 : 1);
        let ne = ns;
        while (ne < n && /[A-Za-z0-9]/.test(s[ne])) ne++;
        if (ne === ns || !/[A-Za-z]/.test(s[ns])) { out += '&lt;'; i++; continue; }  // 不是标签：转义成文本
        const tag = s.slice(ns, ne).toLowerCase();
        const read = readTag(s, ne);
        if (!read) { i = n; break; }                                               // 标签没闭合：丢掉其后全部（比平台严）
        const [attrs, after] = read;
        i = after;
        if (DROP_WITH_CONTENT.has(tag)) {
            removed.add(`<${tag}>`);
            if (!closing) {
                const m = new RegExp(`</${tag}\\s*>`, 'i').exec(s.slice(i));
                i = m ? i + m.index + m[0].length : n;
            }
            continue;
        }
        if (!ALLOWED_TAGS.has(tag)) { removed.add(`<${tag}>`); continue; }        // 剥标签、留内容（同平台 discard）
        if (closing) { if (!VOID_TAGS.has(tag)) out += `</${tag}>`; continue; }
        const allowed = new Set([...COMMON_ATTRS, ...(TAG_ATTRS[tag] ?? [])]);
        const kept = [];
        for (const [name, raw] of attrs) {
            if (/^on/.test(name)) { removed.add('on* 事件属性'); continue; }
            if (!allowed.has(name)) { removed.add(`${name} 属性`); continue; }
            if (tag === 'a' && (name === 'target' || name === 'rel')) continue;  // 下面强制写
            const value = decodeAttr(raw);
            if (value === null) { removed.add(`${name} 属性（含不认识的实体）`); continue; }
            if (name === 'style') {
                const f = filterStyle(value);
                if (f.dropped) removed.add('部分内联样式（CSS 变量 --* / var() / attr()、@、expression、非 https 的 url 等）');
                if (f.style) kept.push(['style', f.style]);
                continue;
            }
            if (tag === 'a' && name === 'href' && !SAFE_HREF.test(value.trim())) { removed.add('非 https 的链接 / 图片（javascript: / data: / http: / 相对路径）'); continue; }
            if (tag === 'img' && name === 'src' && !SAFE_SRC.test(value.trim()) && !LOCAL_MEDIA_SRC.test(value)) {
                removed.add('非 https 的链接 / 图片（javascript: / data: / http: / 相对路径）');
                continue;
            }
            kept.push([name, value]);
        }
        if (tag === 'a') kept.push(['target', '_blank'], ['rel', 'noopener noreferrer']);
        out += `<${tag}${kept.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}${VOID_TAGS.has(tag) ? ' />' : '>'}`;
    }
    return { html: out.trim(), removed: [...removed] };
}

const PH = { job: '%%PT_UNSUBSCRIBE_JOB_URL%%', app: '%%PT_UNSUBSCRIBE_APP_URL%%' };
const PH_STEM = 'PT_UNSUBSCRIBE_';
/** 与平台 neutralizePlaceholders 同口径：应用内容里伪造的退订占位符，把紧贴前面的一串 % 压成一个。 */
export function neutralizePlaceholders(s) {
    if (!s.includes('%')) return s;
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] !== '%') {
            const next = s.indexOf('%', i);
            const e = next < 0 ? s.length : next;
            out += s.slice(i, e);
            i = e;
            continue;
        }
        let j = i;
        while (j < s.length && s[j] === '%') j++;
        out += s.slice(j, j + PH_STEM.length).toUpperCase() === PH_STEM ? '%' : s.slice(i, j);
        i = j;
    }
    return out;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 页脚文案与平台 email-layout.ts 的 COPY 逐字一致。 */
const COPY = {
    'zh-CN': { sentBy: a => `本邮件由 Ptengine 应用「${a}」发送`, job: t => ` · 任务：${t}`, unsubJob: '退订此任务', unsubApp: '退订此应用的全部邮件' },
    'en-US': { sentBy: a => `This email was sent by the Ptengine app "${a}"`, job: t => ` · Job: ${t}`, unsubJob: 'Unsubscribe from this job', unsubApp: 'Unsubscribe from all emails from this app' },
    'ja-JP': { sentBy: a => `このメールは Ptengine アプリ「${a}」から送信されました`, job: t => ` · タスク：${t}`, unsubJob: 'このタスクの配信を停止', unsubApp: 'このアプリからのメールをすべて停止' }
};
/** 法定表示占位：线上由平台按语言配置填入（未配置时生产拒发），本地只占位置。 */
const LEGAL_PLACEHOLDER = '［法定表示（特定電子メール法等）：线上由平台按语言填入，本地仅占位］';
const LINK_STYLE = 'color:#8f959e;text-decoration:underline';

function copyFor(locale) {
    if (!Object.hasOwn(COPY, locale)) {
        throw new Error(`规则快照的语言比本地文案新：${locale}。请升级 starter（scripts/local-stub/notify.mjs 的 COPY 需补该语言）。`);
    }
    return COPY[locale];
}
const footerLine = (c, appName, jobTitle) => c.sentBy(appName) + (jobTitle ? c.job(jobTitle) : '');

/**
 * 简化外框：结构（页眉 / 正文锚点 / 页脚文案 / 退订链接 / 法定页脚段）与平台 renderEmailHtml 一致，样式简化。
 * 「退订此任务」只在 hasJob（有任务 id）时出现 —— 与平台同：草稿预览有标题、没有任务链接。
 */
export function frameLocally({ subject, bodyHtml, appName, jobTitle, hasJob, locale }) {
    const c = copyFor(locale);
    const links = [
        ...(hasJob ? [`<a href="${PH.job}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLE}">${escapeHtml(c.unsubJob)}</a>`] : []),
        `<a href="${PH.app}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLE}">${escapeHtml(c.unsubApp)}</a>`
    ].join(' &nbsp;|&nbsp; ');
    return '<!doctype html>' +
        `<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#f5f6f8">` +
        '<div style="padding:6px 16px;background:#fff3cd;font:12px sans-serif">ptx 本地预览 —— 简化外框，最终样式以产品里的预览面板为准</div>' +
        '<table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#fff">' +
        '<tr><td style="padding:16px 24px;font:bold 16px sans-serif">Ptengine</td></tr>' +
        `<tr><td style="padding:0 24px 24px"><!--pt-body-start-->${bodyHtml}<!--pt-body-end--></td></tr>` +
        `<tr><td style="padding:16px 24px;color:#8f959e;font:12px sans-serif"><p style="margin:0">${escapeHtml(footerLine(c, appName, jobTitle))}</p>` +
        `<p style="margin:8px 0 0">${links}</p><p style="margin:8px 0 0">${escapeHtml(LEGAL_PLACEHOLDER)}</p></td></tr>` +
        '</table></body></html>';
}

/** 纯文本版：与平台 renderEmailText 同结构（正文 trimEnd、「-- 」签名分隔、退订行按 hasJob、法定页脚占位）。 */
export function frameTextLocally({ bodyText, appName, jobTitle, hasJob, locale }) {
    const c = copyFor(locale);
    const lines = [bodyText.trimEnd(), '', '-- ', footerLine(c, appName, jobTitle)];
    if (hasJob) lines.push(`${c.unsubJob}: ${PH.job}`);
    lines.push(`${c.unsubApp}: ${PH.app}`, LEGAL_PLACEHOLDER);
    return lines.join('\n');
}

/** html → 纯文本的简化版（平台用 html-to-text，同样跳过图片；换行细节可能不同）。 */
export function textFromHtml(html) {
    return String(html)
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .split('\n').map(trimLineEnd).join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/** 去行尾空格 / 制表符（手写线性；`/[ \t]+\n/g` 遇到超长空白串是平方级）。 */
function trimLineEnd(line) {
    let e = line.length;
    while (e > 0 && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
    return e === line.length ? line : line.slice(0, e);
}

export function localAppName(manifest) {
    return manifest?.display_name?.['zh-CN'] ?? manifest?.id ?? 'local-dev';
}

const MEDIA_SRC = /\ssrc="(http:\/\/localhost:\d{1,5}\/__ptx\/media\/[0-9a-f]{32}\.png)"/g;

export function handleNotifyEmail(state, { claims, body, appName, rules = RULES.notify }) {
    const bad = validateNotifyInput(body, rules);
    if (bad) return bad;
    const n = notifyRules(rules);
    const { isJob, runId, preview } = jobRunOf(claims);
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

    const sanitized = sanitizeLocally(body.html);
    const removed = sanitized.removed;
    const bodyHtml = neutralizePlaceholders(sanitized.html);          // 与平台同：应用内容里伪造的退订占位符先中和
    const locale = body.locale ?? n.defaultLocale;                    // = contract NOTIFY_EMAIL_DEFAULT_LOCALE（S16，不写字面量兜底）
    const jobTitle = isJob ? (claims.job === 'local' ? '（本地任务）' : String(claims.job ?? '')) : null;
    const hasJob = isJob && typeof claims.job === 'string' && claims.job !== '';   // 平台口径：有任务 id 才有「退订此任务」
    const subject = neutralizePlaceholders(body.subject);
    const name = neutralizePlaceholders(appName);
    const title = jobTitle === null ? null : neutralizePlaceholders(jobTitle);
    const html = frameLocally({ subject, bodyHtml, appName: name, jobTitle: title, hasJob, locale });
    const text = frameTextLocally({ bodyText: neutralizePlaceholders(body.text ?? textFromHtml(bodyHtml)), appName: name, jobTitle: title, hasJob, locale });
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
