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
 *
 * 令牌里的 `scopes` 取自根目录 `manifest.json` 的 `scopes`（见 `devTokenScopes`），
 * 不再写死 —— 写死的那份没有 `asset:read` / `asset:write` / `ai:invoke`，声明了这些
 * scope 的应用本地一调就 403 `SCOPE_REQUIRED`，而线上是通的。
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.mjs';
import { readManifest } from './manifest.mjs';

/** .dev.vars 里由 ptx 管理的键。其余行（比如你自己填的 SHOPIFY_TOKEN）原样保留。 */
const MANAGED_KEYS = ['PT_JWKS_JSON'];
const MARKER = '# --- 以下由 ptx dev 自动生成，请勿手改 ---';

/**
 * 本地 dev token 的 `scopes`：**照抄 manifest.json 的 `scopes`**。
 *
 * 线上令牌里的 scopes 是「manifest 声明过、且已获授权」的那些；本地没有授权这一步，
 * 所以按「声明的全部已批准」签 —— 与线上最常见的状态（自建应用、管理员已同意）一致。
 * 声明了什么本地就有什么，忘了声明的 scope 本地同样 403，问题在本地就现形。
 *
 * 回退规则（理由写在每条旁边）：
 *   - 没有 `scopes` 字段 / 空数组 → `[]`。不报错：manifest schema 不要求这个字段，
 *     「什么都不声明」是合法的最小权限；线上这样的应用令牌里也是空的。
 *   - 不是数组、或元素不是非空字符串 → 抛错。这种 manifest 上传必被拒，
 *     本地若悄悄回退成某个默认集合，只会让本地与线上再次不一致。
 * 值是否在合法 scope 表里不在这里管：`npm run doctor` / `package` 会按 rules.json 拦。
 *
 * @returns {string[]}
 */
export function devTokenScopes(manifest) {
    const scopes = manifest?.scopes;
    if (scopes === undefined || scopes === null) return [];
    if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string' || s.length === 0)) {
        throw new Error(
            `manifest.json 的 scopes 必须是字符串数组（如 ["analytics:read", "ui:notify"]），` +
            `当前是 ${JSON.stringify(scopes)}。本地 dev token 的 scopes 照抄它，所以先把它改对。`
        );
    }
    return [...new Set(scopes)];
}

export function generateDevKeys(root) {
    // 先读 manifest：scopes 写错时在生成任何文件之前就失败，不留半套密钥。
    const scopes = devTokenScopes(readManifest(root));

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
                // 本地假身份。vite 的 /__ptx/token 每次签发都现读这个文件，所以想临时模拟
                // 别的站点 / 缺某个权限，直接改这里即可、**不用重启**；下次 ptx dev 会重写它。
                // scopes 照抄 manifest.json —— 要长期改权限就改 manifest 再重启。
                sub: 'local-user',
                sid: 'local-site',
                wid: vars.PT_APP?.workspaceId ?? 'local-ws',
                scopes,
                ver: vars.PT_APP?.versionId ?? 'local'
            },
            null,
            2
        ),
        { encoding: 'utf8', mode: 0o600 }
    );

    return { kid, aud, iss, scopes, devVarsPath, devKeyPath };
}
