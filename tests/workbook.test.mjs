import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Workbook, createWorkbook, normalizeWorkbook, createSheet, cellKey, parseInput,
  rangeToCsv, parseDelimited, sortRange, cloneBlock, MAX_ROWS, MAX_COLS,
} from '../src/apps/sheet/workbook.js';
import { workbookToXlsx, xlsxToWorkbook } from '../src/apps/sheet/xlsx.js';
import { buildChartData } from '../src/apps/sheet/chart.js';
import { ERR } from '../src/apps/sheet/value.js';

/** 用二维数组快速造一个表 */
function makeBook(rows, header = false) {
  const workbook = new Workbook();
  const entries = [];
  rows.forEach((row, r) => row.forEach((value, c) => {
    if (value === null || value === undefined) return;
    entries.push({ r, c, input: String(value) });
  }));
  workbook.setCells('Sheet1', entries);
  if (header) workbook.setStyle('Sheet1', rows[0].map((_, c) => ({ r: 0, c })), { b: true });
  return workbook;
}

test('新建与规范化', () => {
  const workbook = new Workbook();
  assert.equal(workbook.sheetNames.length, 1);
  assert.equal(workbook.sheet.name, 'Sheet1');
  assert.equal(cellKey(0, 0), 'A1');
  assert.equal(cellKey(9, 27), 'AB10');

  const normalized = normalizeWorkbook({ active: 5, sheets: [{ name: '数据', cells: { A1: { v: 1 } } }] });
  assert.equal(normalized.active, 0);
  assert.equal(normalized.sheets[0].name, '数据');
  assert.deepEqual(normalizeWorkbook(null).sheets.length, 1, '非法输入回退到默认工作簿');
  assert.deepEqual(normalizeWorkbook({ sheets: [] }).sheets.length, 1);
});

test('输入解析：数字 / 百分比 / 日期 / 布尔 / 文本 / 公式', () => {
  assert.deepEqual(parseInput('42'), { v: 42 });
  assert.deepEqual(parseInput('-3.5'), { v: -3.5 });
  assert.deepEqual(parseInput('1.2e3'), { v: 1200 });
  assert.deepEqual(parseInput('25%'), { v: 0.25, fmt: 'percent' });
  assert.deepEqual(parseInput('¥1,234.50'), { v: 1234.5, fmt: 'currency' });
  assert.deepEqual(parseInput('TRUE'), { v: true });
  assert.equal(parseInput('2026-10-10').fmt, 'date');
  assert.equal(parseInput('2026-10-10').v, 46305);
  assert.equal(parseInput('09:30').fmt, 'time');
  assert.deepEqual(parseInput('=SUM(A1:A3)'), { f: '=SUM(A1:A3)' });
  assert.deepEqual(parseInput("'123"), { v: '123', fmt: 'text' });
  assert.equal(parseInput(''), null);
  assert.equal(parseInput('='), null);
});

test('读写单元格与显示文本', () => {
  const workbook = makeBook([['名称', '数量'], ['苹果', 3]]);
  assert.equal(workbook.getText('Sheet1', 0, 0), '名称');
  assert.equal(workbook.getText('Sheet1', 1, 1), '3');
  assert.equal(workbook.getRawInput('Sheet1', 1, 1), '3');
  workbook.setCell('Sheet1', 2, 1, '=B2*2');
  assert.equal(workbook.getText('Sheet1', 2, 1), '6');
  assert.equal(workbook.getRawInput('Sheet1', 2, 1), '=B2*2');
  workbook.setNumberFormat('Sheet1', [{ r: 1, c: 1 }], 'currency');
  assert.equal(workbook.getText('Sheet1', 1, 1), '¥3.00');
  workbook.setNumberFormat('Sheet1', [{ r: 1, c: 1 }], 'percent');
  assert.equal(workbook.getText('Sheet1', 1, 1), '300%');
  workbook.setCell('Sheet1', 1, 1, '');
  assert.equal(workbook.getText('Sheet1', 1, 1), '');
  assert.equal(workbook.getText('Sheet1', 2, 1), '0', '清空后公式按 0 计算');
});

test('样式与数字格式互不干扰', () => {
  const workbook = makeBook([['x']]);
  workbook.setStyle('Sheet1', [{ r: 0, c: 0 }], { b: true, color: '#ff0000' });
  assert.deepEqual(workbook.getCell('Sheet1', 0, 0).s, { b: true, color: '#ff0000' });
  workbook.setStyle('Sheet1', [{ r: 0, c: 0 }], { b: null });
  assert.deepEqual(workbook.getCell('Sheet1', 0, 0).s, { color: '#ff0000' });
  workbook.setStyle('Sheet1', [{ r: 0, c: 0 }], { color: null });
  assert.equal(workbook.getCell('Sheet1', 0, 0).s, undefined);
  assert.equal(workbook.getCell('Sheet1', 0, 0).v, 'x', '样式清除不应删除内容');

  workbook.setNumberFormat('Sheet1', [{ r: 5, c: 5 }], 'number');
  assert.equal(workbook.getCell('Sheet1', 5, 5).fmt, 'number');
  workbook.clearCells('Sheet1', [{ r: 5, c: 5 }], 'format');
  assert.equal(workbook.getCell('Sheet1', 5, 5), null, '只剩格式的空单元格应被清理');
});

test('插入 / 删除行列：数据与公式一起平移', () => {
  const workbook = makeBook([['标题'], [10], [20], ['=SUM(A2:A3)']]);
  assert.equal(workbook.getText('Sheet1', 3, 0), '30');

  workbook.insertRows('Sheet1', 1, 1);
  assert.equal(workbook.getText('Sheet1', 1, 0), '');
  assert.equal(workbook.getText('Sheet1', 2, 0), '10');
  assert.equal(workbook.getText('Sheet1', 3, 0), '20');
  assert.equal(workbook.getRawInput('Sheet1', 4, 0), '=SUM(A3:A4)');
  assert.equal(workbook.getText('Sheet1', 4, 0), '30', '插入行后公式结果保持不变');

  workbook.deleteRows('Sheet1', 1, 1);
  assert.equal(workbook.getText('Sheet1', 1, 0), '10');
  assert.equal(workbook.getText('Sheet1', 3, 0), '30');
});

test('插入 / 删除列：引用位置随之调整', () => {
  const workbook = makeBook([['A', 'B', '=A1&B1']]);
  assert.equal(workbook.getText('Sheet1', 0, 2), 'AB');
  workbook.insertCols('Sheet1', 1, 1);
  assert.equal(workbook.getText('Sheet1', 0, 0), 'A');
  assert.equal(workbook.getText('Sheet1', 0, 1), '', '新列是空的');
  assert.equal(workbook.getText('Sheet1', 0, 2), 'B');
  assert.equal(workbook.getRawInput('Sheet1', 0, 3), '=A1&C1', '原 B1 引用跟随右移');
  assert.equal(workbook.getText('Sheet1', 0, 3), 'AB');
  workbook.setCell('Sheet1', 0, 1, 'X');
  assert.equal(workbook.getText('Sheet1', 0, 3), 'AB', '新插入的列不影响原公式');
  workbook.deleteCols('Sheet1', 1, 1);
  assert.equal(workbook.getText('Sheet1', 0, 1), 'B');
  assert.equal(workbook.getText('Sheet1', 0, 2), 'AB');
  workbook.deleteCols('Sheet1', 0, 1);
  assert.equal(workbook.getText('Sheet1', 0, 0), 'B');
});

test('删除被引用的行：引用变成 #REF!', () => {
  const workbook = makeBook([[1], [2], ['=A1+A2']]);
  workbook.deleteRows('Sheet1', 0, 1);
  assert.equal(workbook.getRawInput('Sheet1', 1, 0), '=#REF!+A1');
  assert.equal(workbook.getText('Sheet1', 1, 0), '#REF!');
});

test('usedRange 与统计', () => {
  const workbook = makeBook([[1, 2], [3, null]]);
  const used = workbook.usedRange('Sheet1');
  assert.equal(used.to.r, 1);
  assert.equal(used.to.c, 1);
  assert.equal(used.empty, false);
  const stats = workbook.stats();
  assert.equal(stats.cells, 3);
  assert.equal(stats.sheets, 1);
  assert.ok(stats.preview.includes('1'));
});

test('CSV 生成与解析（含引号、逗号、换行）', () => {
  const workbook = makeBook([['a', 'b,c', 'd"e'], ['x\ny', 1, 2]]);
  const csv = rangeToCsv(workbook, 'Sheet1', { r: 0, c: 0 }, { r: 1, c: 2 });
  const rows = parseDelimited(csv);
  assert.equal(rows[0][1], 'b,c');
  assert.equal(rows[0][2], 'd"e');
  assert.equal(rows[1][0], 'x\ny');
  assert.equal(rows.length, 2);

  // 制表符分隔（粘贴用）
  const tsv = parseDelimited('a\tb\n1\t2', '\t');
  assert.deepEqual(tsv, [['a', 'b'], ['1', '2']]);
  // 自动识别制表符
  assert.deepEqual(parseDelimited('a\tb,c\n1\t2,3'), [['a', 'b,c'], ['1', '2,3']]);
});

test('排序：保留整行与样式', () => {
  const workbook = makeBook([
    ['名称', '分数'],
    ['b', 30],
    ['a', 50],
    ['c', 10],
  ]);
  workbook.setStyle('Sheet1', [{ r: 2, c: 0 }], { b: true });
  sortRange(workbook, 'Sheet1', { from: { r: 0, c: 0 }, to: { r: 3, c: 1 } }, 1, -1, true);
  assert.equal(workbook.getText('Sheet1', 1, 1), '50');
  assert.equal(workbook.getText('Sheet1', 2, 1), '30');
  assert.equal(workbook.getText('Sheet1', 3, 1), '10');
  assert.equal(workbook.getText('Sheet1', 1, 0), 'a');
  assert.equal(workbook.getCell('Sheet1', 1, 0).s.b, true, '样式跟随行移动');
});

test('区域复制（cloneBlock）', () => {
  const workbook = makeBook([[1, 2], [3, 4]]);
  const block = cloneBlock(workbook, 'Sheet1', { r: 0, c: 0 }, { r: 1, c: 1 });
  assert.deepEqual(block[1][1], { v: 4 });
  block[0][0].v = 99;
  assert.equal(workbook.getCell('Sheet1', 0, 0).v, 1, '克隆必须是深拷贝');
});

test('XLSX 导出并可回读', async () => {
  const workbook = makeBook([
    ['产品', '单价', '数量', '小计'],
    ['苹果', 5.5, 3, '=B2*C2'],
    ['香蕉', 3.2, 10, '=B3*C3'],
    ['合计', '', '', '=SUM(D2:D3)'],
  ]);
  workbook.setStyle('Sheet1', [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 }], { b: true, bg: '#dbeafe' });
  workbook.setNumberFormat('Sheet1', [{ r: 1, c: 1 }], 'currency');
  workbook.setCell('Sheet1', 1, 4, '2026-05-01');

  const bytes = workbookToXlsx(workbook);
  assert.ok(bytes.length > 3000, 'XLSX 应有实际内容');
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK', '应为 ZIP 容器');

  const parsed = await xlsxToWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const restored = new Workbook(parsed);
  assert.equal(restored.getText('Sheet1', 1, 3), '16.5', '公式结果被缓存写入');
  assert.equal(restored.getText('Sheet1', 3, 3), '48.5');
  assert.equal(restored.getText('Sheet1', 1, 1), '¥5.50', '数字格式被还原');
  assert.equal(restored.getText('Sheet1', 1, 4), '2026-05-01', '日期被还原');
  assert.equal(restored.getCell('Sheet1', 0, 0).s.b, true, '加粗被还原');
  assert.equal(restored.getCell('Sheet1', 0, 0).s.bg, '#dbeafe', '填充色被还原');
  assert.equal(restored.getRawInput('Sheet1', 1, 3), '=B2*C2', '公式被保留');
});

test('XLSX 多表与冻结 / 合并', async () => {
  const workbook = makeBook([['一个表']]);
  workbook.data.sheets.push(createSheet('第二页', 1));
  workbook.data.active = 1;
  workbook.setCell('第二页', 0, 0, '跨表');
  workbook.setCell('第二页', 1, 0, '=Sheet1!A1');
  workbook.data.sheets[1].merges = [[0, 0, 0, 2]];
  workbook.data.sheets[1].frozen = { rows: 1, cols: 0 };
  workbook.data.sheets[1].colWidths = { 0: 160 };
  workbook.data.active = 0;

  const bytes = workbookToXlsx(workbook);
  const restored = new Workbook(await xlsxToWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  assert.deepEqual(restored.sheetNames, ['Sheet1', '第二页']);
  assert.equal(restored.getText('第二页', 0, 0), '跨表');
  assert.equal(restored.getText('第二页', 1, 0), '一个表', '跨表引用在导入后依然可用');
  assert.deepEqual(restored.data.sheets[1].merges, [[0, 0, 0, 2]]);
  assert.deepEqual(restored.data.sheets[1].frozen, { rows: 1, cols: 0 });
  assert.ok(Math.abs(restored.data.sheets[1].colWidths['0'] - 160) < 4);
});

test('XLSX 导出覆盖全部工作表且行号正确', async () => {
  const workbook = new Workbook();
  for (let r = 0; r < 40; r += 1) workbook.setCell('Sheet1', r, 0, String(r * 2));
  const bytes = workbookToXlsx(workbook);
  const restored = new Workbook(await xlsxToWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  assert.equal(restored.getText('Sheet1', 39, 0), '78');
  assert.equal(MAX_ROWS, 5000);
  assert.equal(MAX_COLS, 200);
});

test('图表数据抽取', () => {
  const workbook = makeBook([
    ['月份', '收入', '支出'],
    ['1月', 100, 60],
    ['2月', 120, 70],
    ['3月', 90, 65],
  ]);
  const data = buildChartData(workbook, 'Sheet1', { from: { r: 0, c: 0 }, to: { r: 3, c: 2 } });
  assert.deepEqual(data.categories, ['1月', '2月', '3月']);
  assert.equal(data.series.length, 2);
  assert.equal(data.series[0].name, '收入');
  assert.deepEqual(data.series[0].values, [100, 120, 90]);
  assert.deepEqual(data.series[1].values, [60, 70, 65]);

  // 单列数字也能画
  const single = makeBook([[1], [2], [3]]);
  const singleData = buildChartData(single, 'Sheet1', { from: { r: 0, c: 0 }, to: { r: 2, c: 0 } });
  assert.deepEqual(singleData.series[0].values, [1, 2, 3]);
});

test('订阅通知与计算轮次', () => {
  const workbook = new Workbook();
  let events = 0;
  const off = workbook.subscribe(() => { events += 1; });
  workbook.setCell('Sheet1', 0, 0, '1');
  workbook.setCell('Sheet1', 1, 0, '=A1+1');
  assert.equal(events, 2);
  assert.equal(workbook.getText('Sheet1', 1, 0), '2');
  workbook.setCell('Sheet1', 0, 0, '5');
  assert.equal(workbook.getText('Sheet1', 1, 0), '6', '编辑后自动失效缓存');
  off();
  workbook.setCell('Sheet1', 2, 0, '9');
  assert.equal(events, 3, '取消订阅后不再收到通知');
});

test('错误值在单元格里以错误码展示', () => {
  const workbook = makeBook([[1, 0]]);
  workbook.setCell('Sheet1', 0, 2, '=A1/B1');
  assert.equal(workbook.getText('Sheet1', 0, 2), ERR.DIV0);
  workbook.setCell('Sheet1', 0, 3, '=C1+1');
  assert.equal(workbook.getText('Sheet1', 0, 3), ERR.DIV0, '错误值会向上传播');
});

test('示例文件可直接导入（examples/ 是真实产物）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join, dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { parseDoc } = await import('../src/core/format.js');

  const budgetPath = join(root, 'examples/budget.trio');
  assert.ok(existsSync(budgetPath), 'examples/budget.trio 应存在（运行 node scripts/make-examples.mjs 生成）');
  const parsed = parseDoc(readFileSync(budgetPath, 'utf8'));
  assert.equal(parsed.type, 'sheet');
  const workbook = new Workbook(parsed.data);
  assert.equal(workbook.getText('Sheet1', 8, 2), '11448', '预算合计公式应当可复算');
  assert.equal(workbook.getText('Sheet1', 8, 4), '-698', '差额合计公式应当可复算');

  const deckPath = join(root, 'examples/project-report.trio');
  if (existsSync(deckPath)) {
    const deck = parseDoc(readFileSync(deckPath, 'utf8'));
    assert.equal(deck.type, 'deck');
    assert.ok(deck.data.slides.length >= 5);
  }
});
