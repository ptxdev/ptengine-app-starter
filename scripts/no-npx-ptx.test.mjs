import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ptx 只是本项目 package.json 里的一个 script，没有 bin：`npx` 加 `ptx` 在本地找不到命令时会去 npm 下载并执行
 * 同名的无关公共包（e2e 时实际触发过一次，供应链风险）。所有文档、提示、模板与 CI 一律写 `npm run ptx -- <command>`。
 * 这条用例扫全仓（不含依赖与本地产物），禁止那种写法再出现（ST-09）。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.ptx', '.ptengine', 'dist', '.out', '.wrangler']);
const TEXT_EXT = /\.(?:md|mjs|cjs|js|jsx|ts|tsx|json|jsonc|ya?ml|html|css|sh|txt|toml)$|^(?:\.gitignore|\.gitlab-ci\.yml|Dockerfile)$/;
// 拼出来，避免本文件自己命中
const FORBIDDEN = new RegExp(`\\b${'np'}x\\s+(?:--\\S+\\s+)*ptx\\b`);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (TEXT_EXT.test(name)) out.push(p);
    }
    return out;
}

test('仓内不出现「npx + ptx」的写法（ptx 不是 bin，npx 会下载同名无关公共包）；统一 npm run ptx -- <command>', () => {
    const hits = [];
    for (const file of walk(root)) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (FORBIDDEN.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    assert.deepEqual(hits, []);
});

test('禁用正则本身能命中各种写法', () => {
    for (const s of ['np' + 'x ptx doctor', 'run: np' + 'x ptx build', '`np' + 'x  ptx`', 'np' + 'x --yes ptx deploy']) assert.ok(FORBIDDEN.test(s), s);
    for (const s of ['npm run ptx -- doctor', 'np' + 'x ptxy', 'np' + 'x wrangler']) assert.ok(!FORBIDDEN.test(s), s);
});
