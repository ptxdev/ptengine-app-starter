# Ptengine App Starter

开发 **Ptengine X 自定义应用**（Custom App）的官方脚手架。克隆下来即可开始写业务代码，
构建、打包、上传所需的约定都已配好。

## 快速开始

```bash
npm install
npm run dev        # 本地开发（已接好 dev-host，window.PtApp 可用）
npm run package    # 构建 + 打出可直接上传的 zip
```

把 `npm run package` 产出的 zip 上传到 Ptengine X →「自定义应用管理」即可。

## 你的应用如何运行

应用会被 Ptengine X 平台以微前端（iframe 沙箱）方式加载，平台在页面里注入
`window.PtApp`，提供上下文与宿主能力：

```ts
import { getPtApp } from './pt-app';

const app = getPtApp();
app?.context;              // { appId, sid, locale, theme, initialPath }
app?.ui.toast('已保存');    // 宿主的提示条
await app?.ui.confirm({ message: '确定吗？' });
app?.nav.push('dashboard/default');   // 跳转平台页面
app?.nav.syncRoute('detail');          // 把内部路由同步到地址栏
```

类型来自 [`@ptengine/app-sdk`](https://www.npmjs.com/package/@ptengine/app-sdk)，
`src/pt-app.ts` 里封了一个安全取值的 `getPtApp()`（未经平台加载时返回 `null` 而非抛错）。

`src/App.tsx` 是一个可运行的示例，演示了全部能力，可直接替换成你的业务代码。

## manifest.json

项目根目录的 `manifest.json` 描述应用信息，`npm run package` 会自动把它放进 zip 根级。

```json
{
    "schemaVersion": 1,
    "version": "1.0.0",
    "entry": "index.html",
    "display_name": { "zh-CN": "我的应用", "en-US": "My App" },
    "scopes": ["ui:notify"]
}
```

- `version` 每次上传新版本时**必须递增**（平台按内容判定是否建新版本）
- `display_name` 是多语言展示名，决定左侧导航里显示的文字
- `scopes` 声明应用所需权限，取值与含义见
  [`@ptengine/app-sdk` 的权限文档](https://www.npmjs.com/package/@ptengine/app-sdk#权限声明scopes)。
  请遵循最小权限原则；写了未定义的权限值会导致上传校验失败

## 三条不要改的约定

这三处配置错了会直接导致应用无法运行，且现象不直观：

1. **`vite.config.ts` 的 `base: './'`** —— 必须是相对路径。平台加载入口 HTML 的地址是
   `.../bundle/<appId>/<versionId>/index.html`，只有相对路径的资源引用才能解析回该目录；
   改成 `'/'` 会让产物请求 `/assets/*` → 404 → **白屏**。
2. **用 `npm run package` 打包**，不要手动压缩 `dist` 文件夹 —— 手动压缩会多出一层
   `dist/` 目录，平台在 zip 根级找不到 `manifest.json`，上传时报 `MANIFEST_MISSING`。
3. **`manifest.entry` 与构建产物入口一致**（默认都是 `index.html`）—— 不一致时平台报
   `ENTRY_NOT_FOUND`。`npm run package` 会在打包前替你检查这一点。

## 上传后的校验规则

平台会在上传时校验（不通过会返回具体错误码）：

| 检查项 | 说明 |
|---|---|
| 根级 `manifest.json` | 必须存在，且符合 schema（必填 `schemaVersion` / `version` / `entry`）|
| `entry` 指向的文件 | 必须真实存在于包内 |
| 文件类型 | 仅允许静态资源（html/js/css/图片/字体/json 等），不允许可执行文件 |
| 包体积 | 单包与解压后总大小均有上限 |

## 常见问题

**上传后左侧导航没出现应用？** 刷新页面；确认上传成功（有成功提示）。

**点进去白屏？** 打开浏览器控制台看有没有资源 404 —— 多半是 `base` 被改成了绝对路径。

**`window.PtApp` 是 undefined？** 只有经平台加载时才会注入。本地开发请用 `npm run dev`
（入口已调用 `installDevHost()`）；直接打开 `dist/index.html` 是拿不到的。

**换成 Vue / Svelte 可以吗？** 可以。本脚手架的关键约定只有三条（相对 `base`、
根级 `manifest.json`、`entry` 一致），与框架无关，照 `vite.config.ts` 与
`scripts/package.mjs` 迁移即可。
