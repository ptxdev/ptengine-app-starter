/**
 * 取调用自己后端所需的 App Token。
 *
 * 两条路径：
 * - **线上**：平台桥签发（`PtApp.auth.getAppToken()`）。签名私钥只在平台服务端，
 *   前端拿不到，所以前端无法自签。
 * - **本地开发**：`ptx dev` 起的 vite 插件端点 `/__ptx/token`，用临时密钥签一个
 *   与线上**同构**的 token，后端会真验签 —— 本地就能测出鉴权问题。
 *
 * ⚠️ token 只放在内存里，**不写 localStorage**：跨站嵌入下 localStorage 按顶级站点
 * 分区、且 XSS 可读。也**永不放进 URL**（会进日志、Referer、浏览器历史）。
 */

import type { PtAppAuth } from '@ptengine/app-sdk';
import { getPtApp } from './pt-app';

/** 平台签发的 TTL 是 5 分钟；提前 60 秒续期，避免请求正好卡在过期边界。 */
const REFRESH_MARGIN_MS = 60_000;

interface Cached {
    token: string;
    /** 本地时钟下的到期时刻。 */
    expiresAt: number;
}

let cached: Cached | null = null;
/** 并发请求共享同一次取 token，避免同时打出多个签发请求。 */
let inflight: Promise<string> | null = null;

/** 从 JWT 的 payload 读 exp。取不到就按 5 分钟兜底。 */
function readExpiry(token: string): number {
    try {
        const payload = token.split('.')[1];
        if (!payload) return Date.now() + 300_000;
        const json = JSON.parse(
            atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        ) as { exp?: number };
        return typeof json.exp === 'number' ? json.exp * 1000 : Date.now() + 300_000;
    } catch {
        return Date.now() + 300_000;
    }
}

async function mint(): Promise<string> {
    if (import.meta.env.DEV) {
        const res = await fetch('/__ptx/token', { cache: 'no-store' });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`本地取 token 失败（${res.status}）：${body}`);
        }
        return (await res.json() as { token: string }).token;
    }

    const app = getPtApp();
    if (!app) {
        throw new Error(
            '未检测到 window.PtApp —— 只有经 Ptengine 平台加载时才会注入。' +
            '本地开发请用 `npm run dev`。'
        );
    }

    // ⚠️ 类型上 `PtApp.auth` 自 @ptengine/app-sdk 2.0.0 起是**必填**字段，但运行时注入
    // `window.PtApp` 的是平台，不是这个包 —— 老版本平台注入的对象上可能根本没有 `auth`。
    // 所以类型说「一定有」不等于真的有，这里仍要运行时兜底，报一个说得清的错，
    // 而不是让业务代码撞上 `undefined is not a function`。
    const auth: Partial<PtAppAuth> | undefined = app.auth;
    if (typeof auth?.getAppToken !== 'function') {
        throw new Error(
            '当前平台/SDK 还不支持 PtApp.auth.getAppToken()（需要 @ptengine/app-sdk ^2.0.0 ' +
            '与已上线 App Runtime 的平台版本）。在它可用之前，后端只能用 `ptx dev` 在本地联调。'
        );
    }
    // 失败码见 `PT_BRIDGE_ERRORS`：`PT_AUTH_UNSUPPORTED`（应用没有后端，重试无用）、
    // `PT_CONSENT_REQUIRED`（manifest.scopes 还没被工作区管理员同意，**可重试** ——
    // 宿主会弹授权框，同意后再调一次即可）、`PT_HOST_UNAVAILABLE`（不在平台里）。
    return auth.getAppToken();
}

/** 取一个有效 token，内部缓存并自动续期。业务代码不需要关心刷新。 */
export async function getAppToken(): Promise<string> {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
    if (inflight) return inflight;

    inflight = mint()
        .then(token => {
            cached = { token, expiresAt: readExpiry(token) };
            return token;
        })
        .finally(() => {
            inflight = null;
        });

    return inflight;
}

/** 收到 401 时清掉缓存，让下一次调用重新取。 */
export function invalidateAppToken(): void {
    cached = null;
}
