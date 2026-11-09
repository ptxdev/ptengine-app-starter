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
const INTRO = '下面这些由 `npm run audit` 在验收时逐条检查；写之前照着做，大多数就不会出现在自检卡上。';

/**
 * 渲染标记之间的正文。同一维度内严重在前、同严重度按 id 升序，
 * 读的人先看到最不能犯的；排序稳定，json 里条目顺序变了也不会让 --check 误报。
 * `{host}` 这类占位原样保留：文档里没有具体值，编一个反而误导。
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
            lines.push(`- **${id}**（${SEVERITY_LABEL[r.severity]}）：${r.title[lang]} —— ${r.fix[lang]}`);
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
        const now = currentSection(readFileSync(file, 'utf8')).split('\n');
        const want = body.split('\n');
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
