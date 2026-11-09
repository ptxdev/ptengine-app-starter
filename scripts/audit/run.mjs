/**
 * runAudit —— ptx audit 的扫描入口：组装 AuditContext，逐条跑规则，去重后返回。
 *
 * 规则在 rules-*.mjs 里按维度分组，每个模块导出 `rules: { id, check(ctx) }[]`；
 * 新增一个维度只需在 RULE_MODULES 里加一行 import。
 *
 * @typedef {{ rule: string, file: string, line: number, args?: Record<string, string>, severity?: 'severe' | 'normal' }} RawFinding
 * @typedef {{ rel: string, area: 'web'|'backend'|'shared'|'other', sf: import('typescript').SourceFile, text: string }} ParsedFile
 * @typedef {{ root: string, ts: typeof import('typescript'), files: ParsedFile[], manifest: object | null,
 *             backend: { enabled: boolean }, distChunks: { file: string, bytes: number }[] }} AuditContext
 *   distChunks[].file 是相对 root 的 POSIX 路径（如 `web/dist/assets/index-abc.js`），可直接当 RawFinding.file。
 * @typedef {{ id: string, check(ctx: AuditContext): RawFinding[] }} Rule
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, resolveBackend } from '../manifest.mjs';
import { collectFiles, loadTs, parseFile } from './scan.mjs';
import { rules as rulesSec } from './rules-sec.mjs';

/** @type {Rule[][]} 各维度的规则表；后续任务每加一个维度在这里加一项。 */
const RULE_MODULES = [rulesSec];

/** manifest.json 缺失或不是合法 JSON → null；依赖 manifest 的规则自己判空跳过，其余照跑。 */
function loadManifest(root) {
    try {
        return readManifest(root);
    } catch {
        return null;
    }
}

/** 没 build 过就没有 web/dist —— 返回空，包体积规则自然不报。 */
function readDistChunks(root) {
    const dir = join(root, 'web', 'dist', 'assets');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter(name => name.endsWith('.js'))
        .map(name => ({ file: `web/dist/assets/${name}`, bytes: statSync(join(dir, name)).size }));
}

/**
 * 跑规则并按 rule + file + line 去重（一行里两处 eval 只报一条）。
 * 单条规则抛错只记一行 stderr 并跳过：一条规则的 bug 不该让整个自检失败。
 * @param {AuditContext} ctx
 * @param {Rule[]} rules
 * @returns {RawFinding[]}
 */
export function runRules(ctx, rules) {
    const seen = new Set();
    const findings = [];
    for (const rule of rules) {
        let out;
        try {
            out = rule.check(ctx);
        } catch (err) {
            process.stderr.write(`[audit] 规则 ${rule.id} 出错：${err?.message ?? err}\n`);
            continue;
        }
        for (const f of out ?? []) {
            const key = `${f.rule}\0${f.file}\0${f.line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push(f);
        }
    }
    return findings;
}

/**
 * @param {{ root: string, src?: string[] }} opts
 * @returns {Promise<{ findings: RawFinding[], scanned: string[], unscanned: string[], unparsed: string[] }>}
 */
export async function runAudit({ root, src }) {
    const ts = loadTs(root);
    const { files: found, unscanned, scanned } = collectFiles(root, src);
    const files = [];
    const unparsed = [];
    for (const f of found) {
        const parsed = parseFile(ts, f);
        if (parsed) files.push({ rel: f.rel, area: f.area, sf: parsed.sf, text: parsed.text });
        else unparsed.push(f.rel);
    }
    const manifest = loadManifest(root);
    /** @type {AuditContext} */
    const ctx = {
        root,
        ts,
        files,
        manifest,
        backend: { enabled: resolveBackend(manifest, root).enabled },
        distChunks: readDistChunks(root)
    };
    const findings = runRules(ctx, RULE_MODULES.flat());
    return { findings, scanned, unscanned, unparsed };
}
