import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeOf, localize, localizeAll } from './ptx-audit.mjs';

// 与 manifest.mjs 读 rules.json 同一种方式：不依赖 import attributes，老一点的 Node 也能跑
const rules = createRequire(import.meta.url)('./audit-rules.json');

test('exitCodeOf：severe→2，只有 normal→1，空→0', () => {
    assert.equal(exitCodeOf([]), 0);
    assert.equal(exitCodeOf([{ severity: 'normal' }]), 1);
    assert.equal(exitCodeOf([{ severity: 'normal' }, { severity: 'severe' }]), 2);
});

test('audit-rules.json：23 条、三语齐全、维度与严重度合法', () => {
    const ids = Object.keys(rules);
    assert.equal(ids.length, 23);
    for (const [id, r] of Object.entries(rules)) {
        assert.ok(['security', 'ai-cost', 'efficiency', 'design'].includes(r.dimension), id);
        assert.ok(['severe', 'normal'].includes(r.severity), id);
        for (const k of ['title', 'detail', 'fix']) for (const l of ['zh-CN', 'en-US', 'ja-JP']) assert.ok(r[k]?.[l], `${id}.${k}.${l}`);
    }
});

test('localize：id = rule:file:line，占位符按 args 替换；localizeAll 三语全带', () => {
    const raw = { rule: 'SEC-002', file: 'backend/src/index.ts', line: 12, args: { host: 'api.example.com' } };
    const f = localize(raw, rules, 'zh-CN');
    assert.equal(f.id, 'SEC-002:backend/src/index.ts:12');
    assert.equal(f.severity, 'severe');
    assert.ok(f.title.includes('api.example.com'));
    const all = localizeAll(raw, rules);
    assert.ok(all.title['ja-JP'].includes('api.example.com'));
    assert.equal(localize({ ...raw, severity: 'normal' }, rules, 'en-US').severity, 'normal');
});

// ─── 端到端：真起 CLI 进程，看退出码和 --json 输出（Builder 就是这么调的） ───
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ptx-audit.mjs');

/** 最小「坏项目」：定时任务里循环调 AI 且没设 max_tokens、前端写死 sk- 密钥。 */
function badProject() {
    const root = mkdtempSync(join(tmpdir(), 'ptx-audit-e2e-'));
    const files = {
        'manifest.json': JSON.stringify({
            schemaVersion: 2,
            scopes: ['jobs:run', 'ai:chat'],
            backend: { egress: [], jobs: [{ type: 'daily', route: '/jobs/daily', name: { 'zh-CN': '日报' } }] }
        }),
        'backend/src/index.ts': [
            "import { createApp } from '@ptengine/app-backend';",
            'const rows = [1, 2, 3];',
            'export default createApp({',
            '    routes: {',
            "        'POST /jobs/daily': async ctx => {",
            "            for (const r of rows) await ctx.pt.ai.chat({ model: 'claude-haiku-5-5', messages: [] });",
            '        },',
            "        'GET /api/ping': async () => ({ ok: true })",
            '    }',
            '});',
            ''
        ].join('\n'),
        'web/src/App.tsx': [
            "const KEY = 'sk-abcdefghijklmnopqrstuvwx';",
            "export default function App() { fetch('/api/ping', { headers: { authorization: KEY } }); return null; }",
            ''
        ].join('\n')
    };
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    return root;
}

function audit(root, ...extra) {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json', ...extra], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, out: r.stdout ? JSON.parse(r.stdout) : null };
}

test('端到端：坏项目退出 2，AI-001/002/003 与 SEC-001 都在且三语齐全；--src web/src 只剩 SEC-001', () => {
    const root = badProject();
    try {
        const all = audit(root);
        assert.equal(all.status, 2, all.stderr);
        const ids = new Set(all.out.findings.map(f => f.rule));
        for (const id of ['AI-001', 'AI-002', 'AI-003', 'SEC-001']) assert.ok(ids.has(id), `${id} 应命中，实际：${[...ids]}`);
        for (const f of all.out.findings) {
            for (const k of ['title', 'detail', 'fix']) {
                for (const l of ['zh-CN', 'en-US', 'ja-JP']) assert.ok(f[k][l], `${f.id} ${k}.${l}`);
            }
        }

        const web = audit(root, '--src', 'web/src');
        assert.equal(web.status, 2, web.stderr);
        assert.deepEqual(web.out.findings.map(f => f.rule), ['SEC-001']);
        assert.deepEqual(web.out.scanned, ['web/src']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('端到端：--src 给了不存在的目录 → 退出 3，原因写在 stderr，stdout 不出 JSON', () => {
    const root = badProject();
    try {
        const r = audit(root, '--src', 'web/scr');
        assert.equal(r.status, 3);
        assert.match(r.stderr, /扫描目录不存在：web\/scr/);
        assert.equal(r.out, null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
