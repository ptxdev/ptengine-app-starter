# Ptengine App Starter

开发 **Ptengine X 自定义应用**（Custom App）的官方脚手架。**v3 起同时带前端与后端** ——
克隆下来就能写业务代码，构建、打包、部署所需的约定都已配好。

```
my-app/
├── manifest.json        应用声明（schemaVersion 2，含 backend 段）
├── web/                 前端：静态产物，平台以 iframe 加载
├── backend/             后端：一个 Cloudflare Worker，只服务 /api/*
└── shared/api.ts        前后端共享的类型 —— 唯一真相来源
```

前后端打在**同一个 zip、同一个版本号**，一起发布、一起回滚。

## 快速开始

取一个正式版本（推荐，而不是直接 clone 主分支）：

```bash
git clone --branch v3.0.0 --depth 1 https://github.com/ptxdev/ptengine-app-starter.git my-app
cd my-app && rm -rf .git && git init
```

```bash
npm install
npm run dev        # 同时起前端与后端，并签发真 token（鉴权链路本地跑通）
npm run doctor     # 体检：约定有没有被改坏
npm run build      # 类型检查 + 构建前端 + 打包后端
npm run package    # 组装可直接上传的 zip
```

把 `npm run package` 产出的 zip 上传到 Ptengine X →「自定义应用管理」，
或在 CI 里 `npx ptx deploy --publish`。

> **⚠️ 平台前置依赖**：v3 的后端能力需要平台侧 App Runtime 已上线，
> 且需要 `@ptengine/app-sdk` 提供 `PtApp.auth.getAppToken()`（^2.0.0）。
> 在它们就绪之前，**`npm run dev` 的本地开发完全可用**，但上传后前端调
> `/api/*` 会拿到一个说明性的错误。只要纯静态应用的话，把 `manifest.json` 的
> `backend` 段删掉、`schemaVersion` 改回 `1` 即可。

## 用 AI 写这个应用？

项目根的 [`AGENTS.md`](./AGENTS.md) 是给 AI 编码助手的说明（Cursor / Claude Code /
Copilot / Codex / Gemini 都会自动读取；`CLAUDE.md` 是指向它的指针）。里面写清了
平台的硬边界与"改错了长什么样"。

**建议开工前让 AI 先读三份文件**：
`AGENTS.md`、`node_modules/@ptengine/design-components/llms.txt`（组件清单与设计规范）、
`node_modules/@ptengine/app-sdk/data-query.llms.txt`（取数场景与参数）。

**改完让它跑 `npm run doctor`** —— 这个命令就是为此存在的：它把 AGENTS.md 里
那些"违反了不报错"的约定变成一条可执行的检查。

## 本地开发

```bash
npm run dev
# 端口冲突时：PTX_WEB_PORT=5273 PTX_API_PORT=8887 npm run dev
```

它做三件事：

1. 生成一对临时 **Ed25519** 密钥 —— 公钥进 `backend/.dev.vars`，私钥给 vite
2. 起 `wrangler dev`（后端），本地 D1 / KV 由 miniflare 模拟
3. 起 `vite`（前端），`/api` 代理到后端，并挂一个 `/__ptx/token` 端点签发令牌

**本地的鉴权是真的，不是绕过的。** 前端拿到真 token、后端做真验签，所以
`aud` 不匹配、令牌过期、scope 不足这些线上才会遇到的问题，**本地就会现形**。

- 想模拟别的站点 / 权限：改 `web/.ptx-dev-key.json` 的 `sid` / `scopes` 后重启
- 自己的密钥（如 `SHOPIFY_TOKEN`）写在 `backend/.dev.vars`，`ptx dev` **不会覆盖**它们
- 这两个文件都在 `.gitignore` 里，**绝不要提交**

本地跑数据库迁移（在 `backend/` 下）：

```bash
npx wrangler d1 migrations apply ptapp-local --local
```

## 前端

`web/` 里的内容与 v2 完全一致（三条硬约定、四处 UI 接线都没变），只是从
项目根移到了 `web/` 子目录。

应用由平台以微前端（跨源 iframe）加载，平台注入 `window.PtApp`：

```ts
import { getPtApp } from './pt-app';

const app = getPtApp();
app?.context;              // { appId, sid, locale, theme, initialPath }
app?.ui.toast('已保存');
await app?.ui.confirm({ message: '确定吗？' });
app?.nav.syncRoute('detail');
```

取站点数据（平台中介执行，profile 锁死在服务端）：

```ts
const res = await app?.data.query({
    queryType: 'funnel_insight',
    params: { timeRange: { key: 'lastDays', days: 7 },
              steps: [{ event: 'page_view' }, { event: 'purchase' }] }
});
```

18 个 queryType 的完整参数说明见 `node_modules/@ptengine/app-sdk/data-query.llms.txt`。
单次最多 5000 行；`describe()` 可在运行时发现平台放开的场景。

## 调自己的后端

**不要手写 `fetch('/api/...')`**，用 `web/src/api.ts` 的 `api()`：

```ts
import { api } from './api';

const data = await api('GET /orders', { query: { days: '7' } });
//    ^? OrdersResponse —— 类型来自 shared/api.ts
```

它兜住了：取令牌、到期前自动续期、401 自动重试一次、解开错误信封。

前后端**同源**（线上都在 `<appId>.app.ptengine.ai`，本地由 vite proxy 代过去），
所以没有 baseURL、没有 CORS、没有第三方 cookie 的事。

### 加一个新接口

1. `shared/api.ts` 的 `ApiRoutes` 里加一项
2. `backend/src/index.ts` 的 `routes` 里加 handler —— **不加 tsc 就报错**
3. 前端 `api('METHOD /path', ...)`

## 后端

```ts
// backend/src/index.ts
import { createApp } from './runtime';
import type { ApiRoutes } from '../../shared/api';

export default createApp<ApiRoutes>({
    routes: {
        'GET /orders': async (ctx) => {
            const cached = await ctx.kv.get('orders', 'json');
            if (cached) return cached;

            const res = await ctx.fetch('https://api.shopify.com/...', {
                headers: { 'X-Shopify-Access-Token': ctx.secrets.SHOPIFY_TOKEN }
            });
            if (!res.ok) throw ctx.error(502, 'SHOPIFY_UNAVAILABLE');
            /* ... */
        }
    }
});
```

`createApp` 兜掉的事（让正确的事成为默认）：

| 它做的 | 为什么不交给你做 |
|---|---|
| 验签令牌（JWKS + kid 缓存 + 时钟偏移） | 忘记验签 = 后端完全裸奔，而且**本地测不出来** |
| 校验 `aud === app:<appId>` | 漏了就能被别的应用的令牌调用 |
| `ctx.auth` 一定是已验证身份 | 类型上就没有"未验证"这个状态可用 |
| 未声明的路由一律 404 | 避免意外暴露 |
| 统一错误信封，不透传栈 | 栈里常有内部路径与 SQL |
| 内建 `/api/__health` | 平台发布后用它探针，失败自动回滚 |

`ctx` 上能用的东西见 [`AGENTS.md`](./AGENTS.md#后端能用的东西ctx)。

### 资源由平台注入

`backend/wrangler.jsonc` **只服务本地开发**。线上有什么由 `manifest.json` 决定：

```json
"backend": {
    "resources": { "database": true, "kv": true, "files": false },
    "secrets": [{ "name": "SHOPIFY_TOKEN", "label": "Shopify Token", "required": true }],
    "egress": ["api.shopify.com"]
}
```

- **`resources`** —— 平台代你创建 D1 / KV / R2 并挂上绑定，你不需要 Cloudflare 账号
- **`secrets`** —— 只声明**名字**，值由你在应用管理页填。包里永远没有密钥
- **`egress`** —— 出站域名白名单。**缺省或空数组 = 完全禁止出站**

### 后端没有的能力

`Durable Objects`、`connect()`、`caches.default`、`request.cf`、
**Cron Triggers**、Queues、Workflows —— 详见 [`AGENTS.md`](./AGENTS.md) 的
「后端**没有**的能力」。其中 Cron 特别值得注意：Workers for Platforms 的
user worker 不支持它，`triggers.crons` 会被**静默丢弃**（无报错、定时永不触发）。
定时能力要等平台侧调度器。

## manifest.json

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
  跑出一个"前端正常、所有 API 404"的应用 —— `npm run package` 会拦下这种情况
- `version` 每次上传新版本**必须递增**
- `scopes` 合法值只有四个：`analytics:read`、`profile:read`、`user:read`、`ui:notify`
- `icon` 指向包内相对路径，文件必须真实存在（放 `web/public/assets/`）
- `display_name` 只在你点「从应用包填入名称与图标」时被取用；平台显示的名字
  是你在工作区里给这个应用起的那个

## 自动化部署

```yaml
# .github/workflows/deploy.yml —— 打个 tag，线上就更新了
on:
  push:
    tags: ['v*']
jobs:
  deploy:
    steps:
      - run: npm ci
      - run: npx ptx build
      - run: npx ptx package
      - run: npx ptx deploy --publish
        env:
          PTENGINE_TOKEN: ${{ secrets.PTENGINE_TOKEN }}
          PTENGINE_APP_ID: ${{ vars.PTENGINE_APP_ID }}
```

平台收到包后自动做：校验 → 前端进 R2 → 建资源 → 跑迁移 → 组装密钥绑定 →
推后端 → 原子切版本指针 → **健康探针（失败自动回滚）**。
所以 `--publish` 返回成功就意味着线上真的在跑。

先看看会做什么而不真发请求：`npx ptx deploy --dry-run`。

> `PTENGINE_TOKEN` 请用**按应用授权、可撤销**的令牌，不要用账号级令牌 ——
> CI 里任何一个恶意依赖都能读到它。

## ptx 命令

| 命令 | 作用 |
|---|---|
| `ptx dev` | 前端 + 后端 + 本地令牌签发 |
| `ptx build` | 类型检查 + 构建前端 + 打包后端（wrangler bundle） |
| `ptx package` | 组装 zip + 结构自检 |
| `ptx deploy` | 上传（`--publish` 立即发布，`--dry-run` 只看不发） |
| `ptx doctor` | 体检（`--deps` 额外查依赖漂移） |

## 版本与升级

脚手架自身走独立的语义化版本（git tag + Releases），与 `@ptengine/*` 包的版本号
是两条线；配套关系见 [CHANGELOG 的兼容矩阵](./CHANGELOG.md#兼容矩阵)。

注意区分三个 `version`：

| 位置 | 属于谁 | 谁维护 |
|---|---|---|
| git tag / Release | **脚手架** | Ptengine |
| `manifest.json` 的 `version` | **你的应用**（每次上传必须递增） | 你 |
| `package.json` 的 `version` | **你的应用**（npm 惯例，平台不读） | 你 |

`manifest.schemaVersion` 是**平台契约版本**，不是你的版本号。

**已经在开发中的项目要不要升级脚手架？** 通常不需要 —— 脚手架是一次性起点，
不是运行时依赖。只在两种情况下需要跟进：CHANGELOG 里出现 **major**
（说明平台约定有破坏性变更，照该版本的「升级指引」改），或者想要新版本引入的能力
（比如 v2 → v3 的后端）。

## 常见问题

**上传后左侧导航没出现应用？** 三个条件都要满足：这一版**已发布**、应用在
「探索应用」页里是**已固定**状态、以及你对它有访问权。都对了还没有就刷新页面。

**点进去白屏？** 打开控制台看有没有资源 404 —— 多半是 `web/vite.config.ts` 的
`base` 被改成了绝对路径。跑 `npm run doctor` 会直接告诉你。

**组件渲染出来没有样式？** 见 AGENTS.md 的「四处接线」，或直接跑 `npm run doctor`。

**页面正常、一打开弹窗就没样式？** `pt-ui` 挂在 `#root` 上了。Radix 浮层 portal 到
`document.body`，必须挂在 `<html>`。

**`window.PtApp` 是 undefined？** 只有经平台加载时才注入。本地请用 `npm run dev`。

**本地调 `/api/*` 一律 401？** 大概率是没用 `npm run dev` 启动（直接跑了 `vite`）——
`/__ptx/token` 端点需要 `ptx dev` 生成的密钥。它会返回 `PTX_DEV_KEY_MISSING` 说明这件事。

**上线后调 `/api/*` 报"当前平台/SDK 还不支持 PtApp.auth"？** 平台侧 App Runtime
或 `@ptengine/app-sdk@^2.0.0` 还没就绪，见页首的前置依赖说明。

**后端报 `RESOURCE_NOT_DECLARED`？** `manifest.json` 的 `backend.resources` 里
没把对应资源设为 `true`；本地还需要 `backend/wrangler.jsonc` 里有对应 binding。

**后端报 `SECRET_NOT_DECLARED`？** 密钥名没写进 `manifest.backend.secrets`，
或本地没写进 `backend/.dev.vars`。

**换成 Vue / Svelte 可以吗？** 前端可以，关键约定与框架无关（相对 `base`、
根级 `manifest.json`、`entry` 一致）。后端固定是 Cloudflare Worker。
