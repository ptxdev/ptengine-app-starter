/**
 * ptx dev 的本地「通知渠道」桩逻辑（定时任务 1c，brief §8.4）。纯函数（loadLocalChannels 读一个文件）；server.mjs 包一层 HTTP 并负责写文件。
 *
 * 判定顺序与线上平台一致（brief §4.5）：消息形状（第 3 步）→ 查渠道（第 5 步）→ 本 run 调用次数（第 6 步）→ 预览拦截（第 8 步）。
 * 被第 3 / 5 步拒掉的调用不计次（与平台同）。
 * 上限、正则与类型表全部读 scripts/rules.json 的 notifyChannel 段（缺键报「规则快照过旧」，不写字面量兜底）；错误码与线上同名。
 * 唯一例外是 link.path 的 scheme / 点段正则（LINK_PATH_SCHEME / LINK_PATH_DOT_SEGMENT，见下）：contract 已导出但未进 rules.json，暂留本地副本。
 * 可以比平台**严**，不能比平台**宽**（本地能过、线上被拒不可接受）。
 * link.path 与平台 parseChannelMessage 逐条同序：去一个前导 `#/` 或 `/` → 长度 → 字符集 → 带 scheme 或仍以 `/` 开头（P15）→ 含 . / .. 段（R11）→ 400。
 *
 * 本地**永远不真实投递**（含非预览）：本地没有渠道凭据，也不该从开发机往客户频道发消息（裁定 C34）。
 * 工作区每分钟 30 条的限额本地不模拟（brief §8.4 未列）。
 *
 * 本地渠道目录：项目内 `.ptx/channels.json`（`[{ "name": "alerts", "type": "slack" }]`，每次请求现读，改了即时生效）。
 *   · 文件存在：名字不在其中 → 404 NOTIFY_CHANNEL_NOT_FOUND；listChannels 回它（按 name 升序）。
 *   · 文件不存在：任何合法名字都接受，type 记 webhook；listChannels 回 []。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES } from '../manifest.mjs';
import { LOCAL_MEDIA_SRC, jobRunOf, runCounters } from './notify.mjs';

/**
 * 本地渠道桩用到的 notifyChannel 规则键；缺任何一个都视为快照过旧。
 * maxConcurrentPerApp / maxBodyBytes 本模块不读，是 server.mjs（Task C3：并发闸、413 体积上限）经 channelRules 校验后用的，不是死键。
 */
const REQUIRED_CHANNEL_KEYS = ['types', 'namePattern', 'titleMax', 'textMax', 'linkLabelMax', 'linkPathMax', 'linkPathPattern',
    'maxPerRun', 'mediaPathPattern', 'maxConcurrentPerApp', 'maxBodyBytes'];

export function channelRules(rules) {
    const missing = rules ? REQUIRED_CHANNEL_KEYS.filter(k => rules[k] == null) : ['notifyChannel'];
    if (missing.length) {
        throw new Error(`scripts/rules.json 的 notifyChannel 段缺 ${missing.join(' / ')}（规则快照过旧）。维护者请跑 npm run sync-rules。`);
    }
    return rules;
}

/**
 * contract `NOTIFY_CHANNEL_LINK_PATH_SCHEME_PATTERN`（packages/contract/src/limits.ts）的本地副本，source / flags 逐字照抄（R4/P15）：
 * 去前导之后带 scheme（`https:`、`javascript:` 等）的 link.path 即绝对地址。
 * 该常量尚未进 buildRules().notifyChannel（rules.json 读不到）；待导出后改读 rules.json 并删掉本副本。
 */
export const LINK_PATH_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/**
 * contract `NOTIFY_CHANNEL_LINK_PATH_DOT_SEGMENT_PATTERN`（packages/contract/src/limits.ts）的本地副本，source / flags 逐字照抄（R11）：
 * 去前导之后 `?` 之前的路径部分含 `.` / `..` 段（含任意大小写 `%2e`）即拒——线上深链经 URL 归一化会逃出 apps/<appUuid>/。
 * `a.b/c..d`、`?q=..` 不受影响。该常量尚未进 buildRules().notifyChannel（rules.json 读不到）；待导出后改读 rules.json 并删掉本副本。
 */
export const LINK_PATH_DOT_SEGMENT = /^(?:[^?]*\/)?(?:\.|%2e){1,2}(?:[/?]|$)/i;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = s => [...s].length;
const err = (status, code, message) => ({ status, body: { error: { code, message } } });
/** 400 NOTIFY_CHANNEL_MESSAGE_INVALID；field 与平台 details.field 同名（channel / message / message.title / … / message.link.path）。 */
const invalid = (field, message) => {
    const e = err(400, 'NOTIFY_CHANNEL_MESSAGE_INVALID', message);
    if (field) e.body.error.details = { field };
    return { error: e };
};
/**
 * https 图片地址按**原串**拆出路径（不经 new URL 规范化，与平台「原串 startsWith(基址 + '/') 再切片」同口径）：
 * 主机段不含 / ? # @ \ :（即不收账号、显式端口），路径里不含 ? #（末尾空 ? / # 也拒）。
 */
const HTTPS_RAW = /^https:\/\/[^/?#@\\:]+(\/[^?#]*)$/;
/** 任何控制字符（U+0000–U+001F、U+007F）。 */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** text 里除 \t（U+0009）\n（U+000A）之外的控制字符（CR 已先规范化成 LF）。 */
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** 没有 .ptx/channels.json 时本地记的渠道类型（brief §8.4）。 */
const DEFAULT_LOCAL_TYPE = 'webhook';

/**
 * 校验并规范化 `{ channel, message }`（brief §4.3）。返回 `{ message, warnings }` 或 `{ error }`。
 * channel 只判是否字符串（非字符串 → 400，平台 P13）；名字规则与是否存在由 handleNotifyChannel 判（→ 404）。
 * imageUrl 本地只收两种：本地图表桩的地址；或 https 且路径匹配平台 media 形状（rules.notifyChannel.mediaPathPattern）——
 * 后者本地核不了主机与工作区 / 应用段，放行并给一条提示。
 */
export function validateChannelMessage(body, rules = RULES.notifyChannel) {
    const r = channelRules(rules);
    // 平台对非对象请求体回的是另一个通用 400（opInvalid），没有 field；本地沿用本码、不带 details
    if (!isObj(body)) return invalid(null, '请求体必须是 JSON 对象 { channel, message }');
    if (typeof body.channel !== 'string') return invalid('channel', 'channel 必须是字符串（渠道名）');
    const m = body.message;
    if (!isObj(m)) return invalid('message', 'message 必须是对象 { title, text?, imageUrl?, link? }');

    const title = typeof m.title === 'string' ? m.title.trim() : null;
    if (title === null || title === '' || codePoints(title) > r.titleMax || CONTROL.test(title)) {
        return invalid('message.title', `message.title 必须是 trim 后 1..${r.titleMax} 个字符，不含换行与控制字符`);
    }

    let text = '';
    if (m.text != null) {   // null 视同缺省（与平台同）
        if (typeof m.text !== 'string') return invalid('message.text', 'message.text 必须是字符串（不传即为空）');
        text = m.text.replace(/\r\n?/g, '\n');
        if (codePoints(text) > r.textMax || TEXT_CONTROL.test(text)) {
            return invalid('message.text', `message.text 最多 ${r.textMax} 个字符，除换行与制表符外不能含控制字符`);
        }
    }

    const warnings = [];
    let imageUrl = null;
    if (m.imageUrl != null) {
        if (typeof m.imageUrl !== 'string') return invalid('message.imageUrl', 'message.imageUrl 必须是字符串');
        if (!LOCAL_MEDIA_SRC.test(m.imageUrl)) {
            const path = HTTPS_RAW.exec(m.imageUrl)?.[1] ?? null;
            if (path === null || !new RegExp(r.mediaPathPattern).test(path)) {
                return invalid('message.imageUrl', 'message.imageUrl 只收 ctx.pt.render.chart() 返回的图片地址（本地是 http://localhost:8788/__ptx/media/…，线上是平台 media 地址），不收外链');
            }
            warnings.push('message.imageUrl 不是本地图表桩的地址：本地只核对了路径形状，线上还会核对主机，并要求是本工作区本应用渲染的图');
        }
        imageUrl = m.imageUrl;
    }

    let link = null;
    if (m.link != null) {
        if (!isObj(m.link)) return invalid('message.link', 'message.link 必须是 { label, path } 对象');
        const label = typeof m.link.label === 'string' ? m.link.label.trim() : null;
        if (label === null || label === '' || codePoints(label) > r.linkLabelMax || CONTROL.test(label)) {
            return invalid('message.link.label', `message.link.label 必须是 trim 后 1..${r.linkLabelMax} 个字符，不含控制字符`);
        }
        if (typeof m.link.path !== 'string') return invalid('message.link.path', 'message.link.path 必须是字符串（应用内路径）');
        // 与平台 channel-message.ts 逐条同序：去前导 → 长度 → 字符集 → scheme / 仍以 / 开头 → 点段
        const raw = m.link.path;
        const path = raw.startsWith('#/') ? raw.slice(2) : raw.startsWith('/') ? raw.slice(1) : raw;
        if (path.length > r.linkPathMax) {
            return invalid('message.link.path', `message.link.path 去掉开头一个 #/ 或 / 后不能超过 ${r.linkPathMax} 个字符`);
        }
        if (!new RegExp(r.linkPathPattern).test(path)) {
            return invalid('message.link.path', 'message.link.path 只能是应用内路径，只含 URL 路径字符（不含 # 空白 控制字符等）');
        }
        // P15：带 scheme，或去一个前导后仍以 / 开头（即原值 // 开头）= 绝对地址
        if (LINK_PATH_SCHEME.test(path) || path.startsWith('/')) {
            return invalid('message.link.path', 'message.link.path 只接受应用内路径：首段不能带 scheme（https: / javascript: / reports:42 …），也不能以 // 开头');
        }
        // R11：点段（含 %2e）在线上会经 URL 归一化逃出 apps/<appUuid>/
        if (LINK_PATH_DOT_SEGMENT.test(path)) {
            return invalid('message.link.path', 'message.link.path 不能含 . 或 .. 路径段（含 %2e 编码；文件名与 ? 之后的点不受影响）');
        }
        link = { label, path };
    }
    return { message: { title, text, imageUrl, link }, warnings };
}

/** 读项目内 .ptx/channels.json（每次现读）。没有文件 → null；不合规 → 抛错（server 回 500 PTX_STUB_FAILED，消息点名文件）。 */
export function loadLocalChannels(root, rules = RULES.notifyChannel) {
    const r = channelRules(rules);
    const p = join(root, '.ptx', 'channels.json');
    if (!existsSync(p)) return null;
    let list;
    try {
        list = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
        throw new Error(`.ptx/channels.json 不是合法 JSON：${e.message}`);
    }
    if (!Array.isArray(list)) throw new Error('.ptx/channels.json 必须是数组：[{ "name": "alerts", "type": "slack" }]');
    const name = new RegExp(r.namePattern);
    const seen = new Set();
    return list.map((c, i) => {
        if (!isObj(c) || typeof c.name !== 'string' || !name.test(c.name) || !r.types.includes(c.type)) {
            throw new Error(`.ptx/channels.json 第 ${i + 1} 项不合规：name 须匹配 ${r.namePattern}，type 须是 ${r.types.join(' / ')} 之一`);
        }
        if (seen.has(c.name)) throw new Error(`.ptx/channels.json 里渠道名重复：${c.name}`);
        seen.add(c.name);
        return { name: c.name, type: c.type };
    });
}

export function handleNotifyChannel(state, { claims, body, appName, channels, rules = RULES.notifyChannel }) {
    const r = channelRules(rules);
    const v = validateChannelMessage(body, r);
    if (v.error) return v.error;

    const name = body.channel;
    let channel = null;
    if (channels) {
        channel = channels.find(c => c.name === name) ?? null;
    } else {
        if (!r.types.includes(DEFAULT_LOCAL_TYPE)) {
            throw new Error(`规则快照的渠道类型里没有 ${DEFAULT_LOCAL_TYPE}，与本地桩不匹配。请升级 starter。`);
        }
        if (new RegExp(r.namePattern).test(name)) channel = { name, type: DEFAULT_LOCAL_TYPE };
    }
    if (!channel) {
        const shown = JSON.stringify(name.slice(0, 64));
        return err(404, 'NOTIFY_CHANNEL_NOT_FOUND', channels
            ? `渠道 ${shown} 不在 .ptx/channels.json 里（线上：工作区里没有这个名字，或它没对本应用开放）`
            : `渠道名 ${shown} 不合规（须匹配 ${r.namePattern}），线上不可能存在`);
    }

    const { runId, preview } = jobRunOf(claims);
    if (runId) {
        const c = runCounters(state, runId);
        if (c.channelCalls + 1 > r.maxPerRun) {
            return err(409, 'NOTIFY_RUN_LIMIT_EXCEEDED', `一次运行最多 ${r.maxPerRun} 次 notify.channel（含预览）`);
        }
        c.channelCalls++;
    }

    const status = preview ? 'intercepted' : 'sent';
    return {
        status: 200,
        body: { preview, status, channel },
        outbox: {
            dir: runId ?? 'interactive',
            // = 线上 ChannelOutboxPayload 的简化版：rendered 为 null（各渠道的实际格式只在平台渲染）、多一个 status 方便本地预览页；
            //   message.link 是 { label, path }（线上存展开后的 url）。永远没有凭据。
            payload: {
                v: 1, channel: { ...channel, isTest: false }, appName, message: v.message, status,
                rendered: null, delivery: null, mediaUrls: v.message.imageUrl ? [v.message.imageUrl] : []
            }
        },
        warnings: v.warnings
    };
}

export function handleListChannels({ channels }) {
    const list = (channels ?? []).map(({ name, type }) => ({ name, type }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { status: 200, body: { channels: list } };
}
