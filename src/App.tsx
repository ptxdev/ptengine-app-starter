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

/**
 * 演示页：既演示 window.PtApp 的宿主能力，也演示 @ptengine/design-components 的用法。
 *
 * 组件库的使用规约（照抄一句：className 只做布局）：
 * - 只从包入口 `@ptengine/design-components` import，不要深引 dist 内部路径。
 * - `className` 只用来排布（宽度 / 间距 / 对齐），**不要**用它改观感（颜色、圆角、阴影）——
 *   观感由设计 token 决定，覆盖了就会与平台其它页面不一致。
 * - 不要硬编码色值：用 `text-muted-foreground`、`bg-secondary` 这类语义类。
 *
 * ⚠️ 浮层类组件（Tooltip / Dialog / Popover / DropdownMenu）需要在外层包一个
 * `TooltipProvider` 之类的 Provider（各组件文档有说明），且它们 portal 到 body ——
 * 这也是 `.pt-ui` 必须挂在 `<html>` 而不是 `#root` 的原因（见 theme.ts）。
 */
export default function App() {
    const app = useMemo(getPtApp, []);
    // context 由桥握手下发：`window.PtApp` 存在时它可能还是**空对象**，locale / theme 之后才到
    // （app-sdk 1.0.0 起）。所以要订阅 on('context') 而不是只在首帧读一次 —— 只读一次的写法
    // 在托管模式下会显示空白的 theme/sid，且不报任何错。
    const [ctx, setCtx] = useState(() => app?.context);
    const [log, setLog] = useState<string[]>([]);
    const [note, setNote] = useState('');
    const push = (line: string) =>
        setLog(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev]);

    useEffect(() => {
        if (!app) return;
        // 每次都换一个新对象，React 才会重渲染（宿主可能推来同一个引用）。
        app.on('context', next => setCtx({ ...next }));
    }, [app]);

    if (!app) {
        return (
            <main className="mx-auto max-w-3xl p-6">
                <h1 className="mb-4 text-lg font-semibold text-foreground">My Ptengine App</h1>
                {/* Alert 只有 default / destructive 两个变体（0.3.0）；提示类用 default。 */}
                <Alert>
                    <AlertTitle>未检测到 window.PtApp</AlertTitle>
                    <AlertDescription>
                        本页面需要由 Ptengine X 平台加载才能拿到宿主能力；本地开发请用{' '}
                        <code className="rounded-sm bg-secondary px-1">npm run dev</code>
                        （入口已接好 dev-host）。
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
                        下面演示 <code className="rounded-sm bg-secondary px-1">window.PtApp</code>{' '}
                        提供的全部能力，UI 全部来自 @ptengine/design-components。
                    </p>
                </header>

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
                            nav.syncRoute 把子应用内部路径写进地址栏，使刷新 / 分享 / 前进后退都能回到
                            同一个内页（平台会把它作为 context.initialPath 回传）。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-wrap gap-2">
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
                        </div>

                        <Separator />

                        {/* 表单控件示例：Label + Input 的搭配（htmlFor 关联，屏幕阅读器可用） */}
                        <div className="space-y-2">
                            <Label htmlFor="demo-note">随手记一条（组件库的 Input 示例）</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="demo-note"
                                    value={note}
                                    placeholder="输入点什么，然后按下按钮"
                                    onChange={e => setNote(e.target.value)}
                                />
                                <Button
                                    variant="secondary"
                                    disabled={!note.trim()}
                                    onClick={() => {
                                        push(`note: ${note.trim()}`);
                                        setNote('');
                                    }}
                                >
                                    记录
                                </Button>
                            </div>
                        </div>
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
