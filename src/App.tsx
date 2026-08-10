import { useMemo, useState } from 'react';
import { getPtApp } from './pt-app';
import './App.css';

export default function App() {
    const app = useMemo(getPtApp, []);
    const [log, setLog] = useState<string[]>([]);
    const push = (line: string) => setLog(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev]);

    if (!app) {
        return (
            <main className="page">
                <h1>My Ptengine App</h1>
                <p className="warn">
                    未检测到 <code>window.PtApp</code>。本页面需要由 Ptengine X 平台加载才能拿到宿主能力；
                    本地开发请用 <code>npm run dev</code>（入口已接好 dev-host）。
                </p>
            </main>
        );
    }

    return (
        <main className="page">
            <h1>My Ptengine App</h1>
            <p className="sub">
                SDK v{app.version} 已就绪 —— 下面演示 <code>window.PtApp</code> 提供的全部能力。
            </p>

            <section>
                <h2>平台注入的上下文</h2>
                <pre>{JSON.stringify(app.context, null, 2)}</pre>
                <p className="hint">
                    用 <code>context.sid</code> 区分站点、<code>locale</code> 做多语言、
                    <code>initialPath</code> 恢复深链接位置。
                </p>
            </section>

            <section>
                <h2>宿主能力</h2>
                <div className="btns">
                    <button onClick={() => { app.ui.toast('来自子应用的消息', 'success'); push('ui.toast'); }}>
                        toast 提示
                    </button>
                    <button
                        onClick={async () => {
                            const ok = await app.ui.confirm({ title: '确认', message: '要执行这个操作吗？' });
                            push(`ui.confirm → ${ok}`);
                        }}
                    >
                        confirm 确认框
                    </button>
                    <button onClick={() => { app.nav.push('dashboard/default'); push('nav.push → 平台页面'); }}>
                        跳转平台页面
                    </button>
                    <button onClick={() => { app.nav.syncRoute('detail'); push('nav.syncRoute → /detail'); }}>
                        同步内部路由
                    </button>
                </div>
                <p className="hint">
                    <code>nav.syncRoute</code> 把子应用的内部路径写进浏览器地址栏，使刷新、分享链接、
                    浏览器前进后退都能回到同一个内页（平台会把它作为 <code>context.initialPath</code> 回传）。
                </p>
            </section>

            {log.length > 0 && (
                <section>
                    <h2>调用记录</h2>
                    <pre className="log">{log.join('\n')}</pre>
                </section>
            )}
        </main>
    );
}
