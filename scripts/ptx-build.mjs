/**
 * ptx build —— 类型检查 + 构建前端 + 打包后端。
 *
 * 后端刻意用 `wrangler deploy --dry-run --outdir` 而不是自己跑 esbuild：
 * 产出的 bundle 与 wrangler 真部署时**逐字一致**，不会出现"自己打的能跑、
 * wrangler 打的不能跑"这类只在线上暴露的差异。
 *
 * `--dry-run` 不需要 Cloudflare 凭据 —— 它只编译，不联网、不部署。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from './manifest.mjs';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function step(label, fn) {
    console.log(`  -> ${label}`);
    fn();
}

export async function run(_args, root) {
    console.log('');
    const manifest = readManifest(root);
    const hasBackend = Boolean(manifest.backend);

    step('类型检查（web + backend + shared）', () => {
        execFileSync(npx, ['tsc', '-b'], { cwd: root, stdio: 'inherit' });
    });

    step('构建前端', () => {
        execFileSync(npx, ['vite', 'build'], { cwd: join(root, 'web'), stdio: 'inherit' });
    });

    if (!hasBackend) {
        console.log('  -> 跳过后端（manifest.json 里没有 backend 段）');
        console.log('\n[ok] 构建完成。接下来跑 `npm run package`。\n');
        return;
    }

    step('打包后端（wrangler bundle）', () => {
        const outDir = join(root, 'backend', '.out');
        rmSync(outDir, { recursive: true, force: true });
        execFileSync(
            npx,
            ['wrangler', 'deploy', '--dry-run', '--outdir', '.out'],
            { cwd: join(root, 'backend'), stdio: 'inherit' }
        );
    });

    // wrangler 的产物入口名与 wrangler.jsonc 的 main 同名（src/index.ts -> index.js）。
    const bundle = join(root, 'backend', '.out', 'index.js');
    if (!existsSync(bundle)) {
        throw new Error(
            '后端 bundle 没生成（期望 backend/.out/index.js）。' +
            '检查 backend/wrangler.jsonc 的 main 是否指向 src/index.ts。'
        );
    }

    console.log('\n[ok] 构建完成。接下来跑 `npm run package`。\n');
}
