/**
 * ptx dev —— 本地把整条链路跑通（含鉴权）。
 *
 *   1. 生成一对临时 Ed25519 密钥 → 公钥进 backend/.dev.vars，私钥进 web/.ptx-dev-key.json
 *   2. 起 wrangler dev（backend/）:8787 —— 本地 D1/KV 由 miniflare 模拟
 *   3. 起 vite dev（web/）:5173 —— /api 代理到 8787，/__ptx/token 用私钥签 token
 *
 * 上面三步只在**有后端**时发生。轻应用（manifest.json 里没有 backend 段）只起 vite，
 * 不生成密钥、不起 wrangler、也不配 /api 代理 —— 见 planDev()。
 *
 * 于是前端拿到的是**真 token**、后端做的是**真验签**：aud 不匹配、过期、
 * scope 不足这些线上才会遇到的问题，本地就会现形。
 *
 * 刻意不做的事：不在 dev 下让后端跳过验签。跳过的话鉴权代码第一次真正被执行
 * 就是在线上，那是最难查的一类问题。
 *
 * 本地配置怎么注入的：**这里不做任何注入**。`wrangler dev` 原生读配置文件同目录下的
 * `.dev.vars`，把每一行 `KEY=VALUE` 当成一个 env 变量绑上去（启动日志里那句
 * "Using secrets defined in .dev.vars"）。下面 start('worker', …) 的 cwd 是 `backend/`，
 * 而且**不传 `--var` 也不传 `--config`**，所以 `backend/.dev.vars` 一定会被读到 ——
 * 密钥与普通配置共用这一个文件。已实测（wrangler 4.128.0）。
 * 若哪天加了 `--config` 指到别处，就要在这里显式读 `.dev.vars` 并逐条 `--var NAME:VALUE` 补回来。
 */
import { spawn } from 'node:child_process';
import { generateDevKeys } from './dev-keys.mjs';
import { readManifest, requireBackendResolution } from './manifest.mjs';

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

function start(name, command, cmdArgs, cwd, hasBackend = true) {
    const child = spawn(command, cmdArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        // PTX_HAS_BACKEND 让 web/vite.config.ts 知道要不要配 /api 代理：
        // 没有后端时配了代理，对 /api 的请求会变成一串 ECONNREFUSED 噪音。
        env: { ...process.env, PTX_API_PORT: API_PORT, PTX_WEB_PORT: WEB_PORT, PTX_HAS_BACKEND: hasBackend ? '1' : '0' }
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

/**
 * 这次 dev 要起哪些进程 —— 纯函数，不 spawn 任何东西，方便测。
 *
 * 轻应用（manifest 里没有 backend 段）只起 vite：没有 wrangler dev，
 * 也就不需要 `.dev.vars` 与那对临时签名密钥。以前这里无条件起 wrangler，
 * 删掉 backend/ 之后第一句话就是 `ENOENT backend/wrangler.jsonc`。
 *
 * @returns {{ hasBackend: boolean, procs: Array<{name,command,args,cwd}> }}
 */
export function planDev(manifest, root, { webPort = WEB_PORT, apiPort = API_PORT, extraArgs = [] } = {}) {
    const { enabled: hasBackend } = requireBackendResolution(manifest, root);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const procs = [];

    if (hasBackend) {
        procs.push({
            name: 'worker',
            command: npx,
            args: ['wrangler', 'dev', '--port', apiPort, '--local', ...extraArgs],
            cwd: `${root}/backend`
        });
    } else if (extraArgs.length > 0) {
        console.log(`  [!] 纯前端应用，没有 wrangler dev，忽略透传参数：${extraArgs.join(' ')}`);
    }

    procs.push({
        name: 'web',
        command: npx,
        args: ['vite', '--port', webPort, '--strictPort'],
        cwd: `${root}/web`
    });

    return { hasBackend, procs };
}

export async function run(args, root) {
    const manifest = readManifest(root);
    const { hasBackend, procs } = planDev(manifest, root, { extraArgs: args });

    if (!hasBackend) {
        console.log(`
  本地开发已就绪（纯前端模式 —— 这个应用没有后端）

    前端    http://localhost:${WEB_PORT}

  manifest.json 里没有 backend 段，所以不起 wrangler dev、也不生成本地签名密钥。
  /api 没有人接（vite 不会为它配代理），前端请直接用 PtApp 的宿主能力。
  想加后端：恢复 backend/ 目录，并在 manifest.json 里补回 backend 段 + schemaVersion: 2。
`);
    } else {
        const { kid, aud, iss } = generateDevKeys(root);
        console.log(`
  本地开发已就绪（鉴权是真的，不是绕过的）

    前端    http://localhost:${WEB_PORT}
    后端    http://localhost:${API_PORT}   （前端经 /api 代理过去，同源）
    令牌    kid = ${kid}
            iss = ${iss}
            aud = ${aud}

  想模拟别的站点 / 权限：改 web/.ptx-dev-key.json 的 sid / scopes 后重启。
  密钥与普通配置都写在 backend/.dev.vars（一个文件，一行一个 KEY=VALUE），ptx 不会覆盖它们。
  线上只注入 manifest.backend.secrets / backend.vars 声明过的名字。
`);
    }

    for (const p of procs) start(p.name, p.command, p.args, p.cwd, hasBackend);
}
