/**
 * 本地开发的 Ed25519 密钥对与 JWKS。
 *
 * 目的：让**后端在本地也真验签**。如果本地跳过验签，鉴权代码第一次真正被执行
 * 就是在线上，那是最难查的一类问题（"本地全绿、上线 401"）。
 *
 * 产出两个文件（都在 .gitignore 里）：
 *   backend/.dev.vars        ← 追加/替换 PT_JWKS_JSON（公钥），wrangler dev 读它
 *   web/.ptx-dev-key.json    ← 私钥 + 假身份，vite 的 /__ptx/token 端点用它签 token
 *
 * 每次 `ptx dev` 重新生成一对，进程结束即作废 —— 密钥不会长期留在磁盘上被误用。
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

/** .dev.vars 里由 ptx 管理的键。其余行（比如你自己填的 SHOPIFY_TOKEN）原样保留。 */
const MANAGED_KEYS = ['PT_JWKS_JSON'];
const MARKER = '# --- 以下由 ptx dev 自动生成，请勿手改 ---';

export function generateDevKeys(root) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicJwk = publicKey.export({ format: 'jwk' });
    const privateJwk = privateKey.export({ format: 'jwk' });

    // kid 取公钥 x 的 sha256 前 16 字节，稳定且无需外部输入。
    const kid = createHash('sha256').update(publicJwk.x).digest('base64url').slice(0, 22);

    const jwks = {
        keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }]
    };

    // 从 wrangler.jsonc 读 iss / aud，保证与后端校验的值一致 ——
    // 写死两份迟早会漂，然后表现为本地 TOKEN_AUD_MISMATCH。
    const wranglerPath = join(root, 'backend', 'wrangler.jsonc');
    const wrangler = parseJsonc(readFileSync(wranglerPath, 'utf8'));
    const vars = wrangler.vars ?? {};
    const iss = vars.PT_TOKEN_ISS;
    const aud = vars.PT_TOKEN_AUD;
    if (!iss || !aud) {
        throw new Error(
            `backend/wrangler.jsonc 的 vars 里缺 PT_TOKEN_ISS / PT_TOKEN_AUD，` +
            `本地无法签发与后端校验一致的 token。`
        );
    }

    // ── 写 backend/.dev.vars（只替换受管键，保留你自己的行）──────────────
    const devVarsPath = join(root, 'backend', '.dev.vars');
    const existing = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
    const kept = existing
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (trimmed === MARKER) return false;
            const key = trimmed.split('=')[0]?.trim();
            return !MANAGED_KEYS.includes(key);
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();

    const managed = `${MARKER}\nPT_JWKS_JSON=${JSON.stringify(jwks)}\n`;
    writeFileSync(devVarsPath, (kept ? `${kept}\n\n` : '') + managed, 'utf8');

    // ── 写 web/.ptx-dev-key.json（私钥 + 本地假身份）──────────────────────
    const devKeyPath = join(root, 'web', '.ptx-dev-key.json');
    writeFileSync(
        devKeyPath,
        JSON.stringify(
            {
                kid,
                privateJwk,
                iss,
                aud,
                // 本地假身份。想模拟别的站点 / 权限，改这里再重启 ptx dev。
                sub: 'local-user',
                sid: 'local-site',
                wid: vars.PT_APP?.workspaceId ?? 'local-ws',
                scopes: ['analytics:read', 'profile:read', 'user:read', 'ui:notify'],
                ver: vars.PT_APP?.versionId ?? 'local'
            },
            null,
            2
        ),
        { encoding: 'utf8', mode: 0o600 }
    );

    return { kid, aud, iss, devVarsPath, devKeyPath };
}
