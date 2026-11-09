/**
 * 从 audit-rules.json 生成 AGENTS.md 里「自检规则（写代码前先看）」一节。
 *
 * 为什么要生成：自检规则如果只活在 audit 的输出里，写代码的人（和 Builder 里的 agent）
 * 第一次知道某条规则，就是被自检卡拦下的时候。把同一份规则表写进 AGENTS.md，
 * 让它成为「写之前先看」的规范，audit 只做兜底。json 是唯一真相，文档只是渲染结果 ——
 * 手改 AGENTS.md 的那一段会被下次生成覆盖，`--check` 会把两边不一致拦在测试里。
 *
 *   npm run audit:doc                                    重写 AGENTS.md 标记之间的内容
 *   node scripts/audit-rules-doc.mjs --check             只比对不写：一致 → 0，不一致 → 1
 *   node scripts/audit-rules-doc.mjs                     把渲染结果打到 stdout
 *   ... --file <path>                                    换一个目标文件（测试用），缺省是仓库根的 AGENTS.md
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const START = '<!-- audit-rules:start -->';
const END = '<!-- audit-rules:end -->';

/** 维度出现顺序与小标题：安全最要紧排第一，合理性最轻排最后。 */
const DIMENSIONS = [
    ['security', '安全（security）'],
    ['ai-cost', 'AI 成本（ai-cost）'],
    ['efficiency', '效率（efficiency）'],
    ['design', '合理性（design）'],
];
const SEVERITY_LABEL = { severe: '严重', normal: '一般' };
/** 规则文案里的占位在文档里换成的泛称（只渲染 zh-CN）。新增占位要在这里补，测试会拦下漏补的。 */
const DOC_PLACEHOLDERS = { host: '某个外部主机', scope: '某个权限' };
/**
 * 标题整句改写：EFF-004 的「有一个 {kb} KB 的 JS 包，超过 800 KB」去掉具体值后只剩一句别扭的话，
 * 按 id 整句换掉比对着原文做字符串替换清楚 —— 原文改了措辞也不会悄悄替换失败。
 */
const DOC_TITLE = { 'EFF-004': '单个 JS 包超过 800 KB' };
// 占位两侧的空格是给英文主机名、权限名留的；换成中文泛称后一并去掉，免得读成「请求了 某个外部主机，」
const docText = t => t.replace(/ ?\{(\w+)\} ?/g, (m, k) => DOC_PLACEHOLDERS[k] ?? m);
const INTRO = '下面这些由 `npm run audit` 在验收时逐条检查；写之前照着做，大多数就不会出现在自检卡上。';

/**
 * 渲染标记之间的正文。同一维度内严重在前、同严重度按 id 升序，
 * 读的人先看到最不能犯的；排序稳定，json 里条目顺序变了也不会让 --check 误报。
 * `{host}` 这类占位换成泛称：文档里没有具体值，编一个反而误导，原样留着读起来又像模板没填。
 */
export function renderRulesDoc(rules, lang) {
    const lines = [INTRO];
    for (const [dim, heading] of DIMENSIONS) {
        const entries = Object.entries(rules)
            .filter(([, r]) => r.dimension === dim)
            .sort(([a, ra], [b, rb]) =>
                (ra.severity === 'severe' ? 0 : 1) - (rb.severity === 'severe' ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0));
        if (!entries.length) continue;
        lines.push('', `### ${heading}`, '');
        for (const [id, r] of entries) {
            const title = DOC_TITLE[id] ?? docText(r.title[lang]);
            lines.push(`- **${id}**（${SEVERITY_LABEL[r.severity]}）：${title} —— ${docText(r.fix[lang])}`);
        }
    }
    return lines.join('\n');
}

/** 找到标记对的位置；缺任一个或顺序颠倒就抛错 —— 宁可失败也不在错误的位置写。 */
function locate(md) {
    const s = md.indexOf(START);
    const e = md.indexOf(END);
    if (s < 0 || e < 0 || e < s) throw new Error(`找不到成对的 ${START} / ${END} 标记`);
    return [s + START.length, e];
}

/** 只替换标记之间的内容；正文前后各留一个换行，让标记独占一行。 */
export function replaceSection(md, body) {
    const [from, to] = locate(md);
    return `${md.slice(0, from)}\n${body}\n${md.slice(to)}`;
}

function currentSection(md) {
    const [from, to] = locate(md);
    return md.slice(from, to).replace(/^\n/, '').replace(/\n$/, '');
}

function main(args) {
    const fileIdx = args.indexOf('--file');
    const file = fileIdx >= 0 ? args[fileIdx + 1] : join(dirname(dirname(fileURLToPath(import.meta.url))), 'AGENTS.md');
    const body = renderRulesDoc(require('./audit-rules.json'), 'zh-CN');

    if (args.includes('--write')) {
        writeFileSync(file, replaceSection(readFileSync(file, 'utf8'), body));
        console.log(`[ok] 已更新 ${file} 的自检规则一节`);
        return 0;
    }
    if (args.includes('--check')) {
        // 换行统一成 \n 再去首尾空白：Windows 上检出的 CRLF、编辑器多留的空行不算内容不一致
        const norm = t => t.replace(/\r\n/g, '\n').trim().split('\n');
        const now = norm(currentSection(readFileSync(file, 'utf8')));
        const want = norm(body);
        const i = want.findIndex((l, k) => l !== now[k]);
        if (i < 0 && now.length === want.length) return 0;
        const at = i < 0 ? want.length : i;
        // 只给一行线索：第几行不一致、期望什么，足够定位；修法永远是重新生成
        process.stderr.write(`[x] ${file} 的自检规则一节与 audit-rules.json 不一致（生成段第 ${at + 1} 行，应为：${want[at] ?? '<结束>'}）；跑 npm run audit:doc 重新生成\n`);
        return 1;
    }
    process.stdout.write(body + '\n');
    return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`[x] audit-rules-doc: ${err?.message ?? err}\n`);
        process.exitCode = 1;
    }
}
