# CLAUDE.md

给 AI 编码助手的项目说明。本项目是 **Ptengine X 自定义应用**（Custom App）的脚手架，
产物会被 Ptengine X 平台以微前端（iframe 沙箱）方式加载。

## 绝对不要改的三处约定

改动它们会让应用在平台上无法运行，且现象不直观（多为白屏或上传被拒）：

1. **`vite.config.ts` 的 `base: './'`** —— 必须保持相对路径。平台加载入口的实际地址是
   `.../api/custom-app/bundle/<appId>/<versionId>/index.html`；绝对 base 会让产物请求
   `/assets/*` 落到平台根路径 → 404 → 白屏。
2. **`manifest.json` 必须在 zip 根级** —— 由 `scripts/package.mjs` 保证（用 `zip -r` 从
   `dist` 内部执行）。不要改成压缩 `dist` 目录本身，否则多一层前缀，平台报 `MANIFEST_MISSING`。
3. **`manifest.entry` 与构建产物入口一致**（默认 `index.html`）—— 否则报 `ENTRY_NOT_FOUND`。

## UI 组件库（@ptengine/design-components）

界面一律用组件库，不要自己写基础控件、也不要引第三方 UI 库 —— 目标是与平台观感一致。
只从包入口 import；`className` 只做布局，不改观感；不硬编码色值（用 `text-muted-foreground`
/ `bg-secondary` 这类语义类）。组件清单与设计规范见 `node_modules/@ptengine/design-components/llms.txt`。

四处接线改动前必读（错了都**不报错**，只是样式不对）：

1. `tailwind.config.js` 的 `presets: [designPreset]` —— 掉了就变 Tailwind 默认观感。
2. `tailwind.config.js` content 里 `node_modules/@ptengine/design-components/dist/**` ——
   组件 class 在编译后的库产物里，漏了就"有结构没样式"。
3. `src/main.tsx` 的 `import '@ptengine/design-components/styles/tokens.css'` —— 提供 `--pt-*` 变量。
4. `src/theme.ts` 的 `applyPtTheme()` 在 **`<html>`** 上挂 `pt-ui`（库不写 `:root` 级样式）。
   挂到 `#root` 的症状很有辨识度：页面正常，但 Radix 浮层（Dialog/Popover/Tooltip/DropdownMenu，
   portal 到 `body`）一打开就没样式。

暗色模式由 `followPtTheme()` 跟随 `window.PtApp.context.theme`（`<html>` 上加 `dark` 类）。
`PtApp.on` 是粗粒度回调（payload 是整个宿主 data），所以代码自己从里面挑 `context.theme`。

## 平台契约

宿主能力只通过 `window.PtApp` 提供，类型来自 `@ptengine/app-sdk`：

```ts
window.PtApp = {
    version: string;
    context: { appId, sid, locale, theme, initialPath };
    ui:  { toast(message, type?), confirm({ title?, message }) };
    nav: { push(path), syncRoute(subPath) };
    on(event, cb);
};
```

- **不要**假设存在其它宿主全局变量（如 `window.microApp` 之类微前端框架注入的对象）：那是
  平台内部实现细节，会随平台演进变化。只用 `window.PtApp`。
- 读取用 `src/pt-app.ts` 的 `getPtApp()`，它在未经平台加载时返回 `null` 而不是抛错。
- `nav.push` 只接受平台内部相对路径；传外部 URL 或伪协议会被平台拒绝执行。

## 本地开发

`src/main.tsx` 在 `import.meta.env.DEV` 下调用 `installDevHost()` 装一个假宿主。
它必须在渲染前执行（业务代码可能在首次渲染就读 context）。dev-host 的 `ui`/`nav`
只打 `console.log`，不做真实交互。

**在 Ptengine X 平台内以本地开发模式加载时（管理页「本地开发」指向本地 dev
server），`window.PtApp` 是异步就绪的**：`installDevHost()` 会探测到真宿主，转而
插入平台的真 SDK loader script，要等脚本网络加载完才挂上 `window.PtApp`。入口已
处理等待——`installDevHost()` 返回 `Promise<void>`，`main.tsx` 用 `await` 等它
resolve 后才渲染 `<App />`。若你改动入口逻辑，务必保留这个等待（或改成监听
`pt-app-ready` 事件），否则 `App.tsx` 的 `useMemo(getPtApp, [])` 会在首次渲染读到
`null` 且永不重算，页面永久停在"未检测到 window.PtApp"提示页——现象只在平台内
dev 模式出现，独立 `npm run dev` 完全正常。此行为需要 `@ptengine/app-sdk` 0.3.0+。

## 命令

- `npm run dev` — 本地开发
- `npm run build` — 类型检查 + 构建
- `npm run package` — 构建并打出可上传的 zip（含结构自检）

## 权限声明

`manifest.json` 的 `scopes` 声明应用所需权限，合法值：`analytics:read`、`profile:read`、
`user:read`、`ui:notify`。写未定义的值会导致上传校验失败。遵循最小权限原则。
平台当前只校验取值合法性，尚未据此放行/拦截能力。
