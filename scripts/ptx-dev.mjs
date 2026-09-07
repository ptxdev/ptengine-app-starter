/**
 * ptx dev —— 本地把整条链路跑通（含鉴权）。
 *
 *   1. 生成一对临时 Ed25519 密钥 → 公钥进 backend/.dev.vars，私钥进 web/.ptx-dev-key.json
 *   2. 起 wrangler dev（backend/）:8787 —— 本地 D1/KV 由 miniflare 模拟
 *   3. 起 vite dev（web/）:5173 —— /api 代理到 8787，/__ptx/token 用私钥签 token
 *
 * 于是前端拿到的是**真 token**、后端做的是**真验签**：aud 不匹配、过期、
 * scope 不足这些线上才会遇到的问题，本地就会现形。
 *
 * 刻意不做的事：不在 dev 下让后端跳过验签。跳过的话鉴权代码第一次真正被执行
 * 就是在线上，那是最难查的一类问题。
 */
import { spawn } from 'node:child_process';
import { generateDevKeys } from './dev-keys.mjs';

/**
 * 端口可通过环境变量覆盖 —— 5173 被别的项目占着是很常见的情况，
 * 撞车时不该让人去改脚手架源码。
 *
 *   PTX_WEB_PORT=5273 PTX_API_PORT=8887 npm run dev
 *
 * API 端口同时通过 env 传给 vite（见 web/vite.config.ts 的 proxy target），
 * 保证前端代理指向的就是真正起起来的那个后端。
 */
const WEB_PORT = process.env.PTX_WEB_PORT || '5173';
const API_PORT = process.env.PTX_API_PORT || '8787';

const children = [];
let shuttingDown = false;

function start(name, command, cmdArgs, cwd) {
    const child = spawn(command, cmdArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, PTX_API_PORT: API_PORT, PTX_WEB_PORT: WEB_PORT }
    });

    const prefix = `[${name}]`.padEnd(9);
    const pipe = stream => {
        stream.setEncoding('utf8');
        let buffer = '';
        stream.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) console.log(`${prefix} ${line}`);
        });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on('error', err => {
        console.error(`\n[x] 启动 ${name} 失败：${err.message}\n`);
        shutdown(1);
    });

    child.on('exit', code => {
        // 任一进程退出就整体退出 —— 只剩前端在跑会让人误以为后端还活着，
        // 然后对着一堆 502 排查半天。
        if (!shuttingDown && code !== 0 && code !== null) {
            console.error(`\n[x] ${name} 退出（code ${code}），停止全部进程。\n`);
        }
        shutdown(code ?? 0);
    });

    children.push(child);
    return child;
}

function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) {
        if (!c.killed) c.kill('SIGTERM');
    }
    process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

export async function run(args, root) {
    const { kid, aud, iss } = generateDevKeys(root);

    console.log(`
  本地开发已就绪（鉴权是真的，不是绕过的）

    前端    http://localhost:${WEB_PORT}
    后端    http://localhost:${API_PORT}   （前端经 /api 代理过去，同源）
    令牌    kid = ${kid}
            iss = ${iss}
            aud = ${aud}

  想模拟别的站点 / 权限：改 web/.ptx-dev-key.json 的 sid / scopes 后重启。
  你自己的密钥（如 SHOPIFY_TOKEN）写在 backend/.dev.vars，ptx 不会覆盖它们。
`);

    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

    start('worker', npx, ['wrangler', 'dev', '--port', API_PORT, '--local', ...args],
        `${root}/backend`);
    start('web', npx, ['vite', '--port', WEB_PORT, '--strictPort'],
        `${root}/web`);
}
