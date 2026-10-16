/**
 * 本地图表桩的 SVG 闸 —— 与平台 platform/src/render/render-core.ts 的 `assertSvgSelfContained` 同一口径（逐行移植）。
 *
 * resvg 没有关闭外部 href 的选项：zrender 序列化属性值时不转义，option 里塞进的 `"` 能拼出 `<image href="/abs/path">`，
 * 本地渲染就会去读开发者本机文件。这道闸按**允许名单**放行，命中即抛（handleRenderChart 报 PTX_RENDER_FAILED）：
 * - 文档必须以 `<svg` 开头；`<!`（DOCTYPE / ENTITY / 注释 / CDATA）与 `<?` 一律拒；
 * - 标签名必须恰在 rules.json `render.svgAllowedElements` 里（大小写敏感，带任意 `prefix:` 即拒）；
 * - 属性值必须加引号，先按 XML 规则解实体再判：local-name 为 href 的只许 `#id`；任何 `url(` 只许 `#id`；
 *   禁 `@import` 与反斜杠；`&#` 字符引用不合法即拒。
 * 允许名单不写字面量：缺段就报「规则快照过旧」。
 */
import { RULES } from '../manifest.mjs';

const reject = why => { throw new Error(`SVG 不允许：${why}`); };
const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isNameChar = c => c !== undefined && /[A-Za-z0-9_:.-]/.test(c);
const isXmlChar = cp =>
    cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

function allowedElements(rules) {
    if (!rules || !Array.isArray(rules.svgAllowedElements)) {
        throw new Error('scripts/rules.json 的 render 段缺 svgAllowedElements（规则快照过旧）。维护者请跑 npm run sync-rules。');
    }
    return new Set(rules.svgAllowedElements);
}

/** 解字符引用与五个预定义实体（单遍、线性）；非法字符引用 / 未知实体即拒。 */
function decodeXmlValue(v) {
    if (!v.includes('&')) return v;
    const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    let out = '';
    let i = 0;
    while (i < v.length) {
        const amp = v.indexOf('&', i);
        if (amp === -1) { out += v.slice(i); break; }
        out += v.slice(i, amp);
        let j = amp + 1;
        if (v[j] === '#') {
            j++;
            const hex = v[j] === 'x';
            if (hex) j++;
            const digits = hex ? /[0-9A-Fa-f]/ : /[0-9]/;
            const start = j;
            while (j < v.length && digits.test(v[j])) j++;
            if (j === start || v[j] !== ';') reject(`非法字符引用 ${v.slice(amp, Math.min(j + 1, amp + 24))}`);
            let k = start;
            while (k < j - 1 && v[k] === '0') k++;
            const sig = v.slice(k, j);
            if (sig.length > (hex ? 6 : 7)) reject('字符引用超出码点范围');
            const cp = parseInt(sig, hex ? 16 : 10);
            if (!isXmlChar(cp)) reject(`字符引用不是合法 XML 字符（${cp}）`);
            out += String.fromCodePoint(cp);
            i = j + 1;
            continue;
        }
        const start = j;
        while (j < v.length && /[A-Za-z0-9]/.test(v[j])) j++;
        if (j > start && v[j] === ';') {
            const name = v.slice(start, j);
            out += Object.hasOwn(NAMED, name) ? NAMED[name] : reject(`未知实体 &${name};`);
            i = j + 1;
            continue;
        }
        out += '&';
        i = amp + 1;
    }
    return out;
}

function assertUrlsInternal(value) {
    const lower = value.toLowerCase();
    for (let i = lower.indexOf('url('); i !== -1; i = lower.indexOf('url(', i + 4)) {
        let j = i + 4;
        while (j < value.length && (isWs(value[j]) || value[j] === '"' || value[j] === "'")) j++;
        if (value[j] !== '#') reject(`引用了外部资源（${value.slice(i, i + 80)}）`);
    }
}

function checkAttribute(name, raw) {
    const local = name.slice(name.lastIndexOf(':') + 1).toLowerCase();
    const value = decodeXmlValue(raw);
    if (local === 'href' && !value.trim().startsWith('#')) reject(`${name} 引用了外部资源（${value.trim().slice(0, 80) || '空引用'}）`);
    if (/@import/i.test(value)) reject(`${name} 含 @import`);
    if (value.includes('\\')) reject(`${name} 含反斜杠`);
    assertUrlsInternal(value);
}

export function assertSvgSelfContained(svg, rules = RULES.render) {
    const allowed = allowedElements(rules);
    const n = svg.length;
    let i = 0;
    while (isWs(svg[i])) i++;
    if (!svg.startsWith('<svg', i)) reject('文档不是以 <svg 开头');
    while (i < n) {
        const lt = svg.indexOf('<', i);
        if (lt === -1) break;
        i = lt + 1;
        const c = svg[i];
        if (c === '!' || c === '?') reject('DOCTYPE / ENTITY / 注释 / CDATA / 处理指令');
        const closing = c === '/';
        if (closing) i++;
        const nameStart = i;
        while (isNameChar(svg[i])) i++;
        const name = svg.slice(nameStart, i);
        if (!name) reject('空标签名');
        if (name.includes(':') || !allowed.has(name)) reject(`元素 <${closing ? '/' : ''}${name.slice(0, 64)}> 不在允许名单`);
        if (closing) {
            while (isWs(svg[i])) i++;
            if (svg[i] !== '>') reject(`结束标签 </${name}> 未闭合`);
            i++;
            continue;
        }
        for (;;) {
            const before = i;
            while (isWs(svg[i])) i++;
            if (i >= n) reject(`标签 <${name}> 未闭合`);
            if (svg[i] === '>') { i++; break; }
            if (svg[i] === '/') {
                if (svg[i + 1] !== '>') reject(`标签 <${name}> 的 / 后不是 >`);
                i += 2;
                break;
            }
            if (i === before) reject(`标签 <${name}> 的属性之间缺空白`);
            const attrStart = i;
            while (isNameChar(svg[i])) i++;
            const attr = svg.slice(attrStart, i);
            if (!attr) reject(`标签 <${name}> 含非常规属性名（${svg.slice(i, i + 16)}）`);
            while (isWs(svg[i])) i++;
            if (svg[i] !== '=') reject(`属性 ${attr} 没有值`);
            i++;
            while (isWs(svg[i])) i++;
            const q = svg[i];
            if (q !== '"' && q !== "'") reject(`属性 ${attr} 的值没有引号`);
            const close = svg.indexOf(q, i + 1);
            if (close === -1) reject(`属性 ${attr} 的引号未闭合`);
            checkAttribute(attr, svg.slice(i + 1, close));
            i = close + 1;
        }
    }
}
