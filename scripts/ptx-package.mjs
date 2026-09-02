/**
 * ptx package —— 组装可直接上传到 Ptengine X 的 zip，并做结构自检。
 *
 * 平台对包结构的要求很严：`manifest.json` 与入口 HTML 必须在 **zip 根级**。
 * 在 Finder / 资源管理器里右键压缩 dist 会多一层 `dist/`，平台找不到根级
 * manifest 就拒收（MANIFEST_MISSING）。这里通过 staging 目录 + 从内部执行 zip 避免。
 *
 * 包结构：
 *
 *   my-app-1.0.0.zip
 *   ├── manifest.json          ← 根级
 *   ├── index.html             ← 根级
 *   ├── assets/…               ← 前端产物
 *   └── _backend/              ← 后端（平台推到 WfP 时会把它从前端产物里排除）
 *       ├── worker.js
 *       └── migrations/*.sql
 */
import { execFileSync } from 'node:child_process';
import {
    cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
    readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readManifest, validateManifest, reportValidation } from './manifest.mjs';

/** 看起来像密钥的字面量。命中只警告不阻断 —— 误报的代价比漏报的沉默更小。 */
const SECRET_PATTERNS = [
    [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI 风格的 API Key'],
    [/\bshpat_[A-Za-z0-9]{20,}/, 'Shopify Admin API Token'],
    [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub Personal Access Token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key ID'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM 私钥']
];

/** 绝不该进包的文件名。 */
const FORBIDDEN_FILES = ['.dev.vars', '.env', '.env.local', '.ptx-dev-key.json'];

function walk(dir, base = '') {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        if (statSync(full).isDirectory()) out.push(...walk(full, rel));
        else out.push({ rel, full });
    }
    return out;
}

export async function run(_args, root) {
    console.log('');

    const manifest = readManifest(root);
    reportValidation(validateManifest(manifest, root));

    const dist = join(root, 'web', 'dist');
    if (!existsSync(dist)) {
        throw new Error('缺少 web/dist/，请先执行 `npm run build`');
    }

    const hasBackend = Boolean(manifest.backend);
    const bundleSrc = join(root, 'backend', '.out', 'index.js');
    if (hasBackend && !existsSync(bundleSrc)) {
        throw new Error(
            '缺少 backend/.out/index.js。manifest 声明了 backend 段，' +
            '请先执行 `npm run build`（它会跑 wrangler 的 bundle）。'
        );
    }

    // ── 组装 staging ────────────────────────────────────────────────────
    const stage = mkdtempSync(join(tmpdir(), 'ptx-pkg-'));
    try {
        cpSync(dist, stage, { recursive: true });
        cpSync(join(root, 'manifest.json'), join(stage, 'manifest.json'));

        if (hasBackend) {
            const entryRel = manifest.backend.entry;
            const entryAbs = join(stage, entryRel);
            mkdirSync(dirname(entryAbs), { recursive: true });
            cpSync(bundleSrc, entryAbs);

            // wrangler 可能额外产出 wasm、额外 chunk 等同级文件，一并带上。
            //
            // 用**白名单**而不是黑名单：wrangler 还会在 outdir 里放 README.md 之类的
            // 说明文件，黑名单式过滤每次 wrangler 加点东西就会漏进包里。
            // sourcemap 刻意不带（体积 + 会把后端源码泄漏到公开可取的产物里）。
            const MODULE_EXT = ['.js', '.mjs', '.cjs', '.wasm', '.bin'];
            const outDir = join(root, 'backend', '.out');
            for (const name of readdirSync(outDir)) {
                if (name === 'index.js') continue;
                if (!MODULE_EXT.some(ext => name.endsWith(ext))) continue;
                cpSync(join(outDir, name), join(dirname(entryAbs), name), { recursive: true });
            }

            if (manifest.backend.migrations) {
                const src = join(root, 'backend', 'migrations');
                const dst = join(stage, manifest.backend.migrations);
                mkdirSync(dst, { recursive: true });
                cpSync(src, dst, { recursive: true });
            }
        }

        const files = walk(stage);

        // ── 结构自检 ────────────────────────────────────────────────────
        const errors = [];
        const warnings = [];
        const has = rel => files.some(f => f.rel === rel);

        if (!has('manifest.json')) errors.push('MANIFEST_MISSING  zip 根级缺少 manifest.json');
        if (!has(manifest.entry)) {
            errors.push(
                `ENTRY_NOT_FOUND  manifest.entry 指向 "${manifest.entry}"，但包内没有这个文件`
            );
        }
        if (manifest.icon && !has(manifest.icon)) {
            errors.push(
                `ICON_NOT_FOUND  manifest.icon 指向 "${manifest.icon}"，但包内没有这个文件。` +
                `把图标放到 web/public/${manifest.icon} 后重新 build`
            );
        }
        if (files.some(f => f.rel.startsWith('dist/'))) {
            errors.push('包内出现多余的 dist/ 层级 —— 不要手动压缩 dist 文件夹');
        }

        for (const f of files) {
            const base = f.rel.split('/').pop();
            if (FORBIDDEN_FILES.includes(base)) {
                errors.push(
                    `BACKEND_SECRET_LEAKED  包内出现 ${f.rel} —— 本地密钥文件绝不能进产物`
                );
            }
        }

        if (hasBackend) {
            const entryRel = manifest.backend.entry;
            if (!has(entryRel)) {
                errors.push(`BACKEND_ENTRY_NOT_FOUND  backend.entry 指向 "${entryRel}"，包内没有`);
            } else {
                const entryAbs = join(stage, entryRel);
                const code = readFileSync(entryAbs, 'utf8');

                // ES module 语法预检：拷成 .mjs 让 node --check 按 ESM 解析。
                // 只检查语法、**不执行**（执行租户代码不是打包器该做的事）。
                const probe = join(stage, '.__ptx_syntax_probe.mjs');
                writeFileSync(probe, code, 'utf8');
                try {
                    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
                } catch (e) {
                    errors.push(
                        `BACKEND_ENTRY_INVALID  后端 bundle 语法检查失败：\n      ` +
                        String(e.stderr ?? e.message).split('\n').slice(0, 4).join('\n      ')
                    );
                } finally {
                    rmSync(probe, { force: true });
                }

                if (!/export\s*\{|export\s+default/.test(code)) {
                    errors.push(
                        'BACKEND_ENTRY_INVALID  后端 bundle 里没有 export —— ' +
                        '它必须是 ES module 且默认导出 createApp(...) 的结果'
                    );
                }

                for (const [re, label] of SECRET_PATTERNS) {
                    if (re.test(code)) {
                        warnings.push(
                            `后端 bundle 里出现了疑似${label}的字面量。` +
                            `密钥应该写进 manifest.backend.secrets 由平台注入，不要硬编码。`
                        );
                    }
                }
            }
        }

        for (const w of warnings) console.log(`  [!] ${w}`);
        if (errors.length) {
            console.error('\n包结构自检不通过：\n');
            for (const e of errors) console.error(`  [x] ${e}`);
            console.error('');
            throw new Error(`包结构有 ${errors.length} 处问题，见上。`);
        }

        // ── 打 zip（从 staging 内部执行，使 zip 内路径不含前缀）───────────
        const name = `${manifest.id || 'ptengine-app'}-${manifest.version}.zip`;
        const outFile = join(root, name);
        rmSync(outFile, { force: true });
        execFileSync(
            'zip',
            ['-q', '-r', outFile, '.', '-x', '.DS_Store', '-x', '__MACOSX/*'],
            { cwd: stage }
        );

        const size = statSync(outFile).size;
        const listed = execFileSync('unzip', ['-l', outFile], { encoding: 'utf8' });
        if (!/\smanifest\.json$/m.test(listed)) {
            throw new Error(`打出的 zip 根级没有 manifest.json：\n${listed}`);
        }

        console.log(`
[ok] 打包完成：${name}   (${(size / 1024).toFixed(0)} KB)

     前端  ${files.filter(f => !f.rel.startsWith('_backend/') && f.rel !== 'manifest.json').length} 个文件
     后端  ${hasBackend ? manifest.backend.entry : '（无）'}
     迁移  ${hasBackend && manifest.backend.migrations
                ? files.filter(f => f.rel.startsWith(`${manifest.backend.migrations}/`)).length + ' 个'
                : '（无）'}

     上传：到 Ptengine X -> 「自定义应用管理」选这个 zip，
           或在 CI 里跑 \`npx ptx deploy --publish\`。
`);
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
