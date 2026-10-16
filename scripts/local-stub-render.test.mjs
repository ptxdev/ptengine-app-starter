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
                return { setOption(o) { seen.option = o; }, getZr: () => ({ painter: { renderToString(o) { seen.ssr = o; return '<svg/>'; } } }), dispose() { seen.disposed = true; } };
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

test('checkChartInput：禁用前缀与平台同口径 —— 忽略大小写与前导空白（IMAGE://x、"  image://x" 也拒）', () => {
    const [prefix] = RULES.render.forbiddenStringPrefixes;
    for (const s of [`${prefix.toUpperCase()}x`, `  ${prefix}x`, `\t${prefix.toUpperCase()}x`]) {
        assert.equal(codeOf(checkChartInput({ option: { series: [{ symbol: s }] } })), 'RENDER_OPTION_INVALID', JSON.stringify(s));
    }
});

test('checkChartInput：深度以 rules.maxDepth 为界 —— 恰好 maxDepth 层通过，多一层拒', () => {
    assert.equal(checkChartInput({ option: nest(RULES.render.maxDepth) }).ok, true);
    assert.equal(codeOf(checkChartInput({ option: nest(RULES.render.maxDepth + 1) })), 'RENDER_OPTION_INVALID');
});

test('checkChartInput：标量不计深度 —— 恰好 maxDepth 层、最内层对象 / 数组带标量叶子 → 通过（与平台同口径）', () => {
    const withLeaf = nest(RULES.render.maxDepth);
    let d = withLeaf; while (d.a) d = d.a;
    Object.assign(d, { n: 1, s: 'x', b: true, z: null });
    assert.equal(checkChartInput({ option: withLeaf }).ok, true);
    const arr = nest(RULES.render.maxDepth - 1);
    let e = arr; while (e.a) e = e.a;
    e.list = [1, 'x', null];
    assert.equal(checkChartInput({ option: arr }).ok, true);
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

test('renderPng：与平台同口径 —— 主题名原样传 init、resvg 背景按主题；≤ 200 万像素按 2× 输出，更大按 1×；用完 dispose', async () => {
    const seen = {};
    const renderer = await fakeRenderer(seen)();
    assert.equal(renderPng(renderer, { option: OPTION, width: 800, height: 400, theme: 'dark' }).toString(), 'PNG');
    assert.equal(seen.theme, 'dark');
    assert.deepEqual(seen.opts, { renderer: 'svg', ssr: true, width: 800, height: 400 });
    assert.equal(seen.resvg.fitTo.value, 2);
    assert.equal(seen.resvg.background, '#100c2a');
    assert.equal(seen.disposed, true);
    assert.deepEqual(seen.ssr, { cssAnimation: false, cssEmphasis: false, useViewBox: true });
    renderPng(renderer, { option: OPTION, width: 2000, height: 2000, theme: 'light' });
    assert.equal(seen.theme, 'light');
    assert.equal(seen.resvg.background, '#ffffff');
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
    const missing = async () => { const e = new Error('本地渲染需要 echarts 与 @resvg/resvg-js：npm i --save-optional echarts@^5.6.0 @resvg/resvg-js@^2.6.2'); e.code = 'PTX_RENDER_DEPS_MISSING'; throw e; };
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

// ── 平台 T17/T19 口径同步：资源上限、非 JSON / 循环 / 原型键、字符规则、SVG 允许名单闸（全部读 rules.json） ──
import { assertSvgSelfContained } from './local-stub/svg-gate.mjs';

const R = RULES.render;
const nth = (arr, i = 0) => arr[i];

test('rules 快照含 T19 新增 10 键（缺即「规则快照过旧」，不写字面量兜底）', () => {
    for (const k of ['maxNodes', 'maxArrayLength', 'maxStringLength']) assert.equal(typeof R[k], 'number', k);
    for (const k of ['forbiddenCharsPattern', 'cssFieldKeyPattern']) assert.equal(typeof R[k], 'string', k);
    for (const k of ['forbiddenSubstrings', 'cssFieldForbiddenChars', 'protoKeys', 'svgAllowedElements']) assert.ok(Array.isArray(R[k]), k);
    assert.equal(R.jsonOnly, true);
    const { maxNodes, ...stale } = R;
    assert.throws(() => checkChartInput({ option: OPTION }, stale), /maxNodes[\s\S]*规则快照过旧/);
});

test('checkChartInput：节点 / 数组 / 字符串上限读 rules（换小上限即生效）', () => {
    const small = { ...R, maxNodes: 5, maxArrayLength: 3, maxStringLength: 4 };
    assert.equal(codeOf(checkChartInput({ option: { a: [1, 2, 3, 4, 5, 6] } }, { ...small, maxArrayLength: 100 })), 'RENDER_OPTION_INVALID');
    assert.match(checkChartInput({ option: { a: [1, 2, 3, 4] } }, { ...small, maxNodes: 100 }).body.error.message, /数组长度超过 3/);
    assert.equal(checkChartInput({ option: { a: [1, 2, 3] } }, { ...small, maxNodes: 100 }).ok, true);
    assert.match(checkChartInput({ option: { s: 'abcde' } }, small).body.error.message, /字符串长度超过 4/);
    assert.equal(checkChartInput({ option: { s: 'abcd' } }, small).ok, true);
    assert.equal(codeOf(checkChartInput({ option: { a: Array.from({ length: R.maxArrayLength + 1 }, () => 0) } })), 'RENDER_OPTION_INVALID');
});

test('checkChartInput：非 JSON 值 / 循环引用 / 原型键 → RENDER_OPTION_INVALID', () => {
    const cyc = { a: {} }; cyc.a.self = cyc;
    const hole = [1]; hole[2] = 3;
    for (const option of [{ f: () => 1 }, { n: NaN }, { i: Infinity }, { b: 1n }, { d: new Date() }, { u: undefined }, cyc, { h: hole }, { m: new Map() }]) {
        assert.equal(codeOf(checkChartInput({ option })), 'RENDER_OPTION_INVALID', String(Object.keys(option)));
    }
    // 重复引用（非循环）同平台一律拒：走到这里说明不是 JSON 反序列化来的数据
    const shared = { x: 1 };
    assert.match(checkChartInput({ option: { a: shared, b: shared } }).body.error.message, /循环或重复引用/);
    for (const k of R.protoKeys) {
        const option = JSON.parse(`{"series":[{"${k}":{"x":1}}]}`);
        assert.equal(codeOf(checkChartInput({ option })), 'RENDER_OPTION_INVALID', k);
    }
});

test('checkChartInput：字符串（含键名）禁 forbiddenCharsPattern 与 forbiddenSubstrings；\\t \\n 允许', () => {
    for (const s of ['A "B"', 'a<b', 'a>b', 'x\u0000', 'x\u001f', 'x\r', `x${nth(R.forbiddenSubstrings)}117;`]) {
        assert.equal(codeOf(checkChartInput({ option: { title: { text: s } } })), 'RENDER_OPTION_INVALID', JSON.stringify(s));
    }
    assert.equal(codeOf(checkChartInput({ option: { 'a"b': 1 } })), 'RENDER_OPTION_INVALID');
    assert.equal(checkChartInput({ option: { title: { text: '第一行\n第二行\t& 其余' } } }).ok, true);
});

test('checkChartInput：样式字段（cssFieldKeyPattern）子树禁 cssFieldForbiddenChars；非样式字段不禁', () => {
    const [semi] = R.cssFieldForbiddenChars;
    for (const option of [
        { color: [`red${semi}x:y`] },
        { textStyle: { fontFamily: `a${semi}b` } },
        { series: [{ itemStyle: { borderColor: { colorStops: [{ offset: 0, color: `#fff${semi}` }] } } }] }
    ]) assert.equal(codeOf(checkChartInput({ option })), 'RENDER_OPTION_INVALID', JSON.stringify(option));
    assert.equal(checkChartInput({ option: { title: { text: `a${semi}b` } } }).ok, true);
});

test('checkChartInput：判定顺序与平台一致 —— 结构类（深度）先于字节上限', () => {
    const deep = nest(R.maxDepth + 1);
    deep.pad = 'x'.repeat(10);
    assert.equal(codeOf(checkChartInput({ option: deep }, { ...R, optionMaxBytes: 5 })), 'RENDER_OPTION_INVALID');
    // 内容类违规（字符）让位给字节上限
    assert.equal(codeOf(checkChartInput({ option: { s: 'a<b'.repeat(10) } }, { ...R, optionMaxBytes: 5 })), 'RENDER_TOO_LARGE');
});

test('assertSvgSelfContained：允许名单读 rules.svgAllowedElements；外部 href / url( / 前缀 / <! / @import / 反斜杠一律拒', () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" width="10"><g clip-path="url(#c)"><path d="M0 0"/><text x="1">a &amp; b</text></g><defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs></svg>';
    assertSvgSelfContained(ok);
    const bad = [
        '<svg><image href="/etc/passwd"/></svg>',
        '<svg><svg:image href="#a"/></svg>',
        '<svg><use href="#a"/></svg>',
        '<svg><a xlink:href="file:///x"/></svg>',
        '<svg><rect fill="url(http://x/a)"/></svg>',
        '<svg><rect fill="url(&#00000104;ttp://x)"/></svg>',
        '<svg><rect style="@import x"/></svg>',
        '<svg><rect style="u\\72l(x)"/></svg>',
        '<svg><!-- x --></svg>',
        '<?xml version="1.0"?><svg/>',
        '<svg><rect fill=red/></svg>',
        '<svg><rect fill="&bogus;"/></svg>',
        '<svg><rect fill="&#xD800;"/></svg>',
        '<g/>'
    ];
    for (const s of bad) assert.throws(() => assertSvgSelfContained(s), /SVG 不允许/, s);
    assert.throws(() => assertSvgSelfContained('<svg><rect/></svg>', { ...R, svgAllowedElements: ['svg'] }), /rect/);
    assert.throws(() => assertSvgSelfContained('<svg/>', { ...R, svgAllowedElements: undefined }), /规则快照过旧/);
});

test('renderPng：渲染产物先过 SVG 闸 —— 闸拒时抛错，handleRenderChart 回 500 PTX_RENDER_FAILED', async () => {
    const evil = async () => ({
        echarts: { init: () => ({ setOption() {}, getZr: () => ({ painter: { renderToString: () => '<svg><image href="/etc/passwd"/></svg>' } }), dispose() {} }) },
        Resvg: class { constructor() { throw new Error('不该走到 resvg'); } }
    });
    const r = await handleRenderChart(createStubState(), { claims: {}, body: { option: OPTION }, loadRenderer: evil });
    assert.equal(r.status, 500);
    assert.equal(codeOf(r), 'PTX_RENDER_FAILED');
    assert.match(r.body.error.message, /SVG 不允许/);
});
