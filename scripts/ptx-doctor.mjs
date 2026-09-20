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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readManifest, resolveBackend, validateManifest } from './manifest.mjs';
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

/**
 * 把一个 glob 变成正则。只支持 Tailwind content 里实际会出现的几种写法：
 * `**`（跨目录）、`*`（单层）、`?`、以及 `{js,cjs}` 这样的花括号枚举。
 */
function globToRegExp(pattern) {
    const p = pattern.split(sep).join('/');
    let out = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') {
                // `**/` 允许匹配零层目录，所以整段（含斜杠）都是可选的。
                if (p[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
            } else out += '[^/]*';
        } else if (c === '?') out += '[^/]';
        else if (c === '{') {
            const end = p.indexOf('}', i);
            if (end === -1) out += '\\{';
            else {
                out += `(?:${p.slice(i + 1, end).split(',').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
                i = end;
            }
        } else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}

/**
 * glob 至少匹配到一个真实存在的文件？
 *
 * 从 glob 里第一个通配符之前的那段字面量目录开始递归走，避免把整个磁盘翻一遍。
 */
function globMatchesAnyFile(pattern) {
    const p = pattern.split(sep).join('/');
    const star = p.search(/[*?{]/);
    const base = star === -1 ? dirname(p) : p.slice(0, p.lastIndexOf('/', star) + 1) || '/';
    if (!existsSync(base)) return false;
    const re = globToRegExp(p);
    const stack = [base.replace(/\/$/, '') || '/'];
    let seen = 0;
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) stack.push(full);
            else if (re.test(full)) return true;
            if (++seen > 50000) return false;   // 兜底，别在畸形 glob 上转太久
        }
    }
    return false;
}

/**
 * tailwind content 里覆盖组件库 dist 的那条 glob，**真的能匹配到文件吗**。
 *
 * 为什么不只做字符串匹配（这条规则原来就是字符串匹配，漏掉了真正的坑）：
 * Tailwind 把相对 glob 按**配置文件所在目录**（web/）解析，而带后端的布局里
 * node_modules/ 装在**项目根**、没有 web/node_modules/ ——
 * `./node_modules/@ptengine/design-components/dist/**` 于是一个文件都匹配不到，
 * 不报错、不告警，只是组件的 class 全都不生成，页面"结构对、没样式"。
 *
 * 这里不 import 配置本身：组件库的 tailwind.preset.js 在裸 Node ESM 下解析不了
 * （它 import 'tailwindcss/plugin'，靠打包器的 CJS 解析才能跑）。所以改成按
 * 配置里实际用的两种写法各自求值：字面量相对 glob 按 web/ 解析，按包名解析的
 * 写法就用 createRequire 从配置文件出发重做一遍 —— 与配置同一条路径。
 *
 * 返回 { level, msg, why } 以便单测。
 */
export function checkTailwindContent(root) {
    const configPath = join(root, 'web', 'tailwind.config.js');
    if (!existsSync(configPath)) {
        return { level: 'bad', msg: 'web/tailwind.config.js 不存在', msgKey: 'missing', why: '组件库的设计 token 接不进来' };
    }
    const src = readFileSync(configPath, 'utf8');
    const webDir = join(root, 'web');

    /** 候选 glob：[人类可读的来源, 绝对 glob]。 */
    const candidates = [];

    // 写法 A：字面量里直接写了包名（老写法，多半是相对路径）。
    for (const m of src.matchAll(/['"`]([^'"`\n]*@ptengine\/design-components[^'"`\n]*)['"`]/g)) {
        const g = m[1];
        if (!g.includes('dist')) continue;           // tailwind-preset / tokens.css 的 import 不算
        candidates.push([g, isAbsolute(g) ? g : resolve(webDir, g)]);
    }

    // 写法 B：按包名解析（推荐写法）。用与配置同一条解析路径重做一遍。
    if (/require\.resolve\(\s*['"]@ptengine\/design-components/.test(src)) {
        const req = createRequire(configPath);
        let dist = null;
        try {
            dist = join(dirname(req.resolve('@ptengine/design-components/package.json')), 'dist');
        } catch {
            try {
                let dir = dirname(req.resolve('@ptengine/design-components'));
                for (let i = 0; i < 5 && dir; i++) {
                    try {
                        if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@ptengine/design-components') { dist = join(dir, 'dist'); break; }
                    } catch { /* 这一层没有 package.json */ }
                    const up = dirname(dir);
                    if (up === dir) break;
                    dir = up;
                }
            } catch { /* 包根本没装 */ }
        }
        if (!dist) {
            return {
                level: 'bad',
                msg: '解析不到 @ptengine/design-components 的安装位置',
                msgKey: 'unresolved',
                why: '配置按包名解析 dist 目录，但这个包没装上。先 npm install。'
            };
        }
        candidates.push(['按包名解析', join(dist, '**', '*.{js,cjs}')]);
    }

    if (candidates.length === 0) {
        return {
            level: 'bad',
            msg: 'tailwind content 里没有覆盖 @ptengine/design-components 的 dist',
            msgKey: 'absent',
            why: '组件的 class 字符串在**已编译的库产物里**。漏了这条，Tailwind 扫不到、' +
                 '不生成对应 CSS，页面渲染出"结构对但完全没有样式"的组件。'
        };
    }

    const hit = candidates.find(([, g]) => globMatchesAnyFile(g));
    if (hit) {
        return { level: 'ok', msg: `tailwind content 覆盖了组件库 dist，且 glob 能匹配到文件（${hit[0]}）`, msgKey: 'ok' };
    }
    return {
        level: 'bad',
        msg: `tailwind content 里组件库 dist 的 glob 一个文件都匹配不到：${candidates.map(([g]) => g).join('、')}`,
        msgKey: 'nomatch',
        why: 'Tailwind 把相对 glob 按**配置文件所在目录**（web/）解析，而依赖装在**项目根**的 ' +
             'node_modules/ —— 带后端的布局下没有 web/node_modules/，这条 glob 于是静默地扫不到任何文件：' +
             '不报错、不告警，只是组件的 class 全都不生成，页面"结构对、没样式"（CSS 产物会小一个量级）。' +
             "改成按包名解析绝对路径：createRequire(import.meta.url) 拿到 @ptengine/design-components 的安装位置，" +
             '再拼 dist/**/*.{js,cjs}。见 web/tailwind.config.js 的注释。'
    };
}

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

    const { level, msg, why } = checkTailwindContent(root);
    results.push(why ? { level, msg, why } : { level, msg });
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
    // 判定源只有 manifest（与 ptx build / ptx dev 同一个函数，口径不会漂）。
    const be = resolveBackend(manifest, root);
    for (const e of be.errors) bad(e, 'manifest 与目录结构不一致，ptx build / ptx dev 会直接失败');
    for (const w of be.warnings) warn(w, '改了一半的轻应用：上传后所有 /api 请求都会 404');

    if (!manifest.backend) {
        return be.warnings.length > 0 ? undefined : ok('没有 backend 段（纯静态应用）');
    }
    if (!be.dirExists) return;

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

/**
 * 迁移必须**可加**（只增不减）。
 *
 * 平台的迁移只进不退：回滚会把前端与后端一起切回旧版本，但**数据库结构留在新的位置**。
 * 所以一个 DROP COLUMN 会让「回滚到上个版本」变成「旧代码读一个已经不存在的列」——
 * 而这在发布当时一切正常，只有真出事要回滚的那一刻才炸。
 *
 * 只给 warn 不给 bad：确实存在必须删列的场合（改名 = 新增 + 双写 + 删除，最后一步不可避免），
 * 但那必须是**跨两次发布**、且明确接受"删列之后不能再回滚过去"的决定。
 */
const DESTRUCTIVE = [
    [/\bDROP\s+TABLE\b/i, 'DROP TABLE'],
    [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
    [/\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i, 'ALTER TABLE … RENAME']
];

/** 去掉 `--` 行注释与 SQL 块注释，避免把注释里的 DROP 当真。 */
function stripSqlComments(sql) {
    return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function checkMigrationsAdditive(root, manifest, results) {
    if (!manifest?.backend?.migrations) return;
    const dir = join(root, 'backend', 'migrations');
    if (!existsSync(dir)) return;   // 目录缺失由 validateManifest 报，别重复
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    let hits = 0;
    for (const f of files) {
        const sql = stripSqlComments(readFileSync(join(dir, f), 'utf8'));
        for (const [re, label] of DESTRUCTIVE) {
            if (re.test(sql)) {
                hits++;
                results.push({
                    level: 'warn',
                    msg: `迁移 ${f} 里有 ${label}`,
                    why: '迁移只进不退：平台回滚会把前端与后端切回旧版本，数据库结构留在新的位置。' +
                         '删列/删表/改名之后，回滚到更早的版本就等于让旧代码读一个已经不存在的东西 —— ' +
                         '发布当时一切正常，只有真要回滚那一刻才炸。要删就分两次发布做（先停止使用、下个版本再删），' +
                         '并接受"删了之后回不去"。'
                });
            }
        }
    }
    if (hits === 0) results.push({ level: 'ok', msg: `迁移只增不减（检查了 ${files.length} 个文件）` });
}

// ─── 配置项（vars / secrets 与本地 .dev.vars）───────────────────────────

/**
 * 配置项体检。
 *
 * 收录理由（符合本文件的收录标准：违反后不报错、现象不直观）：
 *   · manifest 声明了必填 var 但 .dev.vars 没有 → `ptx dev` 起得来，第一个请求才 500，
 *     报的是 VAR_NOT_DECLARED，指不到"你还没在本地填值"。
 *   · .dev.vars 里有 manifest 没声明的名字 → **本地能跑、线上必挂**：线上只注入声明过的。
 *
 * 只给 warn 不给 bad：本地不填值是完全正常的中间状态（还没开始调那个接口），
 * 而**发布**并不依赖 .dev.vars —— 线上的值在应用管理页填。
 *
 * 返回 { level, msg, why } 而不是直接打印，是为了能单测。
 */
export function checkVars(root, manifest) {
    if (!manifest?.backend) return { level: 'ok', msg: '没有后端，跳过配置检查' };

    /** 两种写法归一：`"NAME"` 与 `{ name, required, default }`。字符串 = 必填。 */
    const normalize = items => (Array.isArray(items) ? items : []).map(v => (typeof v === 'string' ? { name: v, required: true } : { name: v?.name, required: v?.required !== false, default: v?.default }));
    const declared = normalize(manifest.backend.vars);
    // 密钥也写在同一个 .dev.vars 里，所以判"多余的名字"时它们同样算声明过。
    const secrets = normalize(manifest.backend.secrets);

    const path = join(root, 'backend', '.dev.vars');
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const present = new Set(
        text.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(l => l.split('=')[0]?.trim())
            .filter(Boolean)
    );

    const missing = declared.filter(d => d.required && d.default === undefined && !present.has(d.name)).map(d => d.name);
    // PT_JWKS_JSON 是 ptx dev 自己写进去的受管键，PT_ 整个前缀都归平台，不算"多余的名字"。
    const declaredNames = new Set([...declared, ...secrets].map(d => d.name));
    const extra = [...present].filter(n => !declaredNames.has(n) && !n.startsWith('PT_'));

    if (missing.length) {
        return {
            level: 'warn',
            msg: `backend/.dev.vars 缺少必填配置：${missing.join('、')}`,
            why: `本地跑起来后第一个用到它的请求会以 VAR_NOT_DECLARED 500。在 backend/.dev.vars 里补上 ` +
                 `${missing.map(n => `${n}=…`).join(' / ')}（与密钥同一个文件）。线上的值另在应用管理页的「配置」页签填。`
        };
    }
    if (extra.length) {
        return {
            level: 'warn',
            msg: `backend/.dev.vars 里有 manifest 没声明的名字：${extra.join('、')}`,
            why: `线上**只注入 manifest 声明过的**名字，${extra.join('、')} 只在本地存在 —— 典型症状是"本地好好的，` +
                 '上线就 VAR_NOT_DECLARED / SECRET_NOT_DECLARED"。把它们加进 manifest.backend.vars（非敏感）或 backend.secrets（敏感）。'
        };
    }
    return { level: 'ok', msg: `配置项声明与 backend/.dev.vars 对得上（${declared.length} 项配置、${secrets.length} 项密钥）` };
}

// ─── 密钥与忽略项 ───────────────────────────────────────────────────────

/**
 * @ptengine/* 包的最低版本（floor）。**这是脚手架能力表的唯一机器可读副本**：
 * skill / 文档只写"需要 ≥ 某版本"，真正的拦截在这里。改 floor 的时机只有一种——
 * 脚手架开始依赖某个新版本才有的能力时（与 CHANGELOG 兼容矩阵同一次改）。
 *
 * 检查两层：
 *   1. package.json 声明的区间下界 ≥ floor（区间写老了，npm install 装到的就是老包；
 *      0.x 的 caret 不跨 minor，^0.2.0 永远拿不到 0.4）；
 *   2. node_modules 里实际安装的版本 ≥ floor 且 ≥ 区间下界（lock 落后 / 没跑 npm install）。
 */
export const PACKAGE_FLOORS = {
    '@ptengine/app-sdk': { min: '2.4.0', why: 'context.user；取数契约 requiredScope 与 manifest 四个 scope 同口径（≤2.2.1 还是 query:read）' },
    '@ptengine/app-backend': { min: '0.4.0', why: 'ctx.auth.email / name；0.2 起 ctx.vars' }
};

function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVersion(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}
/** 只认 `^x.y.z` / `~x.y.z` / `x.y.z` / `>=x.y.z` 这几种脚手架会写的形态；别的（workspace:、file:、*）返回 null 不判。 */
function rangeLowerBound(range) {
    const m = /^(?:\^|~|>=)?\s*(\d+\.\d+\.\d+)/.exec(String(range ?? '').trim());
    return m ? parseVersion(m[1]) : null;
}

/**
 * 与其它 check 不同，返回结果数组而不直接 push：方便单测在临时目录里跑。
 * `installedVersion` 可注入，缺省读 node_modules/<pkg>/package.json。
 */
export function checkPackageFloors(root, deps = {}) {
    const out = [];
    const pkgRaw = read(root, 'package.json');
    if (!pkgRaw) return out;   // package.json 缺失由 checkBackend 报，这里不重复
    let pkg;
    try { pkg = JSON.parse(pkgRaw); } catch { return out; }
    const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const installedVersion = deps.installedVersion ?? (name => {
        const raw = read(root, join('node_modules', name, 'package.json'));
        if (!raw) return null;
        try { return JSON.parse(raw).version ?? null; } catch { return null; }
    });

    for (const [name, floor] of Object.entries(PACKAGE_FLOORS)) {
        const range = declared[name];
        if (range === undefined) continue;   // 轻应用可以没有 app-backend；缺 app-backend 由 checkBackend 报
        const min = parseVersion(floor.min);
        const lower = rangeLowerBound(range);
        const fix = `npm i ${name}@^${floor.min}`;
        if (lower && cmpVersion(lower, min) < 0) {
            out.push({ level: 'bad', msg: `${name} 的依赖区间 ${range} 低于脚手架要求的 ≥${floor.min}`,
                why: `${floor.why}。改 package.json 区间并重跑 npm install：${fix}` });
            continue;
        }
        const inst = installedVersion(name);
        const instV = parseVersion(inst);
        if (!instV) {
            out.push({ level: 'warn', msg: `${name} 没有安装（node_modules 里找不到）`, why: '先 npm install；doctor 只能按 package.json 判，装出来的可能是老包' });
            continue;
        }
        if (cmpVersion(instV, min) < 0) {
            out.push({ level: 'bad', msg: `${name} 实际安装的是 ${inst}，低于脚手架要求的 ≥${floor.min}`,
                why: `${floor.why}。lock 落后于 package.json 或没重跑安装：${fix}` });
            continue;
        }
        if (lower && cmpVersion(instV, lower) < 0) {
            out.push({ level: 'warn', msg: `${name} 实际安装 ${inst} 低于 package.json 声明的 ${range}`, why: 'package-lock 落后，重跑 npm install' });
            continue;
        }
        out.push({ level: 'ok', msg: `${name} ${inst}（要求 ≥${floor.min}）` });
    }
    return out;
}

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
            '到 Ptengine →「自定义应用管理」→ 部署令牌 撤销旧令牌、生成新的，' +
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
    results.push(...checkPackageFloors(root));
    results.push(checkVars(root, manifest));
    checkScopeConsistency(root, manifest);
    checkMigrationsAdditive(root, manifest, results);
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
