/**
 * 本地 ctx.pt.jobs.* 的内存桩（ptx dev 期间生效）。纯逻辑，worker.mjs 包一层 HTTP。
 *
 * 只模拟「本人视角」（asAdmin=false）：能管的只有自己创建的任务。**不校验 cron / 时区 / 间隔 / 配额、
 * 不会按时触发** —— 要跑任务路由用 `npx ptx job run <type>`。错误码与平台同名，方便本地写错误分支。
 * 令牌只解不验：这是本机开发桩，验签由 app-backend 在任务路由那一侧真做。
 */

const MAX_TITLE = 100;   // = 平台 JOB_TITLE_MAX（本地桩只做形状提示，以平台为准）

export function createJobsStore() {
    return { jobs: new Map(), hinted: false };
}

export function decodeClaims(authorization) {
    const m = /^Bearer[ \t]+(\S+)$/i.exec(String(authorization ?? '').trim());
    const part = m?.[1]?.split('.')[1];
    if (!part) return null;
    try {
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    } catch {
        return null;
    }
}

const err = (status, code, message) => ({ status, body: { error: { code, message } } });

/**
 * JobView.scheduleDescription 的占位（brief §13.3）。线上由平台用 next-runs 同一函数生成三语人话说明；
 * 本地不解析 cron，只把原值回显出来，形状与线上一致。
 */
export const stubDescription = (cron, timezone) => ({
    zh: `（本地桩）cron ${cron} · ${timezone}`,
    en: `(local stub) cron ${cron} · ${timezone}`,
    ja: `（ローカルスタブ）cron ${cron} · ${timezone}`
});
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkFields(b, { partial }) {
    const has = k => b[k] !== undefined;
    if ((!partial || has('type')) && (typeof b.type !== 'string' || !b.type)) return err(400, 'JOB_TYPE_UNKNOWN', 'type 必须是 manifest backend.jobs 里声明过的类型');
    if ((!partial || has('cron')) && (typeof b.cron !== 'string' || !b.cron)) return err(400, 'JOB_CRON_INVALID', 'cron 必须是 5 段 cron 字符串（本地桩不校验语法，以平台为准）');
    if ((!partial || has('timezone')) && (typeof b.timezone !== 'string' || !b.timezone)) return err(400, 'JOB_TIMEZONE_INVALID', 'timezone 必须是 IANA 时区名');
    if (has('params') && !isObj(b.params)) return err(400, 'JOB_PARAMS_INVALID', 'params 必须是 JSON 对象');
    if (has('title') && (typeof b.title !== 'string' || b.title.length === 0 || [...b.title].length > MAX_TITLE)) {
        return err(400, 'JOB_TITLE_INVALID', `title 必须是 1..${MAX_TITLE} 字符`);
    }
    if (has('archiveToAssets') && typeof b.archiveToAssets !== 'boolean') return err(400, 'JOB_OP_INVALID', 'archiveToAssets 必须是布尔值');
    return null;
}

export function handleJobsRequest(store, { appId, authorization, body, now = new Date(), uuid = () => crypto.randomUUID() }) {
    const claims = decodeClaims(authorization);
    if (!claims) return err(401, 'APP_TOKEN_INVALID', '缺少或无法解析 App Token');
    const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
    if (!scopes.includes('jobs:run')) {
        return err(403, 'SCOPE_DENIED', '令牌里没有 jobs:run。在 manifest.json 的 scopes 里声明 jobs:run 后重启 ptx dev（本地 dev token 的 scopes 每次启动都按 manifest 重新生成）。');
    }
    const me = String(claims.sub ?? '');
    const iso = now.toISOString();
    const b = isObj(body) ? body : {};

    if (b.op === 'create') {
        if (claims.trg === 'job') return err(403, 'JOB_CREATE_FROM_JOB', '任务运行中不能创建任务');
        const bad = checkFields(b, { partial: false });
        if (bad) return bad;
        const job = {
            id: uuid(), appId, workspaceId: String(claims.wid ?? ''), type: b.type, title: b.title ?? b.type,
            cron: b.cron, timezone: b.timezone, params: b.params ?? {}, createdBy: me, status: 'active',
            pauseReason: null, consecutiveFailures: 0, nextRunAt: null, lastRunAt: null,
            // 本地只模拟本人视角，「只有创建者能改 archiveToAssets」天然满足；本地不做真实归档
            archiveToAssets: b.archiveToAssets ?? false,
            scheduleDescription: stubDescription(b.cron, b.timezone), createdAt: iso, updatedAt: iso
        };
        store.jobs.set(job.id, job);
        return { status: 201, body: job };
    }
    if (b.op === 'list') {
        const limit = Math.min(Math.max(Number.isInteger(b.limit) ? b.limit : 50, 1), 200);
        const jobs = [...store.jobs.values()]
            .filter(j => j.appId === appId && j.createdBy === me)
            .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
            .slice(0, limit);
        return { status: 200, body: { jobs } };
    }
    if (!['get', 'update', 'pause', 'resume', 'delete'].includes(b.op)) {
        return err(400, 'JOB_OP_INVALID', `不认识的 op：${String(b.op)}`);
    }
    const job = store.jobs.get(b.jobId);
    if (!job || job.appId !== appId) return err(404, 'JOB_NOT_FOUND', '任务不存在');
    if (job.createdBy !== me) return err(403, 'JOB_FORBIDDEN', '只能操作自己创建的任务');

    switch (b.op) {
        case 'get':
            return { status: 200, body: job };
        case 'update': {
            const bad = checkFields(b, { partial: true });
            if (bad) return bad;
            for (const k of ['title', 'cron', 'timezone', 'params', 'archiveToAssets']) if (b[k] !== undefined) job[k] = b[k];
            job.scheduleDescription = stubDescription(job.cron, job.timezone);
            job.updatedAt = iso;
            return { status: 200, body: job };
        }
        case 'pause':
            Object.assign(job, { status: 'paused', pauseReason: 'MANUAL', nextRunAt: null, updatedAt: iso });
            return { status: 200, body: job };
        case 'resume':
            Object.assign(job, { status: 'active', pauseReason: null, consecutiveFailures: 0, updatedAt: iso });
            return { status: 200, body: job };
        default:
            store.jobs.delete(job.id);
            return { status: 204, body: null };
    }
}
