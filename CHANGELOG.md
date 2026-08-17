# 更新日志

本脚手架的所有版本变更记录于此。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号的归属**：这里记录的是**脚手架自身**的版本（对应 git tag 与
> [Releases](https://github.com/ptxdev/ptengine-app-starter/releases)）。
> `package.json` 与 `manifest.json` 里的 `version` 字段属于**你的应用**，
> clone 之后由你自己维护，与本文件无关。

## 兼容矩阵

| 脚手架版本 | `@ptengine/app-sdk` | `@ptengine/design-components` | manifest `schemaVersion` | 说明 |
|---|---|---|---|---|
| v1.2.0 | `^0.6.0` | `^0.4.0` | `1` | 取数放开到 12 个 queryType + 参数改判别联合类型 + `PtApp.data.describe()`（**要用取数的必须升到这版**）|
| v1.1.3 | `^0.4.0` | `^0.3.0` | `1` | dev server 默认开 CORS（平台内 dev 模式）+ 模板默认带 `icon` 占位图 + `npm run package` 新增 icon 自检 |
| v1.1.2 | `^0.4.0` | `^0.3.0` | `1` | 修复平台内本地联调拿到假上下文（**用平台内 dev 模式的必须升到这版**）|
| v1.1.1 | `^0.3.0` | `^0.3.0` | `1` | AI 助手说明归一到 `AGENTS.md`（跨工具通用） |
| v1.1.0 | `^0.3.0` | `^0.3.0` | `1` | 预装 UI 组件库 + Tailwind，暗色跟随平台主题 |
| v1.0.1 | `^0.3.0` | — | `1` | 支持在 Ptengine X 平台内加载本地 dev server 联调 |
| v1.0.0 | `^0.2.0` | — | `1` | 首个版本 |

选版本时以本表为准：脚手架版本决定了它依赖的 SDK 大版本，跨大版本升级请看下面对应条目的「升级指引」。

## [1.2.0] - 2026-08-17

### 变更

- **`@ptengine/app-sdk` 升到 `^0.6.0`**（原 `^0.4.0`）。这一步必须手动做：`0.x` 的 caret
  只放行同 minor，`^0.4.0` 等价于 `>=0.4.0 <0.5.0`，**拿不到 0.5.0 / 0.6.0**。已在开发中的
  项目照下面的「升级指引」改。
- **`@ptengine/design-components` 升到 `^0.4.0`**（原 `^0.3.0`），同样是 caret 跨不过 minor 的
  问题。按组件库自身的发版规则，`0.x` 的 minor 是**向后兼容的扩展**（新增组件 / variant /
  token / prop），major 才会破坏消费方代码 —— 所以升级不需要改你的代码，
  `npm i @ptengine/design-components@^0.4.0` 即可。

### 新增（来自 app-sdk 0.5.0–0.6.0）

- **取数 `PtApp.data.query()` 可用的 queryType 从 3 个放开到 12 个**：原有
  `page_insight` / `event_insight` / `funnel_insight`，新增 `traffic_insight`（站点 KPI）、
  `path_insight`（路径流转）、`page_transitions`（页面单跳）、`page_block_metrics` /
  `page_element_metrics`（区块与元素级）、`experience_search` / `experience_report` /
  `experience_abtest_report` / `experiment_attributed_funnel`（实验相关）。
  用户级（`user_*`）场景不开放。
- **参数类型改为按 queryType 判别的联合**：写 `queryType: 'funnel_insight'` 时 IDE 会直接提示
  该场景的 `steps` / `conversionWindow` 等参数，拼错在编译期就报，不必等运行时
  `INVALID_PARAMS`。类型由平台的 schema 自动生成，随 SDK 发布。
- **`PtApp.data.describe()`**：运行时查询当前平台放开了哪些 queryType 及其参数 schema。
  平台以后放开新场景，不升级 SDK 也能发现。

### 升级指引（已在开发中的项目）

```bash
npm i @ptengine/app-sdk@^0.6.0
```

改完可能要动两处代码：

1. **`funnel_insight` 的 `steps` 参数**。0.5.0 及更早的契约文件把它错写成了 `string[]`，实际是
   对象数组。如果你照旧契约写了 `steps: ['page_view', 'purchase']`，运行时会收到
   `INVALID_PARAMS` —— 改成：

   ```ts
   steps: [{ event: 'page_view' }, { event: 'purchase' }]
   ```

2. **`params` 现在有确切形状**。原先 `params` 是 `Record<string, unknown>`，什么都能塞、编译
   都过；现在按 queryType 收紧，缺必填项或多传字段会在编译期报错。按 IDE 提示补齐即可 ——
   报错的地方通常本来就是运行时会被服务端拒掉的参数。

另外注意：单次取数**最多返回 5000 行**。发生截断时 `metadata.truncated === true`、
`metadata.totalRowCount` 是截断前的真实行数；未截断时这两个字段**不存在**。`rowCount` 永远
等于本次返回的 `rows.length`，别拿它当总数算分母。

## [1.1.3] - 2026-08-13

### 新增

- **`vite.config.ts` 默认开启 dev server CORS（`server.cors: true`）**：在平台里用
  「本地开发 / dev 模式」加载本地 dev server 时，是平台 app 的 origin 跨源 fetch
  你本地 dev server 的入口，Vite 6+ 默认把 dev server 限制成同源、会挡掉这个请求。
  开箱即用，无需再手动配。用反射 Origin 而非白名单，是因为同一个 dev server 会被
  线上平台域与内部 dev 平台域分别 fetch；要收紧改成 `origin: [...]` 列平台域即可。
- **模板 `manifest.json` 默认带 `icon: "assets/icon.svg"`**，并附了占位图
  `public/assets/icon.svg`（vite 会把 `public/` 下的内容原样拷到 `dist/` 根，
  所以产物里对应 `dist/assets/icon.svg`）。换成自己的图标时，把文件放进
  `public/assets/`、再把 manifest 里的 `icon` 改成对应路径即可。
- **`npm run package` 新增 icon 自检**：manifest 里声明了 `icon` 时，校验
  `dist/` 下对应文件是否真实存在；不存在就报错并直接告诉你图标该放哪、
  `public/` 会被拷到 dist 根这件事。`icon` 仍是可选字段，不声明不受影响。

  没有这项自检之前，客户换了图标却忘改 `manifest.json`（或改了路径写错），
  本地 `npm run build && npm run package` 会一路全绿，直到**上传到平台**才
  撞上 `ICON_NOT_FOUND`——平台是唯一会告诉你出错的地方，反馈链很长。

### 说明

- `icon` 与 `display_name` 都**不会自动生效**：平台内实际显示的名称与图标，
  由平台上的应用记录决定（创建应用时填/选，之后在管理页可改）；manifest
  里的值只有在你点开平台管理页的「从应用包同步名称与图标」时才会被采用。
- 本次是**描述与打包自检**的变化，**平台侧的上传校验规则本身没有变**——
  `ICON_NOT_FOUND` 一直存在，只是现在脚手架能在本地就替你挡住它。

## [1.1.2] - 2026-08-11

### 修复

- **平台内「本地开发模式」不再拿到假上下文**：把 `@ptengine/app-sdk` 依赖升到 `^0.4.0`。

  0.3.0 的 `installDevHost()` 用「宿主数据的内容」判断自己在不在平台内，而那份数据是异步到的 ——
  读得早时会误判成「不在平台内」并装上假宿主，于是 `window.PtApp.context.sid` 是 `dev-sid`、
  `ui`/`nav` 只打日志。现象很有欺骗性：页面在平台里正常渲染、控制台一条报错都没有，你以为在调
  真环境，其实全是假数据。详见 [`@ptengine/app-sdk` CHANGELOG](https://www.npmjs.com/package/@ptengine/app-sdk) 的 0.4.0 条目。

  只影响「在 Ptengine X 平台内加载本地 dev server」这一种用法；独立 `npm run dev` 不受影响。

### 升级指引（从 v1.1.x）

```bash
npm i @ptengine/app-sdk@^0.4.0
```

代码无需改动。若你的 `manifest.json` 里写了 `icon`，注意 0.4.0 起它必须是**包内真实存在的**
相对路径（空串不再合法，指向不存在的文件上传会报 `ICON_NOT_FOUND`）；不填 `icon` 仍然合法。

## [1.1.1] - 2026-08-11

### 变更

- **AI 编码助手的说明归一到 `AGENTS.md`**（跨工具通用：Cursor / Claude Code / Copilot /
  Codex / Gemini 都读它），`CLAUDE.md` 退化为指向它的一行指针。**内容只维护一份** ——
  两处各写一份必然漂移，而漂移的那半条约定往往正是最容易出事的那条。
  有意不用 symlink：客户下载源码 zip 或在 Windows 上 clone 时软链会失效。
- 同时补齐了几条 AI 最容易写错、而报错又不直观的硬边界：**没有后端**（静态 bundle，
  不要读平台 cookie/内部接口、不要把密钥写进前端）、**路由只能用 hash 或
  `nav.syncRoute`**（入口不在 `/`，`BrowserRouter` 会跳出子应用）、**写界面前先读
  `node_modules/@ptengine/design-components/llms.txt`**、**改完必须跑 `npm run package`
  而不只是 `build`**、以及各条约定"改错了长什么样"的症状对照表。

纯文档变更，无需改代码；已在开发中的项目想要这份说明，把 `AGENTS.md` 拷进项目根即可。

## [1.1.0] - 2026-08-11

### 新增

- **预装 UI 组件库 `@ptengine/design-components`**（基于 shadcn/ui + Radix + Tailwind），
  用它写界面即与平台自身观感一致。随之接好四处配置：Tailwind preset、扫描组件库产物的
  content glob、`tokens.css` 引入、根元素 `pt-ui` 作用域。四处的作用与"改错了会怎样"见
  README 的「UI 组件库」一节 —— 它们出错时**都不报错**，只是样式不对，很难自查。
- **暗色模式跟随平台主题**（`src/theme.ts`）：读 `window.PtApp.context.theme` 应用一次，
  并订阅宿主后续下发；暗色 = 根元素加 `dark` 类。拿不到宿主时按亮色渲染。
- `src/App.tsx` 改成组件库用法示例（Card / Button / Badge / Input / Alert / Separator），
  可直接删改。原先的 `src/App.css` 已删除（样式改由 Tailwind + 设计 token 提供）。

### 变更

- 新增开发依赖 `tailwindcss` / `postcss` / `autoprefixer`，新增 `tailwind.config.js`、
  `postcss.config.js`、`src/index.css`。

### 升级指引（从 v1.0.x）

已在开发中的项目不需要跟进（脚手架是起点、不是运行时依赖）。想把组件库接进老项目，
照上面四处配置手工挪一遍即可，顺序无所谓，但**四处必须齐全**。

## [1.0.1] - 2026-08-11

### 修复

- **入口改为等待 `window.PtApp` 就绪后再渲染**（`src/main.tsx`）。

  在 Ptengine X 平台内以「本地开发模式」加载本地 dev server 时，`window.PtApp` 是**异步**就绪的 ——
  `installDevHost()` 会探测到自己运行在真宿主里，转而插入平台的真 SDK loader script，要等脚本网络
  加载完才挂上 `window.PtApp`。而 `src/App.tsx` 用 `useMemo(getPtApp, [])` 只读一次、不会重算，
  所以旧写法（同步调用后立即渲染）会读到 `null` 并**永久**停在「未检测到 `window.PtApp`」提示页。

  该现象只在平台内 dev 模式出现，独立 `npm run dev` 完全正常，因此很难自查。

### 变更

- 依赖 `@ptengine/app-sdk` 升到 `^0.3.0`（异步就绪信号自该版本起提供）

### 升级指引（从 v1.0.0）

已在开发中的项目按需跟进即可，只有用到「平台内本地开发模式」时才必须改：

1. `npm i @ptengine/app-sdk@^0.3.0`
2. 把入口的 `installDevHost()` 改成等待完成后再渲染：

   ```ts
   async function bootstrap() {
       if (import.meta.env.DEV) {
           await installDevHost();
       }
       createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
   }
   bootstrap();
   ```

   也可以不改入口，改为监听 `pt-app-ready` 事件后再读 `window.PtApp` —— 两种方式 SDK 都支持，
   详见 [`@ptengine/app-sdk` README](https://www.npmjs.com/package/@ptengine/app-sdk) 的
   「平台内 dev 模式下 `window.PtApp` 是异步就绪的」一节。

## [1.0.0] - 2026-08-10

首个公开版本。

### 新增

- Vite 7 + React 19 + TypeScript 项目骨架，`base: './'` 已按平台要求配好
- `npm run package`：构建 + 打出可直接上传的 zip，并在打包前自检 zip 根级结构与
  `manifest.entry` 是否与产物一致
- `manifest.json` 模板，含多语言 `display_name` 与 `scopes` 权限声明
- `src/pt-app.ts`：`getPtApp()` 安全取值封装（未经平台加载时返回 `null` 而非抛错）
- `src/App.tsx`：可运行示例，演示 `context` / `ui.toast` / `ui.confirm` / `nav.push` /
  `nav.syncRoute` 全部宿主能力
- 本地开发接好 `installDevHost()`，脱离 Ptengine X 主站也能调试
- `README.md` 开发文档、`CLAUDE.md`（供 AI 编码助手遵循平台约定）

[1.1.3]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.1.3
[1.1.2]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.1.2
[1.1.1]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.1.1
[1.1.0]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.1.0
[1.0.1]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.0.1
[1.0.0]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.0.0
