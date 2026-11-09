import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesDoc, replaceSection } from './audit-rules-doc.mjs';

const rules = createRequire(import.meta.url)('./audit-rules.json');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'audit-rules-doc.mjs');

const HEADINGS = ['### 安全（security）', '### AI 成本（ai-cost）', '### 效率（efficiency）', '### 合理性（design）'];

test('renderRulesDoc：四个维度标题按序、每条规则一行、格式与文案取自 json', () => {
    const body = renderRulesDoc(rules, 'zh-CN');
    const pos = HEADINGS.map(h => body.indexOf(h));
    assert.ok(pos.every(p => p >= 0), '四个标题都在');
    assert.deepEqual([...pos].sort((a, b) => a - b), pos, '标题顺序');

    const items = body.split('\n').filter(l => l.startsWith('- **'));
    assert.equal(items.length, Object.keys(rules).length);
    const r = rules['SEC-002'];
    assert.ok(items.includes(`- **SEC-002**（严重）：${r.title['zh-CN']} —— ${r.fix['zh-CN']}`), '严重行格式，占位原样保留');
    const n = rules['DES-003'];
    assert.ok(items.includes(`- **DES-003**（一般）：${n.title['zh-CN']} —— ${n.fix['zh-CN']}`), '一般行格式');
    assert.ok(body.includes('`npm run audit`'), '含节首说明');
});

test('renderRulesDoc：同一维度内严重在前，同严重度按 id 升序', () => {
    const fake = {
        'X-003': { dimension: 'security', severity: 'normal', title: { 'zh-CN': 't3' }, fix: { 'zh-CN': 'f3' } },
        'X-002': { dimension: 'security', severity: 'severe', title: { 'zh-CN': 't2' }, fix: { 'zh-CN': 'f2' } },
        'X-001': { dimension: 'security', severity: 'normal', title: { 'zh-CN': 't1' }, fix: { 'zh-CN': 'f1' } },
        'Y-001': { dimension: 'design', severity: 'severe', title: { 'zh-CN': 'y' }, fix: { 'zh-CN': 'y' } },
    };
    const ids = renderRulesDoc(fake, 'zh-CN').split('\n')
        .filter(l => l.startsWith('- **')).map(l => l.match(/\*\*(.+?)\*\*/)[1]);
    assert.deepEqual(ids, ['X-002', 'X-001', 'X-003', 'Y-001']);
});

test('replaceSection：只替换标记之间，标记本身与外面原样保留', () => {
    const md = 'head\n<!-- audit-rules:start -->\nold\n<!-- audit-rules:end -->\ntail\n';
    assert.equal(replaceSection(md, 'NEW'), 'head\n<!-- audit-rules:start -->\nNEW\n<!-- audit-rules:end -->\ntail\n');
});

test('replaceSection：缺标记或顺序颠倒就抛错', () => {
    assert.throws(() => replaceSection('no markers', 'x'), /audit-rules/);
    assert.throws(() => replaceSection('<!-- audit-rules:end -->\n<!-- audit-rules:start -->', 'x'), /audit-rules/);
});

test('--check：仓库里的 AGENTS.md 与 audit-rules.json 一致（改了 json 记得 npm run audit:doc）', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

test('--check：生成段被改过就退出 1 且不写文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-doc-'));
    try {
        const file = join(dir, 'AGENTS.md');
        const tampered = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').replace('（严重）', '（一般）');
        writeFileSync(file, tampered);
        const r = spawnSync(process.execPath, [SCRIPT, '--check', '--file', file], { encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /audit:doc/);
        assert.equal(readFileSync(file, 'utf8'), tampered);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
