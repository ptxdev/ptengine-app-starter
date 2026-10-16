/**
 * ptx dev 的本地「图表」桩逻辑（定时任务 1b，brief §13.3）。与平台同一套渲染：echarts SSR（SVG）+ @resvg/resvg-js。
 *
 * - 两个包是 starter 的 optionalDependencies：装不上（少见平台）时只有本地渲染不可用，报 501 并说清楚怎么装。
 * - option 白名单的**全部数值与键名**读 rules.json 的 render 段（`maxDepth` / `forbiddenKeys` / `forbiddenStringPrefixes` /
 *   `droppedTopLevelKeys`），与平台 `sanitizeChartOption` 取自同一组 contract 常量（一致性评审 S10）；本文件只实现
 *   「怎么查」，不写「查什么」。另强制 animation:false。宽高 / 主题 / 体积上限同样读 render 段。
 * - 字体：本地用系统字体；平台用镜像里的 Noto Sans CJK —— 字形可能略有不同，以产品里的预览面板为准。
 */
import { RULES } from '../manifest.mjs';
import { runCounters } from './notify.mjs';

const enc = new TextEncoder();
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (status, code, message) => ({ status, body: { error: { code, message } } });

/** 本模块读到的 render 规则键；缺任何一个都视为快照过旧，不用字面量兜底。 */
const REQUIRED_RENDER_NUMBERS = ['optionMaxBytes', 'minDimension', 'maxDimension', 'defaultWidth', 'defaultHeight', 'maxPerRun', 'maxDepth'];
const REQUIRED_RENDER_ARRAYS = ['themes', 'forbiddenKeys', 'forbiddenStringPrefixes', 'droppedTopLevelKeys'];

function renderRules(rules) {
    const missing = rules
        ? [...REQUIRED_RENDER_NUMBERS.filter(k => typeof rules[k] !== 'number'), ...REQUIRED_RENDER_ARRAYS.filter(k => !Array.isArray(rules[k]))]
        : ['render'];
    if (missing.length) {
        throw new Error(`scripts/rules.json 的 render 段缺 ${missing.join(' / ')}（规则快照过旧）。维护者请跑 npm run sync-rules。`);
    }
    return rules;
}

/**
 * 口径与平台 sanitizeChartOption 一致：
 * - 深度：option 本身算第 1 层，每进一层对象 / 数组 +1；只有对象 / 数组判深度，标量叶子不判。
 * - 禁用前缀：字符串去掉前导空白、转小写后再比（`IMAGE://x`、`  image://x` 一样拒）。
 */
function scan(v, depth, path, r) {
    if (typeof v === 'string') {
        const lower = v.trimStart().toLowerCase();
        const hit = r.forbiddenStringPrefixes.find(p => lower.startsWith(p));
        return hit ? `${path} 以 ${hit} 开头，平台不允许` : null;
    }
    if ((Array.isArray(v) || isObj(v)) && depth > r.maxDepth) return `option 嵌套超过 ${r.maxDepth} 层（${path}）`;
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) { const e = scan(v[i], depth + 1, `${path}[${i}]`, r); if (e) return e; }
        return null;
    }
    if (isObj(v)) {
        for (const [k, child] of Object.entries(v)) {
            if (r.forbiddenKeys.includes(k)) return `${path}.${k}：平台不允许 ${k} 键`;
            const e = scan(child, depth + 1, `${path}.${k}`, r);
            if (e) return e;
        }
    }
    return null;
}

export function checkChartInput(body, rules = RULES.render) {
    const r = renderRules(rules);
    if (!isObj(body) || !isObj(body.option)) return err(400, 'RENDER_OPTION_INVALID', 'option 必须是对象（ECharts option）');
    if (enc.encode(JSON.stringify(body.option)).byteLength > r.optionMaxBytes) {
        return err(413, 'RENDER_TOO_LARGE', `option 序列化后超过 ${r.optionMaxBytes} 字节`);
    }
    const reason = scan(body.option, 1, 'option', r);
    if (reason) return err(400, 'RENDER_OPTION_INVALID', reason);
    const width = body.width ?? r.defaultWidth;
    const height = body.height ?? r.defaultHeight;
    const okDim = d => Number.isInteger(d) && d >= r.minDimension && d <= r.maxDimension;
    if (!okDim(width) || !okDim(height)) {
        return err(400, 'RENDER_SIZE_INVALID', `宽高必须是 ${r.minDimension}..${r.maxDimension} 的整数`);
    }
    const theme = body.theme ?? 'light';
    if (!r.themes.includes(theme)) return err(400, 'RENDER_SIZE_INVALID', `theme 只能是 ${r.themes.join(' / ')}`);
    const option = { ...body.option, animation: false };
    for (const k of r.droppedTopLevelKeys) delete option[k];
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

export function renderPng({ echarts, Resvg }, { option, width, height, theme }) {
    const chart = echarts.init(null, theme, { renderer: 'svg', ssr: true, width, height });
    try {
        chart.setOption(option);
        const svg = chart.renderToSVGString();
        // 与平台同口径：≤ 200 万像素按 2× 输出（高分屏清晰），更大按 1×
        const zoom = width * height <= 2_000_000 ? 2 : 1;
        return new Resvg(svg, { fitTo: { mode: 'zoom', value: zoom }, background: BACKGROUND[theme], font: { loadSystemFonts: true } }).render().asPng();
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
        return { status: 200, png: renderPng(renderer, checked), width: checked.width, height: checked.height };
    } catch (e) {
        return err(500, 'PTX_RENDER_FAILED', `本地渲染失败：${e?.message ?? e}`);
    }
}
