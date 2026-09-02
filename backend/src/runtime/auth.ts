/**
 * App Token 的验签。**平台维护，不要改。**
 *
 * 这是整个后端唯一的身份来源。为什么由运行时兜住、而不是让业务代码自己验：
 * 忘记验签的后端是**完全裸奔**的（任何人都能直接打 `/api/*`），而这件事
 * **在本地测不出来** —— 本地只有你自己在调。所以它必须是不可绕过的默认。
 *
 * 算法固定 EdDSA(Ed25519)，且只接受 EdDSA：
 *   - 平台只发公钥，租户**只能验、不能签**。
 *   - 如果用 HS256，共享密钥同时也是签发密钥，租户就能自签一个
 *     `sub` 为任意用户、`scopes` 为任意权限的 token 冒充别人。
 *   - 显式拒绝 `alg: "none"` 与任何非 EdDSA 值（经典的 alg confusion 攻击）。
 */

import type { AuthContext, RuntimeEnv } from './types';
import { unauthorized } from './errors';

/** 允许的时钟偏移。分布式系统里两端时钟不可能完全一致。 */
const CLOCK_SKEW_SEC = 60;
/** JWKS 的进程内缓存时长。isolate 可能被复用很久，所以要有上限。 */
const JWKS_TTL_MS = 5 * 60 * 1000;

/**
 * `AlgorithmIdentifier` 这个全局类型在 @cloudflare/workers-types v5 里没有，
 * 从 SubtleCrypto 的签名上推导出来，避免写 `any`。
 */
type ImportKeyAlgorithm = Parameters<SubtleCrypto['importKey']>[2];
type VerifyAlgorithm = Parameters<SubtleCrypto['verify']>[0];

interface Jwk {
    kty: string;
    crv?: string;
    x?: string;
    kid?: string;
    alg?: string;
}

interface ImportedKey {
    key: CryptoKey;
    /** 记住 import 成功时用的算法名，verify 时要用同一个。 */
    algName: string;
}

/** kid → 已 import 的公钥。进程内缓存，跨请求复用。 */
const keyCache = new Map<string, ImportedKey>();
let jwksFetchedAt = 0;

function b64urlToBytes(s: string): Uint8Array {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function b64urlToJson<T>(s: string): T {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

/**
 * Ed25519 公钥的 import。
 *
 * Workers runtime 现在支持标准的 `Ed25519`；较老的版本只认 Cloudflare 私有的
 * `NODE-ED25519`（且要求 jwk 的 crv 也是这个值）。两条都试，避免 compatibility_date
 * 一变就挂 —— 这是实测会踩的兼容性坑。
 */
async function importEd25519(jwk: Jwk): Promise<ImportedKey> {
    try {
        const key = await crypto.subtle.importKey(
            'jwk', jwk as JsonWebKey, { name: 'Ed25519' }, false, ['verify']
        );
        return { key, algName: 'Ed25519' };
    } catch {
        const legacy = { ...jwk, crv: 'NODE-ED25519' } as JsonWebKey;
        const key = await crypto.subtle.importKey(
            'jwk', legacy,
            { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as unknown as ImportKeyAlgorithm,
            false, ['verify']
        );
        return { key, algName: 'NODE-ED25519' };
    }
}

async function loadJwks(env: RuntimeEnv): Promise<Jwk[]> {
    // 本地开发：`ptx dev` 把 JWKS 内联进 .dev.vars，不需要网络。
    if (env.PT_JWKS_JSON) {
        return (JSON.parse(env.PT_JWKS_JSON) as { keys: Jwk[] }).keys;
    }
    if (!env.PT_JWKS_URL) {
        throw unauthorized(
            'JWKS_NOT_CONFIGURED',
            '既没有 PT_JWKS_URL 也没有 PT_JWKS_JSON。线上由平台注入；本地请用 `ptx dev` 启动。'
        );
    }
    const res = await fetch(env.PT_JWKS_URL, { cf: { cacheTtl: 300 } } as RequestInit);
    if (!res.ok) throw unauthorized('JWKS_FETCH_FAILED', `JWKS ${res.status}`);
    return (await res.json<{ keys: Jwk[] }>()).keys;
}

async function getKey(kid: string | undefined, env: RuntimeEnv): Promise<ImportedKey> {
    if (!kid) throw unauthorized('TOKEN_KID_MISSING');

    const cached = keyCache.get(kid);
    const fresh = Date.now() - jwksFetchedAt < JWKS_TTL_MS;
    if (cached && fresh) return cached;

    // 未知 kid 或缓存过期 → 回源一次。密钥轮转时新 kid 会走到这里。
    const keys = await loadJwks(env);
    jwksFetchedAt = Date.now();
    keyCache.clear();
    for (const jwk of keys) {
        if (!jwk.kid) continue;
        if (jwk.kty !== 'OKP' || (jwk.crv !== 'Ed25519' && jwk.crv !== 'NODE-ED25519')) continue;
        try {
            keyCache.set(jwk.kid, await importEd25519(jwk));
        } catch {
            // 单个坏 key 不该让整个 JWKS 不可用。
        }
    }

    const found = keyCache.get(kid);
    if (!found) throw unauthorized('TOKEN_KID_UNKNOWN', `JWKS 里没有 kid=${kid}`);
    return found;
}

interface Claims {
    iss?: string;
    aud?: string | string[];
    sub?: string;
    wid?: string;
    sid?: string;
    scopes?: string[];
    ver?: string;
    exp?: number;
    nbf?: number;
    iat?: number;
}

/**
 * 校验 `Authorization: Bearer <jwt>` 并返回已验证的身份。
 *
 * 任何一步不过就抛 401/403 —— 没有"部分可信"的中间状态。
 */
export async function verifyAppToken(request: Request, env: RuntimeEnv): Promise<AuthContext> {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized('TOKEN_MISSING');
    const token = header.slice(7).trim();

    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized('TOKEN_MALFORMED');
    const [h, p, s] = parts as [string, string, string];

    let head: { alg?: string; kid?: string; typ?: string };
    let claims: Claims;
    try {
        head = b64urlToJson(h);
        claims = b64urlToJson(p);
    } catch {
        throw unauthorized('TOKEN_MALFORMED');
    }

    // alg 白名单。绝不读 header 里的 alg 去"选择"算法 —— 只用来拒绝。
    if (head.alg !== 'EdDSA') throw unauthorized('TOKEN_ALG_UNSUPPORTED', `alg=${head.alg}`);

    const { key, algName } = await getKey(head.kid, env);
    const ok = await crypto.subtle.verify(
        (algName === 'Ed25519' ? 'Ed25519' : { name: 'NODE-ED25519' }) as VerifyAlgorithm,
        key,
        b64urlToBytes(s) as unknown as BufferSource,
        new TextEncoder().encode(`${h}.${p}`)
    );
    if (!ok) throw unauthorized('TOKEN_SIGNATURE_INVALID');

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number') throw unauthorized('TOKEN_EXP_MISSING');
    if (claims.exp + CLOCK_SKEW_SEC < now) throw unauthorized('TOKEN_EXPIRED');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SEC > now) {
        throw unauthorized('TOKEN_NOT_YET_VALID');
    }

    if (claims.iss !== env.PT_TOKEN_ISS) throw unauthorized('TOKEN_ISS_MISMATCH');

    // aud 必须是 `app:<appId>`。漏了这一条，A 应用的 token 就能调 B 应用的后端。
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(env.PT_TOKEN_AUD)) throw unauthorized('TOKEN_AUD_MISMATCH');

    if (!claims.sub || !claims.sid || !claims.wid) throw unauthorized('TOKEN_CLAIMS_INCOMPLETE');

    return {
        userId: claims.sub,
        sid: claims.sid,
        workspaceId: claims.wid,
        scopes: Object.freeze(claims.scopes ?? []),
        frontendVersionId: claims.ver
    };
}
