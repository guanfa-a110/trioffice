import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize, parse, evaluateFormula, collectRefs, translateFormula, serializeAst, FormulaSyntaxError,
} from '../src/apps/sheet/formula.js';
import { RangeValue, ERR } from '../src/apps/sheet/value.js';
import { colToLabel, labelToCol, parseA1, formatA1, parseRefText, eachInRange } from '../src/apps/sheet/address.js';
import { FUNCTIONS, functionNames } from '../src/apps/sheet/functions.js';
import { Workbook } from '../src/apps/sheet/workbook.js';

/** 用 Workbook 作为求值上下文，避免手写桩 */
function book(rows) {
  const workbook = new Workbook();
  rows.forEach((row, r) => row.forEach((value, c) => {
    if (value === null || value === undefined) return;
    workbook.setCell('Sheet1', r, c, String(value));
  }));
  return workbook;
}

function evalIn(workbook, formula, sheet = 'Sheet1', r = 0, c = 0) {
  return evaluateFormula(formula, workbook.contextFor(sheet, r, c));
}

const plain = (value) => (value && value.isError ? value.code : (value && value.isRange ? value.flat() : value));

test('地址工具：列名互转', () => {
  assert.equal(colToLabel(0), 'A');
  assert.equal(colToLabel(25), 'Z');
  assert.equal(colToLabel(26), 'AA');
  assert.equal(colToLabel(701), 'ZZ');
  assert.equal(colToLabel(702), 'AAA');
  assert.equal(labelToCol('A'), 0);
  assert.equal(labelToCol('AA'), 26);
  assert.equal(labelToCol('AAA'), 702);
  assert.equal(labelToCol('1A'), -1);
  for (let index = 0; index < 900; index += 1) {
    assert.equal(labelToCol(colToLabel(index)), index);
  }
});

test('地址工具：A1 解析与格式化', () => {
  assert.deepEqual(parseA1('B3'), { r: 2, c: 1, absR: false, absC: false });
  assert.deepEqual(parseA1('$B$3'), { r: 2, c: 1, absR: true, absC: true });
  assert.equal(parseA1('3B'), null);
  assert.equal(formatA1({ r: 2, c: 1 }), 'B3');
  assert.equal(formatA1({ r: 0, c: 0, absR: true, absC: true }), '$A$1');
  const parsed = parseRefText("'我的 表'!A1:B2");
  assert.equal(parsed.sheet, '我的 表');
  assert.equal(parsed.from.r, 0);
  assert.equal(parsed.to.c, 1);
  assert.equal(eachInRange({ r: 0, c: 0 }, { r: 1, c: 1 }).length, 4);
});

test('词法分析：识别字面量、引用、函数与运算符', () => {
  const tokens = tokenize('SUM(A1:B2, "x""y", 1.5e2, TRUE, #N/A)&50%');
  const types = tokens.map((token) => token.type);
  assert.deepEqual(types.slice(0, 6), ['name', 'lparen', 'ref', 'colon', 'ref', 'comma']);
  assert.ok(types.includes('str'));
  assert.ok(types.includes('num'));
  assert.ok(types.includes('err'));
  assert.ok(types.includes('percent'));
  assert.equal(tokens.find((token) => token.type === 'str').value, 'x"y');
  assert.equal(tokens.find((token) => token.type === 'num').value, 150);
});

test('语法分析：优先级与结合性', () => {
  const workbook = book([[2, 3, 4]]);
  assert.equal(evalIn(workbook, '1+2*3'), 7);
  assert.equal(evalIn(workbook, '(1+2)*3'), 9);
  assert.equal(evalIn(workbook, '2^3^2'), 512, '幂运算右结合');
  assert.equal(evalIn(workbook, '-2^2'), 4, '一元负号优先级高于幂');
  assert.equal(evalIn(workbook, '10/4'), 2.5);
  assert.equal(evalIn(workbook, '50%%'), 0.005);
  assert.equal(evalIn(workbook, '"a"&"b"&1'), 'ab1');
  assert.equal(evalIn(workbook, '1<2'), true);
  assert.equal(evalIn(workbook, '1<>1'), false);
  assert.equal(evalIn(workbook, '"b">"a"'), true);
  assert.equal(evalIn(workbook, 'TRUE>1'), true, '逻辑值大于数字');
  assert.equal(evalIn(workbook, 'A1+B1+C1'), 9);
  assert.equal(evalIn(workbook, 'A2+B2'), 0, '空单元格按 0 处理');
  assert.throws(() => parse('1+'), FormulaSyntaxError);
  assert.throws(() => parse('SUM(1,2'), FormulaSyntaxError);
  assert.throws(() => parse('"未闭合'), FormulaSyntaxError);
});

test('四则与错误传播', () => {
  const workbook = book([[1, 0, 'x']]);
  assert.equal(plain(evalIn(workbook, 'A1/0')), ERR.DIV0);
  assert.equal(plain(evalIn(workbook, 'A1+C1')), ERR.VALUE);
  assert.equal(plain(evalIn(workbook, 'NOPE(1)')), ERR.NAME);
  assert.equal(plain(evalIn(workbook, 'SUM(1,2,3,4)')), 10);
  assert.equal(plain(evalIn(workbook, 'SUM(A1:A1,B1:B1)')), 1);
  assert.equal(plain(evalIn(workbook, 'SUM(1,SUM(2,3))')), 6);
  assert.equal(plain(evalIn(workbook, 'SUM()')), ERR.VALUE, 'SUM() 参数个数不足');
  assert.equal(plain(evalIn(workbook, 'NOARG()')), ERR.NAME);
});

test('聚合与统计函数', () => {
  const workbook = book([[10, '苹果'], [20, '香蕉'], [30, '苹果']]);
  assert.equal(plain(evalIn(workbook, 'SUM(A1:A3)')), 60);
  assert.equal(plain(evalIn(workbook, 'AVERAGE(A1:A3)')), 20);
  assert.equal(plain(evalIn(workbook, 'COUNT(A1:A3)')), 3);
  assert.equal(plain(evalIn(workbook, 'COUNTA(B1:B3)')), 3);
  assert.equal(plain(evalIn(workbook, 'MAX(A1:A3)')), 30);
  assert.equal(plain(evalIn(workbook, 'MIN(A1:A3)')), 10);
  assert.equal(plain(evalIn(workbook, 'MEDIAN(A1:A3)')), 20);
  assert.equal(plain(evalIn(workbook, 'LARGE(A1:A3,2)')), 20);
  assert.equal(plain(evalIn(workbook, 'SMALL(A1:A3,1)')), 10);
  assert.equal(plain(evalIn(workbook, 'RANK(30,A1:A3)')), 1);
  assert.equal(plain(evalIn(workbook, 'COUNTIF(B1:B3,"苹果")')), 2);
  assert.equal(plain(evalIn(workbook, 'COUNTIF(A1:A3,">15")')), 2);
  assert.equal(plain(evalIn(workbook, 'COUNTIF(B1:B3,"<>苹果")')), 1);
  assert.equal(plain(evalIn(workbook, 'SUMIF(B1:B3,"苹果",A1:A3)')), 40);
  assert.equal(plain(evalIn(workbook, 'AVERAGEIF(B1:B3,"苹果",A1:A3)')), 20);
  assert.equal(plain(evalIn(workbook, 'SUMPRODUCT(A1:A3,A1:A3)')), 1400);
  assert.equal(plain(evalIn(workbook, 'SUM(A:A)')), 60, '整列引用');
  assert.equal(plain(evalIn(workbook, 'COUNTBLANK(C1:C3)')), 3);
  assert.equal(plain(evalIn(workbook, 'PRODUCT(2,3,4)')), 24);
  assert.equal(plain(evalIn(workbook, 'COUNTUNIQUE(B1:B3)')), 2);
});

test('数学与舍入', () => {
  const workbook = book([[1]]);
  assert.equal(plain(evalIn(workbook, 'ROUND(2.345,2)')), 2.35);
  assert.equal(plain(evalIn(workbook, 'ROUND(-2.345,2)')), -2.35);
  assert.equal(plain(evalIn(workbook, 'ROUNDUP(2.341,2)')), 2.35);
  assert.equal(plain(evalIn(workbook, 'ROUNDDOWN(2.349,2)')), 2.34);
  assert.equal(plain(evalIn(workbook, 'MOD(-7,3)')), 2);
  assert.equal(plain(evalIn(workbook, 'INT(-2.5)')), -3);
  assert.equal(plain(evalIn(workbook, 'TRUNC(-2.5)')), -2);
  assert.equal(plain(evalIn(workbook, 'ABS(-3)')), 3);
  assert.equal(plain(evalIn(workbook, 'SIGN(-9)')), -1);
  assert.equal(plain(evalIn(workbook, 'POWER(2,10)')), 1024);
  assert.equal(plain(evalIn(workbook, 'SQRT(144)')), 12);
  assert.equal(plain(evalIn(workbook, 'CEILING(4.1,2)')), 6);
  assert.equal(plain(evalIn(workbook, 'FLOOR(4.9,2)')), 4);
  assert.equal(plain(evalIn(workbook, 'GCD(12,18)')), 6);
  assert.equal(plain(evalIn(workbook, 'LCM(4,6)')), 12);
  assert.equal(plain(evalIn(workbook, 'FACT(5)')), 120);
  assert.equal(plain(evalIn(workbook, 'COMBIN(5,2)')), 10);
  assert.equal(plain(evalIn(workbook, 'QUOTIENT(7,2)')), 3);
  assert.equal(plain(evalIn(workbook, 'ROUND(PI(),4)')), 3.1416);
  assert.equal(plain(evalIn(workbook, 'ROUND(DEGREES(PI()/2),6)')), 90);
  assert.equal(plain(evalIn(workbook, 'SUMSQ(3,4)')), 25);
});

test('文本函数', () => {
  const workbook = book([['hello world']]);
  assert.equal(plain(evalIn(workbook, 'LEFT("hello",3)')), 'hel');
  assert.equal(plain(evalIn(workbook, 'RIGHT("hello",2)')), 'lo');
  assert.equal(plain(evalIn(workbook, 'MID("hello",2,3)')), 'ell');
  assert.equal(plain(evalIn(workbook, 'LEN("中文abc")')), 5);
  assert.equal(plain(evalIn(workbook, 'UPPER("abc")')), 'ABC');
  assert.equal(plain(evalIn(workbook, 'LOWER("ABC")')), 'abc');
  assert.equal(plain(evalIn(workbook, 'TRIM("  a   b  ")')), 'a b');
  assert.equal(plain(evalIn(workbook, 'SUBSTITUTE("a-b-c","-","+")')), 'a+b+c');
  assert.equal(plain(evalIn(workbook, 'SUBSTITUTE("a-b-c","-","+",2)')), 'a-b+c');
  assert.equal(plain(evalIn(workbook, 'REPLACE("abcdef",2,3,"XY")')), 'aXYef');
  assert.equal(plain(evalIn(workbook, 'FIND("l","hello")')), 3);
  assert.equal(plain(evalIn(workbook, 'SEARCH("L","hello")')), 3);
  assert.equal(plain(evalIn(workbook, 'REPT("ab",3)')), 'ababab');
  assert.equal(plain(evalIn(workbook, 'CONCAT("a",1,TRUE)')), 'a1TRUE');
  assert.equal(plain(evalIn(workbook, 'TEXTJOIN("-",TRUE,"a","","b")')), 'a-b');
  assert.equal(plain(evalIn(workbook, 'CHAR(65)')), 'A');
  assert.equal(plain(evalIn(workbook, 'CODE("A")')), 65);
  assert.equal(plain(evalIn(workbook, 'EXACT("a","A")')), false);
  assert.equal(plain(evalIn(workbook, 'TEXT(1234.5,"#,##0.00")')), '1,234.50');
  assert.equal(plain(evalIn(workbook, 'TEXT(0.256,"0.0%")')), '25.6%');
  assert.equal(plain(evalIn(workbook, 'VALUE("12.5")')), 12.5);
});

test('逻辑函数（惰性求值）', () => {
  const workbook = book([[5]]);
  assert.equal(plain(evalIn(workbook, 'IF(A1>3,"大","小")')), '大');
  assert.equal(plain(evalIn(workbook, 'IF(A1>3,1/0,"安全")')), ERR.DIV0);
  assert.equal(plain(evalIn(workbook, 'IF(A1<3,1/0,"安全")')), '安全', '未选中的分支不应求值');
  assert.equal(plain(evalIn(workbook, 'IFERROR(1/0,"兜底")')), '兜底');
  assert.equal(plain(evalIn(workbook, 'IFERROR(2/1,"兜底")')), 2);
  assert.equal(plain(evalIn(workbook, 'IFNA(NA(),"空")')), '空');
  assert.equal(plain(evalIn(workbook, 'IFNA(1/0,"空")')), ERR.DIV0);
  assert.equal(plain(evalIn(workbook, 'AND(TRUE,1=1)')), true);
  assert.equal(plain(evalIn(workbook, 'OR(FALSE,A1=5)')), true);
  assert.equal(plain(evalIn(workbook, 'NOT(FALSE)')), true);
  assert.equal(plain(evalIn(workbook, 'XOR(TRUE,TRUE)')), false);
  assert.equal(plain(evalIn(workbook, 'IFS(FALSE,1,TRUE,2)')), 2);
  assert.equal(plain(evalIn(workbook, 'SWITCH(2,1,"一",2,"二","其它")')), '二');
  assert.equal(plain(evalIn(workbook, 'CHOOSE(2,"a","b","c")')), 'b');
  assert.equal(plain(evalIn(workbook, '--TRUE')), 1);
});

test('查找引用函数', () => {
  const workbook = book([
    ['张三', 90, 'A'],
    ['李四', 75, 'B'],
    ['王五', 60, 'C'],
  ]);
  assert.equal(plain(evalIn(workbook, 'VLOOKUP("李四",A1:C3,2,FALSE)')), 75);
  assert.equal(plain(evalIn(workbook, 'VLOOKUP("赵六",A1:C3,2,FALSE)')), ERR.NA);
  assert.equal(plain(evalIn(workbook, 'HLOOKUP("张三",A1:C3,2,FALSE)')), '李四', 'HLOOKUP 沿首行查找');
  const wide = book([['张三', '李四', '王五'], [90, 75, 60]]);
  assert.equal(plain(evalIn(wide, 'HLOOKUP("李四",A1:C2,2,FALSE)')), 75);
  assert.equal(plain(evalIn(wide, 'INDEX(A1:C2,2,MATCH("王五",A1:C1,0))')), 60);
  assert.equal(plain(evalIn(workbook, 'INDEX(B1:B3,2)')), 75);
  assert.equal(plain(evalIn(workbook, 'MATCH("王五",A1:A3,0)')), 3);
  assert.equal(plain(evalIn(workbook, 'XLOOKUP("王五",A1:A3,B1:B3)')), 60);
  assert.equal(plain(evalIn(workbook, 'XLOOKUP("无",A1:A3,B1:B3,"缺省")')), '缺省');
  assert.equal(plain(evalIn(workbook, 'ROWS(A1:C3)')), 3);
  assert.equal(plain(evalIn(workbook, 'COLUMNS(A1:C3)')), 3);
  assert.equal(plain(evalIn(workbook, 'ROW(B5)')), 5);
  assert.equal(plain(evalIn(workbook, 'COLUMN(C1)')), 3);
  assert.equal(plain(evalIn(workbook, 'ADDRESS(2,3)')), '$C$2');
  assert.equal(plain(evalIn(workbook, 'OFFSET(A1,1,1)')), 75);
  assert.equal(plain(evalIn(workbook, 'SUM(OFFSET(A1,0,1,3,1))')), 225, 'OFFSET 返回多行区域');
  assert.equal(plain(evalIn(workbook, 'INDIRECT("B2")')), 75);
  assert.equal(plain(evalIn(workbook, 'TRANSPOSE(A1:B1)')).length, 2);
  assert.equal(plain(evalIn(workbook, 'SUM(INDEX(A1:C3,0,2))')), 225);
});

test('动态数组', () => {
  const workbook = book([['a'], ['b'], ['a'], ['c']]);
  assert.deepEqual(plain(evalIn(workbook, 'UNIQUE(A1:A4)')), ['a', 'b', 'c']);
  assert.deepEqual(plain(evalIn(workbook, 'SORT(A1:A4)')), ['a', 'a', 'b', 'c']);
  assert.deepEqual(plain(evalIn(workbook, 'SEQUENCE(2,3,1,1)')), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(plain(evalIn(workbook, 'FILTER(A1:A4,A1:A4<>"a")')), ['b', 'c']);
});

test('日期与时间函数', () => {
  const workbook = book([['2026-10-10', '2026-01-01']]);
  assert.equal(plain(evalIn(workbook, 'YEAR(A1)')), 2026);
  assert.equal(plain(evalIn(workbook, 'MONTH(A1)')), 10);
  assert.equal(plain(evalIn(workbook, 'DAY(A1)')), 10);
  assert.equal(plain(evalIn(workbook, 'TEXT(DATE(2026,10,10),"yyyy-mm-dd")')), '2026-10-10');
  assert.equal(plain(evalIn(workbook, 'DAYS(A1,B1)')), 282);
  assert.equal(plain(evalIn(workbook, 'DATEDIF(B1,A1,"D")')), 282);
  assert.equal(plain(evalIn(workbook, 'DATEDIF(B1,A1,"M")')), 9);
  assert.equal(plain(evalIn(workbook, 'EOMONTH(DATE(2026,2,10),0)')), plain(evalIn(workbook, 'DATE(2026,2,28)')));
  assert.equal(plain(evalIn(workbook, 'WEEKDAY(DATE(2026,10,10))')), 7, '2026-10-10 是周六');
  assert.equal(plain(evalIn(workbook, 'NETWORKDAYS(DATE(2026,10,5),DATE(2026,10,9))')), 5);
  assert.ok(plain(evalIn(workbook, 'TODAY()')) > 46000);
  assert.ok(plain(evalIn(workbook, 'NOW()')) > 46000);
});

test('财务函数', () => {
  const workbook = book([[-1000], [300], [420], [680]]);
  assert.ok(Math.abs(plain(evalIn(workbook, 'PMT(0.05/12,360,-1000000)')) - 5368.2162) < 0.01);
  assert.ok(Math.abs(plain(evalIn(workbook, 'FV(0.05,10,-1000)')) - 12577.89) < 0.5);
  assert.ok(Math.abs(plain(evalIn(workbook, 'PV(0.05,10,-1000)')) - 7721.73) < 0.5);
  assert.ok(Math.abs(plain(evalIn(workbook, 'NPV(0.1,300,420,680)')) - 1130.73) < 0.5);
  const irr = plain(evalIn(workbook, 'IRR(A1:A4)'));
  assert.ok(irr > 0.15 && irr < 0.18, `IRR 应落在 15%~18%，实际 ${irr}`);
  assert.ok(Math.abs(plain(evalIn(workbook, 'NPV(IRR(A1:A4),300,420,680)')) - 1000) < 0.5, 'IRR 应使净现值为 0');
  assert.equal(plain(evalIn(workbook, 'SLN(10000,1000,5)')), 1800);
});

test('信息函数', () => {
  const workbook = new Workbook();
  workbook.setCell('Sheet1', 0, 0, '1');
  workbook.setCell('Sheet1', 0, 1, 'x');
  workbook.setCell('Sheet1', 0, 2, '');
  workbook.setCell('Sheet1', 0, 3, '=1/0');
  workbook.beginPass();
  assert.equal(plain(evalIn(workbook, 'ISNUMBER(A1)')), true);
  assert.equal(plain(evalIn(workbook, 'ISTEXT(B1)')), true);
  assert.equal(plain(evalIn(workbook, 'ISBLANK(C1)')), true);
  assert.equal(plain(evalIn(workbook, 'ISERROR(D1)')), true);
  assert.equal(plain(evalIn(workbook, 'ISNA(D1)')), false);
  assert.equal(plain(evalIn(workbook, 'ISEVEN(4)')), true);
  assert.equal(plain(evalIn(workbook, 'ISODD(3)')), true);
  assert.equal(plain(evalIn(workbook, 'TYPE("a")')), 2);
  assert.equal(plain(evalIn(workbook, 'SHEET()')), 1);
  assert.equal(plain(evalIn(workbook, 'SHEETS()')), 1);
});

test('进制与位运算', () => {
  const workbook = book([[1]]);
  assert.equal(plain(evalIn(workbook, 'DEC2BIN(10)')), '1010');
  assert.equal(plain(evalIn(workbook, 'DEC2HEX(255)')), 'FF');
  assert.equal(plain(evalIn(workbook, 'BIN2DEC("1010")')), 10);
  assert.equal(plain(evalIn(workbook, 'HEX2DEC("FF")')), 255);
  assert.equal(plain(evalIn(workbook, 'BITAND(12,10)')), 8);
  assert.equal(plain(evalIn(workbook, 'BITOR(12,10)')), 14);
});

test('引用解析与公式平移', () => {
  const refs = collectRefs('=SUM(A1:B2)+Sheet2!C3', 'Sheet1');
  assert.equal(refs.length, 2);
  assert.equal(refs[0].from.r, 0);
  assert.equal(refs[1].sheet, 'Sheet2');

  assert.equal(translateFormula('=B1+$A$1', { rows: 1, cols: 0 }), '=B2+$A$1');
  assert.equal(translateFormula('=SUM(A1:A3)', { rows: 2, cols: 1 }), '=SUM(B3:B5)');
  assert.equal(translateFormula('=IF(A1>0,"是","否")', { rows: 0, cols: 1 }), '=IF(B1>0,"是","否")');
  assert.equal(serializeAst(parse('SUM(A1,MAX(B1:B3),"x")')), 'SUM(A1,MAX(B1:B3),"x")');
});

test('区域值：跨表与整列', () => {
  const workbook = new Workbook();
  workbook.setCell('Sheet1', 0, 0, '1');
  workbook.setCell('Sheet1', 1, 0, '2');
  workbook.data.sheets.push({
    id: 's2',
    name: '数据',
    cells: { A1: { v: 100 }, A2: { v: 200 } },
    colWidths: {},
    rowHeights: {},
    merges: [],
    frozen: { rows: 0, cols: 0 },
    charts: [],
    view: { row: 0, col: 0 },
  });
  workbook.beginPass();
  assert.equal(plain(evalIn(workbook, 'SUM(数据!A1:A2)')), 300);
  assert.equal(plain(evalIn(workbook, '数据!A1*2')), 200);
  assert.equal(plain(evalIn(workbook, 'SUM(不存在的表!A1)')), ERR.REF);
  const range = evalIn(workbook, 'A1:A2');
  assert.ok(range instanceof RangeValue);
  assert.equal(range.rows, 2);
  assert.deepEqual(range.flat(), [1, 2]);
});

test('函数注册表完整性', () => {
  const names = functionNames();
  assert.ok(names.length >= 150, `函数数量应不少于 150，当前 ${names.length}`);
  for (const name of names) {
    const def = FUNCTIONS[name];
    assert.equal(typeof def.fn, 'function', `${name} 缺少实现`);
    assert.equal(typeof def.min, 'number');
    assert.equal(typeof def.max, 'number');
    assert.ok(def.max >= def.min, `${name} 的 min/max 不合法`);
  }
});

test('循环引用返回 #CIRC!', () => {
  const workbook = new Workbook();
  workbook.setCell('Sheet1', 0, 0, '=A2');
  workbook.setCell('Sheet1', 1, 0, '=A1');
  assert.equal(plain(workbook.getValue('Sheet1', 0, 0)), ERR.CIRC);
  const self = new Workbook();
  self.setCell('Sheet1', 0, 0, '=A1+1');
  assert.equal(plain(self.getValue('Sheet1', 0, 0)), ERR.CIRC);
});
