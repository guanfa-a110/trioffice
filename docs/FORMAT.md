# `.trio` 文件格式规范 / File Format

`.trio` 是 TriOffice 的原生格式：**UTF-8 编码的 JSON 文本**。选它而不是二进制容器，是因为
纯文本文件能被人读懂、能被 git diff、能在出问题时用编辑器抢救。

## 顶层结构

```json
{
  "format": "trio/1",
  "app": "TriOffice",
  "version": "0.1.0",
  "type": "doc",
  "title": "季度报告",
  "createdAt": 1761200000000,
  "updatedAt": 1761203600000,
  "stats": { "words": 1280, "chars": 3421 },
  "preview": "本季度收入环比增长……",
  "data": { }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `format` | string | ✅ | 固定 `"trio/1"`，用于版本识别 |
| `type` | string | ✅ | `doc` / `sheet` / `deck` |
| `title` | string | ✅ | 文件名与标题 |
| `data` | object | ✅ | 各应用的文档模型，见下 |
| `app` `version` | string | | 生成者信息 |
| `createdAt` `updatedAt` | number | | Unix 毫秒时间戳 |
| `stats` `preview` | object / string | | 仅用于工作台展示，可忽略 |

解析实现：`src/core/format.js` 的 `serializeDoc()` / `parseDoc()`。

## `type: "doc"` —— 文档

```json
{
  "html": "<h1>季度报告</h1><p>正文……</p>",
  "footer": "机密 · 第 1 页",
  "pageSize": "a4",
  "orientation": "portrait"
}
```

- `html`：正文 HTML。允许的标签：`h1-h3`、`p`、`ul`/`ol`/`li`、`blockquote`、`pre`/`code`、
  `table`/`thead`/`tbody`/`tr`/`th`/`td`、`strong`/`em`/`u`/`s`/`code`/`mark`/`span`、`a`、`img`、`hr`、`br`。
  `img` 的 `src` 是 DataURL（本地图片，不引用外链）。
- `pageSize`：`a4` | `letter`；`orientation`：`portrait` | `landscape`
- `footer`：打印时显示的页脚文本

## `type: "sheet"` —— 表格

```json
{
  "version": 1,
  "active": 0,
  "sheets": [
    {
      "id": "s1a2b3",
      "name": "预算",
      "cells": {
        "A1": { "v": "类别", "s": { "b": true, "bg": "#eef2ff", "align": "center" } },
        "C2": { "v": 4500, "fmt": "currency" },
        "E2": { "f": "=C2-D2", "fmt": "currency" }
      },
      "colWidths": { "0": 110, "1": 130 },
      "rowHeights": { "3": 40 },
      "merges": [[0, 0, 0, 2]],
      "frozen": { "rows": 1, "cols": 0 },
      "charts": [
        {
          "id": "c1", "type": "bar", "title": "月度支出",
          "range": { "from": { "r": 0, "c": 0 }, "to": { "r": 7, "c": 4 } },
          "x": 620, "y": 40, "w": 520, "h": 300, "colorOffset": 1
        }
      ],
      "view": { "row": 0, "col": 0 }
    }
  ]
}
```

### 单元格对象（`cells` 的键是 A1 记法，值是对象）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `v` | number / string / boolean | 字面值。数字日期以 **Excel 序列号**存储（1900 日期系统，`1900-01-01` = 1） |
| `f` | string | 公式，**带前导 `=`**。与 `v` 互斥：有 `f` 时以公式为准，`v` 不参与计算 |
| `fmt` | string | 数字格式：`general` `number` `currency` `percent` `date` `time` `scientific` `text` |
| `s` | object | 样式，见下 |

### 样式对象 `s`

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `b` `i` `u` `st` | boolean | 加粗 / 斜体 / 下划线 / 删除线 |
| `color` `bg` | string | 前景色 / 填充色，`#rrggbb` |
| `align` | string | `left` `center` `right` |
| `valign` | string | `top` `middle` `bottom` |
| `size` | number | 字号（px） |
| `font` | string | 字体名 |
| `wrap` | boolean | 自动换行 |
| `border` | boolean | 是否绘制单元格边框 |

### 其他约定

- `merges` 是 `[r1, c1, r2, c2]` 数组的数组，行列均为 **0 基**下标，只保留左上角单元格的值
- `frozen` 表示冻结的行数 / 列数
- `charts` 里的 `x/y/w/h` 是相对表格原点的像素坐标
- 表格上限：`MAX_ROWS = 5000`、`MAX_COLS = 200`（0 基下标，见 `workbook.js`）

## `type: "deck"` —— 演示

```json
{
  "theme": "aurora",
  "canvas": { "w": 1280, "h": 720 },
  "slides": [
    {
      "id": "s1",
      "layout": "title",
      "transition": "fade",
      "notes": "开场先讲结论",
      "background": null,
      "elements": [
        {
          "id": "e1", "type": "heading",
          "x": 115, "y": 230, "w": 1050, "h": 130,
          "text": "TriOffice 演示", "fontSize": 70, "color": "#f2f6ff",
          "align": "left", "valign": "top", "bold": true, "lineHeight": 1.2,
          "font": "-apple-system, …", "opacity": 1
        }
      ]
    }
  ]
}
```

- 所有坐标都在 **1280 × 720 的画布坐标系**里，显示时用 `transform: scale()` 适配屏幕
- `type` 取值：`text` `heading` `image` `rect` `ellipse` `triangle` `line` `arrow`
- 形状类元素用 `fill` / `stroke` / `strokeWidth` / `radius`；图片类用 `src`（DataURL）/ `alt` / `fit`
- `layout` 仅用于「换版式」时的模板选择，不影响渲染；`transition`：`none` `fade` `slide` `zoom`
- `background` 为 `null` 时使用当前主题的渐变背景

## 兼容性约定

实现方应遵循：

1. **宽容读取**：缺字段用默认值补齐，未知字段原样保留（`normalizeWorkbook()` 是范例）
2. **`format` 校验**：不认识 `format` 时给出明确错误，不要静默失败
3. **向后兼容**：`trio/1` 内的字段只会新增，不会改语义；破坏性变更会升到 `trio/2`
4. **纯 JSON**：不使用 `NaN` / `Infinity` / `undefined`（用 `null` 代替），保证任何 JSON 解析器都能读

## 备份格式

工作台的「备份全部」导出的是另一种文件（后缀仍是 `.json`，但顶层带 `kind: "backup"`）：

```json
{
  "format": "trio/1",
  "kind": "backup",
  "exportedAt": 1761203600000,
  "count": 3,
  "docs": [ { "type": "doc", "title": "…", "data": { } } ]
}
```

导入时会被识别并批量还原（`buildBackup()` / `parseBackup()`）。

## 其他导出格式

| 格式 | 由谁产出 | 说明 |
| --- | --- | --- |
| `.xlsx` | `src/apps/sheet/xlsx.js` | 自研 OOXML 写入器：值、公式（含缓存结果）、数字格式、列宽行高、合并、冻结 |
| `.csv` | `src/apps/sheet/workbook.js` | UTF-8 带 BOM，逗号分隔，字段内含 `"`/`,`/换行时按 RFC 4180 加引号 |
| `.md` | `src/apps/writer/markdown.js` | HTML → Markdown（纯逻辑实现，无 DOM 依赖） |
| `.html` | `writer/markdown.js` / `deck/render.js` | 独立网页文档 / 可独立放映的演示 |
