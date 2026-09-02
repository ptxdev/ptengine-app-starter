import { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    AlertDescription,
    AlertTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Input,
    Label,
    Separator,
    TooltipProvider
} from '@ptengine/design-components';
import { getPtApp } from './pt-app';
import { api, ApiError } from './api';
import type { OrdersResponse, Settings } from '../../shared/api';

/**
 * 演示页：宿主能力（window.PtApp）+ **自己的后端**（/api/*）+ 组件库用法。
 *
 * 组件库的使用规约（一句话：className 只做布局）：
 * - 只从包入口 `@ptengine/design-components` import，不要深引 dist 内部路径。
 * - `className` 只用来排布（宽度 / 间距 / 对齐），**不要**用它改观感（颜色、圆角、阴影）。
 * - 不要硬编码色值：用 `text-muted-foreground`、`bg-secondary` 这类语义类。
 *
 * ⚠️ 浮层类组件（Tooltip / Dialog / Popover / DropdownMenu）portal 到 body ——
 * 这也是 `.pt-ui` 必须挂在 `<html>` 而不是 `#root` 的原因（见 theme.ts）。
 */
export default function App() {
    const app = useMemo(getPtApp, []);
    // context 由桥握手下发：`window.PtApp` 存在时它可能还是**空对象**，locale / theme 之后才到。
    // 所以要订阅 on('context')，不能只在首帧读一次 —— 只读一次在托管模式下会显示空白且不报错。
    const [ctx, setCtx] = useState(() => app?.context);
    const [log, setLog] = useState<string[]>([]);
    const push = (line: string) =>
        setLog(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev]);

    useEffect(() => {
        if (!app) return;
        // 每次换一个新对象，React 才会重渲染（宿主可能推来同一个引用）。
        app.on('context', next => setCtx({ ...next }));
    }, [app]);

    if (!app) {
        return (
            <main className="mx-auto max-w-3xl p-6">
                <h1 className="mb-4 text-lg font-semibold text-foreground">My Ptengine App</h1>
                <Alert>
                    <AlertTitle>未检测到 window.PtApp</AlertTitle>
                    <AlertDescription>
                        本页面需要由 Ptengine X 平台加载才能拿到宿主能力；本地开发请用{' '}
                        <code className="rounded-sm bg-secondary px-1">npm run dev</code>。
                    </AlertDescription>
                </Alert>
            </main>
        );
    }

    return (
        <TooltipProvider>
            <main className="mx-auto max-w-3xl space-y-5 p-6">
                <header className="space-y-1">
                    <div className="flex items-center gap-2">
                        <h1 className="text-lg font-semibold text-foreground">My Ptengine App</h1>
                        <Badge variant="secondary">SDK v{app.version}</Badge>
                        <Badge variant="information">{ctx?.theme ?? '…'}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        这个脚手架同时带**前端与后端**：下面第一张卡演示调用自己的{' '}
                        <code className="rounded-sm bg-secondary px-1">/api/*</code>。
                    </p>
                </header>

                <BackendDemo onLog={push} />

                <Card>
                    <CardHeader>
                        <CardTitle>平台注入的上下文</CardTitle>
                        <CardDescription>
                            用 context.sid 区分站点、locale 做多语言、initialPath 恢复深链接位置。
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <pre className="overflow-auto rounded-md bg-secondary p-3 text-2xs text-foreground">
                            {JSON.stringify(ctx ?? {}, null, 2)}
                        </pre>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>宿主能力</CardTitle>
                        <CardDescription>
                            nav.syncRoute 把子应用内部路径写进地址栏，使刷新 / 分享 / 前进后退都能
                            回到同一个内页（平台会把它作为 context.initialPath 回传）。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                        <Button
                            onClick={() => {
                                app.ui.toast('来自子应用的消息', 'success');
                                push('ui.toast');
                            }}
                        >
                            toast 提示
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={async () => {
                                const ok = await app.ui.confirm({
                                    title: '确认',
                                    message: '要执行这个操作吗？'
                                });
                                push(`ui.confirm → ${ok}`);
                            }}
                        >
                            confirm 确认框
                        </Button>
                        <Button
                            variant="tertiary"
                            onClick={() => {
                                app.nav.push('dashboard/default');
                                push('nav.push → 平台页面');
                            }}
                        >
                            跳转平台页面
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                app.nav.syncRoute('detail');
                                push('nav.syncRoute → /detail');
                            }}
                        >
                            同步内部路由
                        </Button>
                    </CardContent>
                </Card>

                {log.length > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>调用记录</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <pre className="max-h-52 overflow-auto rounded-md bg-secondary p-3 text-2xs text-foreground">
                                {log.join('\n')}
                            </pre>
                        </CardContent>
                    </Card>
                )}
            </main>
        </TooltipProvider>
    );
}

/**
 * 调用自己后端的示例。
 *
 * 注意这里**没有**任何 baseURL、token 拼装、CORS 处理 —— `api()` 全兜住了
 * （取 token、自动续期、401 重试一次、解错误信封）。见 `web/src/api.ts`。
 */
function BackendDemo({ onLog }: { onLog: (line: string) => void }) {
    const [orders, setOrders] = useState<OrdersResponse | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [currency, setCurrency] = useState('USD');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    /** 把 ApiError 变成一句人能看懂的话，并把 requestId 带出来以便报障。 */
    const run = async (label: string, fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            onLog(`${label} → ok`);
        } catch (e) {
            if (e instanceof ApiError) {
                setError(`${e.code}: ${e.message}${e.requestId ? `（requestId ${e.requestId}）` : ''}`);
                onLog(`${label} → ${e.status} ${e.code}`);
            } else {
                setError(String(e));
                onLog(`${label} → ${String(e)}`);
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>我的后端（/api/*）</CardTitle>
                <CardDescription>
                    后端代码在 <code className="rounded-sm bg-secondary px-1">backend/src/index.ts</code>。
                    本地 <code className="rounded-sm bg-secondary px-1">npm run dev</code> 会同时起
                    vite 与 wrangler，并签发一个真 token —— 后端会真验签，鉴权问题在本地就能测出来。
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                    <Button
                        disabled={busy}
                        onClick={() =>
                            run('GET /orders', async () => {
                                setOrders(await api('GET /orders', { query: { days: '7' } }));
                            })
                        }
                    >
                        取订单
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                            run('GET /settings', async () => {
                                const s = await api('GET /settings');
                                setSettings(s);
                                setCurrency(s.currency);
                            })
                        }
                    >
                        读设置（D1）
                    </Button>
                </div>

                <Separator />

                <div className="space-y-2">
                    <Label htmlFor="currency">币种（写进 D1，按 sid 隔离）</Label>
                    <div className="flex gap-2">
                        <Input
                            id="currency"
                            value={currency}
                            placeholder="USD"
                            onChange={e => setCurrency(e.target.value.toUpperCase())}
                        />
                        <Button
                            variant="secondary"
                            disabled={busy || !/^[A-Z]{3}$/.test(currency)}
                            onClick={() =>
                                run('POST /settings', async () => {
                                    await api('POST /settings', { body: { currency } });
                                    setSettings({ currency });
                                })
                            }
                        >
                            保存
                        </Button>
                    </div>
                </div>

                {error && (
                    <Alert variant="destructive">
                        <AlertTitle>后端返回错误</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                {(orders || settings) && (
                    <pre className="max-h-60 overflow-auto rounded-md bg-secondary p-3 text-2xs text-foreground">
                        {JSON.stringify({ orders, settings }, null, 2)}
                    </pre>
                )}
            </CardContent>
        </Card>
    );
}
