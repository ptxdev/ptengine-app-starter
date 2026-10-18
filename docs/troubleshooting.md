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
`npm run ptx -- deploy --dry-run`。想看实时进度而不是等 20–40 秒一次性返回，
用 `npm run ptx -- deploy --publish --stream`。

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

**已经生成出来的应用怎么救**：不必重新生成。要么把 `web/tailwind.config.js` 整个换成脚手架的新版本
（推荐，装在哪一层都不用管），要么最小改动 —— 把那条 glob 的 `./node_modules/…` 改成
`'../node_modules/@ptengine/design-components/dist/**/*.{js,cjs}'`（多一个 `../`，从 `web/` 退到项目根）。
改完重新构建，`wc -c web/dist/assets/*.css` 应该从十几 KB 跳到近百 KB。

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
先确认你走的是平台调度器（manifest `backend.jobs` + `jobs:run`，见 AGENTS.md 的「定时任务」）。
Workers for Platforms 的 user worker 不支持 Cron Triggers，`wrangler.jsonc` 里写 `triggers.crons`
会被**静默丢弃**（无报错、定时永不触发）。本地更不会按时触发：本地 `ctx.pt.jobs.*` 只是内存桩，
要运行任务路由用 `npm run ptx -- job run <type>`。

> `ctx.auth.trigger` / `preview`、`ctx.requireTrigger()` 与 `ctx.pt.jobs.*` 需要升级到含定时任务的
> `@ptengine/app-backend` 版本后才生效；旧版本上 tsc 会说这些属性不存在。

**出站请求被拒？**
`backend.egress` 是域名白名单，**缺省或空数组 = 完全禁止出站**。只写主机名，
不要带协议、端口或路径；`*.` 只通配一级；不允许写平台自身域。

**数据库迁移没跑？**
`backend/migrations/NNNN_描述.sql` 的序号必须连续不跳号（`npm run package` 会校验）。
已发布的迁移文件不要改 —— 平台按序号记录「已应用到哪一版」，改旧文件不会重跑，要改就加新文件。

## 定时任务与本地网关

**`npm run ptx -- job run` 报「没找到本地开发密钥」或「请求本地 worker 失败」？**
它要连正在跑的 `npm run dev`：先在另一个终端启动它；后端端口改过的话，两边用同一个 `PTX_API_PORT`（缺省 8787）。

**`npm run ptx -- job run` 报「backend.jobs 里没有类型 …」？**
`<type>` 要与 `manifest.json` 的 `backend.jobs[].type` 完全一致；`--params` 必须是 JSON **对象**
（shell 里用单引号包住：`--params '{"channel":"email"}'`）。

**`npm run ptx -- job run` 打印的结果是 `none` / `invalid` / `too_large`？**

- `none` —— 平台没东西可采集：没返回 `archive`，或者不是 2xx、不是 JSON（括号里写了是哪种）。
  只想跑副作用、不需要存档的任务，`none` 就是正常结果。
- `invalid（原因）` —— 返回了 `archive` 但不合规，原因里点名字段（如 `archive.markdown 必填`）。
  运行本身不算失败，但平台不会采集。照原因改返回值：`{ archive: { title?, markdown, files? } }`。
- `too_large` —— **整个响应体**的 UTF-8 字节数超过 `scripts/rules.json` 的 `jobResult.maxBytes`，平台不采集。
  `files` 也算在响应体里，把内容挪进 `files` 不会变小；要精简正文 / 附件，让整个响应体控制在 `jobResult.maxBytes` 以内。
- `stored` —— 平台会采集这份结果。

**任务路由返回 403 `JOB_ONLY`？**
路由第一行是 `ctx.requireTrigger('job')`，而这次请求来自用户（前端 `api()`、curl 带用户令牌）。
这是设计行为：本地用 `npm run ptx -- job run` 调，线上由平台调度器调。

**本地 `ctx.pt.jobs.*` 报 403 `SCOPE_DENIED`（令牌里没有 `jobs:run`）？**
本地 dev token 的 scopes 照抄 `manifest.json` 的 `scopes`。在 manifest 里加 `"jobs:run"` 后**重启**
`npm run dev`（临时改 `web/.ptx-dev-key.json` 的 `scopes` 只影响前端拿到的令牌，下次 `ptx dev` 会被重写；`npm run ptx -- job run` 始终按 manifest 算）。

**本地 `ctx.pt.jobs.*` 建的任务重启后没了？**
本地网关桩 `ptx-local-gateway` 是内存存储，`ptx dev` 重启即清空。它也不校验 cron / 时区 / 配额，以平台为准。

**本地 `ctx.pt.query()` / `ctx.pt.asset.*` / `ctx.pt.ai.*` 返回 501 `PT_GATEWAY_NOT_BOUND`，日志里还多一条 `pt-gateway-*-failed`？**
预期如此。本地网关桩只实现 `ctx.pt.jobs.*`（`ctx.pt.notify.email` / `notify.channel` / `notify.listChannels` / `ctx.pt.render.chart` 转给本地推送 / 图表桩），其余路径一律 501；提示语是笼统的
「本地没有数据网关……请在平台部署后联调」（不再点名缺哪个 scope），运行时同时记一条
`pt-gateway-query-failed` / `pt-gateway-asset-failed` 日志。取数、资产读写与 AI 调用请在平台部署后联调。

**在 `backend/` 里直接跑 `wrangler dev`，报找不到服务 `ptx-local-gateway` / `ctx.pt.*` 全挂？**
`backend/wrangler.jsonc` 的 `PT_GATEWAY` 绑的是同会话里的 `ptx-local-gateway`，只有 `ptx dev`
（`wrangler dev -c wrangler.jsonc -c ../scripts/local-gateway/wrangler.jsonc`）会把它一起拉起来。
用 `npm run dev`，不要绕过它。

### 推送 / 图表 / 通知渠道本地桩

- **`ctx.pt.notify.email` / `notify.channel` / `notify.listChannels` / `ctx.pt.render.chart` 本地 503 `PTX_STUB_UNAVAILABLE`**：本地桩（`127.0.0.1:8788`）没起来。用 `npm run dev` 启动（不要单独跑 `wrangler dev`）；
  横幅里若是「推送 / 图表本地桩没起来（…EADDRINUSE）：8788 被占」，是 8788 被别的进程（常见是另一个 `ptx dev`）占了，停掉它再重启。
  8788 被另一个 `ptx dev` 占用时请求可能成功，但邮件和图片会写到那个项目的 `.ptx/`；渠道消息也写到那个项目，且渠道目录读的是那个项目的
  `.ptx/channels.json`（会出现莫名的 404 或列表与本项目不符）。
  消息里写「wrangler.jsonc 缺 vars.PTX_STUB_ORIGIN」的，是 `scripts/local-gateway/wrangler.jsonc` 被改坏了，补回 `"PTX_STUB_ORIGIN": "http://127.0.0.1:8788"` 或升级 starter。
- **`ctx.pt.render.chart` 本地 501 `PTX_RENDER_DEPS_MISSING`**：可选依赖 `echarts` / `@resvg/resvg-js` 没装上（少见平台没有 resvg 预编译包）。
  重跑 `npm install`，或 `npm i --save-optional echarts@^5.6.0 @resvg/resvg-js@^2.6.2`。线上渲染在平台侧，不受影响。
- **本地 403 `SCOPE_DENIED`（requiredScope: notify:send）**：manifest 的 `scopes` 没有 `notify:send`，加上后重启 `npm run dev`（本地令牌照抄 manifest）。
- **直接访问本地桩得到 421 `PTX_STUB_BAD_HOST`**：本地桩只认 `127.0.0.1:8788` / `localhost:8788` 这两个 Host（防 DNS rebinding 读到 outbox），换用这两个地址打开。
- **本地看到的邮件和预览面板里不一样**：本地外框是简化版、清洗只删平台一定会删的东西；以产品里的预览面板为准。
- **`ctx.pt.notify.channel` 本地 404 `NOTIFY_CHANNEL_NOT_FOUND`**：项目里有 `.ptx/channels.json` 且没有这个名字 —— 补上它，或删掉这个文件（没有文件时任何合法名字都接受）。
  消息里写「不合规」的，是名字不符合规则（小写字母、数字、`-`、`_`，最多 64 个字符，不能以 `-` / `_` 开头），线上也不可能有这个渠道。
- **本地 500 `PTX_STUB_FAILED`，消息提到 `.ptx/channels.json`**：文件格式不对，应为 `[{ "name": "alerts", "type": "slack" }]`（type 是 slack / teams / chatwork / webhook）。
- **本地 `listChannels()` 回 `[]`**：没有 `.ptx/channels.json`。线上的渠道由工作区管理员在「管理 → 通知渠道」里配置。
- **本地 `.ptx/outbox/…/<seq>.channel.json` 和线上运行记录里的渠道存档对不上**：本地文件是简化版 ——
  `message.link` 是原始 `{ label, path }`（不展开；线上存展开后的 `{ label, url }`）、多一个 `status` 字段（线上没有）、`rendered` 为 `null`（线上是平台渲染出的渠道请求体）、`delivery` 恒为 `null`（本地从不投递，线上存投递结果）。属预期，不是 bug。
  另外，线上存档的 `rendered` 与实际发出的体只是语义相等（键序可能不同），不能用来重算 webhook 签名。
- **本地 400 `NOTIFY_CHANNEL_MESSAGE_INVALID`**：看 `e.detail.field` 是哪个字段（线上同样带）。
  - `message.imageUrl`：本地只收 `ctx.pt.render.chart()` 本地桩返回的 `http://localhost:8788/__ptx/media/…`（或路径形状同平台 media 地址的 https）；外链图片线上同样会被拒。
  - `message.link.path`：只接受应用内路径 —— 不能带 scheme（以字母开头、由字母 / 数字 / `+` `.` `-` 组成并紧跟冒号的前缀，如 `https:`、`javascript:`，所以 `reports:42` 也算），
    不能以 `//` 开头、去掉一个前导 `#/` / `/` 后也不能再以 `/` 开头，`?` 之前不能有 `.` / `..` 路径段（含 `%2e` 编码）。线上同口径拒。
- **本地 `notify.channel` 能过、线上 404**：线上的名字由管理员配置，且可能没对本应用开放（「可用应用」）；请管理员核对。
- **报「notifyChannel 段缺 …（规则快照过旧）」**：使用者升级 starter；维护者跑 `npm run sync-rules`。
- `.ptx/` 可以随时删除（已在 `.gitignore`）。

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
