/**
 * 运行时的类型定义。**平台维护，不要改这个目录下的任何文件。**
 *
 * 这一层将来会抽成 `@ptengine/app-backend` 发到 npm；现在内联在脚手架里，
 * 是为了让脚手架开箱可跑（包还没发布）。抽包时是一次 `git mv` + 改 import 路径。
 */

/**
 * 平台注入的环境。
 *
 * ⚠️ 这里列的每一项都是**平台在部署时组装**的（见 manifest 的 `backend.resources`
 * 与 `backend.secrets`）。你在 `backend/wrangler.jsonc` 里加的 binding
 * **不会**出现在线上 —— 那份配置只服务本地 `wrangler dev`。
 */
export interface RuntimeEnv {
    /** manifest 里 `resources.database: true` 时存在。 */
    DB?: D1Database;
    /** manifest 里 `resources.kv: true` 时存在。 */
    KV?: KVNamespace;
    /** manifest 里 `resources.files: true` 时存在。前缀隔离由 `ctx.files` 强制。 */
    FILES?: R2Bucket;

    /** 本 App 的标识。平台以 json binding 注入。 */
    PT_APP: PtAppIdentity;

    /** 令牌校验用的公开信息。 */
    PT_TOKEN_AUD: string;
    PT_TOKEN_ISS: string;
    /** 线上：平台 JWKS 端点。 */
    PT_JWKS_URL?: string;
    /** 本地开发：`ptx dev` 直接把 JWKS 内联进 .dev.vars，免去网络依赖。 */
    PT_JWKS_JSON?: string;

    /** 平台数据网关（Phase 2）。 */
    PT_GATEWAY?: Fetcher;

    /** manifest.backend.secrets 声明过的密钥，以及其它平台注入的字符串。 */
    [key: string]: unknown;
}

export interface PtAppIdentity {
    appId: string;
    workspaceId: string;
    versionId: string;
    env: 'production' | 'development';
}

/** 已验签的调用者身份。**不存在"未验证"的 auth** —— 从类型上消除误用。 */
export interface AuthContext {
    /** 平台用户 id。 */
    userId: string;
    /** 站点 id。多租户的隔离键，落库时务必带上它。 */
    sid: string;
    workspaceId: string;
    scopes: readonly string[];
    /** 令牌里带的前端版本，用于排查前后端版本不一致。 */
    frontendVersionId?: string;
}

/** 单条路由的契约形状（在 `shared/api.ts` 里定义）。 */
export interface RouteShape {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    response: unknown;
}

/**
 * 路由表的约束。
 *
 * 刻意写成映射类型而不是 `Record<string, RouteShape>`：后者要求目标类型有索引签名，
 * 而 `shared/api.ts` 里的 `ApiRoutes` 是 **interface**（没有索引签名），
 * 会报 "Index signature for type 'string' is missing"。用 `{ [K in keyof R]: ... }`
 * 逐键校验，interface 与 type 都能满足。
 */
export type RouteMapOf<R> = { [K in keyof R]: RouteShape };

/** 前缀已限定在 `apps/<appId>/` 的 R2 封装。 */
export interface ScopedR2 {
    get(key: string): Promise<R2ObjectBody | null>;
    put(key: string, value: ReadableStream | ArrayBuffer | string,
        options?: R2PutOptions): Promise<R2Object | null>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<R2Objects>;
}
