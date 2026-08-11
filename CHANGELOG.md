# 更新日志

本脚手架的所有版本变更记录于此。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号的归属**：这里记录的是**脚手架自身**的版本（对应 git tag 与
> [Releases](https://github.com/ptxdev/ptengine-app-starter/releases)）。
> `package.json` 与 `manifest.json` 里的 `version` 字段属于**你的应用**，
> clone 之后由你自己维护，与本文件无关。

## 兼容矩阵

| 脚手架版本 | `@ptengine/app-sdk` | manifest `schemaVersion` | 说明 |
|---|---|---|---|
| v1.0.1 | `^0.3.0` | `1` | 支持在 Ptengine X 平台内加载本地 dev server 联调 |
| v1.0.0 | `^0.2.0` | `1` | 首个版本 |

选版本时以本表为准：脚手架版本决定了它依赖的 SDK 大版本，跨大版本升级请看下面对应条目的「升级指引」。

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

[1.0.1]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.0.1
[1.0.0]: https://github.com/ptxdev/ptengine-app-starter/releases/tag/v1.0.0
