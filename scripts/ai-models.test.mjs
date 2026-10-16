/**
 * `ptx doctor` 的 AI 模型名检查（classifyAiModels）回归测试。
 *
 * 2026-10-16 起模型名是逻辑名（不带厂商），平台网关按环境映射通道；带前缀的旧写法
 * 网关仍认。这里锁的是三种写法各自被认成什么。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyAiModels } from './ptx-doctor.mjs';

const rules = {
    aiModels: ['claude-sonnet-5', 'gpt-5.6-luna'],
    aiModelsByEnv: {
        dev: ['claude-sonnet-5', 'gpt-5.6-luna', 'gpt-6-astra'],
        staging: ['claude-sonnet-5', 'gpt-5.6-luna'],
        prod: ['claude-sonnet-5', 'gpt-5.6-luna']
    }
};

test('三个环境都可用的逻辑名 → 不报', () => {
    assert.deepEqual(classifyAiModels(`ctx.pt.ai.chat({ model: 'claude-sonnet-5' })`, rules), []);
});

test('带厂商前缀的旧写法 → legacy，并给出对应逻辑名', () => {
    assert.deepEqual(classifyAiModels(`const M = 'anthropic/claude-sonnet-5';`, rules),
        [{ kind: 'legacy', name: 'anthropic/claude-sonnet-5', logical: 'claude-sonnet-5' }]);
    assert.deepEqual(classifyAiModels(`model: "custom-tokenops/gpt-5.6-luna"`, rules),
        [{ kind: 'legacy', name: 'custom-tokenops/gpt-5.6-luna', logical: 'gpt-5.6-luna' }]);
});

test('只在部分环境开通的逻辑名 → partial，列出环境', () => {
    assert.deepEqual(classifyAiModels(`model: 'gpt-6-astra'`, rules),
        [{ kind: 'partial', name: 'gpt-6-astra', envs: ['dev'] }]);
});

test('不认识的名字 → unknown', () => {
    assert.deepEqual(classifyAiModels(`model: 'claude-made-up-9'`, rules), [{ kind: 'unknown', name: 'claude-made-up-9' }]);
    assert.deepEqual(classifyAiModels(`const X = 'anthropic/claude-made-up-9';`, rules),
        [{ kind: 'unknown', name: 'anthropic/claude-made-up-9' }]);
});

test('没有 model: 的普通字符串不当成模型名（逻辑名没有 / 可认）', () => {
    assert.deepEqual(classifyAiModels(`const greeting = 'hello'; log('claude-sonnet-5 is great');`, rules), []);
});

test('老快照（没有 aiModelsByEnv）也能用', () => {
    assert.deepEqual(classifyAiModels(`model: 'claude-sonnet-5'`, { aiModels: ['claude-sonnet-5'] }), []);
});
