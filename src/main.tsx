import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installDevHost } from '@ptengine/app-sdk';
import App from './App';

/**
 * 本地开发时装一个假宿主，让 window.PtApp 可用。
 *
 * 必须在渲染前调用：业务代码可能在首次渲染时就读 window.PtApp.context。
 * 生产构建（上传到 Ptengine X 后）由平台注入真实的 window.PtApp，这里不会执行。
 */
if (import.meta.env.DEV) {
    installDevHost();
    // 也可以按需覆盖，模拟不同站点 / 语言 / 主题：
    // installDevHost({ context: { sid: 'my-site', locale: 'en-US', theme: 'dark' } });
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
