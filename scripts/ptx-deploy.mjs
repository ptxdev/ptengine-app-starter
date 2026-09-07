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
 *   PTENGINE_API_BASE  可选，默认线上。私有化/内部环境改这个。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readManifest } from './manifest.mjs';

const DEFAULT_API_BASE = 'https://api.ptengine.io';

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
        const detail = typeof body === 'object' && body
            ? (body.error?.message ?? body.message ?? JSON.stringify(body))
            : String(body).slice(0, 400);
        throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}\n      ${detail}`);
    }
    return body;
}

export async function run(args, root) {
    const dryRun = args.includes('--dry-run');
    const publish = args.includes('--publish');

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
  发布        ${publish ? '上传后立即发布' : '仅上传为草稿'}
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
    await callApi(
        base, `/api/custom-app/apps/${appId}/versions/${versionId}/publish`, token,
        { method: 'POST' }
    );

    console.log(`
[ok] 已发布。前端与后端是同一个版本（${manifest.version} / ${versionId}）。
     出问题可回滚：npx ptx deploy 之后在管理页选上一个版本，
     或调 POST /api/custom-app/apps/${appId}/rollback。
`);
}
