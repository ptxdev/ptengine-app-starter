/**
 * ptx audit —— 自检：对项目源码做确定性的静态检查。
 *
 * 和 doctor 的分工：doctor 查「配置对不对」，每次改完都跑；audit 查「代码写得对不对」
 * （安全 / AI 成本 / 效率 / 合理性四维），只在验收时跑，规则多了会慢，所以不并进 doctor。
 *
 * 检测逻辑在 scripts/audit/，这里只做 CLI 外壳：解析参数、把规则产出的 RawFinding
 * 按 audit-rules.json 补上文案、打印、给退出码。
 *
 *   npm run audit                          按 PTX_LANG（缺省 en-US）打印
 *   npm run audit -- --json                stdout 只输出一个 JSON，三语文案全带
 *   npm run audit -- --src web/src         只扫给定目录（可重复）
 *   node scripts/ptx-audit.mjs --root <项目目录> --json
 *                                          Builder 用沙箱镜像里的这一份扫项目，不经 ptx.mjs
 *
 * 退出码：有 severe → 2；只有 normal → 1；没有 → 0；跑不起来 → 3（原因写到 stderr）。
 */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from './audit/run.mjs';

const require = createRequire(import.meta.url);
/** 规则文案表：每条的维度、缺省严重度和三语 title / detail / fix。同 manifest.mjs 读 rules.json 的方式，不用 import attributes。 */
export const AUDIT_RULES = require('./audit-rules.json');

export const LANGS = ['zh-CN', 'en-US', 'ja-JP'];
const DEFAULT_LANG = 'en-US';
const TEXT_KEYS = ['title', 'detail', 'fix'];

/** 有 severe → 2；只有 normal → 1；没有 → 0。Builder 与 CI 只看退出码就能分档。 */
export function exitCodeOf(findings) {
    if (findings.some(f => f.severity === 'severe')) return 2;
    return findings.length > 0 ? 1 : 0;
}

/** `{host}` 这类占位按 args 替换；args 里没有的占位原样保留，宁可露出占位也不吞掉信息。 */
function fill(template, args = {}) {
    return template.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(args, k) ? String(args[k]) : m));
}

function base(raw, rules) {
    const rule = rules[raw.rule];
    // 规则 id 写错是实现 bug，不该静默产出一条没文案的 finding
    if (!rule) throw new Error(`audit-rules.json 里没有规则 ${raw.rule}`);
    return {
        rule,
        finding: {
            id: `${raw.rule}:${raw.file}:${raw.line}`,
            source: 'rule',
            rule: raw.rule,
            dimension: rule.dimension,
            // 规则可以按命中情况降级（如 SEC-002 目标主机是变量时只报 normal），优先用它
            severity: raw.severity ?? rule.severity,
            file: raw.file,
            line: raw.line
        }
    };
}

/** 单语 finding：title / detail / fix 是字符串。 */
export function localize(raw, rules, lang) {
    const { rule, finding } = base(raw, rules);
    for (const k of TEXT_KEYS) finding[k] = fill(rule[k][lang] ?? rule[k][DEFAULT_LANG], raw.args);
    return finding;
}

/** 三语 finding：title / detail / fix 是 `{ 'zh-CN', 'en-US', 'ja-JP' }`，给 --json（Builder 前端按界面语言取）。 */
export function localizeAll(raw, rules) {
    const { rule, finding } = base(raw, rules);
    for (const k of TEXT_KEYS) finding[k] = Object.fromEntries(LANGS.map(l => [l, fill(rule[k][l], raw.args)]));
    return finding;
}

function parseArgs(args, defaultRoot) {
    const opts = { root: defaultRoot, src: [], json: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--json') opts.json = true;
        else if (a === '--root' || a === '--src') {
            const v = args[++i];
            if (!v || v.startsWith('--')) throw new Error(`${a} 需要一个目录参数`);
            if (a === '--root') opts.root = resolve(v);
            else opts.src.push(v);
        } else throw new Error(`未知参数：${a}`);
    }
    return opts;
}

const SUMMARY = {
    'zh-CN': (s, n) => `${s} 项严重，${n} 项一般`,
    'en-US': (s, n) => `${s} severe, ${n} normal`,
    'ja-JP': (s, n) => `重大 ${s} 件、通常 ${n} 件`
};

function printText(findings, result) {
    const icon = { severe: '[x] ', normal: '[!] ' };
    for (const f of findings) {
        console.log(`  ${icon[f.severity]} ${f.rule} ${f.title}`);
        console.log(`         ${f.file}:${f.line}`);
        console.log(`         ${f.fix}`);
    }
    const severe = findings.filter(f => f.severity === 'severe').length;
    const lang = currentLang();
    console.log(`\n  ${findings.length ? SUMMARY[lang](severe, findings.length - severe) : '[ok]'}`);
    console.log(`  scanned: ${result.scanned.join(', ') || '-'}`);
    console.log(`  unscanned: ${result.unscanned.join(', ') || '-'}`);
    if (result.unparsed.length) console.log(`  unparsed: ${result.unparsed.join(', ')}`);
    console.log('');
}

function currentLang() {
    const l = process.env.PTX_LANG;
    return LANGS.includes(l) ? l : DEFAULT_LANG;
}

export async function run(args, root) {
    let opts, result, findings;
    try {
        opts = parseArgs(args, root);
        if (!existsSync(opts.root)) throw new Error(`--root 目录不存在：${opts.root}`);
        result = await runAudit({ root: opts.root, src: opts.src.length ? opts.src : undefined });
        findings = opts.json
            ? result.findings.map(r => localizeAll(r, AUDIT_RULES))
            : result.findings.map(r => localize(r, AUDIT_RULES, currentLang()));
    } catch (err) {
        // 跑不起来要和「有问题」区分开（3 vs 1/2）；抛给 ptx.mjs 会被变成 1，所以在这里自己退出
        process.stderr.write(`[x] ptx audit: ${err?.message ?? err}\n`);
        process.exit(3);
    }

    if (opts.json) {
        process.stdout.write(JSON.stringify({ findings, scanned: result.scanned, unscanned: result.unscanned, unparsed: result.unparsed }) + '\n');
    } else {
        printText(findings, result);
    }
    // 用 exitCode 而不是 process.exit：stdout 接管道时，立即退出可能截断 JSON
    process.exitCode = exitCodeOf(findings);
}

// Builder 直接 `node /opt/app-starter/scripts/ptx-audit.mjs --root <dir>` 调这一份，不经 ptx.mjs；缺省 root 是当前目录。
// 比 realpath：import.meta.url 是解析过符号链接的真实路径，argv[1] 不是（macOS 的 /var → /private/var、镜像里的软链都会让直比失败）
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await run(process.argv.slice(2), process.cwd());
}
