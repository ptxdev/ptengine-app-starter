# AGENTS.md

给 AI 编码助手的项目说明（Cursor / Claude Code / Copilot / Codex / Gemini 等通用；
`CLAUDE.md` 只是指向本文件的指针，**内容只维护这一份**）。

本项目是 **Ptengine X 自定义应用**（Custom App）：一个**纯静态前端产物**，打成 zip 上传后
由 Ptengine X 平台以微前端（iframe 沙箱）方式加载到主站里。

在这里写业务代码前，先把下面「硬边界」看完 —— 违反它们的失败现象大多**不报错**
（白屏、没样式、上传被拒），靠试很难收敛。

---

## 硬边界（违反即坏，且现象不直观）

### 1. 三处不能改的约定

| 约定 | 位置 | 改错后的症状 |
|---|---|---|
| `base: './'`（相对路径） | `vite.config.ts` | 产物请求 `/assets/*` 落到平台根路径 → 404 → **白屏** |
| `manifest.json` 在 **zip 根级** | `scripts/package.mjs`（从 `dist` 内部执行 `zip -r`） | 上传报 **`MANIFEST_MISSING`** |
| `manifest.entry` 与构建入口一致（默认 `index.html`） | `manifest.json` | 上传报 **`ENTRY_NOT_FOUND`** |

### 2. 没有后端

这是**静态 bundle**：没有服务端、没有 SSR、没有构建期密钥注入。

- 要数据就调**你自己的 API**（注意跨域：你的服务要允许平台域）。
- **不要**试图读平台的 cookie / localStorage / 内部接口 —— 不是"技巧问题"，是明确不允许，
  且平台后续会加隔离，写了迟早坏。将来平台会通过 `manifest.scopes` + 下发令牌开放数据能力
  （见下「权限声明」），届时是新增 API，不是让你现在去猜。
- 不要把密钥写进前端代码：产物是公开可取的静态文件。

### 3. 路由只能用 hash 或 `nav.syncRoute`

入口 HTML 的实际地址不是 `/`，形如 `.../<appId>/<versionId>/index.html`。

- 用 `HashRouter`（或自己管 hash）；**不要**用 `BrowserRouter` / `history.pushState('/detail')`
  —— 绝对路径会跳出子应用范围。
- 要把内部位置反映到浏览器地址栏（刷新 / 分享 / 前进后退能回到同一内页），用
  `window.PtApp.nav.syncRoute('detail')`；平台会把它作为下次进入时的 `context.initialPath` 回传。

### 4. 不要假设别的宿主全局变量

宿主能力**只**通过 `window.PtApp` 提供。`window.microApp` 之类是平台内部实现细节，会随平台
演进变化，不要碰。读取统一用 `src/pt-app.ts` 的 `getPtApp()`（未经平台加载时返回 `null`
而不是抛错）。

---

## 平台契约：window.PtApp

类型来自 `@ptengine/app-sdk`（`import type { PtApp } from '@ptengine/app-sdk'`）：

```ts
window.PtApp = {
    version: string;
    context: { appId, sid, locale, theme, initialPath };
    ui:  { toast(message, type?), confirm({ title?, message }) };
    nav: { push(path), syncRoute(subPath) };
    data: { query(req), describe() };   // 取数，见下一节
    on(event, cb);   // 粗粒度：宿主数据有任何变化都回调，payload 是整个 data
};
```

- `context.sid` 区分站点（**多租户的隔离键，任何请求都要带上它**）、`locale` 做多语言、
  `theme` 明暗、`initialPath` 恢复深链接位置。
- `nav.push` 只接受**平台内部相对路径**；传外部 URL 或伪协议会被平台拒绝执行。
- `ui.confirm` 返回 `Promise<boolean>`，要 `await`。

---

## 取数：window.PtApp.data（**唯一的数据来源**）

应用**没有后端**（见「硬边界 2」），站点数据只能从这里拿。平台做中介执行，
**profile 锁死在服务端**（取自会话，不是你传的参数）—— 所以你既不需要、也无法指定查哪个站点。

```ts
import type { PtAppDataQueryRequest, PtAppDataResult } from '@ptengine/app-sdk';

const res: PtAppDataResult = await window.PtApp.data.query({
    queryType: 'funnel_insight',
    params: {
        timeRange: 'last_7_days',
        steps: [{ event: 'page_view' }, { event: 'purchase' }]
    }
});
// res = { columns: string[], rows: unknown[][], rowCount: number, metadata: object }
// rows 是二维数组，元素序 = columns 序。
```

**给 AI 的硬性要求：**

1. **`params` 的形状由 `queryType` 决定，不要凭印象写。** 类型是判别联合，IDE/tsc 会告诉你该场景
   要什么。**拿不准就先跑一次 `window.PtApp.data.describe()`**，它返回当前平台放开的全部
   queryType 及其参数 JSON Schema（`{ queryTypes: string[], schema: Record<string, PtAppQueryTypeDoc> }`），
   照 schema 写，不要猜字段名。
2. **`timeRange` 是字符串预设**（`'last_7_days'` / `'last_30_days'` / `'today'` …），
   或用 `customStart` + `customEnd` 指定精确区间。**不是** `{ key: 'lastDays', days: 7 }` 这类对象。
3. **别瞎造事件名 / 属性名**：用站点里真实存在的名字。猜错不会报错，**静默返回 0 行**，
   然后你会以为是取数坏了。
4. **一个分析问题 = 一次查询**：用 `dimension` 一次拿回按维度分好组的整表，
   不要枚举候选值逐个查（既慢又容易漏）。
5. **别把维度行加总当总数**：`rows` 是分组明细，不是聚合结果。
6. **单次最多 5000 行**。截断时 `metadata.truncated === true`、`metadata.totalRowCount` 是截断前
   的真实行数；**未截断时这两个字段不存在**（不是 `false`）。`rowCount` 永远等于本次返回的
   `rows.length` —— 别拿它当总数算分母。

可用的 12 个 queryType（`page_insight` 页面指标 / `event_insight` 事件 / `funnel_insight` 漏斗 /
`traffic_insight` 站点 KPI / `path_insight` 路径 / `page_transitions` 页面单跳 /
`page_block_metrics`、`page_element_metrics` 区块与元素 / `experience_*`、`experiment_attributed_funnel`
实验相关）的完整说明与参数 schema，看 SDK 包里的
`node_modules/@ptengine/app-sdk/data-query.llms.txt` 与 `data-query.schema.json` —— 这两份
**由平台自动生成、与线上服务端逐字同源**，比任何二手描述都可靠。用户级（`user_*`）场景不开放。

---

## UI：一律用 @ptengine/design-components

界面**不要自己写基础控件、不要引第三方 UI 库**（antd / MUI / chakra 一概不要）——目标是与
平台自身观感一致。

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
| `tailwind.config.js` `presets: [designPreset]` | token（颜色/字阶/圆角）+ `state-layer` 插件 | 组件掉成 Tailwind 默认观感 |
| `tailwind.config.js` content 里 `node_modules/@ptengine/design-components/dist/**` | 组件 class 在**编译后的库产物**里 | 组件「有结构、没样式」 |
| `src/main.tsx` `import '@ptengine/design-components/styles/tokens.css'` | 提供 `--pt-*` 变量 | 所有颜色失效 |
| `src/theme.ts` `applyPtTheme()` 在 **`<html>`** 上挂 `pt-ui` | 库不写任何 `:root` 级样式 | 同上；挂到 `#root` 则「页面正常、一开弹窗就没样式」（Radix 浮层 portal 到 `body`） |

暗色模式由 `followPtTheme()` 跟随 `context.theme`（`<html>` 上加 `dark` 类）。`PtApp.on` 是
粗粒度回调，所以代码自己从 payload 里挑 `context.theme`，并且只在值真的变了时才写 DOM。

---

## 本地开发的两种模式（区别很关键）

`src/main.tsx` 在 `import.meta.env.DEV` 下 `await installDevHost()`，**必须在渲染前完成**。

1. **纯本地 `npm run dev`**：装一个假宿主，`ui`/`nav` 只打 `console.log`，同步完成。
2. **平台内加载本地 dev server**（管理页「本地开发」指向 `http://localhost:5173`）：
   `installDevHost()` 探测到真宿主，转而插入平台真 SDK loader，**`window.PtApp` 是异步就绪的**。

⚠️ 改入口逻辑时**务必保留那个 `await`**（或改成监听 `pt-app-ready` 事件）。去掉它，
`App.tsx` 的 `useMemo(getPtApp, [])` 会在首次渲染读到 `null` 且永不重算，页面**永久**停在
"未检测到 window.PtApp"——**只在平台内 dev 模式出现**，独立 `npm run dev` 完全正常，
极难自查。需要 `@ptengine/app-sdk` 0.3.0+。

---

## 改完必须验证

```bash
npm run build      # 类型检查 + 构建
npm run package    # 构建 + 打 zip，并做结构自检（根级 manifest / entry 存在）
```

**只跑 `npm run build` 不够**：`package` 才会校验平台要求的包结构。声称"完成"之前先跑它，
并确认输出里有 `✓ 打包完成`。

产物体积没有硬门槛，但平台对单包与解压后总大小有上限；文件类型只允许静态资源
（html/js/css/图片/字体/json），带进可执行文件会被拒。

---

## 权限声明（manifest.scopes）

合法值只有四个：`analytics:read`、`profile:read`、`user:read`、`ui:notify`。写未定义或拼错的
值会导致**上传校验失败**。遵循最小权限原则，只声明确实要用的。

平台当前**只校验取值合法性，尚未据此放行/拦截能力** —— 所以不要写"因为声明了所以能读数据"
这类假设代码；数据能力要等平台令牌机制落地。

---

## 应用图标（manifest.icon）

`icon` 填**包内相对路径**（如 `assets/icon.svg`），文件必须真实存在于 zip 内（否则报
`ICON_NOT_FOUND`），扩展名限 `.svg/.png/.jpg/.jpeg/.webp/.ico`。它**不会自动生效**——平台
内显示的图标始终是站点管理员在平台创建界面选的那个（创建时选，管理页可改）。填了
`icon` 之后，可以在平台的应用管理页打开该应用的「编辑」，点「从应用包填入名称与图标」，把包里
这个文件取用为应用图标（只填表单，按「保存」才生效）。

---

## 版本号别搞混

| 位置 | 属于谁 |
|---|---|
| git tag / Release | **脚手架**（Ptengine 维护，客户仓里通常已 `rm -rf .git`） |
| `manifest.json` 的 `version` | **这个应用**（每次上传必须递增，平台读它） |
| `package.json` 的 `version` | 这个应用（npm 惯例，平台不读） |

`package-lock.json` 有意不进版本库（脚手架是一次性起点，应装到最新兼容版本）。
