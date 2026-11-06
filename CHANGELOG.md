# 更新日志

本脚手架的所有版本变更记录于此。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号的归属**：这里记录的是**脚手架自身**的版本（对应 git tag 与 Releases）。
> `package.json` 与 `manifest.json` 里的 `version` 字段属于**你的应用**，
> clone 之后由你自己维护，与本文件无关。

## 兼容矩阵

| 脚手架版本 | `@ptengine/app-sdk` | `@ptengine/app-backend` | `@ptengine/design-components` | manifest `schemaVersion` | 说明 |
|---|---|---|---|---|---|
| v3.9.0 | `^2.11.0` | `^0.10.0` | `^0.5.0` | **2**（轻应用 1）| 热图截图：前端 `PtApp.heatmap.capture / getCapture`（app-sdk 2.11），后端 `ctx.pt.heatmap.capture / getCapture`（app-backend 0.10），需 `analytics:read`；推送 `imageUrl` 也收本应用的热图截图。**`0.x` 的 caret 不跨 minor，旧项目要手改区间再 `npm install`** |
| v3.8.0 | `^2.10.0` | `^0.9.0` | `^0.5.0` | **2**（轻应用 1）| 定时任务与推送（`jobs:run` / `notify:send`、`backend.jobs`、`ctx.pt.jobs.*` / `ctx.pt.notify.send`、`PtApp.subscriptions.open`）。另含即时通知声明 `backend.notify.instant`（app-sdk 2.10.0 起）。邮件推送在平台侧暂未开放 |
| v3.7.1 | `^2.8.0` | `^0.8.0` | `^0.5.0` | **2**（轻应用 1）| 本地 dev token 的 `scopes` 改为照抄 `manifest.json`（以前写死四项，声明了 `asset:read` / `asset:write` / `ai:invoke` 的应用本地 403）；`AGENTS.md` 与后端模板头注释的能力清单对齐到 app-sdk 2.8 / app-backend 0.8 的实际导出。依赖区间不变 |
| v3.7.0 | `^2.8.0` | `^0.8.0` | `^0.5.0` | **2**（轻应用 1）| 新增 `asset:read` scope：以**当前使用者**身份读 Ptengine Drive 资产树（文件夹 / 落地页 / 页面组 / 图片 / 组件 / 字体 / Studio 知识资产 / 快捷方式），可见范围等于他在产品里能看到的。前端 `PtApp.asset.list / sharedWithMe / get`（`@ptengine/app-sdk` 2.8），后端 `ctx.pt.asset.list / sharedWithMe / get`（`@ptengine/app-backend` 0.8）。它是**读类** scope：本工作区自建应用自动视为已授权，外部 / 商店应用需管理员同意。字段与错误码见包内 `asset-read.llms.txt`。**`0.x` 的 caret 不跨 minor，旧项目要手改区间再 `npm install`** |
| v3.6.1 | `^2.7.0` | `^0.7.0` | `^0.5.0` | **2**（轻应用 1）| 修正 `ai:invoke` 的可用模型清单：v3.6.0 带的 28 项里**只有 4 项真能调通**，其余是地域封锁 / 前缀写错 / 版本号写法不存在。依赖区间不变 |
| v3.6.0 | `^2.7.0` | `^0.7.0` | `^0.5.0` | **2**（轻应用 1）| 新增 `ai:invoke` scope：后端可用 `ctx.pt.ai.chat()` / `.stream()` 调大模型，**凭据在平台侧，应用看不到也传不了**。`@ptengine/app-sdk` 2.7：manifest 的第七个 scope（2.6 以下声明它会 `SCOPE_UNKNOWN`）；`@ptengine/app-backend` 0.7：`ctx.pt.ai.chat / stream` 与 `PtAiChatInput` / `PtAiChatResult`。**与 manifest 里那个 `ai` 段无关** —— 那段讲右侧 AI 助手要不要集成，这条讲你的后端能不能调大模型。它是**写类** scope（没有 first-party 豁免），因为它**花钱**：额度由平台垫付、按工作区计量，用完返回 `AI_BUDGET_EXCEEDED`（要去提额，不是重试能好的）。**`0.x` 的 caret 不跨 minor，旧项目要手改区间再 `npm install`** |
| v3.5.0 | `^2.6.0` | `^0.6.0` | `^0.5.0` | **2**（轻应用 1）| 新增 `asset:write` scope：后端可用 `ctx.pt.asset.*` 替使用者往产品资产库写入。`@ptengine/app-sdk` 2.6：manifest 的第六个 scope（2.5 以下声明它会 `SCOPE_UNKNOWN`）；`@ptengine/app-backend` 0.6：`ctx.pt.asset.ensureFolder / create / update / uploadSource` 与 `PtAssetDoc`。**写类 scope 没有 first-party 豁免** —— 哪怕应用是自己传的，也要管理员显式同意过一次，否则写入以 403 `SCOPE_DENIED` 失败。**`0.x` 的 caret 不跨 minor，旧项目要手改区间再 `npm install`** |
| v3.4.0 | `^2.5.0` | `^0.5.0` | `^0.5.0` | **2**（轻应用 1）| 新增 `openapi:read` scope：后端可用 `ctx.pt.openApiUrl` + 自带的 profile API key 调 Ptengine Open API。`@ptengine/app-sdk` 2.5：manifest 的第五个 scope；`@ptengine/app-backend` 0.5：`ctx.pt.openApiUrl`（未声明 scope 时读它抛 501 `PT_OPENAPI_NOT_DECLARED`）。**`0.x` 的 caret 不跨 minor，旧项目要手改区间再 `npm install`** |
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

## [3.9.0] - 2026-11-06

> 热图截图随 prod 平台上线：依赖 `@ptengine/app-sdk ^2.11.0` / `@ptengine/app-backend ^0.10.0`（均已发到 npm latest），`PACKAGE_FLOORS` 同步。
>
> **上线前置（与平台同批）**：workers 的 edge 运行时 SDK 升到 app-sdk 2.11 并部署（`deploy:workers:prod`）；
> 宿主（frontend-base）的桥认 `heatmap.capture` / `getCapture`，ptengine-x backend 的截图端点已上线。
> 旧宿主 / 旧运行时 SDK 上调用会 reject `PT_METHOD_NOT_ALLOWED`，应用侧按能力探测退回提示。

### 新增

- **热图截图**（需 manifest 声明 `analytics:read`）：前端 `PtApp.heatmap.capture(input)` / `getCapture(captureId)`（app-sdk 2.11），
  后端 `ctx.pt.heatmap.capture(input)` / `getCapture(captureId)`（app-backend 0.10，定时任务里以订阅者身份执行）。
  异步两段式：`capture` 立即返回任务（通常 `queued`，命中缓存直接 `succeeded`），SDK 不代为轮询，建议 10 s 首查、之后每 5 s。
  每类一张整页长图 `full` + 分段 `parts`，图片为公开不可猜链接，约 90 天后失效。字段与错误码见 app-sdk README「Heatmap screenshots」与两个包的 CHANGELOG。
- `AGENTS.md`：`notify.send` 的 `imageUrl` 注明也收本应用 `heatmap.capture` 的截图。
- 规则快照同步（platform contract）：新增 `notifySend.mediaPathPatterns`；本地桩的 `imageUrl` 路径按任一模式匹配（旧快照退回 `mediaPathPattern`），热图截图 jpg 本地放行。

### 变更

- **依赖区间**：`@ptengine/app-sdk` `^2.10.0` → `^2.11.0`，`@ptengine/app-backend` `^0.9.0` → `^0.10.0`；
  `package-lock.json` 锁到 2.11.0 / 0.10.0，`ptx doctor` 的 `PACKAGE_FLOORS` 抬到 2.11.0 / 0.10.0。

## [3.8.0] - 2026-11-02

> 定时任务与推送随 prod 平台上线转正：依赖 `@ptengine/app-sdk ^2.10.0` / `@ptengine/app-backend ^0.9.0`，`PACKAGE_FLOORS` 同步。
> 预发期曾以 tag `next-3.8.0-rc.1`（依赖 rc 版）供 dev / staging 使用，内容与本版相同。

> **上线前置（与平台同批）**：
> 1. **workers 的 edge 运行时 SDK** 升到 app-sdk 2.10 并部署（`workers/package.json`、`build:sdk-asset`、`EXPECTED_APP_SDK_MINOR`，见 workers/README「Edge 自持的运行时 SDK」）：
>    应用运行时的 `window.PtApp` 来自 edge `/__pt/app-sdk.js`，旧资产上 `PtApp.subscriptions` 为 `undefined`（标准写法会退回提示「点右上角『订阅』」，不会崩）。
> 2. **workers gateway 须先于或同批于新版 app-backend**：app-backend 0.9 只对「429 + `TOO_MANY_CONCURRENT_QUERIES` + `x-pt-gate: concurrency`」退避重试，
>    旧 gateway 的闸 429 不带这个头，打满并发闸时直接失败、不重试。
> 3. **ptengine-x backend 须与带 `identity.appId` 的 platform 同批或之后**：新 backend 缺这个字段时任务 run 启动一律 502。
>    详见 custom-app-platform `docs/PHASE0-INFRA.md`「上线顺序（跨仓）」。
> 4. ptengine-x backend 用 app-sdk 的 manifest schema 校验**轻应用**（schemaVersion 1）上传；有后端的应用（`backend.jobs` / `notify:send` 只出现在这类应用里）走 platform 轨道、由 contract 校验，不受 backend pin 的 app-sdk 版本影响。

### 新增

- **推送与图表的本地桩**：`ptx dev` 在进程里起 `127.0.0.1:8788`，本地网关桩把 `ctx.pt.notify.email` / `ctx.pt.render.chart` 转过去。
  邮件写 `.ptx/outbox/<runId|interactive>/<seq>.json` 与 `.html`（**不真实发信**，终端打印本地预览地址与「平台会去掉的东西」），
  图表用与平台同一套 echarts + resvg 渲染进 `.ptx/media/`。校验、本 run 限额与错误码与线上同名，上限读 `scripts/rules.json`。
  `echarts@^5.6.0` / `@resvg/resvg-js@^2.6.2` 是 optionalDependencies，装不上时只有本地渲染报 501 `PTX_RENDER_DEPS_MISSING`。
- **`npm run ptx -- job run <type> --preview`**：另打印应用回的预览日志（`x-pt-job-log`：`ctx.log` 与取数 / 邮件 / 图表次数）与本地邮件预览页。
- **`ptx doctor`**：后端用了 `ctx.pt.notify` / `ctx.pt.render.chart` 却没声明 `notify:send` → bad。
- 规则快照同步：`validScopes` 加 `notify:send`，新增 `notify` / `render` / `jobLog` 段。
- 规则快照同步：`notify` / `render` 段新增 `maxConcurrentPerApp`（各 2），`render` 段新增 `timeoutMs`（5000）；本地桩的每应用并发闸默认生效。
- 规则快照同步：新增 `gateway.gateHeader`（`{ name: "x-pt-gate", concurrencyValue: "concurrency" }`）；本地桩并发闸 429 的闸头改读它，
  快照有并发上限却缺这个键时启动报「规则快照过旧」（不写字面量兜底）。
- 本地图表桩：单次渲染耗时超过 `render.timeoutMs` 时终端警告（线上可能 504 `RENDER_TIMEOUT`），不拒绝；旧快照缺该键时不判。
- 本地图表桩与平台同口径：`render` 段新增的资源上限（节点 / 数组 / 字符串）、非 JSON / 循环 / 原型键拒绝、字符规则
  （字符串禁 `"` `<` `>` 控制字符与 `&#`，颜色 / 字体字段禁 `;`）全部读规则快照；渲染出的 SVG 先过与平台同一份允许名单闸
  （`svgAllowedElements`，外部 `href` / `url(` / 带前缀元素一律拒）再交给 resvg。
- 本地邮件桩与平台外框对齐：页脚三语文案逐字一致、「退订此任务」只在有任务 id 时出现、法定页脚占位、`<body>` 不闭合也能取正文、
  纯文本版结构同平台；清洗改为按平台同一份允许名单重建（只会比平台严），内联样式按平台规则逐条过滤（`--*` / `var()` / `attr()` 丢弃、url 须 https），
  应用内容里伪造的退订占位符被中和。
- 文档：`AGENTS.md` 新增「推送：邮件与图表」「预览模式写法」；定时任务第 4 条改为「预览里照常调用 notify.email（平台拦截）」；
  `docs/troubleshooting.md` 新增「推送 / 图表本地桩」。`.gitignore` 加 `.ptx/`。
- **即时通知声明（`backend.notify.instant`，2026-10-22 补充）**：应用级渠道收窄为「即时通知渠道」，只服务于用户请求里的即时发送。
  - manifest 校验（`doctor` / `package`）：`backend.notify` 只允许 `instant`（布尔），多余键 / 非布尔 / `instant: true` 但 scopes 没有 `notify:send`
    → `MANIFEST_INVALID`（话术同平台）。规则直接读 `scripts/rules.json` 的 `manifestNotify`（`keys` / `instantRequiresScope`），不写字面量兜底：快照缺这一段时 manifest 校验报 `RULES_STALE`（声明了 `backend.notify` 才需要）、本地桩启动即报「规则快照过旧」、doctor 给 warn，都提示 `npm run sync-rules`。
  - 本地桩：用户请求里的 `notify.send` 在 `manifest.json`（每次现读）没声明 `instant: true` 时回 `no_targets` / `APP_INSTANT_NOT_DECLARED`，不读 `.ptx/notify-targets.json`（文件坏了也不影响这条分支）。
  - 本地 jobs 桩：`ctx.pt.jobs.create` 建出的任务 `targetCount` 恒为 0（与线上「应用自建任务初始不带渠道」一致，不再按 `.ptx/notify-targets.json` 计）；
    删掉只为它服务的 `GET /__ptx/notify-targets`。
  - `ptx doctor`：后端用了 `ctx.pt.notify.send`、有 `notify:send` 但没声明 `instant` → info「只能在定时任务里投递；即时发送需声明」。
  - 文档：`AGENTS.md`「推送：通知渠道」、`docs/troubleshooting.md` 的 `no_targets` 条目、README 两份同步。
- 本地 `ctx.pt.jobs.*` 桩接受 `archiveToAssets`（布尔，JobView 缺省 false；非布尔 400 `JOB_OP_INVALID`）；`AGENTS.md` 补「结果归档」说明（定时任务 1b+）。
- **通知投递目标**（取代 1c 未发版的按名发送）：应用只声明订阅项、调 `ctx.pt.notify.send(message)`，投递目标由使用者在宿主订阅中心配置。
  - **本地桩 `notify.send`**（`scripts/local-stub/send.mjs`，取代 `channel.mjs`）：本地网关桩把 `/notify/send` 转到 `127.0.0.1:8788`（`/notify/channel`、`/notify/channels` 不再转，未知路径 501）。
    消息按 `scripts/rules.json` 的 `notifySend` 段同口径校验（标题 / 正文 / 链接 / 图片形状、与邮件共用的本地并发闸、16 KiB 体积上限），
    每 run 单位按 `max(1, 目标数)` 计、合计 ≤ `maxUnitsPerRun`（超了 409 `NOTIFY_RUN_LIMIT_EXCEEDED`，整次不发）。
    投递目标读项目内 `.ptx/notify-targets.json`（`[{ "name", "type" }]`，最多 `maxTargets` 个）：**没有文件 → 一个虚拟目标 `local / webhook`**（本地默认走通 `sent`）；
    **`[]` → `no_targets`**（任务 `JOB_TARGETS_EMPTY`、交互 `APP_DEFAULT_EMPTY`）。写 `.ptx/outbox/<runId|interactive>/<seq>.send.json`（`{ message, targets, status, noTargetsReason, … }`，与邮件共用序号），
    **永远不真实投递**。本地推送预览页按「消息一次 + 将发到列表」展示。`.ptx/channels.json` 不再读取。
  - 本地 `ctx.pt.jobs.*` 桩：`JobView.targetCount` = 创建时的本地目标数（本地桩新增 `GET /__ptx/notify-targets` 回 `{ count }`，没有目录文件为 1，桩不可达按 1）；`channelIds` → 400 `JOB_OP_INVALID`（与平台同码）。
  - `npm run ptx -- job run`：预览日志认 `stats.notifySend`（1c 的 `notifyChannel` 当未知键忽略，与平台同口径），首行显示「通知 n 次」；
    没给 `--params` 时用该类型 manifest 的 `defaultParams`（= 订阅中心创建的任务拿到的 params），再没有才是 `{}`。
  - `ptx doctor`：代码里出现 `ctx.pt.notify.channel` / `notify.listChannels` → **bad**（「已移除，改用 notify.send，投递目标由使用者配置」）；
    `notify:send` 检查覆盖 `notify.send`；新增订阅项字段检查（`displayName` / `description` / `defaultCron` / `defaultParams` / `subscribable` 形状不合规 → bad，
    `defaultCron` 不是 5 段 → warn，订阅项没写 `displayName` → 新增的 info 级提示 `[i]`，不计入通过 / 提醒 / 问题数）。
  - 规则快照同步：删 `notifyChannel` 段，新增 `notifySend` 段（`maxUnitsPerRun` / `maxTargets` 等）与 `jobs` 段（订阅项字段上限与三语 locale）。
  - `AGENTS.md`「定时任务」「推送：通知渠道」重写：两层模型；订阅项字段（日报 / 周报 / 月报 = 三个类型 + 三个 `defaultCron`）、`subscribable: false` 的用法；
    `PtApp.subscriptions.open` 能力探测标准写法；`notify.send` 的四种 `status` 与 `no_targets` 处理、部分成功不要整体重发；不要在 params 里放渠道名。
    `PtApp.jobs.openPreview` 的写法删除。`docs/troubleshooting.md`、README、`backend/src/index.ts` 注释同步。

### 变更

- **邮件推送暂未开放**（平台关闭邮件发送，`ctx.pt.notify.email` 线上返回 503 `NOTIFY_UNAVAILABLE`；API 保留，本地桩行为不变、仍照常收下邮件）：
  - `ptx doctor`：后端代码里出现 `notify.email`（含可选链、解构；注释 / 字符串 / 测试文件 / `.d.ts` 不算）→ **warn**（提醒，不算错误）
    「邮件推送暂未开放，正式运行会返回 NOTIFY_UNAVAILABLE；请改用 notify.send」。
  - 文档：`AGENTS.md`（ctx 清单、本地桩说明、两层模型、结果归档、「推送：邮件与图表」开头、预览模式写法及示例）、README 两份、
    `docs/troubleshooting.md`、`backend/src/index.ts` 头注释都注明暂未开放、推荐 `notify.send`；预览示例改用 `notify.send`；
    说明本地桩能收邮件但线上暂未开放。

### 安全

- 文档、命令提示、`.github/workflows/deploy.yml` 里用 `npx` 调 `ptx` 的写法全部改为 `npm run ptx -- <command>`：`ptx` 只是本项目
  `package.json` 的 script、没有 bin，`npx` 在本地找不到时会去 npm 下载并执行一个同名的无关公共包。新增 `scripts/no-npx-ptx.test.mjs`
  禁止仓内再出现这种写法。**已从旧版脚手架生成的项目**请同样改自己的 CI 与脚本。

## [3.7.1] - 2026-10-13

### 修复

- **本地 dev token 的 `scopes` 照抄 `manifest.json`。** 以前 `scripts/dev-keys.mjs` 写死
  `['analytics:read','profile:read','user:read','ui:notify']`，声明了 `asset:read` / `asset:write` /
  `ai:invoke` 的应用本地一调 `ctx.requireScope(...)` 就 403 `SCOPE_REQUIRED`，线上却是通的。
  - 现在按「声明的全部已获授权」签；没有 `scopes` 字段或空数组 → 令牌不带 scope（合法的最小权限，线上同样如此）；
    `scopes` 不是字符串数组 → 启动时直接报错，不回退到任何默认集合（回退只会让本地与线上再次不一致）。
  - `ptx dev` 横幅打印本次令牌的 scopes。
  - 订正说明：改 `web/.ptx-dev-key.json` **不用重启**（`/__ptx/token` 每次签发都现读它），
    以前写的「改完重启」反而会被 `ptx dev` 重写掉。
- **`AGENTS.md` / `backend/src/index.ts` 头注释与运行时对齐**（以 `@ptengine/app-sdk` 2.8 /
  `@ptengine/app-backend` 0.8 的实际导出为准）：
  - `ctx` 清单补 `ctx.pt.asset.*`（读 `list / sharedWithMe / get`，写 `ensureFolder / create / update / uploadSource`）、
    `ctx.pt.ai.chat / stream`、`ctx.vars`、`ctx.authOrNull`、`ctx.workspaceId`、`ctx.scopes`、`ctx.requestId`；
    删掉「`ctx.pt.query` Phase 2 尚未开放」（早已开放）。
  - `PtApp` 契约补 `asset.*` 与 `context.user`。
  - scope 列表补 `ai:invoke`（README 同步），并加一张「scope → 能力 → 授权方式」表。
  - 写明 **`ctx.error(status, code, detail)` 的第三参只进日志、不回给前端**（前端 message 就是 code），
    要给前端看的说明用 `badRequest(code, message)` 等 helper。
  - 写明本地 `wrangler dev` 没有数据网关，`ctx.pt.query / asset / ai` 本地一律 501 `PT_GATEWAY_NOT_BOUND`，与 scope 无关。

## [3.7.0] - 2026-10-13

### 变更

- **新增 `asset:read` scope**：应用可以读取当前使用者在 Ptengine Drive 里能看到的资产。
  - 前端 `PtApp.asset.list / sharedWithMe / get`，后端 `ctx.pt.asset.list / sharedWithMe / get`，两边入参与返回同形。
  - `list` 省略 `folderId` 为根目录；固定 cursor 分页，**以 `hasMore` 为准**（短页正常）。
  - `get` 只支持 `folder` / `page` / `group` / `studio`；图片、字体、快捷方式的字段都在 `list` 的节点里。
  - 读类 scope：本工作区自建应用自动视为已授权；外部 / 商店应用需管理员同意，否则 403 `SCOPE_DENIED`。
  - 写代码前先读 `node_modules/@ptengine/app-sdk/asset-read.llms.txt`（字段表、分页规则、错误码；时间戳为 Unix 毫秒）。
- **依赖区间**：`@ptengine/app-sdk` `^2.7.0` → `^2.8.0`，`@ptengine/app-backend` `^0.7.0` → `^0.8.0`；
  `package-lock.json` 同步，`ptx doctor` 的 `PACKAGE_FLOORS` 抬到 2.8.0 / 0.8.0。

## [3.6.1] - 2026-10-10

### 修复

- **可用 AI 模型清单改为实测调通的 16 项。** v3.6.0 带的那份有 28 项，是照 Cloudflare
  模型目录整理的 —— 实打下来**只有 4 项能用**：

  | 问题 | 数量 | 实测结果 |
  |---|---|---|
  | OpenAI 整家 | 12 | 403 `unsupported_country_region_territory`（地域封锁）|
  | Google | 8 | 400 `Model not found`（前缀应是 `google-ai-studio/`，不是 `google/`）|
  | Anthropic 点号写法 | 4 | 404（要写 `claude-sonnet-5-5`，不是 `claude-sonnet-5.5`）|

  **OpenAI 按调用来源判地域**，所以同一个模型会「有人能用有人不能」—— 开发时测通、
  上线后部分客户报错，而报错指向上游。这类不该留在清单里。

  影响：`scripts/rules.json` 与 `ptx doctor` 打出来的清单。**依赖区间没变**，
  从 v3.6.0 升上来只需要替换这个文件（或重新 clone）。

## [3.6.0] - 2026-10-09

> **（已在 3.8.0-rc.1 落实）** 待办（发版时）：依赖区间升到含 `backend.jobs` / `jobs:run` / `ctx.pt.jobs` 的 app-sdk / app-backend 版本，
> doctor 版本下限（`PACKAGE_FLOORS`）同步，starter 版本号确定，兼容矩阵补一行、README 里 clone 的 tag 同步。
> 在那之前，本段的定时任务能力在 `@ptengine/app-backend` ^0.6 / `@ptengine/app-sdk` ^2.6 上**类型里没有、运行时拿不到**。

### 新增

- **`npm run ptx -- job run <type> [--params '<json>'] [--preview]`**：用本地开发密钥签一枚任务模式令牌
  （`trg=job`、`job=local`、`run=<uuid>`），POST 到本地 worker 的任务路由，打印状态码、响应体，
  以及平台会把返回结果判成 `stored / none / invalid（原因）/ too_large`。需要先 `npm run dev`。
- **`ptx doctor` 定时任务检查**：声明了 `backend.jobs` 却没有 `jobs:run`（bad）；任务路由不在
  `backend/src` 的 routes 里（bad）；任务路由没有 `requireTrigger(`（warn）；`preview: true` 但没读
  `ctx.auth.preview`（warn）。
- **本地 `ctx.pt.jobs.*` 内存桩**：`ptx dev` 在同一个 wrangler 会话里拉起 `ptx-local-gateway`，
  `backend/wrangler.jsonc` 的 `PT_GATEWAY` 绑到它；重启即清空，不会按时触发。
  副作用：本地 `ctx.pt.query()` / `ctx.pt.asset.*` / `ctx.pt.ai.*` 仍是 501 `PT_GATEWAY_NOT_BOUND`，但提示语变笼统，
  并多一条 `pt-gateway-*-failed` 日志（预期行为）；直接在 `backend/` 里跑 `wrangler dev` 会解析不到该服务，请用 `npm run dev`。
- `npm run ptx -- job run` 签的任务 token 与 dev token 同一口径：scopes 照抄 `manifest.json` 的 `scopes`（3.7.1 起），
  manifest 声明 `jobs:run` 后本地 `ctx.pt.jobs.*` 即可用。
- 规则快照同步：`validScopes` 加 `jobs:run`，新增 `jobResult` 上限段；`scripts/job-result.mjs` 按平台口径本地判定任务返回结果。
- 文档：README / AGENTS.md 新增「定时任务（backend.jobs）」—— `requireTrigger('job')`、用 `ctx.auth.runId` 做幂等
  （先占位后副作用）、`ctx.auth.preview` 跳过外部副作用、返回 `{ archive: { title?, markdown, files? } }`；
  `docs/troubleshooting.md` 新增「定时任务与本地网关」一节。

### 变更

- **新增 `ai:invoke` scope**：应用后端可以调用大模型。
  - `ctx.pt.ai.chat(input)` 一次性返回；`ctx.pt.ai.stream(input)` 返回 SSE 的 `Response`，
    直接 `return` 给路由即可。**拿到之后不要 `await res.text()` 再转发** —— 那会把整条流
    缓冲下来，流式退化成一次性返回，而且只在长回答上才看得出来。
  - `model` **必须带 provider 前缀**（`anthropic/claude-sonnet-5`），裸模型名上游不认。
  - 凭据全程在平台网关侧，应用拿不到也传不了。
  - ⚠️ 与 manifest 里既有的 `ai` 段**毫无关系**：那段讲右侧 AI 助手要不要集成，
    这条讲你的后端能不能调大模型。
- **依赖区间**：`@ptengine/app-sdk` `^2.6.0` → `^2.7.0`，`@ptengine/app-backend` `^0.6.0` → `^0.7.0`；
  `package-lock.json` 同步，`ptx doctor` 的 `PACKAGE_FLOORS` 抬到 2.7.0 / 0.7.0。

## [3.5.0] - 2026-10-09

### 变更

- **依赖区间**：`@ptengine/app-sdk` `^2.5.0` → `^2.6.0`，`@ptengine/app-backend` `^0.5.0` → `^0.6.0`；
  `package-lock.json` 同步，`ptx doctor` 的 `PACKAGE_FLOORS` 抬到 2.6.0 / 0.6.0。
  - app-sdk 2.6：manifest 的 `scopes` 增加第六个合法值 `asset:write`。
  - app-backend 0.6：`ctx.pt.asset.ensureFolder / create / update / uploadSource`，以及正文信封类型 `PtAssetDoc`。
- **规则快照** `scripts/rules.json` 已随平台的 `VALID_SCOPES` 带上 `asset:write`（上一版合入，本版首次随 tag 发出）。

### 为什么这一版必须升（不升会撞上三处，且报错互不相干）

照 README 克隆 v3.4.0 再声明 `asset:write`，会依次遇到：

1. `ptx doctor` → `[x] manifest: SCOPE_UNKNOWN  "asset:write" 不是合法权限值`
   —— 规则快照是旧的（v3.4.0 的 tag 早于快照更新）。
2. `npm run build` → `error TS2339: Property 'asset' does not exist on type ...`
   —— `^0.5.0` 的 caret **拿不到 0.6.0**（`0.x` 的 caret 只放行同 minor），装到的是 0.5.x。
3. `ptx doctor` 的版本下限 → **`[ok]`**，因为 floor 还写着 ≥2.5.0 / ≥0.5.0。
   本该提醒你升级的那道检查，自己是旧的。

第 3 条是最费时间的：前两条报错都没指向"你的包太旧"，而唯一会这么说的检查却沉默。

### 关于 `asset:write` 的一条行为差异

读类 scope 对本工作区自建的应用自动豁免同意，**写类没有这条豁免**。所以声明了
`asset:write` 的应用在管理员点过一次同意之前，写入一律 403 `SCOPE_DENIED` ——
那是设计行为，不是故障，别做成错误路径。

## [3.4.0] - 2026-09-21

### 变更

- **依赖区间**：`@ptengine/app-sdk` `^2.4.0` → `^2.5.0`，`@ptengine/app-backend` `^0.4.0` → `^0.5.0`；`ptx doctor` 的 `PACKAGE_FLOORS` 同步抬到 2.5.0 / 0.5.0。
  - app-sdk 2.5：manifest 的 `scopes` 增加第五个合法值 `openapi:read`。
  - app-backend 0.5：`ctx.pt.openApiUrl` —— 当前环境的 Open API 根地址（`https://<env-backend>/open-api/v1`）。
    没在 manifest 里声明 `openapi:read` 就读它会抛 501 `PT_OPENAPI_NOT_DECLARED`；出站也只放行该 host 的 `/open-api/v1/` 前缀。
- **后端调 Ptengine Open API 的脚手架默认值**：`backend/wrangler.jsonc` 的本地 `vars` 增加 `PT_OPENAPI_URL`（本地直连 prod Open API），
  新增 `backend/.dev.vars.example` 示范 `PTENGINE_OPENAPI_KEY=`（profile API key，由 Owner / Admin 在 Experience → Settings → External App Integration → API Keys 创建）。
  代码里一律读 `ctx.pt.openApiUrl`，不要写死后端域名。
- **边界**：key 是**按应用**存的，所以这条路子只适合单工作区使用的应用（自建 / 单客户）；
  应用市场里被多个工作区安装的应用不要这么用。
- 已在开发中的项目：`0.x` 的 caret 拿不到新 minor，请手改 `package.json` 区间后重跑 `npm install`。

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
