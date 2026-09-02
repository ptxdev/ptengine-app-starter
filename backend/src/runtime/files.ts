/**
 * R2 的前缀隔离封装。**平台维护，不要改。**
 *
 * ⚠️ 已知的残余风险，写在这里以免被忘掉：
 * R2 的 bucket binding **本身不支持前缀限制** —— 平台挂给你的 `env.FILES` 是整个
 * bucket。前缀隔离由这一层强制（所有 key 自动加 `apps/<appId>/`、拒绝路径穿越）。
 * 也就是说这是一个**运行时约定，而不是平台强制的边界**：绕过 `ctx.files` 直接用
 * `env.FILES` 就能访问别的应用的文件。
 *
 * 因此 Level 2（客户自助）的应用在 Phase 1 **一律不开 `resources.files`**。
 * Phase 2 会换成"一 App 一 bucket"或经平台网关代理，届时这一层退化成薄壳。
 */

import type { ScopedR2 } from './types';
import { badRequest } from './errors';

function scopeKey(prefix: string, key: string): string {
    if (key.startsWith('/')) throw badRequest('FILE_KEY_ABSOLUTE', 'key 不能以 / 开头');
    // 逐段检查，而不是简单 includes('..') —— 后者会误杀 `my..file.txt` 这类合法名字。
    const segments = key.split('/');
    if (segments.some(seg => seg === '..' || seg === '.')) {
        throw badRequest('FILE_KEY_TRAVERSAL', 'key 里不允许 . 或 .. 路径段');
    }
    if (key.length === 0) throw badRequest('FILE_KEY_EMPTY');
    return prefix + key;
}

export function createScopedR2(bucket: R2Bucket, appId: string): ScopedR2 {
    const prefix = `apps/${appId}/`;
    return {
        get: key => bucket.get(scopeKey(prefix, key)),
        put: (key, value, options) => bucket.put(scopeKey(prefix, key), value, options),
        delete: async key => { await bucket.delete(scopeKey(prefix, key)); },
        list: async options => {
            const sub = options?.prefix ? scopeKey(prefix, options.prefix) : prefix;
            const res = await bucket.list({ ...options, prefix: sub });
            // 把前缀从返回的 key 上剥掉，让调用方看到的始终是自己的相对 key。
            return {
                ...res,
                objects: res.objects.map(o => ({ ...o, key: o.key.slice(prefix.length) }))
            } as R2Objects;
        }
    };
}
