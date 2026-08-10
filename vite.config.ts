import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    /**
     * ⚠️ base 必须是相对路径 './'，不要改成 '/' 或某个绝对前缀。
     *
     * 子应用最终由 Ptengine X 平台以微前端形式加载，入口 HTML 的实际地址形如
     *   https://<平台域>/api/custom-app/bundle/<appId>/<versionId>/index.html
     * 只有相对 base 产出的 `./assets/xxx.js` 才能正确解析回该目录；
     * 若用绝对 base，产物会请求 `/assets/xxx.js` → 落到平台根路径 → 404 → 白屏。
     */
    base: './',
    build: {
        outDir: 'dist',
        // 产物尽量扁平，避免嵌套层级带来的相对路径困扰
        assetsDir: 'assets'
    }
});
