/**
 * ptx deploy —— 把打好的 zip 上传到 Ptengine X，可选立即发布。
 *
 * 这是"整个过程自动化"的最后一环：CI 里打个 tag，线上就更新了，前后端一起。
 *
 * 平台侧做的事（见设计文档 §10.2）：校验 -> 前端进 R2 -> 建资源 -> 跑迁移 ->
 * 组装 secrets 绑定 -> 推 worker 到 dispatch namespace -> 原子切版本指针 -> 健康探针。
 * 探针失败会自动回滚，所以 `--publish` 返回成功就意味着线上真的在跑。
 *
 * 需要的环境变量：
 *   PTENGINE_TOKEN     部署凭据。**按 App 授权、可撤销**，别用账号级 token。
 *   PTENGINE_APP_ID    目标应用 id（在应用管理页可见）。
 *   PTENGINE_API_BASE  可选，覆盖默认域名。三套环境：
 *                        production   https://xbackend.ptengine.com （默认）
 *                        staging      https://stagingxbackend.ptengine.jp
 *                        development  https://devxbackend.ptengine.cn
 *
 * `--stream` 时改走 NDJSON 流式发布端点，边发布边打印九步进度；不加则走同步 `/publish`，
 * 跑完（约 20–40s，带后端时）一次性返回。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readManifest } from './manifest.mjs';

const DEFAULT_API_BASE = 'https://xbackend.ptengine.com';

// 错误信封 { error: { code, message, requestId } } -> 给用户看的话术。
// 未命中的 code 打印 `code: message` 兜底。
function describeError(body) {
    const code = body?.error?.code;
    const message = body?.error?.message;
    switch (code) {
        case 'DEPLOY_TOKEN_INVALID':
            return 'PTENGINE_TOKEN 无效或已撤销：到 Ptengine X →「自定义应用管理」→ 部署令牌 重新生成';
        case 'PUBLISH_BUSY':
        case 'UPLOAD_BUSY':
            return `平台繁忙（${code}），读 Retry-After 后重试`;
        case 'PUBLISH_IN_PROGRESS':
            return '该应用正在发布中';
        case 'SECRET_NOT_SET':
            return `${message}（到应用管理页的密钥管理页面补上）`;
        default:
            return code ? (message ? `${code}: ${message}` : code) : (message ?? JSON.stringify(body));
    }
}

function findZip(root, manifest) {
    const expected = `${manifest.id || 'ptengine-app'}-${manifest.version}.zip`;
    if (existsSync(join(root, expected))) return join(root, expected);

    // 兜底：目录里只有一个 zip 时用它，并说清用了哪个（避免误传上一个版本）。
    const zips = readdirSync(root).filter(f => f.endsWith('.zip'));
    if (zips.length === 1) return join(root, zips[0]);
    if (zips.length === 0) {
        throw new Error(`没找到 ${expected}，请先执行 \`npm run package\``);
    }
    throw new Error(
        `目录里有多个 zip（${zips.join(', ')}），但没有期望的 ${expected}。` +
        `manifest.version 与包名不一致时容易传错版本 —— 请重新 \`npm run package\`。`
    );
}

async function callApi(base, path, token, init) {
    const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
    });
    const text = await res.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        const detail = typeof body === 'object' && body?.error
            ? describeError(body)
            : (typeof body === 'object' && body ? (body.message ?? JSON.stringify(body)) : String(body).slice(0, 400));
        const suffix = retryAfter ? `（Retry-After: ${retryAfter}s）` : '';
        throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}\n      ${detail}${suffix}`);
    }
    return body;
}

/**
 * 流式发布：POST .../publish/stream，逐行解析 NDJSON（begin/step/done/error）。
 *
 * ⚠️ 一旦开始写流，HTTP 状态码就定死 200 了——必须读完整个流才能判断真正成不成功，
 * 不能只看请求本身有没有抛异常。
 */
async function publishStream(base, appId, versionId, token) {
    const res = await fetch(
        `${base}/api/custom-app/apps/${appId}/versions/${versionId}/publish/stream`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
        // 开流之前就失败（鉴权 / 并发闸 / 包未暂存等），状态码还是真的。
        const text = await res.text();
        let body;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = text;
        }
        const retryAfter = res.headers.get('retry-after');
        const detail = typeof body === 'object' && body?.error ? describeError(body) : String(body).slice(0, 400);
        const suffix = retryAfter ? `（Retry-After: ${retryAfter}s）` : '';
        throw new Error(`POST .../publish/stream -> ${res.status}\n      ${detail}${suffix}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let doneEvent = null;
    let errorEvent = null;

    const handleLine = (line) => {
        if (!line.trim()) return;
        const ev = JSON.parse(line);
        if (ev.type === 'step') {
            console.log(`  [${ev.step}/9] ${ev.label}${ev.detail ? ` — ${ev.detail}` : ''}`);
        } else if (ev.type === 'done') {
            doneEvent = ev;
        } else if (ev.type === 'error') {
            errorEvent = ev;
        }
    };

    for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
    }

    // reader 结束后 buf 里可能还剩最后一行（没有 trailing newline）——当成一行处理，
    // 否则最后的 done/error 事件会被吞掉，误判成"流提前结束"。
    if (buf.trim()) {
        handleLine(buf);
        buf = '';
    }

    if (errorEvent) {
        throw new Error(describeError({ error: errorEvent }));
    }
    if (!doneEvent) {
        throw new Error('流提前结束，发布结果未知（查服务端日志确认，或重新发起一次 --publish --stream）');
    }
    return doneEvent;
}

export async function run(args, root) {
    const dryRun = args.includes('--dry-run');
    const publish = args.includes('--publish');
    const stream = args.includes('--stream');

    const manifest = readManifest(root);
    const zipPath = findZip(root, manifest);
    const size = statSync(zipPath).size;

    const base = process.env.PTENGINE_API_BASE || DEFAULT_API_BASE;
    const appId = process.env.PTENGINE_APP_ID;
    const token = process.env.PTENGINE_TOKEN;

    console.log(`
  上传        ${basename(zipPath)}   (${(size / 1024).toFixed(0)} KB)
  应用版本    ${manifest.version}
  后端        ${manifest.backend ? manifest.backend.entry : '（无）'}
  目标        ${base}
  应用 id     ${appId ?? '(未设置)'}
  发布        ${publish ? (stream ? '上传后立即发布（--stream 实时进度）' : '上传后立即发布') : '仅上传为草稿'}
`);

    if (dryRun) {
        console.log('  [dry-run] 未发起任何请求。\n');
        return;
    }

    const missing = [];
    if (!token) missing.push('PTENGINE_TOKEN');
    if (!appId) missing.push('PTENGINE_APP_ID');
    if (missing.length) {
        throw new Error(
            `缺少环境变量：${missing.join(', ')}。\n` +
            `      本地可以先用 \`npx ptx deploy --dry-run\` 看看会做什么；\n` +
            `      CI 里把 PTENGINE_TOKEN 放进 secrets、PTENGINE_APP_ID 放进 vars。`
        );
    }

    const form = new FormData();
    form.set(
        'package',
        new Blob([readFileSync(zipPath)], { type: 'application/zip' }),
        basename(zipPath)
    );

    console.log('  -> 上传版本');
    const created = await callApi(
        base, `/api/custom-app/apps/${appId}/versions`, token,
        { method: 'POST', body: form }
    );
    const versionId = created?.versionId ?? created?.data?.versionId;
    if (!versionId) {
        throw new Error(`上传成功但响应里没有 versionId：${JSON.stringify(created)}`);
    }
    console.log(`     versionId = ${versionId}`);

    if (!publish) {
        console.log(`
[ok] 已上传为草稿。到应用管理页发布它，或重跑加上 --publish。
`);
        return;
    }

    console.log('  -> 发布（含建资源、跑迁移、推后端、健康探针）');
    if (stream) {
        await publishStream(base, appId, versionId, token);
    } else {
        await callApi(
            base, `/api/custom-app/apps/${appId}/versions/${versionId}/publish`, token,
            { method: 'POST' }
        );
    }

    console.log(`
[ok] 已发布。前端与后端是同一个版本（${manifest.version} / ${versionId}）。
     出问题可回滚：npx ptx deploy 之后在管理页选上一个版本，
     或调 POST /api/custom-app/apps/${appId}/rollback。
`);
}
