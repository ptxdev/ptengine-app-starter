#!/usr/bin/env node
/**
 * 检查本脚手架的 `@ptengine/*` 依赖有没有落后于 npm 上已发布的最新版。
 *
 * 为什么需要它：这两个包与脚手架在**不同仓库**（`@ptengine/*` 在 ptengine-frontend
 * monorepo 里，脚手架是独立 GitHub 仓），发包的人很容易忘记回头更新这里。而它们都还在
 * `0.x` —— npm 对 `0.x` 的 caret 只放行同一个 minor（`^0.4.0` = `>=0.4.0 <0.5.0`），
 * 所以**每个 minor 版本都必须手动改这里**，新 clone 才拿得到。等这些包发到 1.0.0 之后
 * `^1.x` 会自动吸收 minor，这个检查也就只剩兜底意义了。
 *
 * 它**只报告、不改任何文件** —— 依赖该不该跟、CHANGELOG 兼容矩阵怎么写、这次升级对客户
 * 是否必须，都需要人判断，不适合脚本代劳。
 *
 * 退出码：0 = 无漂移；1 = 有漂移（CI 里表现为红灯）；2 = 检查本身出错（如网络不可达）。
 */

import { readFile } from 'node:fs/promises';

const REGISTRY = 'https://registry.npmjs.org';

/** caret 区间的下界，如 `^0.4.0` → `0.4.0`；不是 caret 形态则返回 null（不猜语义）。 */
function caretFloor(range) {
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/**
 * caret 语义（含 npm 对 0.x 的特殊处理）：
 *  - major >= 1：同 major 内放行（`^1.2.3` 允许 1.9.9）
 *  - major == 0 且 minor > 0：**只放行同 minor**（`^0.4.0` 不允许 0.5.0）
 *  - major == 0 且 minor == 0：只放行同 patch（`^0.0.3` 只允许 0.0.3）
 */
function caretAllows(floor, v) {
    if (v.major !== floor.major) return false;
    if (floor.major >= 1) return cmp(v, floor) >= 0;
    if (floor.minor > 0) return v.minor === floor.minor && v.patch >= floor.patch;
    return v.minor === 0 && v.patch === floor.patch;
}

function cmp(a, b) {
    return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 带一次重试 —— 连续打注册表偶发失败过（实测），而定时任务若因偶发网络红灯，
 * 久了就没人认真看它了，那这个检查也就废了。
 */
async function latestOf(name, attempt = 1) {
    try {
        const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
            headers: { accept: 'application/vnd.npm.install-v1+json' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const latest = body['dist-tags'] && body['dist-tags'].latest;
        if (!latest) throw new Error('没有 dist-tags.latest');
        return latest;
    } catch (e) {
        if (attempt >= 2) throw new Error(`查询 ${name} 失败（已重试）：${e.message}`);
        await sleep(1500);
        return latestOf(name, attempt + 1);
    }
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const targets = Object.keys(deps).filter(n => n.startsWith('@ptengine/'));

if (targets.length === 0) {
    console.log('没有 @ptengine/* 依赖，跳过检查。');
    process.exit(0);
}

const drifted = [];
for (const name of targets) {
    const range = deps[name];
    let latest;
    try {
        latest = await latestOf(name);
    } catch (e) {
        console.error(`❌ 检查中断：${e.message}`);
        process.exit(2);
    }

    const floor = caretFloor(range);
    const v = parseVersion(latest);
    if (!floor || !v) {
        // 非 caret 区间（如 `>=0.4.0 <1`、精确版本、tag）：本脚本不猜语义，只提示人工确认。
        console.log(`⚠️  ${name}: 区间 ${range} 不是 caret 形态，npm 最新为 ${latest} —— 请人工确认`);
        continue;
    }

    if (caretAllows(floor, v)) {
        console.log(`✅ ${name}: ${range} 已覆盖 npm 最新版 ${latest}`);
    } else {
        console.log(`❌ ${name}: ${range} **拿不到** npm 最新版 ${latest}`);
        drifted.push({ name, range, latest });
    }
}

if (drifted.length === 0) process.exit(0);

console.log('');
console.log('检测到依赖漂移。新 clone 本脚手架的客户会拿到旧版本，请按下面几步处理：');
console.log('');
for (const d of drifted) {
    const v = parseVersion(d.latest);
    console.log(`  1. package.json：${d.name} 的 ${d.range} → ^${v.major}.${v.minor}.0`);
}
console.log('  2. npm install（刷新 package-lock.json）');
console.log('  3. CHANGELOG.md：加一条新版本条目 + 在**兼容矩阵**里加一行');
console.log('     —— 需要人判断：这次升级对已在开发中的客户是否**必须**跟？');
console.log('  4. 若平台侧的最低版本要求随之抬升，同步改 apps/x 的三语提示');
console.log('     （`shell-{zh,en,ja}.ts` 的 devModeDialogHint）');
console.log('  5. 打 v* tag 发 Release（见 RELEASING.md）');
console.log('');
process.exit(1);
