import designPreset from '@ptengine/design-components/tailwind-preset';

/**
 * Tailwind 配置 —— 只做一件事：把 @ptengine/design-components 的设计系统接进来。
 *
 * ⚠️ 两处不要动：
 *
 * 1. `presets: [designPreset]` —— 组件库的颜色 / 字阶 / 圆角 token 与 `state-layer`
 *    插件都从这里来。删掉它，组件仍能渲染，但全部掉成 Tailwind 默认观感（颜色不对、
 *    hover 没有叠加层），且不会有任何报错。
 * 2. content 里那条 `node_modules/@ptengine/design-components/dist/**` ——
 *    组件的 class 字符串在**已编译的库产物里**，不在你的源码里。漏了这条，Tailwind
 *    扫不到它们、不生成对应 CSS，页面会渲染出"结构对但完全没有样式"的组件。
 *
 * 自定义主题请写在 theme.extend 下（会与 preset 合并），不要覆盖 preset 的同名键。
 *
 * @type {import('tailwindcss').Config}
 */
export default {
    presets: [designPreset],
    darkMode: ['class'],
    content: [
        './index.html',
        './src/**/*.{ts,tsx}',
        './node_modules/@ptengine/design-components/dist/**/*.{js,cjs}'
    ],
    theme: {
        extend: {}
    }
};
