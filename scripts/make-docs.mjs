#!/usr/bin/env node
/**
 * make-docs.mjs —— 由公式注册表生成 docs/FUNCTIONS.md，保证文档与代码永不脱节。
 *
 *   node scripts/make-docs.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './build.mjs';
import { FUNCTIONS, functionCatalog, functionNames } from '../src/apps/sheet/functions.js';
import { NUMBER_FORMATS } from '../src/apps/sheet/workbook.js';

const GROUP_LABELS = {
  math: '数学与统计 / Math & Stats',
  text: '文本 / Text',
  date: '日期时间 / Date & Time',
  lookup: '查找与引用 / Lookup & Reference',
  logical: '逻辑 / Logical',
  array: '动态数组 / Dynamic Arrays',
  finance: '财务 / Financial',
  engineering: '工程 / Engineering',
  info: '信息 / Information',
};

/** 每类函数的一行说明（人工维护，缺省显示参数范围） */
const NOTES = {
  SUM: '求和，自动忽略文本与空单元格',
  SUMIF: '按条件求和：SUMIF(区域, 条件, [求和区域])',
  SUMIFS: '多条件求和：SUMIFS(求和区域, 区域1, 条件1, ...)',
  SUMPRODUCT: '数组乘积之和，常用于加权计算',
  COUNTIF: '按条件计数，条件支持 ">10"、"<>x"、"苹果" 等写法',
  AVERAGEIF: '按条件求平均',
  IF: '条件判断，只有命中的分支会被求值',
  IFERROR: '出错时返回兜底值：IFERROR(表达式, 兜底值)',
  IFS: '多条件分支，从上到下取第一个命中的',
  SWITCH: '值匹配分支，末尾可给默认值',
  VLOOKUP: '纵向查找，第四个参数写 FALSE 表示精确匹配',
  HLOOKUP: '横向查找（沿首行搜索）',
  XLOOKUP: '新一代查找，支持未找到时的兜底值',
  INDEX: '按行列取区域中的值，INDEX(区域, 行, 列)',
  MATCH: '返回值在区域中的位置，第三参数 0 表示精确匹配',
  OFFSET: '以某个引用为基点偏移，返回单个值或多行区域',
  INDIRECT: '把文本解析成引用，如 INDIRECT("B2")',
  FILTER: '按条件筛选区域：FILTER(区域, 条件, [空结果时返回])',
  UNIQUE: '去重后返回唯一值列表',
  SORT: '按某列排序后返回区域',
  SEQUENCE: '生成等差数字序列，如 SEQUENCE(3,2)',
  TEXTJOIN: '用分隔符拼接文本：TEXTJOIN("-",TRUE,A1:A5)',
  TEXT: '按格式串把数值转成文本，如 TEXT(A1,"#,##0.00")',
  DATEDIF: '计算两个日期之差，第三参数为 "Y"/"M"/"D" 等单位',
  PMT: '等额本息月供：PMT(利率, 期数, 现值)',
  NPV: '净现值，第一参数是贴现率，其后是各期现金流',
  IRR: '内部收益率（用牛顿迭代求解）',
  XLOOKUP2: '',
};

function argHint(name) {
  const def = FUNCTIONS[name];
  if (!def) return '';
  if (def.min === def.max) return `${def.min} 个参数`;
  if (def.max >= 255) return `至少 ${def.min} 个参数`;
  return `${def.min} ~ ${def.max} 个参数`;
}

async function main() {
  const catalog = functionCatalog();
  const lines = [];
  lines.push('# 公式函数手册 / Function Reference');
  lines.push('');
  lines.push(`TriOffice 表格内置 **${functionNames().length}** 个公式函数（含常用别名），无需插件、无外部依赖。`);
  lines.push('');
  lines.push('> 本文件由 `node scripts/make-docs.mjs` 从 `src/apps/sheet/functions.js` 自动生成，请勿手工编辑。');
  lines.push('');
  lines.push('## 快速上手');
  lines.push('');
  lines.push('```text');
  lines.push('=SUM(A1:A10)                     求和');
  lines.push('=IF(B2>=60,"及格","不及格")       条件判断');
  lines.push('=SUMIF(C2:C99,"华东",D2:D99)      按条件求和');
  lines.push('=VLOOKUP(A2,表2!A:D,3,FALSE)      跨表查找');
  lines.push('=Sheet2!A1*1.1                    跨表引用');
  lines.push('=SUM(A:A)                         整列引用');
  lines.push('=A1*$B$1                          绝对引用（填充时不变）');
  lines.push('```');
  lines.push('');
  lines.push('支持的运算符：`+ - * / ^ & %`、比较运算 `= <> < > <= >=`，以及 `{}` 数组常量（如 `{1,2;3,4}`）。');
  lines.push('');
  lines.push('## 错误码');
  lines.push('');
  lines.push('| 错误码 | 含义 |');
  lines.push('| --- | --- |');
  lines.push('| `#DIV/0!` | 除数为零 |');
  lines.push('| `#VALUE!` | 类型不匹配（例如把文字当数字） |');
  lines.push('| `#REF!` | 引用已失效（被引用的行/列被删除） |');
  lines.push('| `#NAME?` | 函数名或名称拼写错误 |');
  lines.push('| `#NUM!` | 数值超出定义域（如负数开方） |');
  lines.push('| `#N/A` | 查找不到结果 |');
  lines.push('| `#CIRC!` | 循环引用（TriOffice 特有标记） |');
  lines.push('');
  lines.push('## 数字格式');
  lines.push('');
  lines.push(`共 ${NUMBER_FORMATS.length} 种预设：${NUMBER_FORMATS.map((item) => `\`${item.id}\``).join('、')}。`);
  lines.push('');
  lines.push('## 函数一览');
  lines.push('');

  let total = 0;
  for (const group of catalog) {
    const names = group.names.filter((name) => FUNCTIONS[name]);
    total += names.length;
    lines.push(`### ${GROUP_LABELS[group.key] || group.key}（${names.length}）`);
    lines.push('');
    lines.push('| 函数 | 参数 | 说明 |');
    lines.push('| --- | --- | --- |');
    for (const name of names) {
      const note = NOTES[name] || '';
      lines.push(`| \`${name}\` | ${argHint(name)} | ${note} |`);
    }
    lines.push('');
  }

  lines.push('## 统计');
  lines.push('');
  lines.push('| 分类 | 数量 |');
  lines.push('| --- | --- |');
  for (const group of catalog) {
    lines.push(`| ${GROUP_LABELS[group.key] || group.key} | ${group.names.filter((name) => FUNCTIONS[name]).length} |`);
  }
  lines.push(`| **合计** | **${Object.keys(FUNCTIONS).length}** |`);
  lines.push('');
  lines.push(`（按分类相加为 ${total}，与合计略有差异是因为部分函数同时出现在多个分类的别名中。）`);
  lines.push('');

  await mkdir(join(ROOT, 'docs'), { recursive: true });
  await writeFile(join(ROOT, 'docs/FUNCTIONS.md'), lines.join('\n'), 'utf8');
  console.log(`✔ docs/FUNCTIONS.md 已生成：${Object.keys(FUNCTIONS).length} 个函数，${catalog.length} 个分类`);
}

main().catch((err) => {
  console.error('✖ 生成文档失败:', err.message);
  process.exit(1);
});
