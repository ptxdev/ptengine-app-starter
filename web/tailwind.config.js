import path from 'node:path';
import { createRequire } from 'node:module';
import designPreset from '@ptengine/design-components/tailwind-preset';

const require = createRequire(import.meta.url);

/**
 * 组件库 dist 目录的**绝对路径**。
 *
 * 为什么不写相对路径：Tailwind 把 content 里的相对 glob 按**配置文件所在目录**
 * （也就是 web/）解析，而依赖装在项目根的 node_modules/ —— 带后端的布局下根本
 * 没有 web/node_modules/，`./node_modules/@ptengine/...` 一个文件都匹配不到，
 * 且不报错。所以这里按包名解析，装在哪儿都能找到。
 */
function resolveDesignComponentsDist() {
    // 首选：直接问 package.json 的位置。注意组件库的 exports 目前**没有**
    // 暴露 "./package.json"，所以这一步大概率抛错，下面的兜底才是主路径。
    try {
        return path.join(path.dirname(require.resolve('@ptengine/design-components/package.json')), 'dist');
    } catch {
        // 兜底：解析包入口（dist/index.cjs），然后往上走到含 package.json 的包根。
        let dir = path.dirname(require.resolve('@ptengine/design-components'));
        for (let i = 0; i < 5; i++) {
            const p = path.join(dir, 'package.json');
            try {
                if (require(p).name === '@ptengine/design-components') return path.join(dir, 'dist');
            } catch { /* 这一层没有 package.json，继续往上 */ }
            const up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        throw new Error(
            '定位不到 @ptengine/design-components 的 dist 目录。先确认依赖装好了（npm install）。'
        );
    }
}

const dcDist = resolveDesignComponentsDist();

/**
 * Tailwind 配置 —— 只做一件事：把 @ptengine/design-components 的设计系统接进来。
 *
 * ⚠️ 两处不要动：
 *
 * 1. `presets: [designPreset]` —— 组件库的颜色 / 字阶 / 圆角 token 与 `state-layer`
 *    插件都从这里来。删掉它，组件仍能渲染，但全部掉成 Tailwind 默认观感（颜色不对、
 *    hover 没有叠加层），且不会有任何报错。
 * 2. content 里那条 `${dcDist}/**` —— 组件的 class 字符串在**已编译的库产物里**，
 *    不在你的源码里。漏了这条，Tailwind 扫不到它们、不生成对应 CSS，页面会渲染出
 *    "结构对但完全没有样式"的组件。
 *    这条**必须按包名解析成绝对路径**（上面的 resolveDesignComponentsDist），
 *    不要改回 './node_modules/@ptengine/design-components/dist/**' —— 相对 glob
 *    按 web/ 解析，而依赖装在项目根，改回去就是静默地一个文件都扫不到。
 *    `npx ptx doctor` 会真的去验证这条 glob 能不能匹配到文件。
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
        `${dcDist}/**/*.{js,cjs}`
    ],
    theme: {
        extend: {}
    }
};
