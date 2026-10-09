/**
 * ptx dev 的本地「数据网关」桩。backend/wrangler.jsonc 把 PT_GATEWAY 绑到这个 worker（ptx-local-gateway），
 * 与业务 worker 在同一个 `wrangler dev` 会话里跑（多 -c 配置）。
 *
 * 只实现 /jobs（ctx.pt.jobs.*，内存存储，重启即清空）；其余路径回 501 PT_GATEWAY_NOT_BOUND ——
 * 与「没有网关 binding」时 ctx.pt.query / ctx.pt.asset 在本地得到的码一致。
 */
import { createJobsStore, handleJobsRequest } from './jobs-store.mjs';

const STUB_JOBS_PATH = '/jobs';
const store = createJobsStore();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default {
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === STUB_JOBS_PATH) {
            if (!store.hinted) {
                store.hinted = true;
                console.log('[ptx] ctx.pt.jobs.* 走的是本地内存桩：ptx dev 重启即清空，不校验 cron / 时区 / 配额，也不会按时触发。' +
                            '要运行任务路由：npx ptx job run <type>');
            }
            let body;
            try { body = await request.json(); } catch { return json(400, { error: { code: 'JOB_OP_INVALID', message: 'body 不是合法 JSON' } }); }
            const r = handleJobsRequest(store, {
                appId: request.headers.get('x-pt-app-id') ?? '',
                authorization: request.headers.get('authorization') ?? '',
                body
            });
            return r.status === 204 ? new Response(null, { status: 204 }) : json(r.status, r.body);
        }
        return json(501, { error: {
            code: 'PT_GATEWAY_NOT_BOUND',
            message: '本地没有数据网关（ptx dev 只为 ctx.pt.jobs.* 提供内存桩）。取数与资产写请在平台内联调。'
        } });
    }
};
