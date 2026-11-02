import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyJobResponse, isJsonContentType, validateJobRunResult } from './job-result.mjs';

/**
 * 用例与 platform 计划 Task 4（packages/contract/test/jobs-result.test.ts）**逐条一致**（brief §13.4）：
 * 同样的输入、同样的状态、invalid 的理由里同样点名字段路径。改那边的用例时这里一起改。
 */
const R = { maxBytes: 262144, markdownMaxBytes: 204800, maxFiles: 5, fileTypes: ['text/csv'], titleMax: 200, fileNameMax: 120 };
const v = b => validateJobRunResult(b, R);
const reasonOf = b => { const r = v(b); return r.status === 'invalid' ? r.reason : `<${r.status}>`; };

for (const b of [undefined, null, 'text', 42, [], {}, { ok: true, archived: 1 }]) {
    test(`none：${JSON.stringify(b)}`, () => assert.deepEqual(v(b), { status: 'none' }));
}

test('stored：最小合法，只有 markdown', () => {
    assert.deepEqual(v({ archive: { markdown: '# 周报' } }), { status: 'stored', result: { archive: { markdown: '# 周报' } } });
});

test('stored：只存 archive —— 顶层其它字段与 archive / file 里的未知字段都丢掉', () => {
    assert.deepEqual(v({
        ok: true, rows: [1, 2, 3],
        archive: { title: '周报', markdown: 'x', extra: 'drop-me', files: [{ name: 'a.csv', contentType: 'text/csv', content: 'a,b\n1,2', size: 9 }] }
    }), { status: 'stored', result: { archive: { title: '周报', markdown: 'x', files: [{ name: 'a.csv', contentType: 'text/csv', content: 'a,b\n1,2' }] } } });
});

test('stored：边界值 —— markdown 恰好 204800 字节、title 恰好 200 字、5 个文件、文件名恰好 120 字、空 markdown', () => {
    assert.equal(v({ archive: { markdown: 'x'.repeat(204_800) } }).status, 'stored');
    assert.equal(v({ archive: { title: '题'.repeat(200), markdown: '' } }).status, 'stored');
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `${i}`.padEnd(120, 'n'), contentType: 'text/csv', content: '' }));
    assert.equal(v({ archive: { markdown: 'x', files } }).status, 'stored');
});

test('长度按 Unicode 码点计：200 个 emoji 的标题、120 个 emoji 的文件名合法；多一个就 invalid', () => {
    assert.equal(v({ archive: { title: '😀'.repeat(200), markdown: 'x' } }).status, 'stored');
    assert.equal(v({ archive: { markdown: 'x', files: [{ name: '😀'.repeat(120), contentType: 'text/csv', content: '' }] } }).status, 'stored');
    assert.equal(v({ archive: { title: '😀'.repeat(201), markdown: 'x' } }).status, 'invalid');
    assert.equal(v({ archive: { markdown: 'x', files: [{ name: '😀'.repeat(121), contentType: 'text/csv', content: '' }] } }).status, 'invalid');
});

const INVALID = [
    ['archive 是 null', { archive: null }, 'archive'],
    ['archive 是数组', { archive: [] }, 'archive'],
    ['markdown 缺失', { archive: { title: 't' } }, 'archive.markdown'],
    ['markdown 不是字符串', { archive: { markdown: 1 } }, 'archive.markdown'],
    ['markdown 多字节超限', { archive: { markdown: '汉'.repeat(68_267) } }, 'archive.markdown'],
    ['title 空串', { archive: { title: '', markdown: 'x' } }, 'archive.title'],
    ['title 全空白', { archive: { title: '  ', markdown: 'x' } }, 'archive.title'],
    ['title 201 字', { archive: { title: 't'.repeat(201), markdown: 'x' } }, 'archive.title'],
    ['title 不是字符串', { archive: { title: 7, markdown: 'x' } }, 'archive.title'],
    ['files 不是数组', { archive: { markdown: 'x', files: {} } }, 'archive.files'],
    ['files 6 个', { archive: { markdown: 'x', files: Array.from({ length: 6 }, (_, i) => ({ name: `${i}.csv`, contentType: 'text/csv', content: '' })) } }, 'archive.files'],
    ['file 不是对象', { archive: { markdown: 'x', files: ['a.csv'] } }, 'archive.files[0]'],
    ['文件名为空', { archive: { markdown: 'x', files: [{ name: '', contentType: 'text/csv', content: '' }] } }, 'archive.files[0].name'],
    ['文件名 121 字', { archive: { markdown: 'x', files: [{ name: 'n'.repeat(121), contentType: 'text/csv', content: '' }] } }, 'archive.files[0].name'],
    ['文件名含 /', { archive: { markdown: 'x', files: [{ name: 'a/b.csv', contentType: 'text/csv', content: '' }] } }, 'archive.files[0].name'],
    ['文件名含 \\', { archive: { markdown: 'x', files: [{ name: 'a\\b.csv', contentType: 'text/csv', content: '' }] } }, 'archive.files[0].name'],
    ['文件名含换行', { archive: { markdown: 'x', files: [{ name: 'a\nb.csv', contentType: 'text/csv', content: '' }] } }, 'archive.files[0].name'],
    ['文件名含 DEL', { archive: { markdown: 'x', files: [{ name: 'a\u007fb.csv', contentType: 'text/csv', content: '' }] } }, 'archive.files[0].name'],
    ['contentType 不在白名单', { archive: { markdown: 'x', files: [{ name: 'a.txt', contentType: 'text/plain', content: '' }] } }, 'archive.files[0].contentType'],
    ['content 是 base64 以外的非字符串', { archive: { markdown: 'x', files: [{ name: 'a.csv', contentType: 'text/csv', content: 1 }] } }, 'archive.files[0].content']
];
for (const [name, body, field] of INVALID) {
    test(`invalid：${name}`, () => {
        assert.equal(v(body).status, 'invalid');
        assert.ok(reasonOf(body).includes(field), reasonOf(body));
    });
}

test('isJsonContentType', () => {
    assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
    assert.equal(isJsonContentType('application/problem+json'), true);
    assert.equal(isJsonContentType('text/plain'), false);
    assert.equal(isJsonContentType(null), false);
});

test('classifyJobResponse：与 scheduler 采集口径一致（只看 2xx + JSON，按字节判超限，解析失败 = 无结果）', () => {
    const J = 'application/json';
    assert.equal(classifyJobResponse({ status: 500, contentType: J, text: '{"archive":{"markdown":"x"}}' }, R).status, 'none');
    assert.equal(classifyJobResponse({ status: 200, contentType: 'text/plain', text: '{"archive":{"markdown":"x"}}' }, R).status, 'none');
    assert.equal(classifyJobResponse({ status: 200, contentType: J, text: '{oops' }, R).status, 'none');
    assert.equal(classifyJobResponse({ status: 200, contentType: J, text: '' }, R).status, 'none');
    assert.equal(classifyJobResponse({ status: 200, contentType: J, text: JSON.stringify({ archive: { markdown: 'x' } }) }, R).status, 'stored');
    assert.equal(classifyJobResponse({ status: 200, contentType: J, text: JSON.stringify({ archive: { title: ' ', markdown: 'x' } }) }, R).status, 'invalid');
    const big = JSON.stringify({ archive: { markdown: '中'.repeat(90_000) } });   // 字符数 < 262144，字节数 > 262144
    assert.equal(classifyJobResponse({ status: 200, contentType: J, text: big }, R).status, 'too_large');
});

test('规则段缺失 → 抛错并指向 sync-rules（不偷偷用默认值）', () => {
    assert.throws(() => validateJobRunResult({ archive: { markdown: 'x' } }, undefined), /sync-rules/);
});

test('不传规则 → 用 rules.json 的 jobResult 段；传了别的上限就按传入的判（上限不写死）', () => {
    assert.equal(validateJobRunResult({ archive: { title: 't'.repeat(200), markdown: 'x' } }).status, 'stored');
    assert.equal(validateJobRunResult({ archive: { title: 't'.repeat(201), markdown: 'x' } }).status, 'invalid');
    const tight = { ...R, titleMax: 3, markdownMaxBytes: 4, maxFiles: 1, fileNameMax: 2, fileTypes: ['text/plain'] };
    assert.equal(validateJobRunResult({ archive: { title: 'abcd', markdown: 'x' } }, tight).status, 'invalid');
    assert.equal(validateJobRunResult({ archive: { markdown: '汉汉' } }, tight).status, 'invalid');
    assert.equal(validateJobRunResult({ archive: { markdown: 'x', files: [{ name: 'abc', contentType: 'text/plain', content: '' }] } }, tight).status, 'invalid');
    assert.equal(validateJobRunResult({ archive: { markdown: 'x', files: [{ name: 'ab', contentType: 'text/plain', content: '' }] } }, tight).status, 'stored');
    assert.equal(classifyJobResponse({ status: 200, contentType: 'application/json', text: '{"archive":{"markdown":"x"}}' }, { ...R, maxBytes: 10 }).status, 'too_large');
});

test('classifyJobResponse 规则段缺失同样抛错', () => {
    assert.throws(() => classifyJobResponse({ status: 200, contentType: 'application/json', text: '{}' }, undefined), /sync-rules/);
});
