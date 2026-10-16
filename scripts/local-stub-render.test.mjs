import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from './manifest.mjs';
import { createStubState } from './local-stub/notify.mjs';
import { checkChartInput, handleRenderChart, renderPng } from './local-stub/render.mjs';

const OPTION = { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] };
const codeOf = r => r?.body?.error?.code;

/** 假渲染器：记下 init / setOption 的参数，产出可辨认的「PNG」。 */
function fakeRenderer(seen = {}) {
    return async () => ({
        echarts: {
            init(_dom, theme, opts) {
                seen.theme = theme; seen.opts = opts;
                return { setOption(o) { seen.option = o; }, renderToSVGString() { return '<svg/>'; }, dispose() { seen.disposed = true; } };
            }
        },
        Resvg: class { constructor(svg, o) { seen.resvg = o; this.svg = svg; } render() { return { asPng: () => Buffer.from('PNG') }; } }
    });
}

const nest = n => { const root = {}; let d = root; for (let i = 1; i < n; i++) { d.a = {}; d = d.a; } return root; };

test('checkChartInput：缺省宽高 / 主题取 rules；强制 animation:false；删 rules.droppedTopLevelKeys 列出的顶层键', () => {
    const dropped = Object.fromEntries(RULES.render.droppedTopLevelKeys.map(k => [k, {}]));
    const r = checkChartInput({ option: { ...OPTION, ...dropped, animation: true } });
    assert.equal(r.ok, true);
    assert.equal(r.width, RULES.render.defaultWidth);
    assert.equal(r.height, RULES.render.defaultHeight);
    assert.equal(r.theme, 'light');
    assert.equal(r.option.animation, false);
    for (const k of RULES.render.droppedTopLevelKeys) assert.equal(k in r.option, false, k);
    assert.ok('series' in r.option);
});

test('checkChartInput：rules.forbiddenKeys 里的键 / forbiddenStringPrefixes 开头的字符串 → RENDER_OPTION_INVALID（点名路径）', () => {
    const [key] = RULES.render.forbiddenKeys;
    const [prefix] = RULES.render.forbiddenStringPrefixes;
    const img = checkChartInput({ option: { graphic: { elements: [{ type: 'image', style: { [key]: 'https://x/a.png' } }] } } });
    assert.equal(codeOf(img), 'RENDER_OPTION_INVALID');
    assert.ok(img.body.error.message.includes(`option.graphic.elements[0].style.${key}`));
    assert.equal(codeOf(checkChartInput({ option: { series: [{ symbol: `${prefix}https://x/a.png` }] } })), 'RENDER_OPTION_INVALID');
    for (const bad of [undefined, null, [1], 'x']) assert.equal(codeOf(checkChartInput({ option: bad })), 'RENDER_OPTION_INVALID');
});

test('checkChartInput：深度以 rules.maxDepth 为界 —— 恰好 maxDepth 层通过，多一层拒', () => {
    assert.equal(checkChartInput({ option: nest(RULES.render.maxDepth) }).ok, true);
    assert.equal(codeOf(checkChartInput({ option: nest(RULES.render.maxDepth + 1) })), 'RENDER_OPTION_INVALID');
});

test('checkChartInput：白名单完全由传入的 rules 决定（换一组规则行为跟着变，证明没有写死）', () => {
    const rules = { ...RULES.render, maxDepth: 2, forbiddenKeys: ['danger'], forbiddenStringPrefixes: ['bad:'], droppedTopLevelKeys: ['legend'] };
    assert.equal(codeOf(checkChartInput({ option: { a: { b: {} } } }, rules)), 'RENDER_OPTION_INVALID');
    assert.equal(codeOf(checkChartInput({ option: { danger: 1 } }, rules)), 'RENDER_OPTION_INVALID');
    assert.equal(codeOf(checkChartInput({ option: { s: 'bad:x' } }, rules)), 'RENDER_OPTION_INVALID');
    const ok = checkChartInput({ option: { legend: {}, toolbox: {} } }, rules);
    assert.equal(ok.ok, true);
    assert.equal('legend' in ok.option, false);
    assert.equal('toolbox' in ok.option, true);
});

test('checkChartInput：宽高不是范围内整数 / 主题不认识 → RENDER_SIZE_INVALID；option 过大 → 413 RENDER_TOO_LARGE（上限读 rules）', () => {
    const { minDimension: min, maxDimension: max } = RULES.render;
    for (const patch of [{ width: min - 1 }, { width: max + 1 }, { height: 1.5 }, { width: '800' }, { theme: 'blue' }]) {
        assert.equal(codeOf(checkChartInput({ option: OPTION, ...patch })), 'RENDER_SIZE_INVALID', JSON.stringify(patch));
    }
    const big = checkChartInput({ option: { pad: 'x'.repeat(100) } }, { ...RULES.render, optionMaxBytes: 50 });
    assert.equal(big.status, 413);
    assert.equal(codeOf(big), 'RENDER_TOO_LARGE');
});

test('renderPng：SVG SSR 参数逐字；≤ 200 万像素按 2× 输出，更大按 1×；用完 dispose', async () => {
    const seen = {};
    const renderer = await fakeRenderer(seen)();
    assert.equal(renderPng(renderer, { option: OPTION, width: 800, height: 400, theme: 'dark' }).toString(), 'PNG');
    assert.equal(seen.theme, 'dark');
    assert.deepEqual(seen.opts, { renderer: 'svg', ssr: true, width: 800, height: 400 });
    assert.equal(seen.resvg.fitTo.value, 2);
    assert.equal(seen.disposed, true);
    renderPng(renderer, { option: OPTION, width: 2000, height: 2000, theme: 'light' });
    assert.equal(seen.theme, null);
    assert.equal(seen.resvg.fitTo.value, 1);
});

test('handleRenderChart：本 run 超过 maxPerRun → 409 NOTIFY_RUN_LIMIT_EXCEEDED；交互调用不计', async () => {
    const rules = { ...RULES.render, maxPerRun: 1 };
    const s = createStubState();
    const job = { trg: 'job', run: 'r1', mode: 'preview' };
    assert.equal((await handleRenderChart(s, { claims: job, body: { option: OPTION }, rules, loadRenderer: fakeRenderer() })).status, 200);
    assert.equal(codeOf(await handleRenderChart(s, { claims: job, body: { option: OPTION }, rules, loadRenderer: fakeRenderer() })), 'NOTIFY_RUN_LIMIT_EXCEEDED');
    assert.equal((await handleRenderChart(s, { claims: {}, body: { option: OPTION }, rules, loadRenderer: fakeRenderer() })).status, 200);
});

test('handleRenderChart：可选依赖没装上 → 501 PTX_RENDER_DEPS_MISSING，提示怎么装', async () => {
    const missing = async () => { const e = new Error('本地渲染需要 echarts 与 @resvg/resvg-js：npm i -D echarts@^5.6.0 @resvg/resvg-js@^2.6.2'); e.code = 'PTX_RENDER_DEPS_MISSING'; throw e; };
    const r = await handleRenderChart(createStubState(), { claims: {}, body: { option: OPTION }, loadRenderer: missing });
    assert.equal(r.status, 501);
    assert.equal(codeOf(r), 'PTX_RENDER_DEPS_MISSING');
    assert.match(r.body.error.message, /npm i/);
});

const hasDeps = await import('echarts').then(() => import('@resvg/resvg-js')).then(() => true, () => false);
test('真渲染（装了可选依赖时）：输出 PNG 魔数，IHDR 宽度是 2×', { skip: !hasDeps && '没装 echarts / @resvg/resvg-js' }, async () => {
    const r = await handleRenderChart(createStubState(), { claims: {}, body: { option: OPTION, width: 200, height: 100 } });
    assert.equal(r.status, 200);
    assert.deepEqual([...r.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(r.png.readUInt32BE(16), 400);
});
