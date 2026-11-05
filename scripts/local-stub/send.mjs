/**
 * ptx dev 的本地「通知发送」桩逻辑（`ctx.pt.notify.send`，通知投递目标 brief §9.3）。纯函数（loadLocalTargets 读一个文件）；
 * server.mjs 包一层 HTTP 并负责写文件。取代 1c 的按名发送桩（channel.mjs）。
 *
 * 两层模型：应用只写消息内容，投递目标由使用者配置（任务的「发送到」/ 应用的即时通知渠道）。本地没有订阅中心，
 * 目标来自项目内 `.ptx/notify-targets.json`（`[{ "name": "alerts", "type": "slack" }]`，每次请求现读，改了即时生效）：
 *   · 文件不存在 → 一个虚拟目标 `{ name: 'local', type: 'webhook' }`（让本地默认走通 sent 分支，裁定 N30）；
 *   · 文件为 `[]` → 没有投递目标：任务 run 回 `no_targets` / `JOB_TARGETS_EMPTY`，交互回 `APP_DEFAULT_EMPTY`（用于本地测无目标分支）；
 *   · 任务 run 与交互调用用同一份目录（本地不区分「任务的渠道」与「应用的即时通知渠道」）；
 *   · 交互调用（非任务）且 manifest 没声明 `backend.notify.instant: true`（入参 instant = false，server 每次现读 manifest.json）→
 *     不读目标、不投递，`no_targets` / `APP_INSTANT_NOT_DECLARED`（2026-10-22 即时通知补充 R2，与线上同口径）。
 *
 * 判定顺序与线上平台一致（brief §4.4）：消息形状（第 3 步）→ 解析目标（第 5 步）→ 本 run 单位（第 6 步：每次消耗 max(1, 目标数)，
 * 含预览、含无目标）→ 预览拦截（第 8 步）→ 无目标（第 9 步）→ 投递。被第 3 步拒掉的调用不计。
 * 上限、正则与类型表全部读 scripts/rules.json 的 notifySend 段（含 link.path 的 scheme / 点段正则 linkPathSchemePattern /
 * linkPathDotSegmentPattern，形如 { source, flags }，以 new RegExp(source, flags) 还原；缺键报「规则快照过旧」，不写字面量兜底）；
 * 错误码与线上同名。与平台同口径（本地能过、线上被拒不可接受）。
 * link.path 与平台逐条同序：去一个前导 `#/` 或 `/` → 长度 → 字符集 → 带 scheme 或仍以 `/` 开头（P15）→ 含 . / .. 段（R11）→ 400。
 *
 * 本地**永远不真实投递**（含非预览）：本地没有渠道凭据，也不该从开发机往客户频道发消息（1c 裁定 C34）。所以本地只有 sent，
 * 没有 partial / 502。工作区每分钟 30 条的限额本地不模拟。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES } from '../manifest.mjs';
import { LOCAL_MEDIA_SRC, jobRunOf, runCounters } from './notify.mjs';

/**
 * 本地发送桩用到的 notifySend 规则键；缺任何一个都视为快照过旧。
 * maxConcurrentPerApp / maxBodyBytes 本模块不读，是 server.mjs（并发闸、413 体积上限）经 sendRules 校验后用的，不是死键。
 */
const REQUIRED_SEND_KEYS = ['types', 'titleMax', 'textMax', 'linkLabelMax', 'linkPathMax', 'linkPathPattern',
    'maxUnitsPerRun', 'maxTargets', 'mediaPathPattern', 'maxConcurrentPerApp', 'maxBodyBytes', 'linkPathSchemePattern', 'linkPathDotSegmentPattern'];

/** rules.json 里以 { source, flags } 存的正则键：形状不对（不是两个字符串）同样视为快照过旧，不还原成意外的正则。 */
const REGEX_SEND_KEYS = ['linkPathSchemePattern', 'linkPathDotSegmentPattern'];
const isRegexShape = v => typeof v?.source === 'string' && typeof v?.flags === 'string';
/** mediaPathPatterns（可选键，热图截图起才有）：有就必须是非空字符串数组，否则同样视为快照过旧。 */
const isPatternList = v => Array.isArray(v) && v.length > 0 && v.every(p => typeof p === 'string');

export function sendRules(rules) {
    const missing = rules
        ? REQUIRED_SEND_KEYS.filter(k => rules[k] == null || (REGEX_SEND_KEYS.includes(k) && !isRegexShape(rules[k])))
        : ['notifySend'];
    if (rules && rules.mediaPathPatterns != null && !isPatternList(rules.mediaPathPatterns)) missing.push('mediaPathPatterns');
    if (missing.length) {
        throw new Error(`scripts/rules.json 的 notifySend 段缺 ${missing.join(' / ')}（规则快照过旧）。维护者请跑 npm run sync-rules。`);
    }
    return rules;
}

/**
 * imageUrl 路径可接受的 media 形状：优先 mediaPathPatterns（图表 png + 热图截图 jpg，平台同口径），
 * 旧快照只有单个 mediaPathPattern（只收图表 png）时退回它。
 */
const mediaPatternsOf = r => (r.mediaPathPatterns ?? [r.mediaPathPattern]).map(p => new RegExp(p));

/** rules.json 里以 { source, flags } 存的正则还原成 RegExp（contract buildRules().notifySend 的序列化形状）。 */
const regexOf = ({ source, flags }) => new RegExp(source, flags);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = s => [...s].length;
const err = (status, code, message) => ({ status, body: { error: { code, message } } });
/** 400 NOTIFY_CHANNEL_MESSAGE_INVALID；field 与平台 details.field 同名（message / message.title / … / message.link.path）。 */
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
/** 没有 .ptx/notify-targets.json 时的虚拟目标（裁定 N30）。 */
export const DEFAULT_LOCAL_TARGET = Object.freeze({ name: 'local', type: 'webhook' });
/** 本地目标名的长度上限（只为终端与预览页可读；线上渠道名规则由平台管，应用看不到）。 */
const LOCAL_TARGET_NAME_MAX = 64;

/**
 * 校验并规范化 `{ message }`（brief §4.4 第 3 步，规则同 1c §4.3）。返回 `{ message, warnings }` 或 `{ error }`。
 * 请求体里 message 以外的键（应用塞的 channel / channelIds 之类）一律忽略 —— 线上 backend 也只取 message。
 * imageUrl 本地只收两种：本地图表桩的地址；或 https 且路径匹配平台 media 形状（rules.notifySend.mediaPathPatterns：
 * 图表 png 与 heatmap.capture 的热图截图 jpg；旧快照退回单个 mediaPathPattern）——
 * 后者本地核不了主机与工作区 / 应用段，放行并给一条提示。
 */
export function validateSendMessage(body, rules = RULES.notifySend) {
    const r = sendRules(rules);
    // 非对象请求体：线上在 backend 网关（notify/send）就回 400 NOTIFY_CHANNEL_MESSAGE_INVALID、不带 details，到不了平台。
    if (!isObj(body)) return invalid(null, '请求体必须是 JSON 对象 { message }');
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
            if (path === null || !mediaPatternsOf(r).some(re => re.test(path))) {
                return invalid('message.imageUrl', 'message.imageUrl 只收 ctx.pt.render.chart() 返回的图、或 ctx.pt.heatmap.getCapture() 结果里的热图截图地址（本地图表桩是 http://localhost:8788/__ptx/media/…，线上是平台 media 地址），不收外链');
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
        // 与平台消息校验逐条同序：去前导 → 长度 → 字符集 → scheme / 仍以 / 开头 → 点段
        const raw = m.link.path;
        const path = raw.startsWith('#/') ? raw.slice(2) : raw.startsWith('/') ? raw.slice(1) : raw;
        if (path.length > r.linkPathMax) {
            return invalid('message.link.path', `message.link.path 去掉开头一个 #/ 或 / 后不能超过 ${r.linkPathMax} 个字符`);
        }
        if (!new RegExp(r.linkPathPattern).test(path)) {
            return invalid('message.link.path', 'message.link.path 只能是应用内路径，只含 URL 路径字符（不含 # 空白 控制字符等）');
        }
        // P15：带 scheme，或去一个前导后仍以 / 开头（即原值 // 开头）= 绝对地址
        if (regexOf(r.linkPathSchemePattern).test(path) || path.startsWith('/')) {
            return invalid('message.link.path', 'message.link.path 只接受应用内路径：首段不能带 scheme（https: / javascript: / reports:42 …），去掉一个前导后不能再以 / 开头');
        }
        // R11：点段（含 %2e）在线上会经 URL 归一化逃出 apps/<appUuid>/
        if (regexOf(r.linkPathDotSegmentPattern).test(path)) {
            return invalid('message.link.path', 'message.link.path 不能含 . 或 .. 路径段（含 %2e 编码；文件名与 ? 之后的点不受影响）');
        }
        link = { label, path };
    }
    return { message: { title, text, imageUrl, link }, warnings };
}

/**
 * 读项目内 .ptx/notify-targets.json（每次现读）。没有文件 → null（= 用虚拟目标）；不合规 → 抛错（server 回 500 PTX_STUB_FAILED，消息点名文件）。
 * 上限同线上每个任务 / 应用即时通知渠道的目标数上限（rules.notifySend.maxTargets）。
 */
export function loadLocalTargets(root, rules = RULES.notifySend) {
    const r = sendRules(rules);
    const p = join(root, '.ptx', 'notify-targets.json');
    if (!existsSync(p)) return null;
    let list;
    try {
        list = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
        throw new Error(`.ptx/notify-targets.json 不是合法 JSON：${e.message}`);
    }
    if (!Array.isArray(list)) throw new Error('.ptx/notify-targets.json 必须是数组：[{ "name": "alerts", "type": "slack" }]（[] = 没有投递目标）');
    if (list.length > r.maxTargets) {
        throw new Error(`.ptx/notify-targets.json 最多 ${r.maxTargets} 个目标（线上每个订阅 / 应用即时通知渠道的上限），收到 ${list.length} 个`);
    }
    const seen = new Set();
    return list.map((c, i) => {
        if (!isObj(c) || typeof c.name !== 'string' || c.name.trim() === '' || codePoints(c.name) > LOCAL_TARGET_NAME_MAX ||
            CONTROL.test(c.name) || !r.types.includes(c.type)) {
            throw new Error(`.ptx/notify-targets.json 第 ${i + 1} 项不合规：name 须是 1..${LOCAL_TARGET_NAME_MAX} 个字符的非空字符串，` +
                `type 须是 ${r.types.join(' / ')} 之一`);
        }
        if (seen.has(c.name)) throw new Error(`.ptx/notify-targets.json 里目标名重复：${c.name}`);
        seen.add(c.name);
        return { name: c.name, type: c.type };
    });
}

/** loadLocalTargets 的结果 → 本次的目标列表（null = 没有文件 → 虚拟目标）。 */
export function resolveLocalTargets(targets, rules = RULES.notifySend) {
    if (targets !== null) return targets;
    if (!sendRules(rules).types.includes(DEFAULT_LOCAL_TARGET.type)) {
        throw new Error(`规则快照的渠道类型里没有 ${DEFAULT_LOCAL_TARGET.type}，与本地桩不匹配。请升级 starter。`);
    }
    return [{ ...DEFAULT_LOCAL_TARGET }];
}

/**
 * `instant`：应用（当前 manifest）是否声明了即时发送（`declaresInstantNotify`）。缺省 = 未声明，与平台「当前版本没声明就不投」同口径。
 * 只影响交互调用；任务 run / 预览照旧按任务的目标。
 */
export function handleNotifySend(state, { claims, body, appName, targets, instant = false, rules = RULES.notifySend }) {
    const r = sendRules(rules);
    const v = validateSendMessage(body, r);
    if (v.error) return v.error;

    const { isJob, runId, preview } = jobRunOf(claims);
    const undeclared = !isJob && !instant;
    // 未声明即时发送：不读目标（线上不读默认渠道），按无目标处理
    const list = undeclared ? [] : resolveLocalTargets(targets ?? null, r);
    const k = list.length;
    const noTargetsReason = k === 0 ? (isJob ? 'JOB_TARGETS_EMPTY' : undeclared ? 'APP_INSTANT_NOT_DECLARED' : 'APP_DEFAULT_EMPTY') : null;

    if (runId) {
        const c = runCounters(state, runId);
        const units = Math.max(1, k);
        if (c.sendUnits + units > r.maxUnitsPerRun) {
            return err(409, 'NOTIFY_RUN_LIMIT_EXCEEDED',
                `一次运行最多 ${r.maxUnitsPerRun} 个渠道消息单位（每次 notify.send 消耗 max(1, 目标数)，含预览），本次需要 ${units}、已用 ${c.sendUnits}`);
        }
        c.sendUnits += units;
    }

    let result;
    if (preview) result = { preview: true, status: 'intercepted', targets: k, sent: 0, failed: 0, noTargetsReason };
    else if (k === 0) result = { preview: false, status: 'no_targets', targets: 0, sent: 0, failed: 0, noTargetsReason };
    else result = { preview: false, status: 'sent', targets: k, sent: k, failed: 0, noTargetsReason: null };

    return {
        status: 200,
        body: result,
        outbox: {
            dir: runId ?? 'interactive',
            // = 线上 ChannelOutboxPayloadV2 的简化版：消息只存一份、targets 只有 name / type（没有 rendered / delivery，各渠道的
            //   实际格式只在平台渲染）；status 用 outbox 口径（无目标的任务 run 记 skipped）。message.link 是 { label, path }。永远没有凭据。
            payload: {
                v: 2, appName, message: v.message, targets: list,
                status: result.status === 'no_targets' && isJob ? 'skipped' : result.status,
                noTargetsReason, mediaUrls: v.message.imageUrl ? [v.message.imageUrl] : []
            }
        },
        warnings: v.warnings
    };
}
