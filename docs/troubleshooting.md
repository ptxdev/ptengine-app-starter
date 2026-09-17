# 常见问题

README 里列了最常撞上的五条，这里是全集。绝大多数问题 `npm run doctor` 会直接点名，
遇到问题先跑它。硬约定与背后的原因见 [`AGENTS.md`](../AGENTS.md)。

## 安装与发布

**上传后左侧导航没出现应用？**
三个条件都要满足：这一版**已发布**、应用在「探索应用」页里是**已固定**状态、以及你对它有访问权。
都对了还没有就刷新页面。

**上传被拒，报 `MANIFEST_MISSING`？**
`manifest.json` 必须在 zip 的**根级**。用 `npm run package` 打包（它用 staging 目录保证这一点），
不要自己 `zip -r`。

**上传被拒，报 `ENTRY_NOT_FOUND`？**
`manifest.entry` 与实际构建入口不一致（默认是 `index.html`）。

**上传被拒，报 `BACKEND_EGRESS_TOO_MANY`？**
`backend.egress` 最多 32 条。上限与出站禁域表都来自 `scripts/rules.json`，
`npm run doctor` 会先于上传拦下来。

**`ptx deploy` 返回 404 或 401？**
要么平台后台还没接入 App Runtime（此时上传/发布整体不可用，但 `npm run dev` 完全正常），
要么 `PTENGINE_TOKEN` 无效或已撤销 —— 到「自定义应用管理」→ 部署令牌 重新生成。

**想先看看会做什么、不真发请求？**
`npx ptx deploy --dry-run`。想看实时进度而不是等 20–40 秒一次性返回，
用 `npx ptx deploy --publish --stream`。

## 前端

**点进去白屏？**
打开控制台看有没有资源 404 —— 多半是 `web/vite.config.ts` 的 `base` 被改成了绝对路径。
跑 `npm run doctor` 会直接告诉你。

**组件渲染出来没有样式？**
见 AGENTS.md 的「四处接线」，或直接跑 `npm run doctor`。

**页面只有结构没有样式 / 按钮变成纯文字？**
组件的 DOM 层级都对、文案也在，但颜色、圆角、间距、hover 叠加层全没了，按钮看着像一段纯文本 ——
这是 Tailwind **没扫到组件库的 class**。组件的 class 字符串在**已编译的库产物里**
（`node_modules/@ptengine/design-components/dist/`），不在你的源码里，必须由
`web/tailwind.config.js` 的 `content` 显式覆盖到。

最典型的踩法是把那条 glob 写成相对路径 `'./node_modules/@ptengine/design-components/dist/**'`：
Tailwind 把相对 glob 按**配置文件所在目录**（也就是 `web/`）解析，而依赖装在**项目根**的
`node_modules/` —— 带后端的布局下根本没有 `web/node_modules/`，这条 glob 于是一个文件都匹配不到。
它不报错、不告警，构建照样"成功"，只有 CSS 产物小一个量级（十几 KB 而不是近百 KB）。
（v1/v2 的纯前端应用 `node_modules/` 就在配置旁边，所以同样的写法当时看着没问题。）

修法：按**包名**解析成绝对路径，装在哪一层都能找到 —— 见 `web/tailwind.config.js` 里
`resolveDesignComponentsDist()` 的写法，不要改回相对路径。

自查：`npm run doctor` 会**真的去跑这条 glob**，匹配不到文件就报
「tailwind content 里组件库 dist 的 glob 一个文件都匹配不到」。
也可以直接量一下产物：`wc -c web/dist/assets/*.css`，再 `grep -c 'bg-primary' web/dist/assets/*.css`。

**页面正常、一打开弹窗就没样式？**
`pt-ui` 挂在 `#root` 上了。Radix 浮层 portal 到 `document.body`，必须挂在 `<html>`。

**`window.PtApp` 是 undefined？**
只有经平台加载时才注入。本地请用 `npm run dev`。

**在平台内 dev 模式下，页面永久停在「未检测到 window.PtApp」？**
`web/src/main.tsx` 里的 `await installDevHost()` 被删了。那一行必须保留 ——
dev 模式下 `window.PtApp` 是异步挂上的，去掉它 `useMemo(getPtApp, [])` 会读到 `null` 且永不重算。
本地 `npm run dev` 完全正常，所以极难自查。

**取数返回 0 行？**
事件名或属性名在站点里不存在。猜错不报错，静默返回 0 行 —— 用站点里真实存在的名字。

**路由跳转后刷新就 404？**
用了 `BrowserRouter` / `history.pushState('/detail')`。只能用 hash 路由，
要反映到地址栏就调 `window.PtApp.nav.syncRoute('detail')`。

## 后端

**本地调 `/api/*` 一律 401？**
大概率是没用 `npm run dev` 启动（直接跑了 `vite`）—— `/__ptx/token` 端点需要 `ptx dev` 生成的密钥。
它会返回 `PTX_DEV_KEY_MISSING` 说明这件事。

**上线后调 `/api/*` 报「当前平台/SDK 还不支持 PtApp.auth」？**
平台侧 App Runtime 尚未接入，或 `@ptengine/app-sdk` 版本过低（`PtApp.auth.getAppToken()` 需要 `^2.0.0`）。

**后端报 `RESOURCE_NOT_DECLARED`？**
`manifest.json` 的 `backend.resources` 里没把对应资源设为 `true`；
本地还需要 `backend/wrangler.jsonc` 里有对应 binding。

**后端报 `SECRET_NOT_DECLARED`？**
密钥名没写进 `manifest.backend.secrets`，或本地没写进 `backend/.dev.vars`。

**后端报 `VAR_NOT_DECLARED`？**
同一件事的配置项版本，按顺序查三处：

1. 名字写进 `manifest.json` 的 `backend.vars` 了吗（**声明才会注入**）
2. 线上：应用管理页的「**配置**」页签填了值吗（没 `default` 的必填项不填就没有值）；
   刚改完值的话，注意**配置项要重新发布才生效**（见 AGENTS.md 的「密钥 vs 配置」）
3. 本地：`backend/.dev.vars` 里有这一行吗

`npm run doctor` 会把 1 和 3 对一遍，直接告诉你缺哪个名字。

**在管理页改了配置项，线上还是旧值？**
配置项（`vars`）在**发布时**被当作 `plain_text` 拷进 worker，必须重新发布一版才生效。
密钥（`secrets`）不是拷贝，改完下一个请求就是新值。要热改的开关别放 `vars`。

**`ctx.db` 突然变成了一个字符串？**
`backend.vars` 或 `backend.secrets` 里的名字占用了 worker 内建 binding 名
（`DB` / `KV` / `FILES` / `PT_GATEWAY` …），发布期生成了两个同名 binding，把资源遮掉了。改名。

**定时任务不触发？**
Workers for Platforms 的 user worker 不支持 Cron Triggers，`triggers.crons` 会被**静默丢弃**
（无报错、定时永不触发）。定时能力要等平台侧调度器。

**出站请求被拒？**
`backend.egress` 是域名白名单，**缺省或空数组 = 完全禁止出站**。只写主机名，
不要带协议、端口或路径；`*.` 只通配一级；不允许写平台自身域。

**数据库迁移没跑？**
`backend/migrations/NNNN_描述.sql` 的序号必须连续不跳号（`npm run package` 会校验）。
已发布的迁移文件不要改 —— 平台按序号记录「已应用到哪一版」，改旧文件不会重跑，要改就加新文件。

## 其他

**换成 Vue / Svelte 可以吗？**
前端可以，关键约定与框架无关（相对 `base`、根级 `manifest.json`、`entry` 一致）。
后端固定是 Cloudflare Worker。

**`npm run build` 报 `TS5083: Cannot read file .../backend/tsconfig.json`？**
你在用 v3.2.0 之前的脚手架做轻应用。升到 v3.2.0，或按 CHANGELOG 3.2.0 条目手动修 —— 从那一版起
删掉 `backend/` 与 manifest 的 `backend` 段之后，所有命令会自动切成纯前端模式，不需要改任何脚手架文件。

**manifest 没有 `backend` 段，但 `backend/` 目录还在？**
`npm run dev` / `build` 会警告并按纯前端继续。这通常是改了一半：代码还在，
但上传后所有 `/api` 请求都会 404。反过来（有 `backend` 段、目录不在）直接报错。
