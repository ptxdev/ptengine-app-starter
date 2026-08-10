#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出指定版本那一节，打到 stdout。
 * 供 .github/workflows/release.yml 生成 Release 说明，也可本地预览：
 *
 *   node scripts/changelog-section.mjs 1.0.0
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] || '').replace(/^v/, '');
if (!version) {
    console.error('用法: node scripts/changelog-section.mjs <version>');
    process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');

// 版本标题形如 `## [1.0.0] - 2026-08-10`，也容忍不带方括号 / 不带日期的写法。
const isHeading = line => /^## /.test(line);
const isTarget = line =>
    isHeading(line) && new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(line);

const start = lines.findIndex(isTarget);
if (start === -1) {
    console.error(`CHANGELOG.md 里找不到版本 ${version} 的章节 —— 发版前请先补上。`);
    process.exit(1);
}

const rest = lines.slice(start + 1);
const nextHeading = rest.findIndex(isHeading);
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading))
    // 去掉章节末尾的链接定义行（`[1.0.0]: https://...`）与空行
    .filter(line => !/^\[[^\]]+\]:\s*http/.test(line))
    .join('\n')
    .trim();

if (!body) {
    console.error(`版本 ${version} 的章节是空的 —— Release 说明不能为空。`);
    process.exit(1);
}

console.log(body);
