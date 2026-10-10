# 更新日志 / Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-10-10

### 新增
- **工作台**：新建 / 最近文件 / 重命名 / 删除 / 导入导出 / 模板 / 深色模式。
- **TriOffice Writer（文档）**：富文本编辑、标题层级、列表、引用、代码块、表格、
  图片、链接、查找替换、大纲导航、字数统计；导出 HTML / Markdown / 纯文本 / 打印 PDF。
- **TriOffice Sheet（表格）**：单元格网格、公式引擎（150+ 函数）、绝对引用、
  跨表引用、循环引用检测、数字格式、边框、合并单元格、冻结窗格、
  排序、填充柄自动填充、CSV/TSV 导入导出、**XLSX 导出（自研 ZIP 写入器）**、SVG 图表。
- **TriOffice Deck（演示）**：幻灯片列表、文本框 / 图片 / 形状 / 连线元素、
  拖拽缩放、层级调整、对齐分布、4 套主题、演讲者备注、全屏放映、导出独立 HTML。
- **核心**：IndexedDB 持久化、统一 `.trio` 文件格式、撤销/重做栈、事件总线、
  哈希路由、中英文界面、零依赖零构建。

[0.1.0]: https://github.com/OWNER/trioffice/releases/tag/v0.1.0
