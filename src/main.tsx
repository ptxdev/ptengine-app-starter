import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installDevHost } from '@ptengine/app-sdk';
import App from './App';

/**
 * 本地开发时装一个假宿主，让 window.PtApp 可用。
 *
 * 必须在渲染前等待完成：业务代码在首次渲染时就读 window.PtApp.context（见 App.tsx 的
 * useMemo(getPtApp, [])，只读一次、不会重算）。
 *
 * installDevHost() 返回 Promise<void>：
 * - 纯本地 npm run dev（无真宿主）：装好假宿主后立即 resolve。
 * - 在 Ptengine X 平台内加载本地 dev server 联调时：window.PtApp 是异步就绪的——
 *   installDevHost() 会探测到真宿主，转而插入平台的真 SDK loader script，要等
 *   脚本网络加载完（onload）才 resolve。如果这里不等待就同步渲染，App.tsx 会在
 *   window.PtApp 挂上之前就读到 null，且因为 useMemo 不会重算，会永久停在
 *   "未检测到 window.PtApp" 提示页——现象只在平台内 dev 模式出现，独立 npm run dev
 *   完全正常，很难自查。
 *
 * 生产构建（上传到 Ptengine X 后）由平台在 index.html 注入阻塞 script，
 * window.PtApp 在业务代码执行前已就绪，这段 dev-only 代码也不会执行。
 */
async function bootstrap() {
    if (import.meta.env.DEV) {
        await installDevHost();
        // 也可以按需覆盖，模拟不同站点 / 语言 / 主题：
        // await installDevHost({ context: { sid: 'my-site', locale: 'en-US', theme: 'dark' } });
    }

    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
}

bootstrap();
