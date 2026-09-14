/**
 * manifest.json 的读取与校验。
 *
 * 这里的每一条检查都对应一个"上传到平台才会报、且报错信息指不到真正原因"的坑。
 * 在本地就把它们拦下来，是这个脚手架存在的主要理由之一。
 *
 * 错误码与平台侧上传校验保持一致，方便对照文档。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
/**
 * 规则快照，由 `npm run sync-rules` 从 monorepo 的 `packages/contract` 生成。**不要手改这个文件。**
 *
 * 以前 scope 表、出站禁域表、名字正则在这个脚本里各有一份字面量，与平台侧靠人眼同步 ——
 * 于是本地校验通过、上传照样被拒。现在只有 contract 包这一份真相。
 */
export const RULES = require('./rules.json');

const NAME_RE = new RegExp(RULES.name.pattern);
const APP_ID_RE = new RegExp(RULES.appId.pattern);
/** `name.reservedBindingNames` 是较新的规则字段；老快照没有它时退化成空集合，不报错。 */
const RESERVED_BINDINGS = new Set(RULES.name.reservedBindingNames ?? []);

/** 图标扩展名白名单，与平台产物白名单一致。 */
const ICON_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'];

export function readManifest(root) {
    const path = join(root, 'manifest.json');
    if (!existsSync(path)) {
        throw new Error('缺少 manifest.json（应放在项目根目录）');
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        throw new Error(`manifest.json 不是合法 JSON：${e.message}`);
    }
}

/**
 * 校验 manifest 自身的自洽性（不依赖构建产物）。
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateManifest(manifest, root) {
    const errors = [];
    const warnings = [];
    const fail = (code, msg) => errors.push(`${code}  ${msg}`);
    const warn = msg => warnings.push(msg);

    // ── 基础字段 ────────────────────────────────────────────────────────
    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
        fail('SCHEMA_VERSION_UNSUPPORTED',
            `schemaVersion 只能是 1 或 2，当前是 ${JSON.stringify(manifest.schemaVersion)}`);
    }
    if (typeof manifest.version !== 'string' || !manifest.version) {
        fail('VERSION_MISSING', 'manifest.version 必填，且每次上传新版本必须递增');
    }
    if (typeof manifest.entry !== 'string' || !manifest.entry) {
        fail('ENTRY_MISSING', 'manifest.entry 必填（默认 index.html）');
    }

    // manifest.id 是可选的（平台在创建应用时也会分配），但写了就必须符合**创建**规则：
    // 解析规则（RULES.appId.parsePattern，62 位）更宽，那是给边缘路由拆子域用的，不是创建口径。
    if (manifest.id !== undefined) {
        if (typeof manifest.id !== 'string' || !APP_ID_RE.test(manifest.id)) {
            fail('APP_ID_INVALID', `manifest.id 必须匹配 ${RULES.appId.pattern}（最长 ${RULES.appId.maxLen} 字符）`);
        } else if (RULES.appId.reserved.includes(manifest.id) || manifest.id.startsWith(RULES.appId.reservedPrefix)) {
            fail('APP_ID_RESERVED', `"${manifest.id}" 是平台保留的应用标识（保留字或 "${RULES.appId.reservedPrefix}" 前缀）`);
        }
    }

    if (manifest.icon) {
        if (!ICON_EXT.some(ext => manifest.icon.toLowerCase().endsWith(ext))) {
            fail('ICON_EXT_INVALID',
                `icon 扩展名只允许 ${ICON_EXT.join(' / ')}，当前是 "${manifest.icon}"`);
        }
        if (manifest.icon.startsWith('/')) {
            fail('ICON_PATH_ABSOLUTE', 'icon 必须是包内相对路径，不能以 / 开头');
        }
    }

    if (manifest.scopes) {
        if (!Array.isArray(manifest.scopes)) {
            fail('SCOPES_INVALID', 'scopes 必须是数组');
        } else {
            for (const s of manifest.scopes) {
                if (!RULES.validScopes.includes(s)) {
                    fail('SCOPE_UNKNOWN',
                        `scopes 里的 "${s}" 不是合法权限值。合法值：${RULES.validScopes.join(' / ')}`);
                }
            }
            if (new Set(manifest.scopes).size !== manifest.scopes.length) {
                fail('SCOPES_DUPLICATED', 'scopes 里有重复项');
            }
        }
    }

    // ── backend 段 ─────────────────────────────────────────────────────
    const be = manifest.backend;
    if (!be) {
        if (manifest.schemaVersion === 2) {
            warn('schemaVersion 是 2 但没有 backend 段 —— 这会是一个纯静态应用。' +
                 '如果不需要后端，把 schemaVersion 改回 1 可以兼容更老的平台版本。');
        }
        return { errors, warnings };
    }

    if (manifest.schemaVersion !== 2) {
        fail('BACKEND_REQUIRES_SCHEMA_2',
            '声明了 backend 段就必须 schemaVersion: 2。' +
            '否则旧平台会**静默忽略**后端，跑出一个"前端正常、所有 API 404"的应用。');
    }

    if (typeof be.entry !== 'string' || !be.entry) {
        fail('BACKEND_ENTRY_MISSING', 'backend.entry 必填（默认 _backend/worker.js）');
    }

    if (!Array.isArray(be.routes) || be.routes.length === 0) {
        fail('BACKEND_ROUTES_MISSING', 'backend.routes 必填，当前只支持 ["/api/*"]');
    } else if (be.routes.length !== 1 || be.routes[0] !== '/api/*') {
        fail('BACKEND_ROUTE_UNSUPPORTED',
            `backend.routes 当前只允许 ["/api/*"]，收到 ${JSON.stringify(be.routes)}`);
    }

    // secrets / vars：都只声明名字（vars 可以带 default），值在产品内配置。
    // 两者最终都会成为 worker env 上的键，所以名字规则与命名空间是同一套。
    /** 两种写法归一：`"NAME"` 与 `{ name, required, default }`。 */
    const declaredOf = items => (Array.isArray(items) ? items : []).map(s => (typeof s === 'string' ? { name: s, required: true } : { name: s?.name, required: s?.required !== false }));

    /** 同名冲突两边都能看见，只报一次（同一处问题报两遍会让人以为有两个错）。 */
    const conflictsReported = new Set();
    const checkNames = (items, kind, otherNames) => {
        const c = kind === 'var'
            ? { invalid: 'BACKEND_VAR_NAME_INVALID', reserved: 'BACKEND_VAR_NAME_RESERVED', dup: 'BACKEND_VAR_DUPLICATED', many: 'BACKEND_VARS_TOO_MANY', max: RULES.limits.vars, label: '配置项' }
            : { invalid: 'BACKEND_SECRET_NAME_INVALID', reserved: 'BACKEND_SECRET_NAME_RESERVED', dup: 'BACKEND_SECRET_DUPLICATED', many: 'BACKEND_SECRETS_TOO_MANY', max: RULES.limits.secrets, label: '密钥' };
        if (items.length > c.max) fail(c.many, `${c.label}最多声明 ${c.max} 个，收到 ${items.length} 个`);
        const seen = new Set();
        for (const { name } of items) {
            if (!name || !NAME_RE.test(name)) {
                fail(c.invalid, `${c.label}名 ${JSON.stringify(name)} 不合法，必须匹配 ${RULES.name.pattern}`);
                continue;
            }
            if (name.startsWith(RULES.name.reservedPrefix)) fail(c.reserved, `${c.label}名 ${name} 使用了平台保留前缀 ${RULES.name.reservedPrefix}`);
            // worker 自带的 binding 名（DB / KV / FILES / PT_GATEWAY …）。DB 这类既匹配名字正则、
            // 又不带 PT_ 前缀，上面两条都拦不住；不单独保留的话，发布期会为同一个名字生成两个
            // binding（d1 + plain_text），把资源**遮掉** —— 表现是 ctx.db 突然变成一个字符串。
            else if (RESERVED_BINDINGS.has(name)) fail(c.reserved, `${c.label}名 ${name} 是 worker 内建 binding 名，已被平台占用，必须改名`);
            if (seen.has(name)) fail(c.dup, `${c.label}名 ${name} 重复`);
            if (otherNames.has(name) && !conflictsReported.has(name)) {
                conflictsReported.add(name);
                fail('BACKEND_VAR_CONFLICTS_SECRET', `${name} 同时被声明成配置项与密钥，它们是同一个环境变量命名空间`);
            }
            seen.add(name);
        }
    };

    if (be.secrets !== undefined && !Array.isArray(be.secrets)) fail('BACKEND_SECRETS_INVALID', 'backend.secrets 必须是数组');
    if (be.vars !== undefined && !Array.isArray(be.vars)) fail('BACKEND_VARS_INVALID', 'backend.vars 必须是数组');
    const secretsDeclared = declaredOf(be.secrets);
    const varsDeclared = declaredOf(be.vars);
    checkNames(secretsDeclared, 'secret', new Set(varsDeclared.map(v => v.name)));
    checkNames(varsDeclared, 'var', new Set(secretsDeclared.map(s => s.name)));

    // egress：缺省或空数组 = 完全禁止出站（默认拒绝，不是默认允许）。
    if (be.egress !== undefined) {
        if (!Array.isArray(be.egress)) {
            fail('BACKEND_EGRESS_INVALID', 'backend.egress 必须是数组');
        } else {
            if (be.egress.length > RULES.limits.egress) {
                fail('BACKEND_EGRESS_TOO_MANY', `egress 最多 ${RULES.limits.egress} 条，收到 ${be.egress.length} 条`);
            }
            for (const host of be.egress) {
                if (typeof host !== 'string' || !host) {
                    fail('BACKEND_EGRESS_INVALID', `egress 项必须是非空字符串：${JSON.stringify(host)}`);
                    continue;
                }
                if (host.includes('/') || host.includes(':')) {
                    fail('BACKEND_EGRESS_INVALID',
                        `egress 只写主机名，不要带协议、端口或路径："${host}"`);
                }
                if (host === '*' || host === '*.') {
                    fail('BACKEND_EGRESS_TOO_BROAD', 'egress 不允许通配全部域名');
                }
                const bare = host.startsWith('*.') ? host.slice(2) : host;
                if (RULES.forbiddenEgress.some(f => bare === f || bare.endsWith(`.${f}`))) {
                    fail('BACKEND_EGRESS_FORBIDDEN',
                        `egress 不允许包含平台自身或本机地址："${host}"`);
                }
            }
        }
    }

    if (be.resources) {
        for (const key of Object.keys(be.resources)) {
            if (!['database', 'kv', 'files'].includes(key)) {
                fail('BACKEND_RESOURCE_UNKNOWN',
                    `backend.resources 不认识 "${key}"，可用：database / kv / files`);
            }
        }
        if (be.resources.files === true) {
            warn('backend.resources.files 目前只对官方应用开放（R2 的前缀隔离是运行时约定，' +
                 '不是平台强制的边界）。客户自助的应用请先设为 false。');
        }
    }

    // migrations 文件名：序号必须连续不跳号，否则平台执行顺序与你预期不一致。
    if (be.migrations) {
        const dir = join(root, 'backend', 'migrations');
        if (!existsSync(dir)) {
            fail('MIGRATION_DIR_MISSING',
                `manifest 声明了 backend.migrations，但 backend/migrations 目录不存在`);
        } else {
            const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
            const seen = new Set();
            let expected = 1;
            for (const f of files) {
                const m = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/.exec(f);
                if (!m) {
                    fail('MIGRATION_NAME_INVALID',
                        `migration 文件名必须形如 0001_描述.sql，收到 "${f}"`);
                    continue;
                }
                const n = Number(m[1]);
                if (seen.has(n)) {
                    fail('MIGRATION_NUMBER_DUPLICATED', `migration 序号 ${m[1]} 重复`);
                }
                seen.add(n);
                if (n !== expected) {
                    fail('MIGRATION_NUMBER_GAP',
                        `migration 序号应连续：期望 ${String(expected).padStart(4, '0')}，收到 ${m[1]}`);
                }
                expected = n + 1;
            }
        }
    }

    return { errors, warnings };
}

/** 把校验结果打印出来；有 error 就抛。 */
export function reportValidation({ errors, warnings }) {
    for (const w of warnings) console.log(`  [!] ${w}`);
    if (errors.length === 0) return;
    console.error('\nmanifest.json 校验不通过：\n');
    for (const e of errors) console.error(`  [x] ${e}`);
    console.error('');
    throw new Error(`manifest 有 ${errors.length} 处问题，见上。`);
}
