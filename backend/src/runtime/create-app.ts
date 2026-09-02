/**
 * 路由与请求生命周期。**平台维护，不要改。**
 *
 * 它保证的事（这些都是"忘了就出事、且本地测不出来"的类型）：
 *   - 每个请求都验签，`ctx.auth` 一定是已验证身份，没有"未验证"的中间状态
 *   - `aud` 必须匹配本 App，别的应用的 token 打不进来
 *   - 未声明的路由一律 404，不会意外暴露
 *   - 错误统一成信封，栈与内部细节只进日志不进响应
 *   - 内建 `/api/__health`，平台发布后用它探针（见 spec §10.2 第 9 步）
 */

import type { RouteMapOf, RouteShape, RuntimeEnv } from './types';
import { AppError, badRequest, notFound } from './errors';
import { verifyAppToken } from './auth';
import { buildContext, type Context } from './context';

/** 按路由契约收窄后的 ctx。 */
export type RouteContext<S extends RouteShape> =
    Omit<Context, 'params' | 'query' | 'body'> & {
        params: S extends { params: infer P } ? P : Record<string, never>;
        /**
         * 查询串。**值恒为 string，运行时不做任何隐式类型转换。**
         *
         * 为什么不自动转成 number/boolean：`?code=0123` 会被转成 `123`、
         * `?v=1e3` 会被转成 `1000`，这类静默的值改写非常难查。
         * 需要数字就自己 `Number(...)`，一行的成本换掉一整类 bug。
         */
        query: S extends { query: infer Q } ? Q : Record<string, never>;
        body: S extends { body: infer B } ? B : undefined;
    };

export type Handler<S extends RouteShape> =
    (ctx: RouteContext<S>) => Promise<S['response']> | S['response'] | Promise<Response> | Response;

export interface AppConfig<R extends RouteMapOf<R>> {
    routes: { [K in keyof R]: Handler<Extract<R[K], RouteShape>> };
    /** 所有路由之前跑。抛错即中断整个请求。 */
    onRequest?: (ctx: Context) => void | Promise<void>;
    /** 覆盖默认的错误序列化。返回 undefined 则走默认。 */
    onError?: (err: unknown, ctx: { requestId: string; route: string }) => Response | undefined;
}

interface CompiledRoute {
    method: string;
    segments: string[];
    paramNames: (string | null)[];
    key: string;
    handler: Handler<RouteShape>;
}

function compile<R extends RouteMapOf<R>>(routes: AppConfig<R>['routes']): CompiledRoute[] {
    return Object.entries(routes).map(([key, handler]) => {
        const spaceAt = key.indexOf(' ');
        if (spaceAt < 0) {
            throw new Error(`路由键 "${key}" 格式不对，应形如 "GET /orders"`);
        }
        const method = key.slice(0, spaceAt).toUpperCase();
        const path = key.slice(spaceAt + 1);
        if (!path.startsWith('/')) {
            throw new Error(`路由键 "${key}" 的路径必须以 / 开头（且不要写 /api 前缀）`);
        }
        if (path.startsWith('/api/') || path === '/api') {
            throw new Error(`路由键 "${key}" 不要带 /api 前缀 —— 运行时会自动剥掉它`);
        }
        const segments = path.split('/').filter(Boolean);
        return {
            method,
            segments,
            paramNames: segments.map(s => (s.startsWith(':') ? s.slice(1) : null)),
            key,
            handler: handler as Handler<RouteShape>
        };
    });
}

function match(compiled: CompiledRoute[], method: string, pathname: string) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of compiled) {
        if (r.method !== method) continue;
        if (r.segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
            const name = r.paramNames[i];
            const part = parts[i]!;
            // noUncheckedIndexedAccess 下 paramNames[i] 是 string | null | undefined。
            // 用 typeof 收窄，把 undefined 与 null 一起当作"静态段"处理。
            if (typeof name !== 'string') {
                if (r.segments[i] !== part) { ok = false; break; }
            } else {
                params[name] = decodeURIComponent(part);
            }
        }
        if (ok) return { route: r, params };
    }
    return null;
}

function errorResponse(status: number, code: string, message: string, requestId: string) {
    return new Response(
        JSON.stringify({ error: { code, message, requestId } }),
        { status, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
}

export function createApp<R extends RouteMapOf<R>>(config: AppConfig<R>) {
    // 编译在模块加载时做，路由键写错会在**部署探针**阶段就暴露，而不是等到线上某个请求。
    const compiled = compile(config.routes);

    return {
        async fetch(request: Request, env: RuntimeEnv, execCtx: ExecutionContext): Promise<Response> {
            const requestId = crypto.randomUUID();
            const url = new URL(request.url);

            // 平台把整条 URL 原样转发过来，前缀在这里剥掉 —— 这样线上与
            // 本地（vite proxy 也带 /api）行为一致，不需要两套路径逻辑。
            let pathname = url.pathname;
            if (pathname === '/api') pathname = '/';
            else if (pathname.startsWith('/api/')) pathname = pathname.slice(4);

            // ── 健康探针：平台发布后用它确认 worker 真的能跑起来 ──────────
            // 刻意**不验签**：探针来自平台 Deployer，没有用户 token。
            // 因此它只返回自身标识，不碰任何资源、不泄漏任何业务信息。
            if (pathname === '/__health') {
                return new Response(
                    JSON.stringify({
                        ok: true,
                        appId: env.PT_APP?.appId ?? null,
                        versionId: env.PT_APP?.versionId ?? null,
                        routes: compiled.length
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }

            const hit = match(compiled, request.method.toUpperCase(), pathname);
            const routeKey = hit?.route.key ?? `${request.method} ${pathname}`;
            const started = Date.now();

            try {
                if (!hit) throw notFound('ROUTE_NOT_FOUND', `没有这个路由：${routeKey}`);

                const auth = await verifyAppToken(request, env);

                // query：只取字符串，不做隐式转换（见 RouteContext 的注释）。
                const query: Record<string, string> = {};
                for (const [k, v] of url.searchParams) query[k] = v;

                let body: unknown;
                const ct = request.headers.get('content-type') ?? '';
                if (request.method !== 'GET' && request.method !== 'HEAD') {
                    if (ct.includes('application/json')) {
                        try {
                            body = await request.json();
                        } catch {
                            throw badRequest('BODY_INVALID_JSON');
                        }
                    } else if (ct) {
                        body = await request.text();
                    }
                }

                const ctx = buildContext({
                    request, env, execCtx, auth, requestId,
                    params: hit.params, query, body, route: hit.route.key
                });

                if (config.onRequest) await config.onRequest(ctx);

                const result = await hit.route.handler(ctx as never);

                console.log(JSON.stringify({
                    requestId, appId: env.PT_APP?.appId, versionId: env.PT_APP?.versionId,
                    route: hit.route.key, status: 200, ms: Date.now() - started
                }));

                if (result instanceof Response) return result;
                return new Response(JSON.stringify(result ?? null), {
                    status: 200,
                    headers: { 'content-type': 'application/json; charset=utf-8' }
                });
            } catch (err) {
                const override = config.onError?.(err, { requestId, route: routeKey });
                if (override) return override;

                if (err instanceof AppError) {
                    console.log(JSON.stringify({
                        requestId, appId: env.PT_APP?.appId, route: routeKey,
                        status: err.status, code: err.code, detail: err.detail,
                        ms: Date.now() - started
                    }));
                    return errorResponse(err.status, err.code, err.message, requestId);
                }

                // 未预期的错误：详情**只进日志**。栈里常有内部路径与 SQL。
                console.error(JSON.stringify({
                    requestId, appId: env.PT_APP?.appId, route: routeKey, status: 500,
                    error: err instanceof Error ? err.stack ?? err.message : String(err),
                    ms: Date.now() - started
                }));
                return errorResponse(
                    500, 'INTERNAL_ERROR',
                    '服务端内部错误。把 requestId 提供给应用作者以便排查。', requestId
                );
            }
        }
    };
}
