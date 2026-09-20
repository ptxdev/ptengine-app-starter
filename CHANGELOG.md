# 更新日志

本脚手架的所有版本变更记录于此。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号的归属**：这里记录的是**脚手架自身**的版本（对应 git tag 与 Releases）。
> `package.json` 与 `manifest.json` 里的 `version` 字段属于**你的应用**，
> clone 之后由你自己维护，与本文件无关。

## 兼容矩阵

| 脚手架版本 | `@ptengine/app-sdk` | `@ptengine/app-backend` | `@ptengine/design-components` | manifest `schemaVersion` | 说明 |
|---|---|---|---|---|---|
| v3.3.0 | `^2.4.0` | `^0.4.0` | `^0.5.0` | **2**（轻应用 1）| `@ptengine/app-sdk` 2.4：`context.user { id, email, name }`；取数契约 `requiredScope` 自 2.2.2 起与 manifest 四个 scope 同口径（≤2.2.1 的 `query:read` 已废）。`@ptengine/app-backend` 0.4：`ctx.auth.email / name`；0.3 起 `ctx.files` 前缀带工作区（客户应用不可用，不受影响）。**`0.x` 的 caret 不跨 minor，旧项目要手改区间再 `npm install`** |
| v3.2.1 | `^2.2.0` | `^0.2.0` | `^0.5.0` | **2**（轻应用 1）| 修复带后端布局下组件样式全丢（Tailwind `content` 改为按包解析绝对路径）|
| v3.2.0 | `^2.2.0` | `^0.2.0` | `^0.5.0` | **2**（轻应用 1）| `@ptengine/app-sdk` 升到 2.x（`PtApp.auth.getAppToken()` 可用）；`@ptengine/app-backend` 升到 0.2.x（`ctx.vars`）；轻应用（无后端）零改动可用 |
| v3.1.0 | `^1.2.0`（待 `2.0.0`） | `^0.1.0` | `^0.5.0` | **2** | `ptx deploy --stream`；`ptx doctor` 令牌泄漏检查；默认 API 域名改线上正式环境 |
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

## [3.3.0] - 2026-09-20

### 变更

- **依赖区间**：`@ptengine/app-sdk` `^2.2.0` → `^2.4.0`，`@ptengine/app-backend` `^0.2.0` → `^0.4.0`；`package-lock.json` 锁到 2.4.0 / 0.4.0。
  - app-sdk 2.4：`PtApp.context.user { id, email, name }`（老宿主没有，判空）；2.2.2 起 `data-query.schema.json` 的 `requiredScope` 与 manifest 的 `analytics:read / profile:read / user:read` 同口径，≤2.2.1 里的 `query:read` 不要写进 manifest。
  - app-backend 0.4：`ctx.auth.email / ctx.auth.name`（可选，来自已签名令牌）。0.3 的 `ctx.files` 前缀变更只影响官方应用。
  - 已在开发中的项目：`0.x` 的 caret 拿不到新 minor，请手改 `package.json` 区间后重跑 `npm install`。

## [3.2.1] - 2026-09-17

### 修复

- **带后端的布局下，组件库的样式全都不生成**（`web/tailwind.config.js` 的 `content`）。
  症状是页面"结构对、完全没样式"：DOM 层级和文案都在，但颜色、圆角、间距、hover 叠加层全没了，
  按钮看着像一段纯文本。原因是那条覆盖组件库产物的 glob 写成了相对路径
  `'./node_modules/@ptengine/design-components/dist/**/*.{js,cjs}'` —— Tailwind 把相对 glob 按
  **配置文件所在目录**（`web/`）解析，而 v3 把依赖装在**项目根**的 `node_modules/`，
  压根没有 `web/node_modules/`，于是这条 glob 一个文件都匹配不到。
  它不报错、不告警，构建照样"成功"，只有 CSS 产物小一个量级（实测 16KB，修好后 88KB）。
  v1/v2 的纯前端应用 `node_modules/` 就在配置旁边，所以同样的写法当时看着是对的 ——
  正是这一点让它在 v3 里活了下来。

  现在 `content` 里那一条**按包名解析成绝对路径**（`createRequire(import.meta.url)` +
  `require.resolve`，并对组件库 `exports` 没暴露 `./package.json` 的情况做了包根兜底），
  依赖装在哪一层都能找到。配置里的「两处不要动」注释同步更新，明确写了不要改回相对路径。

- **`ptx doctor` 现在真的去验证这条 glob**。此前这条规则只是字符串匹配
  `@ptengine/design-components/dist`，而出问题的配置**恰好能通过字符串匹配** —— 规则在，
  坑照样踩。现在 doctor 按配置里实际用的写法求值（字面量相对 glob 按 `web/` 解析；
  按包名解析的写法用 `createRequire` 从配置文件出发重做一遍），然后真的去磁盘上跑这条 glob，
  匹配不到文件就报错，并把"依赖装在项目根、glob 按 web/ 解析"这个层级原因写进提示里。
  依赖装在 `web/` 下的老布局仍判为通过，不误报。

### 文档

- `docs/troubleshooting.md` 新增「页面只有结构没有样式 / 按钮变成纯文字」条目。

## [3.2.0] - 2026-09-16

> 版本号说明：GitHub 镜像上的 `v3.0.0` tag 打在 2026-09-15 迁入 GitLab 时的最新提交上（内容已含 3.1.0），
> 是「v3 首个可 clone 快照」的标记，不对应本文件的 3.0.0 条目；从本版起 tag 与本文件版本一致。

### 修复

- **轻应用（只有前端、没有后端）现在零改动可用**。删掉 `backend/` 目录、去掉 `manifest.json`
  的 `backend` 段之后，此前 `npm run build` 会挂在 `TS5083: Cannot read file .../backend/tsconfig.json`
  （根 `tsconfig.json` 的 `references` 仍引用 `./backend`），`npm run dev` 会挂在
  `ENOENT backend/wrangler.jsonc`（无条件起 `wrangler dev`）。两个报错都与用户写的代码无关，
  而且修法是「去改脚手架自己的内部文件」——最糟的那种要求。现在：
  - `ptx build` 无后端时跑 `tsc -b web`（不读根 tsconfig，自然绕开那条 `./backend` 引用；
    `web/tsconfig.json` 的 `include` 已含 `../shared`，共享类型照样被检查），
    **用户不需要改 `tsconfig.json`**；
  - `ptx dev` 无后端时只起 vite，不生成本地签名密钥、不写 `.dev.vars`、不起 wrangler，
    并通过 `PTX_HAS_BACKEND=0` 让 `web/vite.config.ts` 跳过 `/api` 代理
    （否则每个 `/api` 请求都是一条 ECONNREFUSED 噪音）。启动横幅区分「纯前端模式」与带鉴权的完整模式。

### 变更

- **「有没有后端」的判定收敛到一个函数**：`scripts/manifest.mjs` 的 `resolveBackend()`，
  `ptx build` / `ptx dev` / `ptx doctor` 共用。**唯一判定源是 `manifest.json` 的 `backend` 段
  （且 `schemaVersion: 2`）**——manifest 是与平台的合同，`backend/` 目录只是残留物。
  目录只做一致性检查：manifest 有 backend 而目录不在 → 报错并说清两条修法；
  manifest 没 backend 而目录还在 → 警告并按纯前端继续（这是「轻应用改了一半」的典型现场，
  上传后所有 `/api` 会 404）。

- **`@ptengine/app-sdk` 区间升到 `^2.2.0`**（此前 `^1.2.0`）。`2.0.0` 起 `PtApp.auth.getAppToken()`
  与 manifest 的 `backend` 段进入契约 —— 这正是本脚手架 `web/src/pt-auth.ts` 与 `manifest.json`
  一直在用、却只能靠类型断言绕过去的两件事。3.1.0 记的那条「已知阻塞项」到此解除。
  2.x 对本脚手架的**唯一破坏性变更**是 `PtApp` 新增必填字段 `auth`，只影响自己实现 `PtApp`
  类型的代码；本脚手架只消费 `window.PtApp`，不受影响。2.1.0 / 2.2.0 是纯加法
  （`PT_CONSENT_REQUIRED` 错误码、`data-query` 契约补字段）。
- **`package-lock.json` 刷新**：`@ptengine/app-sdk` 锁到 `2.2.0`，`@ptengine/app-backend`
  锁到 `0.2.0`。后者的区间在 3.1.0 之后就改成了 `^0.2.0`，但当时 `0.2.0` 还没发到 npm，
  锁文件一直停在 `0.1.0`（装出来的运行时没有 `ctx.vars`）。
- `web/src/pt-auth.ts` 去掉 `PtApp.auth` 的 `as unknown as` 断言，改用 SDK 导出的 `PtAppAuth`
  类型。**运行时兜底保留** —— 注入 `window.PtApp` 的是平台而不是这个包，类型说「必填」不等于
  老版本平台真的注入了 `auth`。同时补注释说明 `getAppToken()` 的三个失败码，其中
  `PT_CONSENT_REQUIRED`（scopes 未经管理员同意）是**可重试**的。
- 文档与注释里「contract 仓」的说法统一改为「monorepo 的 `packages/contract`」，
  `PT_CONTRACT_DIR` 的示例路径相应改为 `../custom-app-platform/packages/contract`
  （`scripts/sync-rules.mjs`、`scripts/manifest.mjs`、`README.md`；纯注释，无行为变化）。

### 说明

- **`manifest.json` 的 `sdkVersion` 保持 `"2.0.0"`，不跟着依赖区间走。** 这个字段声明的是
  「这个应用需要的 SDK 契约下限」，不是开发时装到的精确版本：`packages/contract` 里没有任何
  规则读它，`@ptengine/app-sdk` 的 schema 也只写了 `{"type": "string"}`、TS 侧是可选的
  `sdkVersion?: string` —— 没有消费方，写精确版本只会误导「这个应用需要 2.2.0 的新能力」。
  本脚手架用到的是 `PtApp.auth` 与 manifest `backend` 段，二者都是 2.0.0 引入的。
  将来真用上 2.1+ 的新契约（比如按 `PT_CONSENT_REQUIRED` 分支、或热图查询传 `experienceId`）
  时再抬这个下限。

## [3.1.0] - 2026-09-07

### 新增

- **`ptx deploy --publish --stream`**：改走 NDJSON 流式发布端点，九步各自完成时
  立刻打印一行进度，不用像同步 `/publish` 那样干等 20–40 秒才看到结果。
- **`ptx doctor` 新增「令牌没有进仓」检查**（体检项从 17 项增至 18 项）：对
  `git ls-files` 列出的每个受版本控制文件扫部署令牌明文模式，命中直接报 bad。

### 变更

- 默认 API 域名改为线上正式环境 `https://xbackend.ptengine.com`（此前是占位域名，
  从未真正指向过可用后端）；`PTENGINE_API_BASE` 可覆盖为 staging / development。
- `@ptengine/app-backend` 确认为 `^0.1.0`（3.0.1 已改，本次未变）。

### 说明

- `@ptengine/app-sdk` 仍为 `^1.2.0`——`PtApp.auth.getAppToken()` 依赖的
  `^2.0.0` 尚未发布，这是**已知阻塞项**。`2.0.0` 发布后再升级。

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
