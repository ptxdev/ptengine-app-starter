#!/usr/bin/env node
/**
 * ptx —— Ptengine Custom App 的开发与发布 CLI。
 *
 * 这一份内联在脚手架里（将来抽成 `@ptengine/app-cli`）。命令：
 *
 *   ptx dev        本地起前端 + 后端，并签发真 token（鉴权链路本地跑通）
 *   ptx build      类型检查 + 构建前端 + 打包后端（单文件 bundle）
 *   ptx package    组装可上传的 zip，并做结构自检
 *   ptx deploy     上传到平台（CI 用 PTENGINE_TOKEN）
 *   ptx doctor     体检：约定是否被改坏、manifest 是否自洽
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');

const [, , command, ...args] = process.argv;

const COMMANDS = {
    dev: './ptx-dev.mjs',
    build: './ptx-build.mjs',
    package: './ptx-package.mjs',
    deploy: './ptx-deploy.mjs',
    doctor: './ptx-doctor.mjs'
};

function usage() {
    console.log(`
ptx <command>

  dev        本地开发（vite + wrangler dev + 本地令牌签发）
  build      类型检查 + 构建前端与后端
  package    组装 zip（含结构自检）
  deploy     上传到 Ptengine X
               需要环境变量 PTENGINE_TOKEN、PTENGINE_APP_ID
               可选 PTENGINE_API_BASE（默认线上）
               --publish  上传后立即发布
               --dry-run  只打印将要做什么，不实际发请求
  doctor     体检（改完代码、尤其是 AI 改完之后跑一次）
`);
}

if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
}

const mod = COMMANDS[command];
if (!mod) {
    console.error(`\n[x] 未知命令：${command}`);
    usage();
    process.exit(1);
}

try {
    const { run } = await import(mod);
    await run(args, ROOT);
} catch (err) {
    console.error(`\n[x] ${err?.message ?? err}\n`);
    if (process.env.PTX_DEBUG) console.error(err);
    process.exit(1);
}
