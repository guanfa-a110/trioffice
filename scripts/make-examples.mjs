#!/usr/bin/env node
/**
 * make-examples.mjs —— 生成 examples/ 下的示例文件（.trio / .xlsx / .csv / .md）。
 * 这些文件直接由项目自身的数据模型与导出器产出，既能当示例，也能当作回归样本。
 *
 *   node scripts/make-examples.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './build.mjs';

// 导入三个应用会触发各自的导入/导出器注册（浏览器里由 src/main.js 完成）
import '../src/apps/writer/index.js';
import '../src/apps/sheet/index.js';
import '../src/apps/deck/index.js';

import { TEMPLATES, templateById } from '../src/shell/templates.js';
import { serializeDoc, listExporters, findExporter } from '../src/core/format.js';
import { Workbook } from '../src/apps/sheet/workbook.js';

const OUT = join(ROOT, 'examples');

/** 与 store 里的记录结构保持一致 */
function asDoc({ type, title, data, stats }) {
  return {
    id: `example-${type}-${title}`,
    type,
    title,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preview: '',
    stats: stats || { words: 0, cells: 0, slides: 0 },
    schema: 'trio/1',
    data,
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const written = [];

  const plan = [
    { id: 'meeting', file: 'meeting-notes.trio', title: '会议纪要（示例）' },
    { id: 'weekly', file: 'weekly-report.trio', title: '项目周报（示例）' },
    { id: 'budget', file: 'budget.trio', title: '家庭预算（示例）' },
    { id: 'tracker', file: 'task-tracker.trio', title: '任务清单（示例）' },
    { id: 'report-deck', file: 'project-report.trio', title: '项目汇报（示例）' },
  ];

  for (const item of plan) {
    const template = templateById(item.id);
    const doc = asDoc({ type: template.type, title: item.title, data: template.build() });
    await writeFile(join(OUT, item.file), serializeDoc(doc), 'utf8');
    written.push(item.file);
  }

  // XLSX / CSV / Markdown 示例：走真实的导出器
  const budget = asDoc({ type: 'sheet', title: '家庭预算', data: templateById('budget').build() });
  const tracker = asDoc({ type: 'sheet', title: '任务清单', data: templateById('tracker').build() });
  const meeting = asDoc({ type: 'doc', title: '会议纪要', data: templateById('meeting').build() });
  const deck = asDoc({ type: 'deck', title: '项目汇报', data: templateById('report-deck').build() });

  const jobs = [
    [budget, 'sheet', 'xlsx', 'budget.xlsx'],
    [tracker, 'sheet', 'csv', 'task-tracker.csv'],
    [meeting, 'doc', 'md', 'meeting-notes.md'],
    [meeting, 'doc', 'html', 'meeting-notes.html'],
    [deck, 'deck', 'html', 'project-report.html'],
    [deck, 'deck', 'md', 'project-report-outline.md'],
  ];

  for (const [doc, type, formatId, filename] of jobs) {
    const exporter = findExporter(type, formatId);
    if (!exporter) throw new Error(`缺少导出器 ${type}/${formatId}`);
    const result = await exporter.run(doc);
    const content = typeof result.content === 'string' ? result.content : Buffer.from(result.content);
    await writeFile(join(OUT, filename), content);
    written.push(filename);
  }

  // 预算表的数据校验结果也会打印出来，方便人工确认示例是对的
  const workbook = new Workbook(budget.data);
  const total = workbook.getText('Sheet1', 8, 2);
  const delta = workbook.getText('Sheet1', 8, 4);

  await writeFile(join(OUT, 'README.md'), buildExamplesReadme(written, total, delta), 'utf8');
  written.push('README.md');

  console.log(`✔ 已生成 ${written.length} 个示例文件：`);
  for (const file of written) console.log(`  examples/${file}`);
  console.log(`  预算合计 = ${total}，差额合计 = ${delta}`);
  console.log(`  可用导出格式：${['doc', 'sheet', 'deck'].map((type) => `${type}[${listExporters(type).map((item) => item.id).join('/')}]`).join('  ')}`);
  void TEMPLATES;
}

function buildExamplesReadme(files, total, delta) {
  return `# 示例文件 / Examples

这些文件全部由 \`node scripts/make-examples.mjs\` 从项目自身的数据模型生成，可以直接拖进 TriOffice 打开。

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| \`meeting-notes.trio\` | 文档 | 会议纪要模板（议题 / 结论 / 待办） |
| \`weekly-report.trio\` | 文档 | 项目周报模板 |
| \`budget.trio\` | 表格 | 家庭预算，含公式（合计 ${total}，差额 ${delta}） |
| \`task-tracker.trio\` | 表格 | 任务清单，含 \`SUM\` 汇总公式 |
| \`project-report.trio\` | 演示 | 6 页项目汇报 |
| \`budget.xlsx\` | Excel | 由自研 XLSX 导出器生成，可直接用 Excel / WPS 打开 |
| \`task-tracker.csv\` | CSV | UTF-8 BOM，Excel 打开不乱码 |
| \`meeting-notes.md\` | Markdown | 文档导出结果 |
| \`meeting-notes.html\` | HTML | 带完整排版的独立网页 |
| \`project-report.html\` | HTML | 可独立放映的演示（← → 翻页，F 全屏） |
| \`project-report-outline.md\` | Markdown | 演示的大纲导出 |

## 怎么用

\`\`\`bash
npm start                 # 打开 http://localhost:5173
\`\`\`

然后在工作台点「导入文件」，选择上面任意一个文件即可。

## 重新生成

\`\`\`bash
node scripts/make-examples.mjs
\`\`\`
`;
}

main().catch((err) => {
  console.error('✖ 生成示例失败:', err.message);
  process.exit(1);
});
