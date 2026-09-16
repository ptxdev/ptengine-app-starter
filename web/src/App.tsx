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
import type { OrdersResponse, PublicStatus, Settings } from '../../shared/api';

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
        // 直接在浏览器里打开（不经 Ptengine 托管）时走这里。
        //
        // ⚠️ 这里刻意**不是**一个死胡同页。原来只显示一句"未检测到 window.PtApp"，
        //    结果是：应用地址打开后你完全看不出后端到底有没有部署成功 ——
        //    验收和排障时分不清"鉴权在正常工作"还是"后端根本没起来"。
        //    所以这里仍然跑一遍公开自检，并顺带演示鉴权边界。
        return <StandaloneMode />;
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

/**
 * 独立打开（不经 Ptengine 托管）时显示的自检面板。
 *
 * 它回答三个问题，每个都用一次真实请求回答，不靠文案声明：
 *   1. 后端部署成功了吗           → GET /api/public/status（公开路由，不验签）
 *   2. D1 / KV 通不通             → 同上，逐项探活
 *   3. 鉴权真的在拦吗             → GET /api/settings 不带令牌，期望 401
 *
 * 第 3 项是刻意的：**看到 401 才说明鉴权在工作**。把它显示成"通过"而不是
 * 报错，否则验收的人会以为出了问题。
 */
function StandaloneMode() {
    const [status, setStatus] = useState<PublicStatus | null>(null);
    const [statusErr, setStatusErr] = useState<string | null>(null);
    const [authProbe, setAuthProbe] = useState<{ ok: boolean; detail: string } | null>(null);

    useEffect(() => {
        // 公开路由：直接 fetch，不走 api()（那会去取令牌）。
        fetch('/api/public/status')
            .then(async r => {
                const body = await r.json();
                if (!r.ok) throw new Error(body?.error?.code ?? `HTTP ${r.status}`);
                setStatus(body as PublicStatus);
            })
            .catch(e => setStatusErr(String(e?.message ?? e)));

        // 鉴权边界：故意不带令牌，期望被拒。
        fetch('/api/settings')
            .then(async r => {
                const body = await r.json().catch(() => null);
                const code = body?.error?.code ?? '';
                setAuthProbe(
                    r.status === 401
                        ? { ok: true, detail: `401 ${code} —— 鉴权正常拦截` }
                        : { ok: false, detail: `HTTP ${r.status} ${code} —— 期望 401，请检查` }
                );
            })
            .catch(e => setAuthProbe({ ok: false, detail: String(e?.message ?? e) }));
    }, []);

    const dot = (s: 'ok' | 'unavailable' | 'error' | 'pending') => {
        const map = {
            ok: ['success', '正常'],
            unavailable: ['secondary', '未声明'],
            error: ['destructive', '故障'],
            pending: ['secondary', '检测中…']
        } as const;
        const [variant, label] = map[s];
        return <Badge variant={variant as never}>{label}</Badge>;
    };

    return (
        <main className="mx-auto max-w-3xl space-y-5 p-6">
            <header className="space-y-1">
                <div className="flex items-center gap-2">
                    <h1 className="text-lg font-semibold text-foreground">Custom App 自检</h1>
                    <Badge variant="secondary">独立模式</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                    这个页面没有由 Ptengine 托管，所以拿不到宿主能力（window.PtApp）。
                    但它仍然会真实调用自己的后端 —— 下面每一行都是一次实际请求的结果。
                </p>
            </header>

            <Card>
                <CardHeader>
                    <CardTitle>后端状态</CardTitle>
                    <CardDescription>
                        <code className="rounded-sm bg-secondary px-1">GET /api/public/status</code>
                        {' '}—— 公开路由，不需要令牌
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                    {statusErr && (
                        <Alert variant="destructive">
                            <AlertTitle>后端没有响应</AlertTitle>
                            <AlertDescription>{statusErr}</AlertDescription>
                        </Alert>
                    )}
                    {!status && !statusErr && <p className="text-muted-foreground">检测中…</p>}
                    {status && (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <span className="text-muted-foreground">应用 ID</span>
                                <code>{status.appId ?? '—'}</code>
                                <span className="text-muted-foreground">版本</span>
                                <code>{status.versionId ?? '—'}</code>
                                <span className="text-muted-foreground">服务端时间</span>
                                <code>{status.serverTime}</code>
                            </div>
                            <Separator />
                            <div className="flex items-center gap-3">
                                <span className="text-muted-foreground w-24">D1 数据库</span>
                                {dot(status.checks.database)}
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-muted-foreground w-24">KV</span>
                                {dot(status.checks.kv)}
                            </div>
                            <Separator />
                            <div>
                                <p className="mb-1 text-muted-foreground">已注册路由</p>
                                <ul className="space-y-0.5">
                                    {status.routes.map(r => (
                                        <li key={r}><code className="text-xs">{r}</code></li>
                                    ))}
                                </ul>
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>鉴权边界</CardTitle>
                    <CardDescription>
                        <code className="rounded-sm bg-secondary px-1">GET /api/settings</code>
                        {' '}不带令牌 —— <strong>被拒才是正确结果</strong>
                    </CardDescription>
                </CardHeader>
                <CardContent className="text-sm">
                    {!authProbe && <p className="text-muted-foreground">检测中…</p>}
                    {authProbe && (
                        <div className="flex items-center gap-3">
                            {authProbe.ok ? dot('ok') : dot('error')}
                            <code className="text-xs">{authProbe.detail}</code>
                        </div>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">
                        业务接口需要 App Token，而令牌由 Ptengine 平台在 iframe 里下发。
                        要看完整功能，把这个应用装进 Ptengine；本地开发用{' '}
                        <code className="rounded-sm bg-secondary px-1">npm run dev</code>。
                    </p>
                </CardContent>
            </Card>
        </main>
    );
}
