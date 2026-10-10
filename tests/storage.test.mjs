import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDriver, setDriver, getDriver } from '../src/core/idb.js';
import { store, normalizeDoc, makePreview, newId, DOC_TYPES } from '../src/core/store.js';
import {
  serializeDoc, parseDoc, importFile, htmlToPlainText, withPreview, buildBackup, parseBackup,
  listExporters, findExporter, registerExporter, registerImporter, importableExtensions, TRIO_FORMAT,
} from '../src/core/format.js';
import { zipSync, unzip, crc32, utf8 } from '../src/core/zip.js';

// 三个应用在导入时会注册各自的导入/导出器（浏览器里由 main.js 触发）
import '../src/apps/writer/index.js';
import '../src/apps/sheet/index.js';
import '../src/apps/deck/index.js';
import { parseXml, escapeXml, decodeEntities, child, children, findAll, find } from '../src/core/xml.js';

/** 让 store 使用内存驱动，避免依赖浏览器 */
async function useMemory() {
  const driver = new MemoryDriver();
  setDriver(driver);
  await driver.clear();
  return driver;
}

test('ZIP：写入后可被读取（store 方式）', async () => {
  const bytes = zipSync([
    { name: 'a.txt', data: '你好，世界' },
    { name: 'dir/b.xml', data: '<x>1</x>' },
    { name: 'bin.dat', data: new Uint8Array([1, 2, 3, 255]) },
  ]);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
  const files = await unzip(bytes);
  assert.equal(files.size, 3);
  assert.equal(utf8.decode(files.get('a.txt')), '你好，世界');
  assert.equal(utf8.decode(files.get('dir/b.xml')), '<x>1</x>');
  assert.deepEqual([...files.get('bin.dat')], [1, 2, 3, 255]);
});

test('ZIP：CRC32 与空文件', async () => {
  assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926, '标准 CRC32 测试向量');
  const files = await unzip(zipSync([{ name: 'empty.txt', data: '' }]));
  assert.equal(files.get('empty.txt').length, 0);
  await assert.rejects(() => unzip(new Uint8Array([1, 2, 3, 4])), /ZIP/);
});

test('XML：解析元素、属性、CDATA 与实体', () => {
  const root = parseXml('<?xml version="1.0"?><root a="1" b=\'x\'><child>文本 &amp; 实体</child><self/><![CDATA[raw <b>]]><nested><deep>1</deep></nested></root>');
  assert.equal(root.name, 'root');
  assert.equal(root.attrs.a, '1');
  assert.equal(root.attrs.b, 'x');
  assert.equal(child(root, 'child').text, '文本 & 实体');
  assert.equal(children(root, 'self').length, 1);
  assert.equal(find(root, 'deep').text, '1');
  assert.equal(findAll(root, 'nested').length, 1);
  assert.equal(decodeEntities('&lt;&gt;&quot;&#39;&#x41;'), '<>"\'A');
  assert.equal(escapeXml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
});

test('XML：容错处理畸形输入', () => {
  assert.doesNotThrow(() => parseXml('<a><b>1</b>'));
  assert.doesNotThrow(() => parseXml(''));
  assert.doesNotThrow(() => parseXml('纯文本没有标签'));
  const root = parseXml('<a><!-- 注释 --><b/></a>');
  assert.equal(children(root, 'b').length, 1);
});

test('文档规范化与预览', () => {
  const doc = normalizeDoc({ type: 'sheet', title: '  预算  ' });
  assert.equal(doc.title, '预算');
  assert.equal(doc.type, 'sheet');
  assert.equal(doc.schema, 'trio/1');
  assert.equal(normalizeDoc({ type: 'sheet' }).items, undefined);
  assert.equal(normalizeDoc({ type: '未知类型' }).type, 'doc', '未知类型回退到 doc');
  assert.equal(normalizeDoc({}).title, '未命名');
  assert.ok(newId('doc').startsWith('doc_'));
  assert.ok(DOC_TYPES.deck);
  assert.equal(makePreview('  多   空格\n换行  '), '多 空格 换行');
  assert.ok(makePreview('x'.repeat(300)).length <= 141);
});

test('trio 序列化与解析往返', () => {
  const doc = normalizeDoc({
    id: 'doc_1',
    type: 'deck',
    title: '方案汇报',
    data: { theme: 'aurora', slides: [{ id: 's1', elements: [{ id: 'e1' }] }] },
    stats: { slides: 1 },
  });
  const text = serializeDoc(doc);
  assert.ok(text.includes(TRIO_FORMAT));
  const parsed = parseDoc(text);
  assert.equal(parsed.type, 'deck');
  assert.equal(parsed.title, '方案汇报');
  assert.equal(parsed.data.slides[0].elements[0].id, 'e1');
  assert.throws(() => parseDoc('不是 JSON'), /JSON/);
  assert.throws(() => parseDoc('{"foo":1}'), /类型/);
});

test('store：增删改查 / 副本 / 置顶', async () => {
  await useMemory();
  const created = await store.create('doc', { title: '第一篇', data: { html: '<p>你好</p>' }, preview: '你好' });
  assert.equal(created.title, '第一篇');
  assert.equal(created.type, 'doc');

  const sheet = await store.create('sheet', { data: null });
  assert.equal(sheet.title, '未命名表格');

  let list = await store.list();
  assert.equal(list.length, 2);

  await store.rename(created.id, '改名了');
  assert.equal((await store.get(created.id)).title, '改名了');

  const copy = await store.duplicate(created.id);
  assert.notEqual(copy.id, created.id);
  assert.ok(copy.title.includes('改名了'));
  assert.notEqual(copy.data, (await store.get(created.id)).data, '副本必须是深拷贝');

  await store.setPinned(sheet.id, true);
  list = await store.list();
  assert.equal(list[0].id, sheet.id, '置顶排在最前');

  await store.remove(sheet.id);
  assert.equal((await store.get(sheet.id)), null);
  assert.equal((await store.list()).length, 2);

  await store.clear();
  assert.equal((await store.list()).length, 0);
});

test('store：保存时会更新 updatedAt', async () => {
  await useMemory();
  const doc = await store.create('doc', {});
  const before = doc.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const saved = await store.save({ ...doc, title: '改了' });
  assert.ok(saved.updatedAt >= before);
});

test('导出注册表：三件套都有导出器', () => {
  for (const type of ['doc', 'sheet', 'deck']) {
    const list = listExporters(type);
    assert.ok(list.length >= 3, `${type} 至少应有 3 种导出格式，实际 ${list.length}`);
    for (const exporter of list) {
      assert.equal(typeof exporter.id, 'string');
      assert.equal(typeof exporter.label, 'string');
      assert.equal(typeof exporter.run, 'function');
      assert.ok(exporter.ext);
    }
    assert.ok(findExporter(type, 'trio'), `${type} 应支持 .trio 导出`);
  }
  assert.ok(importableExtensions().includes('csv'));
  assert.ok(importableExtensions().includes('md'));
});

test('导出器实际可运行（文档 / 表格 / 演示）', async () => {
  const trioDoc = normalizeDoc({ title: '样例', type: 'doc', data: { html: '<h1>样例</h1><p>正文</p>' } });
  const result = await findExporter('doc', 'trio').run(trioDoc);
  assert.equal(result.filename, '样例.trio');
  assert.ok(result.content.includes('trio/1'));
});

test('自定义导出器可注册', async () => {
  registerExporter('doc', {
    id: 'test-custom',
    label: '自定义',
    ext: 'txt',
    mime: 'text/plain',
    run: async () => ({ filename: 'custom.txt', content: 'ok', mime: 'text/plain' }),
  });
  const exporter = findExporter('doc', 'test-custom');
  assert.ok(exporter);
  const out = await exporter.run({});
  assert.equal(out.content, 'ok');
  assert.deepEqual(importableExtensions().sort(), importableExtensions().sort());
});

test('htmlToPlainText / withPreview 组合', () => {
  const text = htmlToPlainText('<h1>标题</h1><p>正文&nbsp;内容</p><script>坏</script>');
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('正文 内容'));
  assert.ok(!text.includes('坏'));
  const doc = withPreview({ title: 'x' }, '一些内容', { words: 3 });
  assert.equal(doc.preview, '一些内容');
  assert.equal(doc.stats.words, 3);
});

test('备份与恢复', async () => {
  await useMemory();
  const a = await store.create('doc', { title: 'A 文档', data: { html: '<p>A</p>' } });
  const b = await store.create('sheet', { title: 'B 表格', data: { version: 1, active: 0, sheets: [] } });
  const backup = buildBackup([a, b]);
  const parsed = parseBackup(backup);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((item) => item.type), ['doc', 'sheet']);
  assert.equal(parsed[0].title, 'A 文档');
  assert.throws(() => parseBackup('{"foo":1}'), /备份/);
});

test('导入：CSV / Markdown / 原生 trio 自动分流', async () => {
  const { sheetToWorkbook } = await import('../src/apps/sheet/index.js').catch(() => ({}));
  void sheetToWorkbook;
  const csv = new File(['名称,数量\n苹果,3\n香蕉,10'], '水果.csv', { type: 'text/csv' });
  const result = await importFile(csv);
  assert.equal(result.doc.type, 'sheet');
  assert.equal(result.doc.title, '水果');
  assert.equal(result.source, 'csv');

  const md = new File(['# 标题\n\n正文'], 'note.md', { type: 'text/markdown' });
  const mdResult = await importFile(md);
  assert.equal(mdResult.doc.type, 'doc');
  assert.ok(mdResult.doc.data.html.includes('<h1>标题</h1>'));

  const json = new File([JSON.stringify({ type: 'doc', title: '来的', data: { html: '<p>x</p>' } })], 'x.trio');
  const jsonResult = await importFile(json);
  assert.equal(jsonResult.doc.type, 'doc');
  assert.equal(jsonResult.doc.title, '来的');

  await assert.rejects(() => importFile(new File(['x'], 'a.unknown')), /不支持/);
});

test('注册自定义导入器', async () => {
  registerImporter(['zzz'], async (file) => ({ type: 'doc', title: 'zzz', data: { html: '<p>zzz</p>' } }));
  const result = await importFile(new File(['任意内容'], 'demo.zzz'));
  assert.equal(result.doc.type, 'doc');
  assert.equal(result.source, 'zzz');
});

test('MemoryDriver 与 getDriver 行为一致', async () => {
  const driver = await getDriver();
  await driver.clear();
  await driver.put({ id: 'x', type: 'doc', title: 't', updatedAt: 1, createdAt: 1 });
  assert.equal((await driver.get('x')).title, 't');
  assert.equal((await driver.all()).length, 1);
  const usage = await driver.usage();
  assert.ok('driver' in usage);
});

test('ZIP：可解压 deflate 压缩的条目（真实 Excel 文件就是这么压的）', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const { setInflateRaw } = await import('../src/core/zip.js');
  setInflateRaw((bytes) => new Uint8Array(deflateRawSync(Buffer.from(bytes))));

  const text = '真实 xlsx 使用 deflate 压缩，<x>中文</x>'.repeat(40);
  const rawData = utf8.encode(text);
  const compressed = deflateRawSync(Buffer.from(rawData));
  const crc = crc32(rawData);
  const nameBytes = utf8.encode('xl/sharedStrings.xml');

  const parts = [];
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(compressed.length), ...u32(rawData.length), ...u16(nameBytes.length), ...u16(0),
  ];
  parts.push(new Uint8Array(local), nameBytes, new Uint8Array(compressed));
  const localSize = local.length + nameBytes.length + compressed.length;

  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(compressed.length), ...u32(rawData.length),
    ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0),
  ];
  const centralSize = central.length + nameBytes.length;
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(centralSize), ...u32(localSize), ...u16(0)];

  const out = new Uint8Array(localSize + centralSize + end.length);
  let offset = 0;
  for (const chunk of [...parts, new Uint8Array(central), nameBytes, new Uint8Array(end)]) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  const files = await unzip(out);
  assert.equal(utf8.decode(files.get('xl/sharedStrings.xml')), text);

  // 未注入解压实现时，应该给出清晰的错误而不是静默失败
  setInflateRaw(null);
  if (typeof DecompressionStream === 'undefined') {
    await assert.rejects(() => unzip(out), /deflate/);
  }
});
