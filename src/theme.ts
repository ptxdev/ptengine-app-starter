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
 * `PtApp.on` 目前是**粗粒度**的（宿主 data 有任何变化都回调，payload 是整个 data），
 * 所以这里自己从 payload 里挑 `context.theme`，并且只在值真的变了时才写 DOM。
 * 返回值是"取消订阅"占位：`on` 尚未提供反注册，故返回一个把开关置死的函数。
 */
export function followPtTheme(app: {
    context: { theme: 'light' | 'dark' };
    on(event: string, cb: (payload: unknown) => void): void;
}): () => void {
    let active = true;
    let current = app.context.theme;
    applyPtTheme(current);

    app.on('change', payload => {
        if (!active) return;
        const next = (payload as { context?: { theme?: 'light' | 'dark' } })?.context?.theme;
        if (!next || next === current) return;
        current = next;
        applyPtTheme(next);
    });

    return () => {
        active = false;
    };
}
