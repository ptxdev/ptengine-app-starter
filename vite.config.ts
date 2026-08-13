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
    },
    server: {
        /**
         * ⚠️ 必须开 CORS，否则平台的「本地开发 / dev 模式」加载不出来。
         *
         * 该模式下是 Ptengine X **平台 app 的 origin** 去 fetch 本地 dev server 的入口
         * HTML（微前端 iframe 加载），端口/域不同即为跨源请求；Vite 6+ 出于安全默认把
         * dev server 限制成同源，这个跨源 fetch 会被直接挡掉。
         *
         * 用 `true`（反射请求 Origin）而不是列白名单：同一个本地 dev server 会被线上
         * 平台域、内部 dev 平台域分别 fetch，将来可能还有 staging，反射一份配置就都覆盖，
         * 不用维护一份容易漏的域名清单。
         *
         * 安全取舍：开着 cors: true 期间，开发者本机浏览器访问的任何网站理论上都能读到
         * 这个 dev server 的内容——因为 dev server 只跑在本机、不暴露公网，这个代价对
         * 临时联调是可接受的。要收紧就把这里换成
         * `origin: ['https://<线上平台域>', 'https://<dev平台域>']`，代价是每加一个
         * 平台环境都要来改一次。
         */
        cors: true
    }
});
