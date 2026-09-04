/**
 * 前后端共享的 API 契约 —— **唯一的真相来源**。
 *
 * 前端 `web/src/api.ts` 与后端 `backend/src/index.ts` 都从这里取类型：
 * 改一处，两边同时报错。不要在任何一侧另抄一份。
 *
 * ⚠️ 兼容性约定（因为发布存在秒级的前后端不一致窗口）：
 * 改 API 时，**新后端必须能服务旧前端至少一个发布周期**。
 * 加字段可以；删字段、改语义、改路由名，都要分两次发布：
 *   1. 先加新的 → 发布 → 前端切过去 → 2. 再发布删旧的。
 */

/** 一条订单。 */
export interface Order {
    id: string;
    total: number;
    currency: string;
    createdAt: string;
}

export interface OrdersResponse {
    orders: Order[];
    /** 命中缓存时是缓存写入时间，否则 null。 */
    cachedAt: string | null;
}

export interface Settings {
    currency: string;
}

/**
 * 公开自检信息。
 *
 * 这条路由在 `publicRoutes` 里，**不验签** —— 它存在的理由是：
 * 直接打开应用地址时能一眼看出后端到底有没有在跑、数据库通没通。
 * 没有它的话，未登录访问只会看到 401，分不清是"鉴权正常工作"
 * 还是"后端根本没起来"。
 *
 * ⚠️ 因此它只返回**自身状态**，不返回任何业务数据、不接受任何输入。
 *    新增公开路由时照这个标准审：泄漏了什么？能被拿来做什么？
 */
export interface PublicStatus {
    appId: string | null;
    versionId: string | null;
    /** 各依赖的连通性自检。 */
    checks: {
        /** D1 是否可查询。 */
        database: 'ok' | 'unavailable' | 'error';
        /** KV 是否可读写。 */
        kv: 'ok' | 'unavailable' | 'error';
    };
    /** 已注册的路由键，用于确认部署的是哪一版代码。 */
    routes: string[];
    /** 服务端当前时间，用于确认不是缓存。 */
    serverTime: string;
}

/**
 * 路由表。键的形状是 `'<METHOD> <path>'`，path 里可以写 `:param`。
 *
 * 不要写 `/api` 前缀 —— 运行时会剥掉它（见 `@ptengine/app-backend`）。
 */
export interface ApiRoutes {
    'GET /orders': {
        /**
         * ⚠️ query 的值恒为 string —— 运行时**不做隐式类型转换**。
         * 想要数字就在 handler 里 `Number(ctx.query.days ?? '7')`。
         * （自动转换会把 `?code=0123` 静默改写成 `123`，那类 bug 极难查。）
         */
        query: { days?: string };
        response: OrdersResponse;
    };
    'GET /orders/:id': {
        params: { id: string };
        response: Order;
    };
    'GET /settings': {
        response: Settings;
    };
    'POST /settings': {
        body: Settings;
        response: { ok: true };
    };
    /** 公开自检。见 PublicStatus 的说明 —— 这条不验签。 */
    'GET /public/status': {
        response: PublicStatus;
    };
}

/** 错误信封。后端出错时的响应体恒为这个形状。 */
export interface ApiErrorBody {
    error: {
        code: string;
        message: string;
        /** 服务端生成的追踪 id，报障时带上它。 */
        requestId: string;
    };
}
