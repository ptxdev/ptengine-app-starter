import { existsSync, readFileSync } from 'node:fs';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_KEY_FILE = resolve(import.meta.dirname, '.ptx-dev-key.json');

/**
 * 本地开发的令牌签发端点。
 *
 * 为什么要有它：线上前端调后端要带平台签发的 App Token，后端会真验签。如果本地
 * 绕过这一步（比如后端在 dev 下跳过校验），你就会得到"本地全绿、上线 401"——
 * 而且线上才第一次跑到验签逻辑，最难查。
 *
 * 所以 `ptx dev` 会生成一对临时 Ed25519 密钥：公钥（JWKS 形态）写进
 * `backend/.dev.vars` 让 worker 真验签，私钥留在这里给这个端点签 token。
 * claims 与线上**同构**，本地就能测出 aud 不匹配、过期、scope 不足这些问题。
 *
 * 私钥文件不存在时这个端点返回 503 —— 说明你没用 `ptx dev` 启动。
 */
function ptxDevToken(): Plugin {
    return {
        name: 'ptx-dev-token',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/__ptx/token', (_req, res) => {
                if (!existsSync(DEV_KEY_FILE)) {
                    res.statusCode = 503;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({
                        error: {
                            code: 'PTX_DEV_KEY_MISSING',
                            message: '没找到本地开发密钥。请用 `npm run dev`（即 ptx dev）启动，' +
                                     '不要直接跑 vite —— 后端会因为验签失败一律返回 401。'
                        }
                    }));
                    return;
                }

                const conf = JSON.parse(readFileSync(DEV_KEY_FILE, 'utf8')) as {
                    kid: string; privateJwk: Record<string, unknown>;
                    iss: string; aud: string;
                    sub: string; sid: string; wid: string; scopes: string[]; ver: string;
                };

                const now = Math.floor(Date.now() / 1000);
                const header = { alg: 'EdDSA', typ: 'JWT', kid: conf.kid };
                const payload = {
                    iss: conf.iss, aud: conf.aud, sub: conf.sub,
                    wid: conf.wid, sid: conf.sid, scopes: conf.scopes, ver: conf.ver,
                    iat: now, exp: now + 300, jti: crypto.randomUUID()
                };

                const b64 = (o: unknown) =>
                    Buffer.from(JSON.stringify(o)).toString('base64url');
                const signingInput = `${b64(header)}.${b64(payload)}`;

                const key = createPrivateKey({
                    key: conf.privateJwk as never, format: 'jwk'
                });
                // Ed25519 是 one-shot 签名，algorithm 传 null。
                const sig = nodeSign(null, Buffer.from(signingInput), key).toString('base64url');

                res.setHeader('content-type', 'application/json');
                res.setHeader('cache-control', 'no-store');
                res.end(JSON.stringify({ token: `${signingInput}.${sig}`, expiresIn: 300 }));
            });
        }
    };
}

export default defineConfig({
    plugins: [react(), ptxDevToken()],

    /**
     * ⚠️ base 必须是相对路径 './'，不要改成 '/' 或某个绝对前缀。
     *
     * 前端产物由平台从 R2 提供，入口 HTML 的实际地址形如
     *   https://<appId>.app.ptengine.ai/v/<versionId>/index.html
     * 只有相对 base 产出的 `./assets/xxx.js` 才能正确解析回该目录；
     * 绝对 base 会让产物请求 `/assets/xxx.js` → 落到域名根 → 404 → 白屏。
     */
    base: './',

    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        emptyOutDir: true
    },

    server: {
        /**
         * ⚠️ 必须开 CORS，否则平台的「本地开发 / dev 模式」加载不出来。
         *
         * 该模式下是 Ptengine X **平台 app 的 origin** 去 fetch 本地 dev server 的入口
         * HTML（微前端 iframe 加载），端口/域不同即为跨源；Vite 6+ 默认把 dev server
         * 限制成同源，会直接挡掉。用 `true`（反射请求 Origin）而不是列白名单：
         * 同一个 dev server 会被线上平台域、内部 dev 平台域分别 fetch，反射一份就都覆盖。
         *
         * 取舍：开着期间本机浏览器访问的任何网站理论上都能读到这个 dev server 的内容。
         * 它只跑在本机、不暴露公网，对临时联调可接受。
         */
        cors: true,

        /**
         * 把 /api 代理到本地 wrangler dev。
         *
         * 这样本地也是**同源**调用（跟线上 `<appId>.app.ptengine.ai` 一致），
         * 不需要在前端代码里区分环境写不同的 baseURL，也不需要任何 CORS 配置。
         *
         * 轻应用（manifest.json 里没有 backend 段）根本没有 wrangler dev 可代理，
         * `ptx dev` 会传 PTX_HAS_BACKEND=0 —— 此时不配代理，免得每个 /api 请求
         * 都变成一条 ECONNREFUSED 噪音，掩盖真正的错误。
         */
        proxy: process.env.PTX_HAS_BACKEND === '0' ? undefined : {
            '/api': {
                // 端口由 ptx dev 通过 env 传进来（PTX_API_PORT），
                // 保证代理指向的就是真正起起来的那个 wrangler dev。
                target: `http://127.0.0.1:${process.env.PTX_API_PORT ?? '8787'}`,
                changeOrigin: false
            }
        }
    }
});
