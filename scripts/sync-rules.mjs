/**
 * 从 custom-app-contract 同步规则快照到 scripts/rules.json。
 *
 * **本仓是公开仓，不能依赖内部包**，所以规则以生成物的形式提交进来。
 *
 * ⚠️ spec B.4 写的是「从**平台仓**复制生成的 JSON 规则」，这里刻意改成**直接从 contract 仓取**
 * （「刻意偏离」表第 11 行）。理由：平台仓自己也只是 contract 的消费方，从一个消费方复制规则
 * 等于凭空多一跳漂移面 —— 规则改了以后要先等平台仓同步、再等 starter 同步。直取只有一跳。
 * 维护者（不是普通使用者）在改完 contract 之后跑：
 *
 *   PT_CONTRACT_DIR=../custom-app-contract npm run sync-rules
 *   PT_CONTRACT_DIR=../custom-app-contract npm run sync-rules -- --check   # CI：只比对不写
 *
 * --check 模式给 contract 仓的跨仓测试用：规则漂了就非零退出。退出码分两档，
 * 好让 CI 分得清「该同步规则了」和「契约包还没 build」：
 *
 *   0  一致（或写入成功）
 *   1  规则漂了 —— 跑一次 sync-rules 并提交
 *   2  环境没准备好 —— 没设 PT_CONTRACT_DIR，或 contract 仓缺 dist/rules.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'rules.json');
const contractDir = process.env.PT_CONTRACT_DIR;
if (!contractDir) {
    console.error('需要 PT_CONTRACT_DIR 指向 custom-app-contract 的本地目录（先在那边跑 npm run build && npm run emit-rules）');
    process.exit(2);
}
const source = resolve(contractDir, 'dist', 'rules.json');
// 退出码是有区分的：**2 = 环境没准备好**（没设 PT_CONTRACT_DIR、或 contract 仓还没生成
// dist/rules.json），**1 = 规则真的漂了**。以前两者都靠 readFileSync 抛 ENOENT，CI 里
// 看到的是一个非零退出 + 一句 "no such file"，分不出"契约包没 build"与"该同步规则了"。
if (!existsSync(source)) {
    console.error(`找不到 ${source}`);
    console.error('contract 仓还没生成规则快照。先在那边跑：npm run build && npm run emit-rules');
    process.exit(2);
}
const next = `${JSON.stringify(JSON.parse(readFileSync(source, 'utf8')), null, 4)}\n`;

if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8');
    if (current !== next) {
        console.error('scripts/rules.json 与 contract 包不一致。跑一次 npm run sync-rules 并提交。');
        process.exit(1);
    }
    console.log('rules.json 与 contract 包一致');
} else {
    writeFileSync(target, next, 'utf8');
    console.log(`wrote ${target}`);
}
