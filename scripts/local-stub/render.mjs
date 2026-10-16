/**
 * ptx dev 的本地「图表」桩逻辑（定时任务 1b，brief §13.3）。与平台同一套渲染：echarts SSR（SVG）+ @resvg/resvg-js。
 *
 * - 两个包是 starter 的 optionalDependencies：装不上（少见平台）时只有本地渲染不可用，报 501 并说清楚怎么装。
 * - option 白名单的**全部数值、键名与字符规则**读 rules.json 的 render 段（`maxDepth` / `maxNodes` / `maxArrayLength` /
 *   `maxStringLength` / `forbiddenKeys` / `protoKeys` / `forbiddenStringPrefixes` / `forbiddenCharsPattern` /
 *   `forbiddenSubstrings` / `cssFieldKeyPattern` / `cssFieldForbiddenChars` / `droppedTopLevelKeys`），与平台
 *   `sanitizeChartOption` 取自同一组 contract 常量（一致性评审 S10、平台 T19）；本文件只实现「怎么查」，不写「查什么」。
 *   另强制 animation:false。宽高 / 主题 / 体积上限同样读 render 段。
 * - 渲染出的 SVG 先过 `svg-gate.mjs`（与平台 render-core 的 assertSvgSelfContained 同口径，允许名单读
 *   `svgAllowedElements`），才交给 resvg —— 否则注入的 `<image href>` 会读本机文件。
 * - 字体：本地用系统字体；平台用镜像里的 Noto Sans CJK —— 字形可能略有不同，以产品里的预览面板为准。
 */
import { RULES } from '../manifest.mjs';
import { runCounters } from './notify.mjs';
import { assertSvgSelfContained } from './svg-gate.mjs';

const enc = new TextEncoder();
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (status, code, message) => ({ status, body: { error: { code, message } } });

/** 本模块读到的 render 规则键；缺任何一个都视为快照过旧，不用字面量兜底。 */
const REQUIRED_RENDER_NUMBERS = ['optionMaxBytes', 'minDimension', 'maxDimension', 'defaultWidth', 'defaultHeight', 'maxPerRun', 'maxDepth',
    'maxNodes', 'maxArrayLength', 'maxStringLength'];
const REQUIRED_RENDER_STRINGS = ['forbiddenCharsPattern', 'cssFieldKeyPattern'];
const REQUIRED_RENDER_ARRAYS = ['themes', 'forbiddenKeys', 'forbiddenStringPrefixes', 'droppedTopLevelKeys',
    'forbiddenSubstrings', 'cssFieldForbiddenChars', 'protoKeys', 'svgAllowedElements'];

function renderRules(rules) {
    const missing = rules
        ? [...REQUIRED_RENDER_NUMBERS.filter(k => typeof rules[k] !== 'number'),
            ...REQUIRED_RENDER_STRINGS.filter(k => typeof rules[k] !== 'string'),
            ...REQUIRED_RENDER_ARRAYS.filter(k => !Array.isArray(rules[k])),
            ...(rules.jsonOnly === true ? [] : ['jsonOnly'])]
        : ['render'];
    if (missing.length) {
        throw new Error(`scripts/rules.json 的 render 段缺 ${missing.join(' / ')}（规则快照过旧）。维护者请跑 npm run sync-rules。`);
    }
    return rules;
}

/** 只认字面量对象（原型为 Object.prototype 或 null）：Date / Map / 类实例都不是 JSON 值。 */
const isJsonObject = v => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
const describeChar = c => (c === '"' || c === '<' || c === '>' ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * 与平台 sanitizeChartOption（platform/src/render/option-whitelist.ts）同口径，规则全部读 rules.json render 段：
 * - 只接受 JSON 值（函数 / undefined / NaN / Infinity / bigint / 非字面量对象 / 数组空洞 / 循环或重复引用 / Symbol 键都拒）；
 * - 资源上限：节点数 maxNodes、数组长度 maxArrayLength、字符串（含键名）长度 maxStringLength、深度 maxDepth
 *   （option 本身第 1 层，只有对象 / 数组判深度）；
 * - 字符串与键名禁 forbiddenCharsPattern（" < > 与控制字符，\t \n 除外）与 forbiddenSubstrings（&#）；
 *   样式字段（键名匹配 cssFieldKeyPattern）的整个子树禁 cssFieldForbiddenChars（;）；
 * - 键：protoKeys 与 forbiddenKeys 一律拒；字符串去前导空白转小写后以 forbiddenStringPrefixes 开头即拒。
 * 判定顺序同平台：结构类立即返回 → 字节上限（RENDER_TOO_LARGE）→ 内容类（第一条）。
 */
function sanitize(option, r) {
    const forbiddenChars = new RegExp(r.forbiddenCharsPattern);
    const cssKey = new RegExp(r.cssFieldKeyPattern);
    const invalid = message => err(400, 'RENDER_OPTION_INVALID', message);
    let nodes = 0;
    let content = null;
    const note = m => { if (!content) content = m; };
    const seen = new Set();
    const stack = [{ v: option, depth: 1, path: 'option', css: false }];
    while (stack.length) {
        const { v, depth, path, css } = stack.pop();
        if (++nodes > r.maxNodes) return invalid(`option 节点数超过 ${r.maxNodes}`);
        switch (typeof v) {
            case 'string': {
                if (v.length > r.maxStringLength) note(`${path} 字符串长度超过 ${r.maxStringLength}`);
                const bad = forbiddenChars.exec(v);
                if (bad) note(`${path} 含不允许的字符 ${describeChar(bad[0])}（字符串里不能有 " < > 与控制字符）`);
                const sub = r.forbiddenSubstrings.find(x => v.includes(x));
                if (sub) note(`${path} 不能含字符引用 ${sub}`);
                const cssBad = css ? r.cssFieldForbiddenChars.find(x => v.includes(x)) : undefined;
                if (cssBad) note(`${path} 是样式字段，不能含 ${cssBad}`);
                const lower = v.trimStart().toLowerCase();
                const hit = r.forbiddenStringPrefixes.find(p => lower.startsWith(p));
                if (hit) note(`${path} 以 ${hit} 开头，平台不允许`);
                continue;
            }
            case 'boolean':
                continue;
            case 'number':
                if (!Number.isFinite(v)) return invalid(`${path} 不是有限数字（NaN / Infinity 不是 JSON 值）`);
                continue;
            case 'object':
                break;
            default:
                return invalid(`${path} 不是 JSON 值（${typeof v}）`);
        }
        if (v === null) continue;
        if (depth > r.maxDepth) return invalid(`option 嵌套超过 ${r.maxDepth} 层（${path}）`);
        if (seen.has(v)) return invalid(`${path} 是循环或重复引用`);
        seen.add(v);
        if (Array.isArray(v)) {
            if (v.length > r.maxArrayLength) return invalid(`${path} 数组长度超过 ${r.maxArrayLength}`);
            for (let i = v.length - 1; i >= 0; i--) {
                if (!(i in v)) return invalid(`${path}[${i}] 是数组空洞（不是 JSON 值）`);
                stack.push({ v: v[i], depth: depth + 1, path: `${path}[${i}]`, css });
            }
            continue;
        }
        if (!isJsonObject(v)) return invalid(`${path} 不是 JSON 对象`);
        // 先正序检查键名（第一条坏键与平台报的一致），再逆序入栈（出栈按书写顺序）
        const children = [];
        for (const k of Object.keys(v)) {
            const kp = `${path}.${k.length > 64 ? `${k.slice(0, 64)}…` : k}`;
            if (k.length > r.maxStringLength) { note(`${kp} 键名长度超过 ${r.maxStringLength}`); continue; }
            const badKey = forbiddenChars.exec(k);
            if (badKey) { note(`${kp} 键名含不允许的字符 ${describeChar(badKey[0])}`); continue; }
            if (r.protoKeys.includes(k)) { note(`${kp} 不允许`); continue; }
            if (r.forbiddenKeys.includes(k)) { note(`${path}.${k}：平台不允许 ${k} 键`); continue; }
            children.push({ v: v[k], depth: depth + 1, path: kp, css: css || cssKey.test(k) });
        }
        for (let ci = children.length - 1; ci >= 0; ci--) stack.push(children[ci]);
        if (Object.getOwnPropertySymbols(v).length) return invalid(`${path} 含 Symbol 键（不是 JSON 值）`);
    }
    const json = JSON.stringify(option);
    if (enc.encode(json).byteLength > r.optionMaxBytes) return err(413, 'RENDER_TOO_LARGE', `option 序列化后超过 ${r.optionMaxBytes} 字节`);
    if (content) return invalid(content);
    return { ok: true, option: JSON.parse(json) };
}

export function checkChartInput(body, rules = RULES.render) {
    const r = renderRules(rules);
    if (!isObj(body) || !isObj(body.option) || !isJsonObject(body.option)) return err(400, 'RENDER_OPTION_INVALID', 'option 必须是对象（ECharts option）');
    const s = sanitize(body.option, r);
    if (!s.ok) return s;
    const width = body.width ?? r.defaultWidth;
    const height = body.height ?? r.defaultHeight;
    const okDim = d => Number.isInteger(d) && d >= r.minDimension && d <= r.maxDimension;
    if (!okDim(width) || !okDim(height)) {
        return err(400, 'RENDER_SIZE_INVALID', `宽高必须是 ${r.minDimension}..${r.maxDimension} 的整数`);
    }
    const theme = body.theme ?? 'light';
    if (!r.themes.includes(theme)) return err(400, 'RENDER_SIZE_INVALID', `theme 只能是 ${r.themes.join(' / ')}`);
    const option = s.option;
    for (const k of r.droppedTopLevelKeys) delete option[k];
    option.animation = false;
    return { ok: true, option, width, height, theme };
}

export async function loadEchartsRenderer() {
    try {
        const [echarts, resvg] = await Promise.all([import('echarts'), import('@resvg/resvg-js')]);
        return { echarts: echarts.default ?? echarts, Resvg: resvg.Resvg ?? resvg.default.Resvg };
    } catch (e) {
        const out = new Error(
            '本地渲染需要 echarts 与 @resvg/resvg-js（脚手架的 optionalDependencies），这次没装上' +
            `（${e?.code ?? e?.message ?? e}）。重跑 npm install，或手动 npm i --save-optional echarts@^5.6.0 @resvg/resvg-js@^2.6.2。` +
            '线上渲染在平台侧，不受影响。');
        out.code = 'PTX_RENDER_DEPS_MISSING';
        throw out;
    }
}

/** 与平台渲染同口径：主题名原样交给 echarts.init（light 也传 'light'），PNG 背景按主题铺底（echarts 内置 dark 主题的底色）。 */
const BACKGROUND = { light: '#ffffff', dark: '#100c2a' };

export function renderPng({ echarts, Resvg }, { option, width, height, theme }, rules = RULES.render) {
    const chart = echarts.init(null, theme, { renderer: 'svg', ssr: true, width, height });
    try {
        chart.setOption(option);
        // 与平台 renderChartSvg 同口径：关掉 CSS 动画与 CSS emphasis，产物里不会有 <style> / CDATA，闸可以一律拒绝它们
        const svg = chart.getZr().painter.renderToString({ cssAnimation: false, cssEmphasis: false, useViewBox: true });
        assertSvgSelfContained(svg, rules);
        // 与平台同口径：≤ 200 万像素按 2× 输出（高分屏清晰），更大按 1×
        const zoom = width * height <= 2_000_000 ? 2 : 1;
        // 字体：starter 不带字体文件，本地只能开系统字体（平台只用镜像里打包的 Noto CJK）。开系统字体不引入外部资源 ——
        // 外部 href / url( 已由上面的 SVG 闸挡住；字形与线上可能略有差异，以产品里的预览面板为准。logLevel off 同平台。
        return new Resvg(svg, { fitTo: { mode: 'zoom', value: zoom }, background: BACKGROUND[theme], logLevel: 'off', font: { loadSystemFonts: true } }).render().asPng();
    } finally {
        chart.dispose();
    }
}

export async function handleRenderChart(state, { claims, body, rules = RULES.render, loadRenderer = loadEchartsRenderer }) {
    const checked = checkChartInput(body, rules);
    if (!checked.ok) return checked;
    const r = renderRules(rules);
    const runId = claims?.trg === 'job' && typeof claims.run === 'string' ? claims.run : null;
    if (runId) {
        const c = runCounters(state, runId);
        if (c.charts + 1 > r.maxPerRun) return err(409, 'NOTIFY_RUN_LIMIT_EXCEEDED', `一次运行最多渲染 ${r.maxPerRun} 张图`);
        c.charts++;
    }
    let renderer;
    try {
        renderer = await loadRenderer();
    } catch (e) {
        return err(501, 'PTX_RENDER_DEPS_MISSING', String(e?.message ?? e));
    }
    try {
        return { status: 200, png: renderPng(renderer, checked, r), width: checked.width, height: checked.height };
    } catch (e) {
        return err(500, 'PTX_RENDER_FAILED', `本地渲染失败：${e?.message ?? e}`);
    }
}
