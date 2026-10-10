/**
 * templates.js —— 内置模板（新建时可选，全部本地生成、零网络请求）。
 */
import { markdownToHtml } from '../apps/writer/markdown.js';
import { createWriterData } from '../apps/writer/index.js';
import { createDeckData, deckFromMarkdown } from '../apps/deck/index.js';
import { createWorkbook, createSheet } from '../apps/sheet/workbook.js';
import { colToLabel } from '../apps/sheet/address.js';

const doc = (markdown, extra = {}) => ({ ...createWriterData(), html: markdownToHtml(markdown), ...extra });

/** 由若干行数据构建表格 */
function sheetFrom(rows, options = {}) {
  const workbook = createWorkbook();
  const raw = workbook.sheets[0];
  const entries = [];
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === null || value === undefined || value === '') return;
      entries.push({ r, c, input: String(value) });
    });
  });
  // 直接写入 cells，避免触发多次计算
  for (const entry of entries) {
    const label = `${colToLabel(entry.c)}${entry.r + 1}`;
    raw.cells[label] = entry.input.startsWith('=') ? { f: entry.input } : parseLiteral(entry.input);
  }
  if (options.widths) raw.colWidths = options.widths;
  if (options.headerRow) {
    for (let c = 0; c < (rows[0]?.length || 0); c += 1) {
      const label = `${colToLabel(c)}1`;
      raw.cells[label] = { ...(raw.cells[label] || {}), s: { b: true, bg: '#eef2ff', align: 'center' } };
    }
  }
  if (options.sheets) {
    for (const extra of options.sheets) {
      const created = createSheet(extra.name, workbook.sheets.length);
      for (const [label, value] of Object.entries(extra.cells || {})) {
        created.cells[label] = String(value).startsWith('=') ? { f: String(value) } : parseLiteral(String(value));
      }
      workbook.sheets.push(created);
    }
  }
  return workbook;
}

function parseLiteral(text) {
  if (/^-?\d+(\.\d+)?$/.test(text)) return { v: Number(text) };
  if (/^-?\d+(\.\d+)?%$/.test(text)) return { v: Number(text.replace('%', '')) / 100, fmt: 'percent' };
  if (text === 'TRUE') return { v: true };
  if (text === 'FALSE') return { v: false };
  return { v: text };
}

export const TEMPLATES = [
  {
    id: 'meeting',
    type: 'doc',
    icon: 'note',
    name: '会议纪要',
    hint: '议题 / 结论 / 待办，三段式',
    build: () => doc(`# 会议纪要

**会议主题：**  
**时间：** ${new Date().toLocaleDateString('zh-CN')}  
**参会人：**  
**记录人：**

## 一、议题

1. 
2. 

## 二、讨论要点

- 
- 

## 三、结论与决策

| 事项 | 结论 | 负责人 | 截止日期 |
| --- | --- | --- | --- |
|  |  |  |  |

## 四、待办事项

- [ ] 
- [ ] 

> 下次会议安排：
`),
  },
  {
    id: 'weekly',
    type: 'doc',
    icon: 'file-text',
    name: '周报 / 项目进展',
    hint: '本周进展、风险与下周计划',
    build: () => doc(`# 项目周报

**汇报周期：**  
**汇报人：**

## 本周进展

1. 
2. 

## 关键指标

| 指标 | 目标 | 实际 | 完成率 |
| --- | --- | --- | --- |
|  |  |  |  |

## 风险与阻塞

- **风险：**  影响：  应对：

## 下周计划

- [ ] 
- [ ] 

## 需要的支持

- 
`),
  },
  {
    id: 'budget',
    type: 'sheet',
    icon: 'sheet',
    name: '预算表',
    hint: '带公式与合计的月度预算',
    build: () => sheetFrom([
      ['类别', '项目', '预算', '实际', '差额'],
      ['固定支出', '房租', 4500, 4500, '=C2-D2'],
      ['固定支出', '水电燃气', 320, 358, '=C3-D3'],
      ['固定支出', '通讯', 128, 128, '=C4-D4'],
      ['生活支出', '餐饮', 2400, 2760, '=C5-D5'],
      ['生活支出', '交通', 600, 520, '=C6-D6'],
      ['生活支出', '购物', 1500, 1880, '=C7-D7'],
      ['储蓄投资', '基金定投', 2000, 2000, '=C8-D8'],
      ['合计', '', '=SUM(C2:C8)', '=SUM(D2:D8)', '=C9-D9'],
    ], {
      headerRow: true,
      widths: { 0: 110, 1: 130, 2: 96, 3: 96, 4: 96 },
    }),
  },
  {
    id: 'tracker',
    type: 'sheet',
    icon: 'table',
    name: '任务清单',
    hint: '任务、负责人、状态与完成率',
    build: () => {
      const workbook = sheetFrom([
        ['任务', '负责人', '优先级', '状态', '开始日期', '截止日期', '工时'],
        ['需求评审', '张明', '高', '已完成', '2026-10-01', '2026-10-03', 6],
        ['接口设计', '李蕾', '高', '进行中', '2026-10-04', '2026-10-09', 12],
        ['前端页面', '王强', '中', '未开始', '2026-10-10', '2026-10-18', 24],
        ['联调测试', '赵敏', '中', '未开始', '2026-10-19', '2026-10-24', 16],
        ['上线准备', '张明', '低', '未开始', '2026-10-25', '2026-10-28', 8],
        ['合计工时', '', '', '', '', '', '=SUM(G2:G6)'],
      ], { headerRow: true, widths: { 0: 150, 1: 96, 2: 84, 3: 96, 4: 116, 5: 116, 6: 80 } });
      return workbook;
    },
  },
  {
    id: 'report-deck',
    type: 'deck',
    icon: 'deck',
    name: '项目汇报',
    hint: '封面 / 目标 / 进展 / 计划',
    build: () => {
      const base = createDeckData();
      const parsed = deckFromMarkdown(`# 项目汇报

## 项目背景与目标

- 解决什么问题
- 目标用户与场景
- 成功的衡量指标

## 当前进展

- 里程碑 1：已完成
- 里程碑 2：进行中（70%）
- 里程碑 3：待启动

## 关键数据

- 活跃用户： 
- 转化率： 
- 平均响应时间：

## 风险与应对

- 资源不足 → 提前排期
- 技术难点 → 预研验证

## 下一步计划

- 本周：完成核心链路联调
- 下周：灰度发布 10% 流量
- 月底：全量发布`);
      base.slides = parsed.slides;
      return base;
    },
  },
];

/** 按类型取默认模板 */
export function templateById(id) {
  return TEMPLATES.find((item) => item.id === id) || null;
}

export function templatesByType(type) {
  return TEMPLATES.filter((item) => item.type === type);
}
