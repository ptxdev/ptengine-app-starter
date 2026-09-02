/**
 * 调用自己后端的类型安全封装。
 *
 * 类型全部来自 `shared/api.ts` —— 前后端同一个文件，改一处两边同时报错。
 *
 * 它内部做的事：取 App Token（缓存 + 自动续期）→ 拼 Authorization 头 →
 * **同源** `fetch('/api/...')` → 解开错误信封。
 *
 * 同源是设计出来的（线上前后端都在 `<appId>.app.ptengine.io`，本地由 vite proxy
 * 代到 wrangler dev），所以这里没有任何 baseURL / CORS / 第三方 cookie 的处理 ——
 * 那些问题在架构层就消掉了。
 */

import type { ApiErrorBody, ApiRoutes } from '../../shared/api';
import { getAppToken, invalidateAppToken } from './pt-auth';

type RouteKey = keyof ApiRoutes;

/** 按路由契约推导出的调用参数。 */
type Options<S> =
    (S extends { params: infer P } ? { params: P } : { params?: never }) &
    (S extends { query: infer Q } ? { query: Q } : { query?: never }) &
    (S extends { body: infer B } ? { body: B } : { body?: never });

/** 后端返回的错误。`code` 与后端 `ctx.error(status, code)` 里的值一致。 */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly requestId: string
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

function buildPath(
    key: string,
    params: Record<string, string | number> | undefined,
    query: Record<string, unknown> | undefined
): string {
    const spaceAt = key.indexOf(' ');
    const rawPath = key.slice(spaceAt + 1);

    const path = rawPath
        .split('/')
        .map(seg => {
            if (!seg.startsWith(':')) return seg;
            const name = seg.slice(1);
            const value = params?.[name];
            // 运行时兜住：类型层为了可读性把 options 设成可选，漏传会在这里响。
            if (value === undefined || value === null || value === '') {
                throw new Error(`调用 "${key}" 缺少路径参数 ${name}`);
            }
            return encodeURIComponent(String(value));
        })
        .join('/');

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const suffix = qs.toString();
    return `/api${path}${suffix ? `?${suffix}` : ''}`;
}

/**
 * 调后端。
 *
 * ```ts
 * const data = await api('GET /orders', { query: { days: '7' } });
 * //    ^? OrdersResponse
 * ```
 *
 * 注：`options` 在类型层是可选的（为了可读性，不用一串条件类型），
 * 但缺路径参数会在运行时抛出明确错误。
 */
export async function api<K extends RouteKey>(
    key: K,
    options?: Options<ApiRoutes[K]>
): Promise<ApiRoutes[K]['response']> {
    const opts = (options ?? {}) as {
        params?: Record<string, string | number>;
        query?: Record<string, unknown>;
        body?: unknown;
    };

    const method = key.slice(0, key.indexOf(' ')).toUpperCase();
    const path = buildPath(key as string, opts.params, opts.query);

    const send = async (token: string) => {
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        let body: string | undefined;
        if (opts.body !== undefined) {
            headers['content-type'] = 'application/json';
            body = JSON.stringify(opts.body);
        }
        return fetch(path, { method, headers, body });
    };

    let res = await send(await getAppToken());

    // token 可能在飞行途中过期（或平台轮转了签名密钥）。重试一次，只重试一次。
    if (res.status === 401) {
        invalidateAppToken();
        res = await send(await getAppToken());
    }

    if (!res.ok) {
        let code = 'HTTP_ERROR';
        let message = `请求失败（${res.status}）`;
        let requestId = '';
        try {
            const parsed = await res.json() as ApiErrorBody;
            if (parsed?.error) {
                code = parsed.error.code;
                message = parsed.error.message;
                requestId = parsed.error.requestId;
            }
        } catch {
            // 后端挂在运行时之外（比如 worker 顶层抛异常）时不是 JSON，保留兜底文案。
        }
        throw new ApiError(res.status, code, message, requestId);
    }

    return res.json() as Promise<ApiRoutes[K]['response']>;
}
