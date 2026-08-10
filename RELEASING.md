# 发版流程（维护者）

面向本仓库的维护者。使用脚手架的客户不需要读这篇，看 [README](./README.md) 即可。

## 版本号的含义

脚手架自身走独立语义化版本，**与 `@ptengine/app-sdk` 的版本号不绑定**（SDK 修 bug 发小版本
时，脚手架不必跟着发；脚手架改文档时，SDK 也不必动）。两者的配套关系记录在
[CHANGELOG.md 的兼容矩阵](./CHANGELOG.md#兼容矩阵)里。

| 位 | 什么情况下递增 |
|---|---|
| **major** | 客户从上一版升级需要改自己的代码。例如：`window.PtApp` 契约不兼容变更、manifest `schemaVersion` 升级、打包/构建约定变更、依赖的 SDK 跨大版本 |
| **minor** | 向后兼容地新增东西。例如：新增示例能力、新增可选配置、依赖的 SDK 升小版本且无需客户改代码 |
| **patch** | 修 bug、改文档、升补丁依赖。客户重新 clone 或不动都不会受影响 |

判断标准始终是**已经在用旧版的客户要不要动手**，而不是改动量大小。

## 发一个版本

### 1. 确认代码就绪

```bash
npm install
npm run package        # 必须成功，且产出的 zip 结构正确
```

`npm run package` 的自检已经覆盖了两个最容易踩的坑（zip 根级缺 `manifest.json`、
产物引用绝对路径），跑通即可。

### 2. 写 CHANGELOG

在 `CHANGELOG.md` 顶部（兼容矩阵下方）加一节新版本，按 `新增` / `变更` / `修复` /
`移除` 分组。如果依赖的 SDK 版本变了，**同时更新兼容矩阵那一行**。

major 版本还要补一小节「升级指引」，写清楚客户具体要改什么 —— 只写"有破坏性变更"没有用。

### 3. 提交并打 tag

```bash
git add CHANGELOG.md
git commit -m "chore: 发布 v1.1.0"
git tag -a v1.1.0 -m "v1.1.0"
git push origin main --follow-tags
```

tag 格式固定为 `v<major>.<minor>.<patch>`。

### 4. 自动建 Release

`.github/workflows/release.yml` 监听 `v*` tag 推送，会自动：

- 从 `CHANGELOG.md` 里抽出该版本那一节作为 Release 说明
- 建好对应的 GitHub Release

推完 tag 去 [Releases](https://github.com/ptxdev/ptengine-app-starter/releases) 页确认一下就行。
同一个工作流里还有一个独立的 `verify` 任务会跑一遍 `npm run package` 作为回归检查 ——
它**不阻塞** Release 的创建（发版记录不该因为一次 CI 抖动而卡住），但红了要去看。

## 撤回一个版本

Release 页把该 Release 改成 draft 或删掉，然后删 tag：

```bash
git push origin :refs/tags/v1.1.0
git tag -d v1.1.0
```

因为客户是 clone / 下载源码使用（不是 npm 依赖），撤回的代价比撤回 npm 包小得多。
但如果已经有客户按该版本开发，优先**发一个新的 patch 修掉**，而不是撤回。
