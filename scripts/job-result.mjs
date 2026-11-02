/**
 * 任务返回结果（JobRunResult）的本地校验 —— 定时任务接口约定 §10 / §13.4。
 *
 * 平台侧的真值是 contract 包的 `validateJobRunResult`（platform 计划 Task 4）；本仓是公开仓、装不了那个内部包，
 * 所以这里**逐条照它**写一遍：判定顺序（title → markdown → files）、`title.trim()` 为空判 invalid、
 * invalid 理由里点名字段路径、stored 时只回传 archive 里约定的字段 —— 全部一致，用例也逐条一致。
 * **全部上限从 scripts/rules.json 的 jobResult 段读**（sync-rules 生成），不写字面量。
 * 「字符」按 Unicode 码点计（`[...s].length`，brief §11.8）。
 */
import { RULES } from './manifest.mjs';

const enc = new TextEncoder();
/** 文件名禁用字符：路径分隔符与 C0 控制字符、DEL。 */
const FILE_NAME_FORBIDDEN = /[\/\\\u0000-\u001f\u007f]/;

/**
 * 取规则段。不用默认参数：`f(x, undefined)` 会落回默认值，「调用方显式传了个缺失的规则段」就被悄悄吞掉了。
 * 没传第二个参数才用 RULES.jobResult；传了就用传的，缺失（undefined / null）一律抛错。
 */
function requireRules(args) {
    const rules = args.length > 1 ? args[1] : RULES.jobResult;
    if (!rules) {
        throw new Error('scripts/rules.json 里没有 jobResult 段（规则快照过旧）。维护者请跑 npm run sync-rules。');
    }
    return rules;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePointLength = s => [...s].length;

export function isJsonContentType(ct) {
    if (!ct) return false;
    const mime = String(ct).split(';')[0].trim().toLowerCase();
    return mime === 'application/json' || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(mime);
}

/** @param {unknown} body  @param {object} [rules] 缺省为 RULES.jobResult */
export function validateJobRunResult(body, rules) {
    const r = requireRules(arguments);
    if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'archive')) return { status: 'none' };
    const invalid = reason => ({ status: 'invalid', reason });
    const a = body.archive;
    if (!isPlainObject(a)) return invalid('archive 必须是对象');

    if (a.title !== undefined && (typeof a.title !== 'string' || a.title.trim().length === 0 || codePointLength(a.title) > r.titleMax)) {
        return invalid(`archive.title 必须是 1..${r.titleMax} 个字符的字符串`);
    }
    if (typeof a.markdown !== 'string') return invalid('archive.markdown 必填，且必须是字符串');
    if (enc.encode(a.markdown).byteLength > r.markdownMaxBytes) return invalid(`archive.markdown 超过 ${r.markdownMaxBytes} 字节`);

    let files;
    if (a.files !== undefined) {
        if (!Array.isArray(a.files)) return invalid('archive.files 必须是数组');
        if (a.files.length > r.maxFiles) return invalid(`archive.files 最多 ${r.maxFiles} 个，收到 ${a.files.length} 个`);
        files = [];
        for (let i = 0; i < a.files.length; i++) {
            const at = `archive.files[${i}]`;
            const f = a.files[i];
            if (!isPlainObject(f)) return invalid(`${at} 必须是对象`);
            if (typeof f.name !== 'string' || f.name.length === 0 || codePointLength(f.name) > r.fileNameMax || FILE_NAME_FORBIDDEN.test(f.name)) {
                return invalid(`${at}.name 必须是 1..${r.fileNameMax} 个字符，且不含 / \\ 与控制字符`);
            }
            if (typeof f.contentType !== 'string' || !r.fileTypes.includes(f.contentType)) {
                return invalid(`${at}.contentType 只能是 ${r.fileTypes.join(' / ')}`);
            }
            if (typeof f.content !== 'string') return invalid(`${at}.content 必须是字符串（文本内容，不是 base64）`);
            files.push({ name: f.name, contentType: f.contentType, content: f.content });
        }
    }
    const archive = {
        ...(a.title !== undefined ? { title: a.title } : {}),
        markdown: a.markdown,
        ...(files ? { files } : {})
    };
    return { status: 'stored', result: { archive } };
}

/**
 * 一次任务响应会被平台判成什么。口径照 scheduler 的采集写（真值在 custom-app-platform 仓的
 * `workers/workers/scheduler/src/response.ts`，brief §11.7）：只有 2xx + JSON content-type
 * 才看结果，按 UTF-8 字节判超限，JSON 解析失败视为无结果。
 */
export function classifyJobResponse({ status, contentType, text }, rules) {
    const r = requireRules(arguments);
    if (status < 200 || status >= 300) return { status: 'none', note: '非 2xx 的响应平台不采集结果' };
    if (!isJsonContentType(contentType)) return { status: 'none', note: '响应不是 JSON，平台不采集结果' };
    if (enc.encode(text ?? '').byteLength > r.maxBytes) return { status: 'too_large' };
    if (!text) return { status: 'none' };
    let body;
    try { body = JSON.parse(text); } catch { return { status: 'none', note: '响应体不是合法 JSON' }; }
    return validateJobRunResult(body, r);
}
