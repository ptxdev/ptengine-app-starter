/**
 * 把构建产物打成可直接上传到 Ptengine X 的 zip。
 *
 * 平台对包结构的要求很严：manifest.json 与入口 HTML 必须在 **zip 根级**。
 * 如果在 Finder / 资源管理器里对 dist 文件夹右键压缩，zip 里会多一层 `dist/`，
 * 平台会因为找不到根级 manifest.json 而拒收（报 MANIFEST_MISSING）。
 * 本脚本用 `zip -j`（junk paths，不保留目录前缀）避免这个坑，并在打包前做几项自检。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const manifestPath = join(root, 'manifest.json');

const fail = msg => {
    console.error(`\n✗ ${msg}\n`);
    process.exit(1);
};

if (!existsSync(dist)) fail('缺少 dist/，请先执行 npm run build');
if (!existsSync(manifestPath)) fail('缺少 manifest.json（应放在项目根目录）');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = manifest.entry;
if (!entry) fail('manifest.json 缺少 entry 字段');
if (!existsSync(join(dist, entry))) {
    fail(`manifest.entry 指向 "${entry}"，但 dist/ 下没有这个文件。检查 entry 是否与构建产物一致。`);
}

// 把 manifest 复制进 dist，使其与入口 HTML 同级 —— 打出的 zip 根级即两者并列。
copyFileSync(manifestPath, join(dist, 'manifest.json'));

const name = `${manifest.id || 'ptengine-app'}-${manifest.version}.zip`;
const outFile = join(root, name);
rmSync(outFile, { force: true });

// -r 递归（保留 assets/ 等子目录），但从 dist 内部执行，使 zip 内路径不含 dist 前缀。
execFileSync('zip', ['-q', '-r', outFile, '.', '-x', '.DS_Store', '-x', '__MACOSX/*'], { cwd: dist });

const listed = execFileSync('unzip', ['-l', outFile], { encoding: 'utf8' });
const hasRootManifest = /\smanifest\.json$/m.test(listed);
const hasRootEntry = new RegExp(`\\s${entry.replace('.', '\\.')}$`, 'm').test(listed);
if (!hasRootManifest || !hasRootEntry) {
    fail(`zip 根级缺少 manifest.json 或 ${entry}，包结构不符合平台要求：\n${listed}`);
}

console.log(`\n✓ 打包完成：${name}`);
console.log(readdirSync(dist).map(f => `    ${f}`).join('\n'));
console.log('\n到 Ptengine X →「自定义应用管理」→ 选择该 zip 上传即可。\n');
