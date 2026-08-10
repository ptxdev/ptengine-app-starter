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

- **不要**假设存在其它宿主全局变量（如 `window.$wujie`、`window.microApp`）：那是平台内部
  实现细节，会随平台演进变化。只用 `window.PtApp`。
- 读取用 `src/pt-app.ts` 的 `getPtApp()`，它在未经平台加载时返回 `null` 而不是抛错。
- `nav.push` 只接受平台内部相对路径；传外部 URL 或伪协议会被平台拒绝执行。

## 本地开发

`src/main.tsx` 在 `import.meta.env.DEV` 下调用 `installDevHost()` 装一个假宿主。
它必须在渲染前执行（业务代码可能在首次渲染就读 context）。dev-host 的 `ui`/`nav`
只打 `console.log`，不做真实交互。

## 命令

- `npm run dev` — 本地开发
- `npm run build` — 类型检查 + 构建
- `npm run package` — 构建并打出可上传的 zip（含结构自检）

## 权限声明

`manifest.json` 的 `scopes` 声明应用所需权限，合法值：`analytics:read`、`profile:read`、
`user:read`、`ui:notify`。写未定义的值会导致上传校验失败。遵循最小权限原则。
平台当前只校验取值合法性，尚未据此放行/拦截能力。
