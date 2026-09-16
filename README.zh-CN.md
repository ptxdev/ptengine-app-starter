# Ptengine App Starter

> [English](README.md) | [中文](README.zh-CN.md)

[![latest tag](https://img.shields.io/github/v/tag/ptxdev/ptengine-app-starter)](https://github.com/ptxdev/ptengine-app-starter/tags)
[![Node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](https://nodejs.org)

开发 **Ptengine 自定义应用**（Custom App）的官方脚手架：前端由平台以跨源 iframe 加载，后端是一个可选的 Cloudflare Worker —— 两边打进**同一个 zip、同一个版本号**，一起发布、一起回滚。

## 快速开始

取一个正式版本，而不是直接 clone 默认分支：

```bash
git clone --branch v3.2.0 --depth 1 https://github.com/ptxdev/ptengine-app-starter.git my-app
cd my-app && rm -rf .git && git init
```

```bash
npm install
npm run dev        # 同时起前端与后端，并在本地签发真 token
npm run doctor     # 体检：平台约定有没有被改坏
npm run build      # 类型检查 + 构建前端 + 打包后端
npm run package    # 组装可直接上传的 zip
```

把 `npm run package` 产出的 zip 上传到 Ptengine 的「**自定义应用管理**」页，或在 CI 里跑 `npx ptx deploy --publish`。

> **平台前置依赖** —— 上传与发布需要 Ptengine 后台已接入 App Runtime；未接入时 `ptx deploy` 会得到 404 或 401。**本地 `npm run dev` 不受影响。**

## 用 AI 来写

先装上 Ptengine 的 skills，让编码助手了解这个平台：

```bash
npx skills add ptxdev/ptengine-skills          # 大多数助手
/plugin marketplace add ptxdev/ptengine-skills # Claude Code
```

然后直接描述你要什么 ——「*做一个看最近 7 天漏斗转化的看板，每一步能点开明细抽屉*」—— 交给它写。动手之前，让它先读这三份：

| 文件 | 它能给助手什么 |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | 平台的硬边界，以及「改错了长什么样」 |
| `node_modules/@ptengine/design-components/llms.txt` | 组件清单与设计规范 |
| `node_modules/@ptengine/app-sdk/data-query.llms.txt` | 18 个取数场景与参数说明 |

改完让它跑一次 `npm run doctor` —— 这个命令就是为此存在的：它把 `AGENTS.md` 里的约定变成一条可执行的检查，因为绝大多数违规都是**不报错**的。

## 目录里有什么

| 路径 | 是什么 |
|---|---|
| `web/` | 前端。纯静态产物，由平台以 iframe 加载并注入 `window.PtApp` |
| `backend/` | 后端。一个 Cloudflare Worker，只服务 `/api/*`。可选 |
| `shared/api.ts` | 前后端共享的接口契约 —— 唯一真相来源 |
| `manifest.json` | 应用声明：版本、入口、权限、后端资源、密钥、出站白名单 |
| `scripts/ptx*.mjs` | `ptx` 命令行：`dev` / `build` / `package` / `deploy` / `doctor` |

## 两种应用

|  | 只有前端 | 带后端 |
|---|---|---|
| `manifest.schemaVersion` | `1` | `2` |
| `backend/` 目录 | 删掉 | 保留 |
| `manifest.backend` 段 | 没有 | 有 |
| 数据从哪来 | `PtApp.data.query()` | 同前，外加自己的 `/api/*` |
| 适合 | 看板、平台内小工具 | 对接三方接口、自己存数据、要用密钥 |

不少应用根本不需要后端。改成轻应用只要：`rm -rf backend/`、删掉 `manifest.json` 的 `backend` 段、`schemaVersion` 改回 `1`。**其余什么都不用动** —— `tsconfig.json`、`package.json`、`scripts/` 下的文件都不用改。从 v3.2.0 起所有命令都按 manifest 自动分支：`dev` 只起 vite，`build` 跑 `tsc -b web`，`package` 产出纯前端的 zip。细节见 [`AGENTS.md`](./AGENTS.md#轻应用只有前端)。

## `ptx` 命令

| 命令（也可以 `npx ptx <command>`） | 作用 |
|---|---|
| `npm run dev` | vite + `wrangler dev` + 本地令牌端点。端口冲突用 `PTX_WEB_PORT` / `PTX_API_PORT` |
| `npm run doctor` | 查约定与 manifest 自洽性。`--deps` 额外报依赖漂移 |
| `npm run build` | 类型检查（web + backend + shared）+ vite build + wrangler bundle |
| `npm run package` | 组装 zip 并做结构自检 |
| `npm run deploy` | 上传。`--publish` 立即发布，`--stream` 流式打印进度，`--dry-run` 只打印不发请求 |

## 本地开发

**本地的鉴权是真的，不是绕过的。** `npm run dev` 会生成一对临时 Ed25519 密钥：公钥进 `backend/.dev.vars`，worker 用它真验签；私钥给前端签真 token。所以 `aud` 不匹配、令牌过期、scope 不足这些线上才遇得到的问题，本地就会现形。

你自己的配置与密钥写在 `backend/.dev.vars`，一行一个 `KEY=VALUE`；`ptx dev` 只重写它托管的 `PT_` 开头的键，你写的行原样保留。这个文件和 `web/.ptx-dev-key.json` 都在 `.gitignore` 里，**绝不要提交**。完整规则（包括值是怎么注入的、为什么改完要重启）见 [`AGENTS.md`](./AGENTS.md#本地配置backenddevvars)。

## 前端

平台注入 `window.PtApp`，统一通过 `web/src/pt-app.ts` 读取：

```ts
const app = getPtApp();
app?.context;                 // { appId, sid, locale, theme, initialPath }
app?.ui.toast('已保存');
app?.nav.syncRoute('detail');

const res = await app?.data.query({
    queryType: 'funnel_insight',
    params: { timeRange: { key: 'lastDays', days: 7 },
              steps: [{ event: 'page_view' }, { event: 'purchase' }] }
});
```

界面一律用 `@ptengine/design-components` 写 —— 不要 antd、MUI，也不要自己造基础控件 —— 这样应用才和平台本身观感一致。路由只能走 hash。这两条，以及让组件库真正生效的四处接线，都在 [`AGENTS.md`](./AGENTS.md) 里。

## 后端

```ts
export default createApp<ApiRoutes>({
    routes: {
        'GET /orders': async (ctx) => {
            const res = await ctx.fetch('https://api.shopify.com/...', {
                headers: { 'X-Shopify-Access-Token': ctx.secrets.SHOPIFY_TOKEN }
            });
            if (!res.ok) throw ctx.error(502, 'SHOPIFY_UNAVAILABLE');
            /* ... */
        }
    }
});
```

`createApp` 替你兜住：每个请求都验签、`aud` 锁到你这个应用、未声明的路由一律 404、错误统一封装不漏栈，以及内建的 `/api/__health` —— 平台发布后用它探针，失败自动回滚。前端别手写 fetch，用 `web/src/api.ts` 的 `api('GET /orders', { query: { days: '7' } })`：类型来自 `shared/api.ts`，取令牌、续期、401 重试都已经处理好。

数据库、KV、R2、密钥、出站白名单全部**在 `manifest.json` 里声明、由平台创建并注入** —— 你不需要 Cloudflare 账号，`backend/wrangler.jsonc` 只服务本地开发。`ctx` 上有什么、后端**没有**哪些能力（Durable Objects、Cron Triggers、Queues……）、密钥与配置项有什么区别，见 [`AGENTS.md`](./AGENTS.md#后端能用的东西ctx)。

## manifest.json

```json
{
    "schemaVersion": 2,
    "version": "1.0.0",
    "entry": "index.html",
    "icon": "assets/icon.svg",
    "scopes": ["analytics:read", "ui:notify"],
    "backend": { "entry": "_backend/worker.js", "routes": ["/api/*"], "...": "..." }
}
```

`version` 每次上传必须递增；只要有 `backend` 段，`schemaVersion` 就必须是 `2`；`scopes` 的合法值只有 `analytics:read`、`profile:read`、`user:read`、`ui:notify` 四个。每个字段、各项上限，以及与平台逐字同源、落在 `scripts/rules.json` 里的校验规则，都写在 [`AGENTS.md`](./AGENTS.md#manifestjson-字段)；`npm run doctor` 会在你上传之前先拦一遍。

## 在 CI 里发布

```yaml
on:
  push:
    tags: ['v*']
jobs:
  deploy:
    steps:
      - run: npm ci
      - run: npx ptx doctor
      - run: npx ptx build && npx ptx package
      - run: npx ptx deploy --publish
        env:
          PTENGINE_TOKEN: ${{ secrets.PTENGINE_TOKEN }}
          PTENGINE_APP_ID: ${{ vars.PTENGINE_APP_ID }}
```

仓库里已经带了一份可用的工作流：[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)。`PTENGINE_TOKEN` 在「**自定义应用管理**」页生成 —— 按应用授权、可随时撤销、只显示一次。**绝不能进仓**，`ptx doctor` 会扫已入库的文件找明文令牌。发布时平台依次做：校验包 → 前端进对象存储 → 创建资源 → 跑迁移 → 部署 worker → 原子切版本指针 → 健康探针，探针失败自动回滚。

## 版本与升级

脚手架自身走独立的语义化版本，以 git tag 和 Releases 记在本仓，与 `@ptengine/*` 包的版本是两条线 —— 配套关系见 [CHANGELOG](./CHANGELOG.md) 的[兼容矩阵](./CHANGELOG.md#兼容矩阵)。一个项目里有三个 `version`：git tag 属于**脚手架**，`manifest.json` 与 `package.json` 里的属于**你的应用**；`manifest.schemaVersion` 是**平台契约版本**，不是你的版本号。

**已经在开发中的项目通常不需要升级脚手架** —— 它是一次性起点，不是运行时依赖。只有两种情况需要跟进：CHANGELOG 里出现 **major**（照该版本的升级指引改），或者你想要新版本引入的能力。

## 常见问题

**上传后打开白屏？** 多半是 `web/vite.config.ts` 的 `base` 被改成了绝对路径。跑 `npm run doctor` 会直接告诉你。

**组件渲染出来没有样式？** 四处接线漏了一处 —— 见 [`AGENTS.md`](./AGENTS.md)，或者直接跑 `npm run doctor`。

**`window.PtApp` 是 undefined？** 只有经平台加载时才注入。本地请用 `npm run dev`。

**本地调 `/api/*` 一律 401？** 大概率是直接跑了 `vite` 而不是 `npm run dev`：`/__ptx/token` 端点需要 `ptx dev` 生成的密钥。

**后端报 `RESOURCE_NOT_DECLARED` / `SECRET_NOT_DECLARED` / `VAR_NOT_DECLARED`？** 这个名字没在 `manifest.json` 里声明，或者本地没写进 `backend/.dev.vars`。`npm run doctor` 会告诉你缺哪个。

更多问题（含发布与配置的坑）见 [`docs/troubleshooting.md`](./docs/troubleshooting.md)。
