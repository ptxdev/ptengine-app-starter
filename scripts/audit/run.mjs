/**
 * runAudit —— ptx audit 的扫描入口。
 *
 * 现在只是骨架：返回空结果，让 CLI 外壳、文案表和退出码可以先独立落地并测试。
 * 文件收集、语法树解析和各条规则在后续任务里接进来。
 *
 * @param {{ root: string, src?: string[] }} opts
 * @returns {Promise<{ findings: RawFinding[], scanned: string[], unscanned: string[], unparsed: string[] }>}
 *
 * @typedef {{ rule: string, file: string, line: number, args?: Record<string, string>, severity?: 'severe' | 'normal' }} RawFinding
 */
export async function runAudit({ root, src }) {
    return { findings: [], scanned: [], unscanned: [], unparsed: [] };
}
