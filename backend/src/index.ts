/**
 * 你的后端业务代码写在这里。
 *
 * 运行时（`@ptengine/app-backend`）已经兜住了验签、路由、错误规范化、日志与健康探针 ——
 * 你只写 handler。`ctx` 上的每一样东西都是已经安全的：
 *   ctx.auth      已验签的调用者身份（userId / sid / workspaceId / scopes）
 *   ctx.db        你自己的数据库      ctx.kv   你自己的 KV
 *   ctx.secrets   你在 manifest 里声明的密钥
 *   ctx.fetch     出站请求（受 manifest.backend.egress 白名单管）
 *   ctx.pt.query  Ptengine 取数（Phase 2）
 *
 * 落库时**务必带上 `ctx.auth.sid`**：一个应用会被同一个工作区下的多个站点使用，
 * sid 是它们之间的隔离键。漏了它，A 站点会看到 B 站点的数据。
 */

import { createApp } from '@ptengine/app-backend';
import type { ApiRoutes, Order, OrdersResponse, PublicStatus } from '../../shared/api';

export default createApp<ApiRoutes>({
    /**
     * 不验签的路由，逐条列出。默认所有路由都要 App Token。
     *
     * 这里只放了自检 —— 它不返回业务数据、不接受输入。
     * 加新的之前先问：泄漏了什么？能被拿来做什么？
     */
    publicRoutes: ['GET /public/status'],

    routes: {
        /**
         * 示例：调第三方 API + KV 缓存。
         *
         * 想让它真的跑起来，需要两步（缺任一步都会拿到明确的报错，不会静默失败）：
         *   1. manifest.json 的 backend.secrets 加 SHOPIFY_TOKEN，
         *      backend.egress 加 "api.shopify.com"
         *   2. 本地在 backend/.dev.vars 写 SHOPIFY_TOKEN=xxx；
         *      线上在应用管理页填
         */
        /**
         * 公开自检。**不验签**（见上面的 publicRoutes）。
         *
         * 它逐项探活依赖，任何一项挂了都不影响整体返回 —— 目的就是
         * 在出问题时告诉你「哪一项挂了」，而不是整个接口 500。
         */
        'GET /public/status': async (ctx): Promise<PublicStatus> => {
            const checks: PublicStatus['checks'] = { database: 'unavailable', kv: 'unavailable' };

            // ctx.db / ctx.kv 是 getter：manifest 没声明这个资源时它会抛
            // RESOURCE_NOT_DECLARED。所以「没绑定」和「绑了但坏了」都要接住，
            // 且要分开报 —— 前者是配置问题，后者是运行时故障。
            try {
                await ctx.db.prepare('SELECT 1').first();
                checks.database = 'ok';
            } catch (e) {
                checks.database =
                    (e as { code?: string })?.code === 'RESOURCE_NOT_DECLARED' ? 'unavailable' : 'error';
            }
            try {
                const probe = '__status_probe';
                await ctx.kv.put(probe, String(Date.now()), { expirationTtl: 60 });
                checks.kv = (await ctx.kv.get(probe)) ? 'ok' : 'error';
            } catch (e) {
                checks.kv =
                    (e as { code?: string })?.code === 'RESOURCE_NOT_DECLARED' ? 'unavailable' : 'error';
            }

            return {
                appId: ctx.app?.appId ?? null,
                versionId: ctx.app?.versionId ?? null,
                checks,
                routes: [
                    'GET /public/status', 'GET /orders', 'GET /orders/:id',
                    'GET /settings', 'POST /settings'
                ],
                serverTime: new Date().toISOString()
            };
        },

        'GET /orders': async (ctx): Promise<OrdersResponse> => {
            const days = Number(ctx.query.days ?? '7');
            if (!Number.isFinite(days) || days < 1 || days > 365) {
                throw ctx.error(400, 'DAYS_OUT_OF_RANGE');
            }

            const cacheKey = `orders:${ctx.auth.sid}:${days}`;
            const cached = await ctx.kv.get<OrdersResponse>(cacheKey, 'json');
            if (cached) return cached;

            // 演示用的假数据。真实实现把下面整段换成 ctx.fetch(...)：
            //
            //   const res = await ctx.fetch(
            //       `https://api.shopify.com/admin/api/2026-01/orders.json?days=${days}`,
            //       { headers: { 'X-Shopify-Access-Token': ctx.secrets.SHOPIFY_TOKEN } }
            //   );
            //   if (!res.ok) throw ctx.error(502, 'SHOPIFY_UNAVAILABLE');
            //   const orders = (await res.json<{ orders: Order[] }>()).orders;
            const orders: Order[] = [
                { id: 'demo-1', total: 129.0, currency: 'USD', createdAt: new Date().toISOString() }
            ];

            const payload: OrdersResponse = { orders, cachedAt: new Date().toISOString() };
            // 缓存写入不该阻塞响应。
            ctx.waitUntil(ctx.kv.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }));
            return payload;
        },

        /** 示例：路径参数。 */
        'GET /orders/:id': async (ctx): Promise<Order> => {
            ctx.log('查单条订单', { orderId: ctx.params.id });
            if (ctx.params.id !== 'demo-1') throw ctx.error(404, 'ORDER_NOT_FOUND');
            return { id: 'demo-1', total: 129.0, currency: 'USD', createdAt: new Date().toISOString() };
        },

        /** 示例：读 D1。注意 WHERE 里带 sid。 */
        'GET /settings': async (ctx) => {
            const row = await ctx.db
                .prepare('SELECT currency FROM settings WHERE sid = ?')
                .bind(ctx.auth.sid)
                .first<{ currency: string }>();
            return { currency: row?.currency ?? 'USD' };
        },

        /** 示例：写 D1 + scope 校验。 */
        'POST /settings': async (ctx) => {
            // 缺少声明的权限就抛 403。scopes 来自已验签的 token，
            // 租户代码改不了它 —— 所以这不是"自觉遵守"，是强制的。
            ctx.requireScope('analytics:read');

            const currency = ctx.body.currency;
            if (!/^[A-Z]{3}$/.test(currency)) throw ctx.error(400, 'CURRENCY_INVALID');

            await ctx.db
                .prepare(
                    'INSERT INTO settings (sid, currency) VALUES (?, ?) ' +
                    'ON CONFLICT(sid) DO UPDATE SET currency = excluded.currency, ' +
                    "updated_at = datetime('now')"
                )
                .bind(ctx.auth.sid, currency)
                .run();

            return { ok: true } as const;
        }
    }
});
