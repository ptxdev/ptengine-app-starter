/**
 * 把 @ptengine/design-components 的样式作用域与暗色模式接到平台上下文。
 *
 * 组件库**不写任何 `:root` 级样式**：所有 `--pt-*` 变量都声明在 `.pt-ui` 作用域下
 * （与宿主零撞名）。所以子应用必须自己在根元素挂 `pt-ui`，否则组件渲染出来是"有结构、
 * 没颜色"——不会报错，只是变量全部解析失败。
 *
 * 挂在 `<html>` 而不是 `#root`：Radix 的浮层（Dialog / Popover / Tooltip / DropdownMenu）
 * 走 portal 挂到 `document.body`，挂在 `#root` 上它们取不到变量，表现为"页面正常、
 * 一打开弹窗就没样式"。
 */

/** 应用主题：暗色 = 在同一个根元素上再加 `dark` 类（组件库按 `.pt-ui.dark` 覆盖语义层）。 */
export function applyPtTheme(theme: 'light' | 'dark'): void {
    const root = document.documentElement;
    root.classList.add('pt-ui');
    root.classList.toggle('dark', theme === 'dark');
    // 让浏览器原生控件（滚动条、表单默认样式）跟着走，否则暗色下会出现亮色滚动条。
    root.style.colorScheme = theme;
}

/**
 * 跟随平台主题：先按当前 context 应用一次，再订阅宿主后续下发。
 *
 * 两个 app-sdk 1.0.0 的要点：
 * - 订阅的是 `on('context', ctx => …)`。旧的粗粒度 `'change'` 事件（回调整个 data）**已移除**，
 *   还按它写不会报错，只是主题永远不跟随。
 * - **握手完成前 `context` 是空对象**（`window.PtApp` 存在 ≠ context 已就绪），所以初值要兜底
 *   成亮色，真正的主题由随后到达的 `context` 事件纠正；直接读 `context.theme` 会拿到
 *   `undefined`，`colorScheme` 被写成空串。
 *
 * 只在值真的变了时才写 DOM。返回值是"取消订阅"占位：`on` 尚未提供反注册，
 * 故返回一个把开关置死的函数。
 */
export function followPtTheme(app: {
    context: { theme?: 'light' | 'dark' };
    on(event: 'context', cb: (ctx: { theme?: 'light' | 'dark' }) => void): void;
}): () => void {
    let active = true;
    let current: 'light' | 'dark' = app.context?.theme ?? 'light';
    applyPtTheme(current);

    app.on('context', ctx => {
        if (!active) return;
        const next = ctx?.theme;
        if (!next || next === current) return;
        current = next;
        applyPtTheme(next);
    });

    return () => {
        active = false;
    };
}
