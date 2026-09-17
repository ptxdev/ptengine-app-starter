# AGENTS.md

给 AI 编码助手的项目说明（Cursor / Claude Code / Copilot / Codex / Gemini 等通用；
`CLAUDE.md` 只是指向本文件的指针，**内容只维护这一份**）。

本项目是 **Ptengine 自定义应用**（Custom App），有前端也有后端：

- **前端** `web/` —— 纯静态产物，由平台以真跨源 `<iframe>` 加载，经 `window.PtApp` 桥拿宿主能力。
- **后端** `backend/` —— 一个 Cloudflare Worker，由平台部署，只服务 `/api/*`。
- **契约** `shared/api.ts` —— 前后端共享的类型，唯一真相来源。

前后端**打在同一个 zip 里、同一个版本号、一起发布一起回滚**。

**也可以没有后端**（「轻应用」）：见下面的[轻应用（只有前端）](#轻应用只有前端)。

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

前端入口 HTML 的实际地址形如 `https://<appId>.app.ptengine.ai/v/<versionId>/index.html`。

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

## 轻应用（只有前端）

不少应用根本不需要后端 —— 数据从 `PtApp.data.query()` 取，交互用 `PtApp.ui`。
这种情况**删两个东西就行，其余命令照常**：

```bash
rm -rf backend/
```

然后改 `manifest.json`：删掉整个 `backend` 段，`schemaVersion` 改回 `1`
（`2` 是「带后端」的 schema，纯前端回 `1` 可兼容更老的平台版本）。

**不需要改 `tsconfig.json`、`package.json` 或任何 `scripts/` 下的文件。**
`dev` / `doctor` / `build` / `package` / `deploy` 全部照常跑，会自动切成纯前端模式：

| 命令 | 有后端 | 轻应用 |
|---|---|---|
| `npm run dev` | vite + `wrangler dev` + 本地签发真 token，`/api` 代理到 8787 | **只起 vite**；不生成密钥、不配 `/api` 代理，横幅会写「纯前端模式」 |
| `npm run build` | `tsc -b`（web + backend + shared）+ vite build + wrangler bundle | `tsc -b web`（web + shared）+ vite build |
| `npm run package` | zip 里含 `_backend/` | zip 只有前端产物 |

判定源**只有 `manifest.json`**（有没有 `backend` 段），`backend/` 目录在不在只用来对账：

- manifest 有 `backend` 段、目录却不在 → 直接报错（不然只会看到一句
  `ENOENT backend/wrangler.jsonc`，指不到真正原因）；
- manifest 没有 `backend` 段、目录还在 → 警告并按纯前端继续。这通常是改了一半：
  代码还在，但上传后所有 `/api` 请求都会 404。

反过来，给轻应用加回后端：恢复 `backend/` 目录，并把 `backend` 段与 `schemaVersion: 2` 写回 manifest。

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

前后端**同源**（线上都在 `<appId>.app.ptengine.ai`，本地由 vite proxy 代到 wrangler dev），
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

### 资源由平台注入

`backend/wrangler.jsonc` **只服务本地开发**。线上有什么由 `manifest.json` 决定：

```json
"backend": {
    "resources": { "database": true, "kv": true, "files": false },
    "secrets": [{ "name": "SHOPIFY_TOKEN", "label": "Shopify Token", "required": true }],
    "vars": [{ "name": "API_BASE", "required": false, "default": "https://api.shopify.com" }],
    "egress": ["api.shopify.com"]
}
```

- **`resources`** —— 平台代你创建 D1 / KV / R2 并挂上绑定，你不需要 Cloudflare 账号
- **`secrets`** —— 只声明**名字**，值由用户在应用管理页填。包里永远没有密钥
- **`vars`** —— 非敏感配置项，同样只声明名字（可给 `default`），值在应用管理页填。
  与 `secrets` **共用同一个环境变量命名空间**：同名会被判为冲突。名字要匹配
  `^[A-Z][A-Z0-9_]*$`，不能用 `PT_` 前缀，也不能占用 worker 内建 binding 名
  （`DB` / `KV` / `FILES` / `PT_GATEWAY` …）—— 占了会在发布期生成两个同名 binding，
  把资源**遮掉**（`ctx.db` 突然变成一个字符串）。两者各最多 64 条
- **`egress`** —— 出站域名白名单，规则见上面的[硬边界 4](#4-出站请求受白名单管默认全禁)

### 密钥 vs 配置

`backend.secrets` 与 `backend.vars` 声明方式几乎一样、在 worker 里也都从 `ctx` 上读，
但它们是**两种东西**，选错了会踩坑：

|  | `secrets`（密钥） | `vars`（配置项） |
|---|---|---|
| 值存在哪 | Cloudflare **Secrets Store** | 平台数据库 |
| 填完能读回吗 | **不能**，管理页只显示「已设置」 | 能，管理页能看到当前值 |
| 改完何时生效 | **立即**（下一个请求就是新值） | **要重新发布**才生效 |
| 适合放什么 | token、私钥、数据库口令 | 接口地址、开关、超时时间、ID |

第三行是最容易踩的一条：配置项在**发布时**被当作 `plain_text` 值**拷进 worker**，
所以它在管理页改完之后，线上跑的还是发布那一刻的值 —— 必须重新发布一版。
密钥不是拷贝，是运行时从 Secrets Store 取，所以改了立即生效。

推论：**别把要热改的东西放 `vars`**（比如一个想随时关掉的功能开关，走 `vars` 得重新发一版）；
也**别把密钥放 `vars`** —— `vars` 的值能被读回，而且会明文出现在 worker 配置里。

`vars` 可以带 `default`，此时它是可选的（用户不填就用默认值）：

```json
"vars": [{ "name": "API_BASE", "required": false, "default": "https://api.example.com", "label": "第三方接口地址" }]
```

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
| `web/tailwind.config.js` content 里指向组件库 `dist/**` 的那条 glob（**按包名解析成绝对路径**，见文件里的 `resolveDesignComponentsDist()`）| 组件 class 在**编译后的库产物**里 | 组件「有结构、没样式」。别改回相对路径 `'./node_modules/...'`：相对 glob 按 `web/` 解析，而依赖装在项目根，改回去会静默地一个文件都扫不到 |
| `web/src/main.tsx` 的 `import '@ptengine/design-components/styles/tokens.css'` | 提供 `--pt-*` 变量 | 所有颜色失效 |
| `web/src/theme.ts` 的 `applyPtTheme()` 在 **`<html>`** 上挂 `pt-ui` | 库不写任何 `:root` 级样式 | 同上；挂到 `#root` 则「页面正常、一开弹窗就没样式」（Radix 浮层 portal 到 `body`） |

暗色模式由 `followPtTheme()` 跟随 `context.theme`（`<html>` 上加 `dark` 类）。

---

## 本地开发

```bash
npm run dev        # 同时起 vite（前端）与 wrangler dev（后端），并签发真 token
                   # 轻应用（manifest 无 backend 段）只起 vite，横幅会写「纯前端模式」
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

### 本地配置：backend/.dev.vars

一个文件、一行一个 `KEY=VALUE`，**密钥和普通配置放在一起**（它们最终都是 worker `env`
上的键，本来就是同一个命名空间）：

```
# 你自己的（对应 manifest 的 backend.secrets / backend.vars）
SHOPIFY_TOKEN=shpat_xxx
API_BASE=https://api.example.com

# --- 以下由 ptx dev 自动生成，请勿手改 ---
PT_JWKS_JSON={"keys":[...]}
```

- 这个文件**不需要你创建**：第一次 `npm run dev` 会生成它（里面先只有 `PT_JWKS_JSON`）。
  你自己加的行会被原样保留，`ptx dev` 只重写 `PT_` 开头的受管键
- 值一般不用加引号（`API_BASE=https://a.test` 即可）。wrangler 用 dotenv 规则解析：引号会被剥掉，
  所以 `API_BASE="https://a.test"` 读到同一个值；只有值里含空格或 `#`（未加引号时 `#` 之后会被当注释截掉）
  才需要用引号包住
- 改完要**重启 `npm run dev`** 才生效
- `npm run doctor` 会把这个文件和 `manifest.json` 的声明对一遍：漏填必填项、
  或填了没声明的名字，都会给一条提醒

> **本地是怎么注入的（已实测，不要再重跑一遍）。** `ptx dev` **自己不做任何注入**：
> 它把 `wrangler dev` 的 cwd 设在 `backend/`，既不传 `--var` 也不传 `--config`，
> 于是 wrangler 原生读同目录的 `.dev.vars`，逐行绑成 env 变量 —— 启动日志里那句
> `Using secrets defined in .dev.vars` 就是它。想自己确认：
> `printf 'PTX_SMOKE=hello\n' >> backend/.dev.vars`，加一个读 `env.PTX_SMOKE` 的
> 路由，`npm run dev` 后请求它，拿到 `hello`。（wrangler 4.128.0 实测通过。）

本地跑数据库迁移（在 `backend/` 下）：

```bash
npx wrangler d1 migrations apply ptapp-local --local
```

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

## manifest.json 字段

```json
{
    "schemaVersion": 2,
    "version": "1.0.0",
    "entry": "index.html",
    "display_name": { "zh-CN": "我的应用", "en-US": "My App" },
    "icon": "assets/icon.svg",
    "scopes": ["analytics:read", "ui:notify"],
    "backend": { "entry": "_backend/worker.js", "routes": ["/api/*"], "...": "..." }
}
```

- **`schemaVersion` 有 `backend` 段就必须是 `2`**。写成 1 会让平台**静默忽略**后端，
  跑出一个「前端正常、所有 API 404」的应用 —— `npm run package` 会拦下这种情况
- `version` 每次上传新版本**必须递增**
- `id` 是**可选的**（平台创建应用时也会分配）。但写了就会被按创建口径校验：
  匹配 `^[a-z0-9][a-z0-9-]{0,49}$`（**最长 50 字符**）、不能是保留字
  （`www` / `api` / `admin` / `app` / `console` / `ptengine` …），也不能用
  `pt-` 前缀（那是平台自己的官方应用命名空间）。完整名单见 `scripts/rules.json`
- `icon` 指向包内相对路径，文件必须真实存在（放 `web/public/assets/`）
- `display_name` 只在点「从应用包填入名称与图标」时被取用；平台显示的名字
  是用户在工作区里给这个应用起的那个
- 各项声明有上限：`backend.vars` / `backend.secrets` 各 64 条、
  **`backend.egress` 32 条**（超了上传被拒，报 `BACKEND_EGRESS_TOO_MANY`）
- `backend` 段里各字段的含义见[资源由平台注入](#资源由平台注入)

### 权限声明（manifest.scopes）

合法值只有四个：`analytics:read`、`profile:read`、`user:read`、`ui:notify`。
写未定义或拼错的值会导致**上传校验失败**。遵循最小权限原则。

平台当前只校验取值合法性，尚未据此放行/拦截；但 `ctx.requireScope()` 已经会按
token 里的 scopes 强制校验，所以后端可以现在就写。

### 校验规则从哪来

`scripts/rules.json` 是 Ptengine 契约包的**生成快照**（名字正则、`appId` 规则、各项上限、
出站禁域表、合法 scope），由维护者用 `npm run sync-rules` 更新，**不要手改**。
好处是本地 `npm run doctor` 的判定与平台上传校验逐字一致。
注意出站禁域表比早期版本更严：平台自身域名与本机/保留地址都在里面，以 `rules.json` 为准。

---

## 发布与 CI

```bash
npx ptx deploy --dry-run           # 只打印将要做什么，不发请求
npx ptx deploy --publish           # 上传并立即发布
npx ptx deploy --publish --stream  # 同上，流式打印九步进度（否则要等 20–40 秒）
```

需要环境变量 `PTENGINE_TOKEN` 与 `PTENGINE_APP_ID`，可选 `PTENGINE_API_BASE`（默认线上）。
仓库里带了一份可用的 GitHub Actions 工作流：`.github/workflows/deploy.yml`（打 `v*` tag 即发布）。

平台收到包后自动做：校验 → 前端进对象存储 → 建资源 → 跑迁移 → 组装密钥绑定 →
推后端 → 原子切版本指针 → **健康探针（失败自动回滚）**。
所以 `--publish` 返回成功就意味着线上真的在跑。

> `PTENGINE_TOKEN` 在「自定义应用管理」→ 部署令牌 生成，按应用授权、可随时撤销；
> 令牌只显示一次，请立刻存进 CI 的 secrets。不要用账号级令牌 ——
> CI 里任何一个恶意依赖都能读到它。
>
> **令牌绝不能进仓** —— 写死在代码、`.env` 提交、CI 配置文件明文都算。
> `npx ptx doctor` 会扫已入库的文件，发现令牌明文会直接报 bad。

---

## 版本号别搞混

| 位置 | 属于谁 |
|---|---|
| git tag / Release | **脚手架**（Ptengine 维护，客户仓里通常已 `rm -rf .git`） |
| `manifest.json` 的 `version` | **这个应用**（每次上传必须递增，平台读它） |
| `package.json` 的 `version` | 这个应用（npm 惯例，平台不读） |

`manifest.schemaVersion` 是**平台契约版本**，不是你的版本号 —— 有 `backend` 段就必须是 `2`。
写成 1 会让平台**静默忽略**后端，跑出一个「前端正常、所有 API 404」的应用。

脚手架与 `@ptengine/*` 包的配套关系见 [CHANGELOG 的兼容矩阵](./CHANGELOG.md#兼容矩阵)。
`ctx.vars` 需要 `@ptengine/app-backend` ≥ `0.2.0`：`0.x` 的 caret 不跨 minor，
所以 `package.json` 里必须写 `^0.2.0`（写 `^0.1.0` 装到的运行时没有 `ctx.vars`）；
改完区间要重跑一次 `npm install` 刷 `package-lock.json`。

**已经在开发中的项目通常不需要升级脚手架** —— 它是一次性起点，不是运行时依赖。
只在两种情况下需要跟进：CHANGELOG 里出现 **major**（平台约定有破坏性变更，照该版本的
「升级指引」改），或者想要新版本引入的能力。

---

## 出问题了

先跑 `npm run doctor`。它没点名的情况见 [`docs/troubleshooting.md`](./docs/troubleshooting.md)。
