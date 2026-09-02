# AGENTS.md

给 AI 编码助手的项目说明（Cursor / Claude Code / Copilot / Codex / Gemini 等通用；
`CLAUDE.md` 只是指向本文件的指针，**内容只维护这一份**）。

本项目是 **Ptengine X 自定义应用**（Custom App），有前端也有后端：

- **前端** `web/` —— 纯静态产物，由平台以真跨源 `<iframe>` 加载，经 `window.PtApp` 桥拿宿主能力。
- **后端** `backend/` —— 一个 Cloudflare Worker，由平台部署，只服务 `/api/*`。
- **契约** `shared/api.ts` —— 前后端共享的类型，唯一真相来源。

前后端**打在同一个 zip 里、同一个版本号、一起发布一起回滚**。

在这里写代码前，先把下面「硬边界」看完 —— 违反它们的失败现象大多**不报错**
（白屏、没样式、上传被拒、线上 401），靠试很难收敛。

**改完必须跑 `npm run doctor`**，它把本文件里的检查项变成了可执行的体检。

---

## 硬边界（违反即坏，且现象不直观）

### 1. 前端三处不能改的约定

| 约定 | 位置 | 改错后的症状 |
|---|---|---|
| `base: './'`（相对路径） | `web/vite.config.ts` | 产物请求 `/assets/*` 落到域名根 → 404 → **白屏** |
| `manifest.json` 在 **zip 根级** | `scripts/ptx-package.mjs`（用 staging 目录保证） | 上传报 **`MANIFEST_MISSING`** |
| `manifest.entry` 与构建入口一致（默认 `index.html`） | `manifest.json` | 上传报 **`ENTRY_NOT_FOUND`** |

### 2. 后端五条不能破的约定

| 约定 | 为什么 |
|---|---|
| **入口必须是 `export default createApp({...})`** | `createApp` 是唯一保证"每个请求都验签"的地方。自己写 `export default { fetch }` 会让后端**完全裸奔**，而且**本地测不出来**（本地只有你自己在调） |
| **不要 fork `@ptengine/app-backend`** | 运行时由平台维护并随包升级。把它复制到本地改，就拿不到后续的安全修复；有需求提到平台侧 |
| **落库必须带 `ctx.auth.sid`** | 一个应用会被同一工作区下的多个站点使用，`sid` 是隔离键。漏了它，A 站点会看到 B 站点的数据，**而且不会报错** |
| **不要用 `env`，用 `ctx`** | 线上的 `env` 由平台组装，形状与本地不同；`ctx` 是稳定契约，且强制了 R2 前缀隔离等边界 |
| **密钥只经 `ctx.secrets`** | 值由平台在部署时注入。硬编码进代码 = 写进了公开可取的产物 |

### 3. 后端**没有**的能力（写了也不会有）

平台不给租户这些绑定，写了要么线上直接报错，要么被静默丢弃：

| 不可用 | 原因 |
|---|---|
| **Durable Objects** | 平台的 outbound worker 拦不住 DO 内部发出的 fetch，给了就等于 SSRF 防线有洞 |
| **`connect()` 建 TCP** | 启用 outbound worker 后运行时自动禁用 |
| **`caches.default`** | untrusted 隔离（默认隔离模式）下被禁用 |
| **`request.cf`** | 同上，untrusted 隔离下不可用 |
| **Cron Triggers / `scheduled()` 处理器** | ⚠️ Workers for Platforms 的 user worker **不支持 cron**：`triggers.crons` 在部署时被**静默丢弃**，无报错无警告、定时永不触发。定时能力要等平台侧调度器（Phase 3） |
| **Queues / Workflows** | 同上，需要平台侧调度器 |
| **mTLS certificate binding** | outbound worker 拦不住它 |

### 4. 出站请求受白名单管，**默认全禁**

`manifest.json` 的 `backend.egress` 是域名白名单，**缺省或空数组 = 完全禁止出站**。

```json
"egress": ["api.shopify.com", "*.myshopify.com"]
```

- 只写主机名，不要带协议、端口或路径
- `*.` 只通配一级
- 不允许写平台自身域（`ptengine.com` / `ptengine.io` 等）
- 用 `ctx.fetch()` 而不是全局 `fetch()`（前者加了超时与结构化日志）

### 5. 路由只能用 hash 或 `nav.syncRoute`

前端入口 HTML 的实际地址形如 `https://<appId>.app.ptengine.io/v/<versionId>/index.html`。

- 用 `HashRouter`（或自己管 hash）；**不要**用 `BrowserRouter` / `history.pushState('/detail')`
- 要把内部位置反映到浏览器地址栏，用 `window.PtApp.nav.syncRoute('detail')`，
  平台会把它作为下次进入时的 `context.initialPath` 回传

### 6. 不要假设别的宿主全局变量

宿主能力**只**通过 `window.PtApp` 提供。`window.microApp` 之类是平台内部实现细节。
读取统一用 `web/src/pt-app.ts` 的 `getPtApp()`（未经平台加载时返回 `null` 而不是抛错）。

### 7. API 必须向后兼容一版

发布时前端切版本与后端切版本之间有**秒级窗口**，期间"新后端 + 旧前端"会同时在线。

所以：加字段可以；**删字段、改字段语义、改路由名，都要分两次发布** ——
先加新的、发布、前端切过去、再发布删旧的。

---

## 平台契约：window.PtApp

类型来自 `@ptengine/app-sdk`：

```ts
window.PtApp = {
    version: string;
    context: { appId, sid, locale, theme, initialPath };
    ui:   { toast(message, type?), confirm({ title?, message }), overlay(theme | null) };
    nav:  { push(path), syncRoute(subPath) };
    data: { query(req), describe() };        // 前端取数
    ai:   { provideContext(fn | null) };     // 页面内容抽取的覆盖入口（多数应用不用碰）
    auth: { getAppToken() };                 // ⚠️ 调自己后端用；需 app-sdk ^2.0.0
    on(event: 'context' | 'route' | 'overlay.click', cb);
};
```

⚠️ 两个就绪语义的坑：

1. **`window.PtApp` 存在 ≠ `context` 就绪。** `context` 由桥握手下发，握手完成前是**空对象**。
   要按 `sid` / `locale` / `theme` 分支的逻辑必须订阅 `on('context', ...)`，
   不能只在首帧读一次。只读一次的写法**不报错**，只是永远显示空值。
2. **dev 模式下 `window.PtApp` 本身也是异步挂上的。** `web/src/main.tsx` 里
   `await installDevHost()` **必须保留**。去掉它，`App.tsx` 的 `useMemo(getPtApp, [])`
   会读到 `null` 且永不重算，页面**永久**停在"未检测到 window.PtApp"——
   只在平台内 dev 模式出现，本地 `npm run dev` 完全正常，极难自查。

`on('change')` 已在 app-sdk 1.0.0 移除。照旧写法不报错，只是回调永不触发。

---

## 调自己的后端

**不要手写 `fetch('/api/...')`**，用 `web/src/api.ts` 的 `api()`：

```ts
import { api, ApiError } from './api';

const data = await api('GET /orders', { query: { days: '7' } });
//    ^? OrdersResponse —— 类型来自 shared/api.ts
```

`api()` 已经兜住了：取 App Token、到期前自动续期、401 自动重试一次、解开错误信封。
手写 fetch 会漏掉这些，而且**在本地也能跑通**（因为 token 还没过期），线上才出问题。

前后端**同源**（线上都在 `<appId>.app.ptengine.io`，本地由 vite proxy 代到 wrangler dev），
所以不需要任何 baseURL / CORS / 第三方 cookie 处理。

### 加一个新接口的正确顺序

1. 在 `shared/api.ts` 的 `ApiRoutes` 里加一项（含 `query` / `body` / `response` 类型）
2. 在 `backend/src/index.ts` 的 `routes` 里加对应 handler —— **不加会 tsc 报错**
3. 前端用 `api('METHOD /path', ...)` 调用

⚠️ `query` 的值**恒为 string**，运行时不做隐式类型转换（`?code=0123` 自动转数字会
静默变成 `123`，那类 bug 极难查）。要数字就自己 `Number(ctx.query.days ?? '7')`。

---

## 后端能用的东西（ctx）

```ts
ctx.auth        // { userId, sid, workspaceId, scopes }  —— 已验签，没有"未验证"状态
ctx.app         // { appId, workspaceId, versionId, env }
ctx.params      // 路径参数        ctx.query  查询串（值恒为 string）   ctx.body  已解析的 body
ctx.db          // D1（需 manifest backend.resources.database: true）
ctx.kv          // KV（需 backend.resources.kv: true）
ctx.files       // R2（需 backend.resources.files: true；前缀已限定）
ctx.secrets.X   // manifest backend.secrets 里声明过的密钥
ctx.fetch()     // 出站（受 egress 白名单管，带超时与日志）
ctx.pt.query()  // Ptengine 取数（Phase 2，尚未开放）
ctx.requireScope('analytics:read')   // 缺则抛 403
ctx.error(502, 'CODE')               // 抛它 → 受控响应；抛其它 → 500 且详情只进日志
ctx.log('msg', { ... })              // 结构化日志
ctx.waitUntil(promise)               // 后台任务（如写缓存，不阻塞响应）
```

没在 manifest 里声明就访问 `ctx.db` / `ctx.kv` / `ctx.secrets.X`，会抛**说得清原因的错误**
（`RESOURCE_NOT_DECLARED` / `SECRET_NOT_DECLARED`），不是 `undefined is not a function`。

---

## 数据库迁移

`backend/migrations/NNNN_描述.sql`，序号**连续不跳号**（`npm run package` 会校验）。

三条硬约定，由平台侧 Migrator 的行为决定：

1. **只进不退。** 版本回滚只回滚代码，**不回滚 schema** —— 自动回滚 schema 会丢数据。
2. **已发布的文件不要改。** 平台按序号记录"已应用到哪一版"，改旧文件不会重跑。要改就加新文件。
3. **必须可重复安全执行。** 用 `CREATE TABLE IF NOT EXISTS` 之类，别假设只跑一次。

本地跑迁移：`npx wrangler d1 migrations apply ptapp-local --local`（在 `backend/` 下）。

---

## 前端取数：window.PtApp.data

前端能直接取站点数据（平台做中介执行，**profile 锁死在服务端**，不需要也无法指定查哪个站点）。

```ts
const res = await window.PtApp.data.query({
    queryType: 'funnel_insight',
    params: {
        timeRange: { key: 'lastDays', days: 7 },
        steps: [{ event: 'page_view' }, { event: 'purchase' }]
    }
});
// res = { columns: string[], rows: unknown[][], rowCount: number, metadata: object }
```

**给 AI 的硬性要求：**

1. **`params` 的形状由 `queryType` 决定，不要凭印象写。** 类型是判别联合，tsc 会告诉你该填什么。
   拿不准就先跑 `window.PtApp.data.describe()`，照它返回的 JSON Schema 写。
2. **`timeRange` 是对象且必填**：`{ key: 'lastDays', days: 7 }` /
   `{ key: 'custom', startTime: '2026/08/01', endTime: '2026/08/20' }` / `{ key: 'thisMonth' }`。
   `key` 全部取值：`today` `yesterday` `thisWeek` `lastWeek` `thisMonth` `lastMonth`
   `lastDays` `custom` `before` `after` `on`。旧的字符串预设（`'last_7_days'`）服务端仍兼容，
   但**类型层会报错**，不要再写。
3. **别瞎造事件名 / 属性名**：用站点里真实存在的名字。猜错不报错，**静默返回 0 行**。
4. **一个分析问题 = 一次查询**：用 `dimension` 一次拿回分好组的整表，不要枚举候选值逐个查。
5. **别把维度行加总当总数**：`rows` 是分组明细，不是聚合结果。
6. **单次最多 5000 行**。截断时 `metadata.truncated === true`、`metadata.totalRowCount` 是
   截断前的真实行数；**未截断时这两个字段不存在**（不是 `false`）。`rowCount` 永远等于
   本次返回的 `rows.length`，别拿它当总数算分母。

完整的 18 个 queryType 说明与参数 schema 见
`node_modules/@ptengine/app-sdk/data-query.llms.txt` 与 `data-query.schema.json`
（**由平台自动生成、与线上服务端逐字同源**，比任何二手描述都可靠）。

⚠️ 用户级（`user_*`）场景返回的是**单个用户的明细**（可能含 email、跨会话轨迹）。
只在应用确实要讲某个人的行为时用，面向运营的看板一律用聚合场景。

**什么时候该改用后端取数**：需要跨源 join、需要超过 5000 行、或者不想把用户级明细
暴露到浏览器时。那是 `ctx.pt.query()`（Phase 2，尚未开放）。

---

## UI：一律用 @ptengine/design-components

界面**不要自己写基础控件、不要引第三方 UI 库**（antd / MUI / chakra 一概不要）——
目标是与平台自身观感一致。

- **组件清单与设计规范在 `node_modules/@ptengine/design-components/llms.txt`** ——
  那份文件就是给 AI 看的，写界面前先读它，不要凭印象猜组件名与变体名。
- 只从包入口 import：`import { Button, Card } from '@ptengine/design-components'`，
  不要深引 `dist/` 内部路径。
- `className` **只做布局**（宽度 / 间距 / 对齐），不要用它改观感（颜色、圆角、阴影）。
- **不硬编码色值**，用语义类：`text-foreground` / `text-muted-foreground` / `bg-secondary` /
  `bg-neutral-subtler` / `text-danger` 等。
- 变体名与 shadcn 官方不同：`secondary` = 白底描边（官方 outline）、`tertiary` = 灰底
  （官方 secondary）。照 `llms.txt` 的表来。

### 四处接线（改动前必读；错了**都不报错**，只是样式不对）

| 位置 | 作用 | 错了会怎样 |
|---|---|---|
| `web/tailwind.config.js` 的 `presets: [designPreset]` | token（颜色/字阶/圆角）+ `state-layer` 插件 | 组件掉成 Tailwind 默认观感 |
| `web/tailwind.config.js` content 里 `node_modules/@ptengine/design-components/dist/**` | 组件 class 在**编译后的库产物**里 | 组件「有结构、没样式」 |
| `web/src/main.tsx` 的 `import '@ptengine/design-components/styles/tokens.css'` | 提供 `--pt-*` 变量 | 所有颜色失效 |
| `web/src/theme.ts` 的 `applyPtTheme()` 在 **`<html>`** 上挂 `pt-ui` | 库不写任何 `:root` 级样式 | 同上；挂到 `#root` 则「页面正常、一开弹窗就没样式」（Radix 浮层 portal 到 `body`） |

暗色模式由 `followPtTheme()` 跟随 `context.theme`（`<html>` 上加 `dark` 类）。

---

## 本地开发

```bash
npm run dev        # 同时起 vite（前端）与 wrangler dev（后端），并签发真 token
```

端口冲突时：`PTX_WEB_PORT=5273 PTX_API_PORT=8887 npm run dev`

**本地的鉴权是真的，不是绕过的。** `ptx dev` 会生成一对临时 Ed25519 密钥：
公钥进 `backend/.dev.vars`（worker 用它真验签），私钥给 vite 的 `/__ptx/token` 端点签 token。
所以 `aud` 不匹配、过期、scope 不足这些线上才会遇到的问题，本地就会现形。

- 想模拟别的站点 / 权限：改 `web/.ptx-dev-key.json` 的 `sid` / `scopes` 后重启
- 自己的密钥（如 `SHOPIFY_TOKEN`）写在 `backend/.dev.vars`，`ptx dev` **不会覆盖**它们
- 这两个文件都在 `.gitignore` 里，**绝不要提交**

平台内 dev 模式（管理页「本地开发」指向本地 dev server）也支持 —— `web/vite.config.ts`
里 `server.cors: true` 就是为它准备的（平台 app 的 origin 会跨源 fetch 你的 dev server，
Vite 6+ 默认会挡掉）。

---

## 改完必须验证

```bash
npm run doctor     # 体检：把本文件的检查项跑一遍（改完先跑这个）
npm run build      # 类型检查（web + backend + shared）+ 构建前端 + 打包后端
npm run package    # 组装 zip + 结构自检
```

**只跑 `build` 不够**：`package` 才会校验平台要求的包结构与 manifest 自洽性
（后端入口是否存在、egress 语法、migration 序号、有没有把 `.dev.vars` 打进包）。
声称"完成"之前先跑它，并确认输出里有 `[ok] 打包完成`。

---

## 权限声明（manifest.scopes）

合法值只有四个：`analytics:read`、`profile:read`、`user:read`、`ui:notify`。
写未定义或拼错的值会导致**上传校验失败**。遵循最小权限原则。

平台当前只校验取值合法性，尚未据此放行/拦截；但 `ctx.requireScope()` 已经会按
token 里的 scopes 强制校验，所以后端可以现在就写。

---

## 版本号别搞混

| 位置 | 属于谁 |
|---|---|
| git tag / Release | **脚手架**（Ptengine 维护，客户仓里通常已 `rm -rf .git`） |
| `manifest.json` 的 `version` | **这个应用**（每次上传必须递增，平台读它） |
| `package.json` 的 `version` | 这个应用（npm 惯例，平台不读） |

`manifest.schemaVersion` 是**平台契约版本**，不是你的版本号 —— 有 `backend` 段就必须是 `2`。
写成 1 会让平台**静默忽略**后端，跑出一个"前端正常、所有 API 404"的应用。
