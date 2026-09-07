/**
 * 极小的 JSONC 解析（wrangler.jsonc 带注释，JSON.parse 直接吃不下）。
 *
 * 逐字符扫描而不是正则替换 —— 正则会把字符串里的 `//`（比如 "https://..."）
 * 当成注释砍掉，那是个静默的错误配置。
 */
export function parseJsonc(text) {
    let out = '';
    let i = 0;
    let inString = false;
    let escaped = false;

    while (i < text.length) {
        const c = text[i];

        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            i++;
            continue;
        }

        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }

        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }

        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        out += c;
        i++;
    }

    // 去掉尾逗号（JSONC 允许，JSON 不允许）。此时字符串已被保留但注释已移除，
    // 仍要避开字符串内容，所以再扫一遍。
    let cleaned = '';
    inString = false;
    escaped = false;
    for (let j = 0; j < out.length; j++) {
        const c = out[j];
        if (inString) {
            cleaned += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; cleaned += c; continue; }
        if (c === ',') {
            const rest = out.slice(j + 1).match(/^\s*([}\]])/);
            if (rest) continue;
        }
        cleaned += c;
    }

    return JSON.parse(cleaned);
}
