/**
 * ptx doctor —— 体检。
 *
 * 这个命令主要是**给 AI 编码助手用的**：把"四处 UI 接线 + 三条硬约定 +
 * 后端边界"变成一条可执行的检查。改完代码跑一次就知道有没有踩坑，
 * 而不是依赖它记住文档里的每一条。
 *
 * 收录标准：只查那些**违反后不报错、现象不直观**的东西（白屏、没样式、
 * 上传被拒、线上 401）。能靠 tsc 或 vite 报出来的，这里不重复查。
 *
 *   npx ptx doctor            本地检查
 *   npx ptx doctor --deps     额外检查 @ptengine/* 依赖是否落后于 npm 最新版（需要网络）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readManifest, validateManifest } from './manifest.mjs';
import { parseJsonc } from './jsonc.mjs';

const results = [];
const ok = msg => results.push({ level: 'ok', msg });
const bad = (msg, why) => results.push({ level: 'bad', msg, why });
const warn = (msg, why) => results.push({ level: 'warn', msg, why });

function read(root, rel) {
    const p = join(root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ─── 三条硬约定 ─────────────────────────────────────────────────────────

function checkViteBase(root) {
    const src = read(root, 'web/vite.config.ts');
    if (!src) return bad('web/vite.config.ts 不存在', '前端构建配置丢了');
    if (/base:\s*'\.\/'/.test(src) || /base:\s*"\.\/"/.test(src)) {
        return ok("vite base 是相对路径 './'");
    }
    bad(
        'vite base 不是相对路径',
        "必须是 './'。前端产物由平台从 R2 提供，入口地址形如 " +
        '<appId>.app.ptengine.ai/v/<versionId>/index.html；绝对 base 会让产物请求 ' +
        '/assets/* 落到域名根 -> 404 -> 白屏，且控制台之外没有任何提示。'
    );
}

function checkManifestEntry(root, manifest) {
    if (!manifest.entry) return bad('manifest.entry 缺失', '平台会报 ENTRY_MISSING');
    const html = read(root, 'web/index.html');
    if (!html) return warn('web/index.html 不存在', '构建入口对不上');
    if (manifest.entry === 'index.html') return ok('manifest.entry 与构建入口一致');
    warn(
        `manifest.entry 是 "${manifest.entry}"，不是默认的 index.html`,
        '确认构建产物里真的有这个文件，否则上传报 ENTRY_NOT_FOUND'
    );
}

// ─── 四处 UI 接线（错了都不报错，只是样式不对）───────────────────────────

function checkTailwind(root) {
    const src = read(root, 'web/tailwind.config.js');
    if (!src) return bad('web/tailwind.config.js 不存在', '组件库的设计 token 接不进来');

    if (/presets:\s*\[\s*designPreset/.test(src)) {
        ok('tailwind presets 引入了组件库 preset');
    } else {
        bad(
            'tailwind 缺少 presets: [designPreset]',
            '组件仍会渲染，但全部掉成 Tailwind 默认观感（颜色不对、hover 没有叠加层），' +
            '且不会有任何报错。'
        );
    }

    if (/@ptengine\/design-components\/dist/.test(src)) {
        ok('tailwind content 覆盖了组件库 dist');
    } else {
        bad(
            'tailwind content 里没有 @ptengine/design-components/dist/**',
            '组件的 class 字符串在**已编译的库产物里**。漏了这条，Tailwind 扫不到、' +
            '不生成对应 CSS，页面渲染出"结构对但完全没有样式"的组件。'
        );
    }
}

function checkTokensCss(root) {
    const src = read(root, 'web/src/main.tsx');
    if (!src) return bad('web/src/main.tsx 不存在', '前端入口丢了');
    if (/@ptengine\/design-components\/styles\/tokens\.css/.test(src)) {
        ok('main.tsx 引入了 tokens.css');
    } else {
        bad(
            'main.tsx 没有 import tokens.css',
            '缺了它所有 --pt-* 变量未定义，组件"有结构、没颜色"，且不报错。'
        );
    }

    if (/await\s+installDevHost\(/.test(src)) {
        ok('main.tsx 等待了 installDevHost()');
    } else {
        bad(
            'main.tsx 没有 await installDevHost()',
            '在平台内以 dev 模式加载时 window.PtApp 是**异步**就绪的。不等它，' +
            'App.tsx 的 useMemo(getPtApp, []) 会读到 null 且永不重算，页面永久停在' +
            '"未检测到 window.PtApp"——只在平台内 dev 模式出现，本地 npm run dev 完全正常。'
        );
    }
}

function checkPtUiScope(root) {
    const src = read(root, 'web/src/theme.ts');
    if (!src) return bad('web/src/theme.ts 不存在', 'pt-ui 作用域没人挂');
    if (/document\.documentElement/.test(src) && /'pt-ui'|"pt-ui"/.test(src)) {
        ok('pt-ui 挂在 <html> 上');
    } else {
        bad(
            'pt-ui 没有挂在 document.documentElement 上',
            '组件库不写任何 :root 级样式。挂到 #root 上的症状是"页面正常、一打开弹窗' +
            '就没样式"——Radix 浮层 portal 到 document.body，取不到变量。'
        );
    }
    if (/on\('context'/.test(src)) {
        ok('主题订阅了 on(\'context\')');
    } else {
        warn(
            "theme.ts 没有订阅 on('context')",
            "旧的 on('change') 已移除；照旧写法不报错，只是主题静默不跟随。"
        );
    }
}

// ─── 路由 ───────────────────────────────────────────────────────────────

function checkRouting(root) {
    const files = ['web/src/App.tsx', 'web/src/main.tsx'];
    const hits = [];
    for (const f of files) {
        const src = read(root, f);
        if (!src) continue;
        if (/BrowserRouter/.test(src)) hits.push(`${f}: BrowserRouter`);
        if (/history\.pushState\(\s*[^,]*,\s*[^,]*,\s*['"]\//.test(src)) {
            hits.push(`${f}: history.pushState('/...')`);
        }
    }
    if (hits.length === 0) return ok('没有使用绝对路径路由');
    bad(
        `使用了会跳出子应用范围的路由：${hits.join('、')}`,
        '入口 HTML 的地址不是 /，绝对路径会跳出子应用。用 HashRouter，' +
        '或用 PtApp.nav.syncRoute() 把内部位置同步到地址栏。'
    );
}

// ─── 后端边界 ───────────────────────────────────────────────────────────

function checkBackend(root, manifest) {
    if (!manifest.backend) {
        return ok('没有 backend 段（纯静态应用）');
    }

    const idx = read(root, 'backend/src/index.ts');
    if (!idx) return bad('backend/src/index.ts 不存在', 'manifest 声明了后端但没有代码');

    if (/createApp\s*[<(]/.test(idx) && /export\s+default/.test(idx)) {
        ok('backend 入口默认导出 createApp(...)');
    } else {
        bad(
            'backend/src/index.ts 没有 `export default createApp(...)`',
            'createApp 是唯一保证"每个请求都验签"的地方。自己写 export default { fetch } ' +
            '会让后端完全裸奔，而且**本地测不出来**（本地只有你自己在调）。'
        );
    }

    // 运行时现在是 npm 依赖而不是内联目录。检查两件事：依赖在、且没有被 fork 回本地。
    //
    // read() 在文件不存在时返回 null，而 JSON.parse(null) 得到的是 null ——
    // 紧接着读 .dependencies 会抛 TypeError。doctor 的全部意义就是给出说得清的
    // 诊断，让它自己崩在一个 TypeError 上最难看，所以先守一道。
    const pkgRaw = read(root, 'package.json');
    if (!pkgRaw) return bad('package.json 不存在', '这不像是脚手架的根目录');
    const pkg = JSON.parse(pkgRaw);
    const hasDep = Boolean(pkg.dependencies?.['@ptengine/app-backend']);
    if (hasDep) ok('依赖了 @ptengine/app-backend');
    else {
        bad(
            'package.json 缺少 @ptengine/app-backend 依赖',
            'createApp 来自这个包。npm i @ptengine/app-backend'
        );
    }
    if (read(root, 'backend/src/runtime/index.ts')) {
        warn(
            '本地存在 backend/src/runtime/ —— 看起来把运行时 fork 回来了',
            '运行时由平台维护并随包升级。本地 fork 会拿不到安全修复；' +
            '有需求请提到平台侧，不要在应用里改它。'
        );
    }

    // 禁止项：DO 与 connect() —— outbound worker 拦不住这两条出站路径，
    // 平台层面不会给这些绑定，写了也只是线上直接报错。
    const forbidden = [
        [/DurableObject/, 'Durable Objects', '平台不给租户 DO：outbound worker 拦不住 DO 内的 fetch，SSRF 防线会有洞'],
        [/\bconnect\s*\(/, 'connect() TCP', '启用 outbound worker 后 connect() 被运行时禁用'],
        [/caches\.default/, 'caches.default', 'untrusted 隔离下它被禁用（这是默认隔离模式）']
    ];
    let anyForbidden = false;
    for (const [re, label, why] of forbidden) {
        if (re.test(idx)) {
            anyForbidden = true;
            bad(`后端用了 ${label}`, why);
        }
    }
    if (!anyForbidden) ok('后端没有使用被禁的运行时能力');

    // wrangler.jsonc 的本地配置要与后端校验的值一致，否则本地一律 TOKEN_AUD_MISMATCH。
    const wranglerSrc = read(root, 'backend/wrangler.jsonc');
    if (!wranglerSrc) {
        bad('backend/wrangler.jsonc 不存在', '本地 wrangler dev 起不来');
    } else {
        try {
            const w = parseJsonc(wranglerSrc);
            if (w.main === 'src/index.ts') ok('wrangler main 指向 src/index.ts');
            else bad(`wrangler main 是 "${w.main}"`, 'ptx build 期望产物落在 .out/index.js');

            if (w.vars?.PT_TOKEN_AUD && w.vars?.PT_TOKEN_ISS) {
                ok('wrangler vars 有 PT_TOKEN_AUD / PT_TOKEN_ISS');
            } else {
                bad(
                    'wrangler vars 缺 PT_TOKEN_AUD 或 PT_TOKEN_ISS',
                    'ptx dev 从这里取值签本地 token；缺了本地请求会一律 401。'
                );
            }
            if (!w.compatibility_date) {
                warn('wrangler 没有 compatibility_date', '本地与线上运行时行为可能不一致');
            }
        } catch (e) {
            bad(`backend/wrangler.jsonc 解析失败：${e.message}`, '检查是否有语法错误');
        }
    }

    // 声明了资源就该在本地也有对应 binding，否则本地一跑就撞 RESOURCE_NOT_DECLARED。
    if (wranglerSrc) {
        try {
            const w = parseJsonc(wranglerSrc);
            const res = manifest.backend.resources ?? {};
            if (res.database && !(w.d1_databases?.length)) {
                warn('manifest 声明了 database，但 wrangler.jsonc 里没有 d1_databases',
                    '线上没问题（平台注入），但本地 ctx.db 会抛 RESOURCE_NOT_DECLARED');
            }
            if (res.kv && !(w.kv_namespaces?.length)) {
                warn('manifest 声明了 kv，但 wrangler.jsonc 里没有 kv_namespaces',
                    '同上：线上没问题，本地会抛错');
            }
        } catch {
            // 上面已经报过解析失败了。
        }
    }
}

/**
 * 后端 `ctx.requireScope(...)` 用到的权限，必须在 manifest.scopes 里声明过。
 *
 * 不一致的后果很别扭：manifest 没声明 -> 平台不会把该权限放进 token ->
 * `requireScope` 永远 403。而这**只在真实用户调用时才出现**（本地 ptx dev 签的
 * 假身份带了全部 scope，所以本地一切正常）。属于典型的"上线才炸"。
 */
function checkScopeConsistency(root, manifest) {
    const idx = read(root, 'backend/src/index.ts');
    if (!idx || !manifest.backend) return;

    const used = new Set();
    // 匹配 requireScope('a', "b") 里的字符串字面量。
    for (const m of idx.matchAll(/requireScope\s*\(([^)]*)\)/g)) {
        for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) used.add(s[1]);
    }
    if (used.size === 0) return ok('后端没有用 requireScope（无需对照 manifest.scopes）');

    const declared = new Set(manifest.scopes ?? []);
    const missing = [...used].filter(s => !declared.has(s));
    if (missing.length === 0) {
        return ok(`requireScope 用到的权限都已在 manifest.scopes 声明（${[...used].join('、')}）`);
    }
    bad(
        `后端 requireScope 用了未声明的权限：${missing.join('、')}`,
        '把它们加进 manifest.json 的 scopes。没声明 -> 平台不会把该权限放进 token -> ' +
        '线上永远 403；而本地 ptx dev 的假身份带了全部 scope，所以本地测不出来。'
    );
}

// ─── 密钥与忽略项 ───────────────────────────────────────────────────────

function checkGitignore(root) {
    const src = read(root, '.gitignore');
    if (!src) return warn('.gitignore 不存在', '本地密钥文件可能被提交');
    const need = ['backend/.dev.vars', 'web/.ptx-dev-key.json'];
    const missing = need.filter(n => !src.includes(n));
    if (missing.length === 0) return ok('本地密钥文件已在 .gitignore 里');
    bad(
        `.gitignore 少了：${missing.join('、')}`,
        '这些文件含本地密钥与签名私钥，提交上去等于泄漏。'
    );
}

/**
 * 令牌没有进仓：部署令牌形如 `ptx_` + 43 位字符，一旦被 commit，撤销之前
 * 谁拿到仓库历史都能拿它部署。对 `git ls-files` 列出的每个受版本控制的文件
 * grep 这个模式——只查已入库的文件，不查 .gitignore 忽略掉的本地密钥文件
 * （那些由 checkGitignore 另外兜底）。
 */
const TOKEN_RE = /\bptx_[A-Za-z0-9_-]{43}\b/;

function checkTokenLeak(root) {
    let files;
    try {
        const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
        files = out.split('\n').filter(Boolean);
    } catch (e) {
        return warn('无法列出 git 追踪的文件，跳过令牌泄漏检查', '不是 git 仓库，或本机没有 git 可执行文件');
    }

    const hits = [];
    for (const rel of files) {
        let content;
        try {
            content = readFileSync(join(root, rel), 'utf8');
        } catch {
            continue; // 文件不存在（已删除未提交）或不是文本，跳过。
        }
        if (TOKEN_RE.test(content)) hits.push(rel);
    }

    if (hits.length === 0) return ok('没有在受版本控制的文件里发现部署令牌明文');
    for (const rel of hits) {
        bad(`文件 ${rel} 里出现了部署令牌明文，立即撤销并从历史里清掉`,
            '到 Ptengine X →「自定义应用管理」→ 部署令牌 撤销旧令牌、生成新的，' +
            '并把这个文件从 git 历史里清掉（不能只删掉这次改动，历史里还留着）');
    }
}

// ─── 依赖漂移（需要网络，默认不查）──────────────────────────────────────

async function checkDeps(root) {
    const pkg = JSON.parse(read(root, 'package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const targets = Object.keys(deps).filter(n => n.startsWith('@ptengine/'));

    for (const name of targets) {
        const range = deps[name];
        try {
            const res = await fetch(
                `https://registry.npmjs.org/${name.replace('/', '%2F')}`,
                { headers: { accept: 'application/vnd.npm.install-v1+json' } }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const latest = (await res.json())['dist-tags']?.latest;
            if (!latest) throw new Error('没有 dist-tags.latest');

            const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
            if (!m) {
                warn(`${name}: 区间 ${range} 不是 caret 形态（npm 最新 ${latest}）`, '请人工确认');
                continue;
            }
            const [, maj, min] = m.map(Number);
            const lv = /^(\d+)\.(\d+)\.(\d+)/.exec(latest).slice(1).map(Number);
            // npm 对 0.x 的 caret 只放行同 minor：^0.4.0 拿不到 0.5.0。
            const covered = maj >= 1
                ? lv[0] === maj && (lv[1] > min || lv[1] === min)
                : lv[0] === maj && lv[1] === min;
            if (covered) ok(`${name}: ${range} 已覆盖 npm 最新版 ${latest}`);
            else {
                warn(
                    `${name}: ${range} 拿不到 npm 最新版 ${latest}`,
                    `改成 ^${lv[0]}.${lv[1]}.0 再 npm install`
                );
            }
        } catch (e) {
            warn(`${name}: 检查失败（${e.message}）`, '网络问题，跳过');
        }
    }
}

// ─── 主流程 ─────────────────────────────────────────────────────────────

export async function run(args, root) {
    console.log('');

    let manifest;
    try {
        manifest = readManifest(root);
        const { errors, warnings } = validateManifest(manifest, root);
        if (errors.length === 0) ok('manifest.json 校验通过');
        for (const e of errors) bad(`manifest: ${e}`, '');
        for (const w of warnings) warn(`manifest: ${w}`, '');
    } catch (e) {
        bad(`manifest.json 读不了：${e.message}`, '');
        manifest = {};
    }

    checkViteBase(root);
    checkManifestEntry(root, manifest);
    checkTailwind(root);
    checkTokensCss(root);
    checkPtUiScope(root);
    checkRouting(root);
    checkBackend(root, manifest);
    checkScopeConsistency(root, manifest);
    checkGitignore(root);
    checkTokenLeak(root);

    if (args.includes('--deps')) await checkDeps(root);

    const icon = { ok: '[ok]', warn: '[!] ', bad: '[x] ' };
    for (const r of results) {
        console.log(`  ${icon[r.level]} ${r.msg}`);
        if (r.why) console.log(`         ${r.why}`);
    }

    const bads = results.filter(r => r.level === 'bad').length;
    const warns = results.filter(r => r.level === 'warn').length;
    console.log(
        `\n  ${results.length - bads - warns} 项通过` +
        `${warns ? `，${warns} 项提醒` : ''}` +
        `${bads ? `，${bads} 项需要修` : ''}\n`
    );

    if (bads > 0) {
        throw new Error(`体检发现 ${bads} 处问题，见上。`);
    }
}
