# 更新日志

本脚手架的所有版本变更记录于此。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号的归属**：这里记录的是**脚手架自身**的版本（对应 git tag 与 Releases）。
> `package.json` 与 `manifest.json` 里的 `version` 字段属于**你的应用**，
> clone 之后由你自己维护，与本文件无关。

## 兼容矩阵

| 脚手架版本 | `@ptengine/app-sdk` | `@ptengine/app-backend` | `@ptengine/design-components` | manifest `schemaVersion` | 说明 |
|---|---|---|---|---|---|
| v3.0.1 | `^2.0.0` | `^0.1.0`（npm） | `^0.5.0` | **2** | `@ptengine/app-backend` 首发到公共 npm，脚手架改为依赖它；修示例错误码；manifest 加 `id` |
| v3.0.0 | `^2.0.0` | `file:../app-backend` | `^0.5.0` | **2** | **新增后端运行时**：每个应用一个 Worker，前后端同包同版本。目录结构变化（前端移到 `web/`）|
| v2.0.0 | `^1.0.0` | — | `^0.4.0` | 1 | 宿主改真跨源 iframe + 桥换 postMessage；`on('change')` 移除、`timeRange` 改对象、取数放开到 18 个 queryType |
| v1.2.0 | `^0.6.0` | — | `^0.4.0` | 1 | 取数放开到 12 个 queryType + 参数改判别联合类型 + `PtApp.data.describe()` |
| v1.1.3 | `^0.4.0` | — | `^0.3.0` | 1 | dev server 默认开 CORS + 模板默认带 `icon` 占位图 |
| v1.1.2 | `^0.4.0` | — | `^0.3.0` | 1 | 修复平台内本地联调拿到假上下文 |
| v1.1.1 | `^0.3.0` | — | `^0.3.0` | 1 | AI 助手说明归一到 `AGENTS.md` |
| v1.1.0 | `^0.3.0` | — | `^0.3.0` | 1 | 预装 UI 组件库 + Tailwind，暗色跟随平台主题 |
| v1.0.1 | `^0.3.0` | — | — | 1 | 支持在平台内加载本地 dev server 联调 |
| v1.0.0 | `^0.2.0` | — | — | 1 | 首个版本 |

## [3.0.1] - 2026-09-07

### 变更

- **`@ptengine/app-backend` 改为 npm 依赖 `^0.1.0`**（此前是 `file:../app-backend` 本地路径）。
  运行时已发布到公共 npm，与 `@ptengine/app-sdk` 同政策。clone 后 `npm install` 即可，不再需要同级目录。
- `manifest.json` 增加 `id` 字段（示例值 `my-app`）。`ptx package` 用它命名 zip
  （`<id>-<version>.zip`），之前缺省时永远叫 `ptengine-app-<version>.zip`。

### 修复

- `backend/src/index.ts` 示例里 `/public/status` 比对的错误码 `MISSING_RESOURCE` 改为运行时
  实际抛出的 `RESOURCE_NOT_DECLARED`。之前那个分支永远走不到，未声明的资源会被报成 `error` 而不是 `unavailable`。

## [3.0.0] - 2026-09-02

**自定义应用从"自定义前端"变成"可运行的业务应用"**：每个应用获得一个独立的后端
（Cloudflare Worker），能安全持有密钥、调第三方 API、持久化自己的业务数据。

**这一版有破坏性变更**，见下面的「升级指引」。

### 新增

- **后端运行时。** `backend/` 下写 `export default createApp({ routes })`，
  就有了 `/api/*`。运行时兜住验签、路由、错误规范化、结构化日志与健康探针。
- **`shared/api.ts` 契约。** 前后端共享类型，改一处两边同时报错。
  前端用 `api('GET /orders', { query })` 调用，类型自动推导。
- **平台注入资源。** `manifest.backend.resources` 声明 `database` / `kv` / `files`，
  平台代你创建 D1 / KV / R2 并挂绑定 —— 你不需要 Cloudflare 账号，也不写任何
  Cloudflare 概念，代码里只有 `ctx.db` / `ctx.kv` / `ctx.files`。
- **密钥管理。** `manifest.backend.secrets` 只声明名字，值在应用管理页填，
  部署时由平台注入。包里永远没有密钥。
- **出站白名单。** `manifest.backend.egress` 声明可访问的域名，**缺省即完全禁止出站**。
- **数据库迁移。** `backend/migrations/NNNN_*.sql`，平台按序号执行并记录进度。
- **`ptx` CLI。** `dev` / `build` / `package` / `deploy` / `doctor`。
  取代原来的 `npm run package`（旧命令保留一个版本并给出提示）。
- **本地鉴权是真的。** `ptx dev` 生成临时 Ed25519 密钥：前端拿真令牌、后端做真验签。
  `aud` 不匹配、令牌过期、scope 不足这些线上问题在本地就会现形。
- **`ptx doctor`。** 把 AGENTS.md 里那些"违反了不报错"的约定变成一条可执行的检查。
  主要是给 AI 编码助手用的 —— 改完跑一次，不用指望它记住每条文档。
- **CI 一条命令发布。** 打 tag → GitHub Action → 线上更新，前后端一起。

### 破坏性：目录结构变化

前端从项目根移到 `web/`：

```diff
- src/                    → web/src/
- index.html              → web/index.html
- vite.config.ts          → web/vite.config.ts
- tailwind.config.js      → web/tailwind.config.js
- postcss.config.js       → web/postcss.config.js
- public/                 → web/public/
+ backend/                  新增
+ shared/                    新增
```

三条硬约定与四处 UI 接线**内容完全没变**，只是路径带上了 `web/` 前缀。

### 破坏性：`manifest.schemaVersion` 升到 2

**v3 的包无法上传到旧平台。**

这是刻意的：现有 schema 是 `additionalProperties: true`，加 `backend` 段**不会**让
旧平台校验失败 —— 旧平台会**静默忽略**它，跑出一个"前端加载正常、所有 API 返回 404"
的应用，开发者会以为是自己路由写错了，排查方向完全跑偏。

升 `schemaVersion` 让旧平台在上传时就明确报 `SCHEMA_VERSION_UNSUPPORTED`。
按本项目一贯的"失败要响、现象要直观"原则，这个破坏性变更是值得的。

不需要后端的应用可以删掉 `backend` 段并把 `schemaVersion` 改回 `1`，
继续兼容旧平台。

### 破坏性：`@ptengine/app-sdk` 升到 `^2.0.0`

新增 `PtApp.auth.getAppToken()` —— 调自己后端所需的短时效令牌。
纯前端应用不受影响。

### 平台侧前置依赖

后端能力需要平台的 App Runtime 已上线。在它就绪之前：

- `npm run dev` 的**本地开发完全可用**（含真实鉴权）
- 上传后前端调 `/api/*` 会拿到一个说明性的错误，而不是莫名的失败

### 升级指引（已在开发中的 v2 项目）

1. **挪目录**（照上面的对照表），并把 `src/` 里的 import 路径按需调整
2. `npm i @ptengine/app-sdk@^2.0.0 @ptengine/design-components@^0.5.0`
   —— 注意 `0.x` 的 caret 跨不过 minor，`^0.4.0` 拿不到 `0.5.x`
3. 从本版脚手架复制过来：`backend/`、`shared/`、`scripts/`、
   `web/src/api.ts`、`web/src/pt-auth.ts`，以及 `web/vite.config.ts` 里的
   `ptxDevToken()` 插件与 `/api` proxy
4. `manifest.json`：`schemaVersion` 改 `2`，加 `backend` 段
5. `package.json` 的 scripts 换成 `node scripts/ptx.mjs <cmd>`
6. `.gitignore` 加 `backend/.dev.vars` 与 `web/.ptx-dev-key.json`
   —— **这两个文件含密钥与签名私钥，提交上去等于泄漏**
7. 跑 `npm run doctor`，把它报的问题逐条修掉
8. 重新 `npm run package` 并上传

只想留在纯静态、不要后端的话：**不用升级**。v2 继续可用。
