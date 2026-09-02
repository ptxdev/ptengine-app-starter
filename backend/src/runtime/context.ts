/** ctx 的组装。**平台维护，不要改。** */

import type { AuthContext, RuntimeEnv, ScopedR2 } from './types';
import { AppError, forbidden, missingResource } from './errors';
import { createScopedR2 } from './files';

/** 出站请求的默认超时。没有超时的 fetch 会把 CPU 配额挂死在等待上。 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface BuildContextArgs {
    request: Request;
    env: RuntimeEnv;
    execCtx: ExecutionContext;
    auth: AuthContext;
    requestId: string;
    params: Record<string, string>;
    query: Record<string, unknown>;
    body: unknown;
    route: string;
}

export function buildContext(args: BuildContextArgs) {
    const { request, env, execCtx, auth, requestId, params, query, body, route } = args;
    const app = env.PT_APP;

    const logFields = {
        requestId,
        appId: app?.appId,
        versionId: app?.versionId,
        route,
        userId: auth.userId,
        sid: auth.sid
    };

    return {
        auth,
        app,
        params,
        query,
        body,
        request,
        requestId,

        waitUntil: (p: Promise<unknown>) => execCtx.waitUntil(p),

        get db(): D1Database {
            if (!env.DB) throw missingResource('数据库', 'backend.resources.database');
            return env.DB;
        },
        get kv(): KVNamespace {
            if (!env.KV) throw missingResource('KV', 'backend.resources.kv');
            return env.KV;
        },
        get files(): ScopedR2 {
            if (!env.FILES) throw missingResource('文件存储', 'backend.resources.files');
            return createScopedR2(env.FILES, app.appId);
        },

        /**
         * manifest.backend.secrets 声明过的密钥。
         *
         * 读一个没声明的名字会抛错而不是给 undefined —— 否则你会拿着 undefined 去
         * 调第三方 API，然后对着一个 401 排查半天。
         */
        secrets: new Proxy({} as Record<string, string>, {
            get(_t, name: string) {
                const v = env[name];
                if (typeof v !== 'string') {
                    throw new AppError(
                        500, 'SECRET_NOT_DECLARED',
                        `密钥 ${name} 不存在。把它加到 manifest.json 的 backend.secrets 里并重新发布，` +
                        `然后在应用管理页填入它的值。（本地开发写在 backend/.dev.vars。）`
                    );
                }
                return v;
            }
        }),

        /**
         * 受 egress allowlist 管的出站请求。
         *
         * 一定用它而不是全局 `fetch`：它加了超时与结构化日志。至于**能不能出站**
         * 不由它决定 —— 平台的 outbound worker 按 manifest.backend.egress 拦，
         * 不在白名单里的域会拿到 403，且 `egress` 为空 = 完全禁止出站。
         */
        async fetch(input: RequestInfo, init?: RequestInit & { timeoutMs?: number }) {
            const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
            const started = Date.now();
            const url = typeof input === 'string' ? input : (input as Request).url;
            try {
                const res = await fetch(input, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
                console.log(JSON.stringify({
                    ...logFields, kind: 'egress', url, status: res.status, ms: Date.now() - started
                }));
                return res;
            } catch (e) {
                console.log(JSON.stringify({
                    ...logFields, kind: 'egress', url, error: String(e), ms: Date.now() - started
                }));
                throw e;
            }
        },

        /** Ptengine 取数（Phase 2；网关未就绪时抛明确错误而不是静默失败）。 */
        pt: {
            async query(req: unknown) {
                if (!env.PT_GATEWAY) {
                    throw new AppError(501, 'PT_GATEWAY_UNAVAILABLE',
                        '服务端取数尚未开放（Phase 2）。当前请在前端用 PtApp.data.query()。');
                }
                const res = await env.PT_GATEWAY.fetch('https://gateway/query', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(req)
                });
                if (!res.ok) throw new AppError(res.status, 'PT_QUERY_FAILED', await res.text());
                return res.json();
            }
        },

        /** 缺少任一 scope 就抛 403。 */
        requireScope(...scopes: string[]) {
            const missing = scopes.filter(s => !auth.scopes.includes(s));
            if (missing.length) {
                throw forbidden('SCOPE_REQUIRED',
                    `缺少权限 ${missing.join(', ')}。在 manifest.json 的 scopes 里声明它们。`);
            }
        },

        error: (status: number, code: string, detail?: unknown) =>
            new AppError(status, code, undefined, detail),

        log(msg: string, fields?: Record<string, unknown>) {
            console.log(JSON.stringify({ ...logFields, msg, ...fields }));
        }
    };
}

export type Context = ReturnType<typeof buildContext>;
