/**
 * manifest.json 的读取与校验。
 *
 * 这里的每一条检查都对应一个"上传到平台才会报、且报错信息指不到真正原因"的坑。
 * 在本地就把它们拦下来，是这个脚手架存在的主要理由之一。
 *
 * 错误码与平台侧上传校验保持一致，方便对照文档。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 平台目前认的 scope，写错会导致上传校验失败。 */
const VALID_SCOPES = ['analytics:read', 'profile:read', 'user:read', 'ui:notify'];

/** 图标扩展名白名单，与平台产物白名单一致。 */
const ICON_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'];

/** 出站白名单里不允许出现的域 —— 禁止租户绕过网关直接打平台接口。 */
const FORBIDDEN_EGRESS = ['ptengine.com', 'ptengine.io', 'ptengine.ai', 'ptmind.com', 'localhost', '127.0.0.1'];

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
                if (!VALID_SCOPES.includes(s)) {
                    fail('SCOPE_UNKNOWN',
                        `scopes 里的 "${s}" 不是合法权限值。合法值：${VALID_SCOPES.join(' / ')}`);
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

    // secrets：只声明名字，值由平台侧管理。名字必须是环境变量惯例，
    // 因为它们最终会成为 worker env 上的键。
    if (be.secrets) {
        if (!Array.isArray(be.secrets)) {
            fail('BACKEND_SECRETS_INVALID', 'backend.secrets 必须是数组');
        } else {
            for (const s of be.secrets) {
                const name = typeof s === 'string' ? s : s?.name;
                if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
                    fail('BACKEND_SECRET_NAME_INVALID',
                        `密钥名 ${JSON.stringify(name)} 不合法，必须匹配 ^[A-Z][A-Z0-9_]*$`);
                }
                if (name && name.startsWith('PT_')) {
                    fail('BACKEND_SECRET_NAME_RESERVED',
                        `密钥名 ${name} 使用了平台保留前缀 PT_`);
                }
            }
        }
    }

    // egress：缺省或空数组 = 完全禁止出站（默认拒绝，不是默认允许）。
    if (be.egress !== undefined) {
        if (!Array.isArray(be.egress)) {
            fail('BACKEND_EGRESS_INVALID', 'backend.egress 必须是数组');
        } else {
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
                if (FORBIDDEN_EGRESS.some(f => bare === f || bare.endsWith(`.${f}`))) {
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
