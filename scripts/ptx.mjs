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
 *   ptx job run    以定时任务身份在本地调一次任务路由（需先 ptx dev）
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
    job: './ptx-job.mjs',
    doctor: './ptx-doctor.mjs'
};

function usage() {
    console.log(`
ptx <command>

  dev        本地开发（vite + wrangler dev + 本地令牌签发）
  build      类型检查 + 构建前端与后端
  package    组装 zip（含结构自检）
  deploy     上传到 Ptengine
               需要环境变量 PTENGINE_TOKEN、PTENGINE_APP_ID
               可选 PTENGINE_API_BASE（默认线上）
               --publish  上传后立即发布
               --stream   仅与 --publish 同用，流式打印九步进度
               --dry-run  只打印将要做什么，不实际发请求
  job run <type> [--params '<json>'] [--preview]
             以定时任务身份调一次本地任务路由（先在另一个终端跑 npm run dev），
             打印状态码、响应体，以及平台会把返回结果判成 stored / none / invalid / too_large
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
