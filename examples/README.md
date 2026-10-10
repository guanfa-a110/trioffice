# 示例文件 / Examples

这些文件全部由 `node scripts/make-examples.mjs` 从项目自身的数据模型生成，可以直接拖进 TriOffice 打开。

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `meeting-notes.trio` | 文档 | 会议纪要模板（议题 / 结论 / 待办） |
| `weekly-report.trio` | 文档 | 项目周报模板 |
| `budget.trio` | 表格 | 家庭预算，含公式（合计 11448，差额 -698） |
| `task-tracker.trio` | 表格 | 任务清单，含 `SUM` 汇总公式 |
| `project-report.trio` | 演示 | 6 页项目汇报 |
| `budget.xlsx` | Excel | 由自研 XLSX 导出器生成，可直接用 Excel / WPS 打开 |
| `task-tracker.csv` | CSV | UTF-8 BOM，Excel 打开不乱码 |
| `meeting-notes.md` | Markdown | 文档导出结果 |
| `meeting-notes.html` | HTML | 带完整排版的独立网页 |
| `project-report.html` | HTML | 可独立放映的演示（← → 翻页，F 全屏） |
| `project-report-outline.md` | Markdown | 演示的大纲导出 |

## 怎么用

```bash
npm start                 # 打开 http://localhost:5173
```

然后在工作台点「导入文件」，选择上面任意一个文件即可。

## 重新生成

```bash
node scripts/make-examples.mjs
```
