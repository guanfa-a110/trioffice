<div align="center">

<img src="assets/logo.svg" width="104" height="104" alt="TriOffice logo">

# TriOffice

**零依赖、纯前端的开源办公三件套**

文档 · 表格 · 演示 —— 打开浏览器就能用，数据只留在你自己的电脑里。

[English](./README.en.md) · [架构设计](./docs/ARCHITECTURE.md) · [文件格式](./docs/FORMAT.md) · [函数手册](./docs/FUNCTIONS.md) · [快捷键](./docs/KEYBINDINGS.md) · [路线图](./docs/ROADMAP.md)

</div>

---

## 这是什么

**TriOffice** 是一个不依赖任何第三方库的办公套件，包含三个可以独立使用的应用：

| 应用 | 对标 | 你能用它做什么 |
| --- | --- | --- |
| **Writer** 文档 | Word | 富文本排版、标题层级、列表 / 待办、引用、代码块、表格、图片；导出 **Markdown / HTML / 纯文本 / PDF** |
| **Sheet** 表格 | Excel | 单元格网格 + **202 个公式函数**、跨表引用、合并 / 冻结、排序、填充柄、SVG 图表；导入导出 **CSV / XLSX** |
| **Deck** 演示 | PowerPoint | 拖拽式幻灯片编辑（文本框 / 图片 / 形状 / 连线）、5 套主题、演讲者备注、全屏放映；导出**可独立放映的 HTML** |

整个项目**没有 `dependencies`、没有构建工具、没有后端**：源码就是浏览器直接运行的 ES 模块，
`npm start` 只是一个 30 行的静态文件服务器。想离线分发，`npm run build` 会产出**一个 HTML 文件**，
双击即用，断网也能跑。

```
┌──────────────────────────── 一个浏览器标签页 ────────────────────────────┐
│  工作台：新建 / 模板 / 最近文件 / 导入导出 / 深色模式                     │
├──────────────┬──────────────┬──────────────┬────────────────────────────┤
│  Writer      │  Sheet       │  Deck        │  基础设施（src/core）       │
│  富文本编辑  │  网格 + 公式 │  幻灯片编辑  │  存储 / 文件格式 / UI 组件  │
│  md/html     │  csv/xlsx    │  html        │  IndexedDB · .trio · i18n   │
└──────────────┴──────────────┴──────────────┴────────────────────────────┘
```

## 快速开始

```bash
git clone <本仓库地址>
cd trioffice
npm start          # 起一个本地静态服务器，零依赖
```

打开终端提示的地址（默认 <http://127.0.0.1:5173>），就是这样 —— 不需要安装任何东西。

**想直接离线使用？**

```bash
npm run build      # 产出 dist/triooffice.html（约 600 KB，包含全部 CSS/JS）
```

把 `dist/triooffice.html` 拷到任何地方双击打开即可，完全不联网也能用。
想放到服务器上，`dist/index.html` + `dist/src/` 就是一份可直接部署的静态站点。

## 特性速览

### Writer 文档

- 标题 / 正文 / 引用 / 代码块，加粗、斜体、下划线、删除线、行内代码、颜色与高亮
- 有序 / 无序 / **任务列表**，表格（Tab 键在单元格间跳转），本地图片（自动转 DataURL，不联网）
- **大纲面板**：自动解析 H1–H3，点击跳转，写作长文档时很好用
- **查找替换**：支持区分大小写、批量替换并统计处数
- 实时**字数统计**（中英文分别计数）、缩放、页面设置（A4 / Letter，纵向 / 横向，页脚）
- 导出：Markdown、HTML（带完整排版的独立网页）、纯文本、打印 / PDF

### Sheet 表格

- **202 个公式函数**：聚合、文本、日期、查找引用、逻辑、动态数组、财务、工程、信息
  → 完整清单见 [docs/FUNCTIONS.md](./docs/FUNCTIONS.md)
- 公式引擎自研：词法 + 语法分析（`1+2*3^2` 优先级、`{}` 数组常量、整列引用 `A:A`、跨表 `Sheet2!A1`、绝对引用 `$A$1`）
- **循环引用检测**（返回 `#CIRC!`）、错误值传播、惰性求值（`IF` 只算命中的分支）
- 虚拟滚动网格：5000 行 × 200 列也不卡；鼠标拖选、Shift 扩展、`Ctrl+方向键` 跳到数据边界
- 填充柄自动填充（等差序列 / 公式相对平移 / 文本循环）、多单元格复制粘贴（TSV 互通 Excel）
- 数字格式（数值 / 货币 / 百分比 / 日期 / 时间 / 科学计数 / 文本）、边框、合并单元格、冻结窗格
- 排序、插入 / 删除行列并**自动调整所有公式的引用**（越界引用变 `#REF!`，与 Excel 行为一致）
- SVG 图表：柱状 / 折线 / 面积 / 饼图，可拖动缩放，鼠标悬停显示数值
- 导入 / 导出：**CSV（UTF-8 BOM 防乱码）、XLSX（自研 ZIP + OOXML 读写器）**

### Deck 演示

- 5 套主题（极光 / 纸页 / 薄荷 / 终端 / 日落），一键换肤
- 元素：文本框、标题、图片、矩形、椭圆、三角形、直线、箭头；拖动 / 八向缩放 / 方向键微调
- 对齐（左中右、上中下）、水平垂直等距、层级调整、复制、删除
- 演讲者备注、切换动画（淡入 / 滑动 / 缩放 / 无）
- **全屏放映**：`← →` 翻页、`F` 全屏、`Esc` 退出、带进度条与备注浮层
- 导出：**独立 HTML 演示**（自带键盘操作，拷给别人就能放）、Markdown 大纲、`.trio`
- 从 Markdown 大纲一键生成幻灯片（`#` 开标题页，`##` 分页，列表变要点）

### 统一的体验

- **工作台**：新建、5 套模板（会议纪要 / 周报 / 预算表 / 任务清单 / 项目汇报）、最近文件、搜索、排序、置顶、重命名、副本、删除、导入、一键备份全部
- **`.trio` 统一文件格式**：UTF-8 JSON，人可读、可 diff、可手改；规范见 [docs/FORMAT.md](./docs/FORMAT.md)
- **数据全在本地**：IndexedDB 持久化，不上传、不联网、无账号；`Ctrl/⌘+S` 保存，未保存时关闭会提示
- **中英文界面**、浅色 / 深色主题、全键盘操作、自动保存标题
- **零依赖零构建**：没有 `node_modules`，没有打包等待，CI 只跑 `npm test`

## 常用快捷键

| 操作 | 快捷键 |
| --- | --- |
| 保存 | `Ctrl / ⌘ + S` |
| 撤销 / 重做 | `Ctrl / ⌘ + Z` 、`Shift + Ctrl / ⌘ + Z` |
| 加粗 / 斜体 / 下划线 | `Ctrl / ⌘ + B` / `I` / `U` |
| 查找替换 | `Ctrl / ⌘ + F` |
| 打印 / 导出 PDF | `Ctrl / ⌘ + P` |
| 放映演示 | `F5` |
| 编辑单元格 | `F2` 或直接输入 |
| 单元格内换行 | `Alt + Enter` |
| 跳到数据边界 | `Ctrl / ⌘ + 方向键` |
| 自动求和 | `Alt + =` |

完整列表见 [docs/KEYBINDINGS.md](./docs/KEYBINDINGS.md)。

## 项目结构

```
index.html                 单页入口
src/
  main.js                  启动：主题、路由、保存编排
  core/                    与业务无关的基础设施
    dom.js  ui.js          微 DOM 库（h/svg/事件委托）+ 图标/弹窗/菜单/Toast
    idb.js  store.js       IndexedDB 封装（Node 下自动退化内存）+ 文档仓库
    format.js              .trio 格式 + 导入/导出注册表
    zip.js  xml.js         自研 ZIP 读写（store/deflate）+ 极简 XML 解析
    history.js router.js  快照式撤销栈 + 哈希路由
    i18n.js                中英文词条与日期格式化
  apps/
    writer/                文档：markdown.js（md ↔ html，纯逻辑）+ index.js
    sheet/                 表格：address / value / formula / functions / workbook / grid / chart / xlsx
    deck/                  演示：themes / render / index
  shell/                   工作台首页、应用外壳、模板
  styles/                  原生 CSS（base/shell/writer/sheet/deck）
tests/                     node:test 单元测试（83 个用例，含静态一致性检查）
scripts/                   零依赖工具：serve / build（自研打包器）/ make-examples / make-docs / set-repo
docs/                      架构、格式、函数手册、快捷键、路线图
examples/                  示例文件（.trio / .xlsx / .csv / .md / .html）
```

## 开发

```bash
npm start                     # 本地开发服务器
npm test                      # 全部单测
npm run test:watch            # 监听模式
npm run build                 # 产出 dist/ 与单文件离线版
node scripts/make-examples.mjs # 重新生成 examples/
node scripts/make-docs.mjs     # 重新生成 docs/FUNCTIONS.md
```

测试共 98 个用例，全部跑在 Node 里，**不需要浏览器**：

| 层面 | 覆盖内容 |
| --- | --- |
| 公式引擎 | 19 组：词法 / 语法 / 优先级 / 200+ 函数 / 惰性求值 / 循环引用 / 引用平移 |
| 表格模型 | 18 组：输入解析、样式、插入删除行列后的公式调整、排序、XLSX 往返（含多表与冻结） |
| 文档与演示 | Markdown ↔ HTML 无损往返、独立 HTML 导出、大纲生成幻灯片 |
| 基础设施 | 自研 ZIP（store + deflate）、XML 解析、IndexedDB 仓库、导入导出注册表、静态服务器 |
| **挂载冒烟** | `tests/dom-shim.mjs` 提供一套 DOM 影子环境，**真的把工作台与三个应用挂载起来**，并把工具栏按钮全点一遍 —— 专抓 TDZ、拼错标识符、空引用这类"一打开就白屏"的问题 |
| 静态一致性 | 每个 `import` 的名字真的被导出、`t('key')` 两种语言都有、`icon('name')` 真的定义过、JS 用到的 CSS 类名真的有样式、打包产物不残留 ESM 语句 |

## 数据与隐私

- 所有文件保存在你浏览器的 **IndexedDB** 里，键名 `trioffice`；不上传任何数据，没有埋点、没有账号
- 想搬走数据：工作台 →「备份全部」导出一份 JSON；再在新环境「导入文件」即可
- 想彻底清除：浏览器设置里清站点数据，或在工作台删除全部文件

## 支持的文件格式

| 方向 | 文档 | 表格 | 演示 |
| --- | --- | --- | --- |
| 打开 / 导入 | `.trio` `.md` `.markdown` `.html` `.txt` | `.trio` `.csv` `.tsv` `.xlsx` | `.trio` `.md` |
| 导出 | `.md` `.html` `.txt` `.trio` · 打印 PDF | `.xlsx` `.csv` `.html` `.trio` · 打印 | `.html` `.md` `.trio` |

## 诚实的边界

这是一个**轻量级**办公套件，不是 Office 的逐字节替代品。当前版本明确不做 / 没做的事：

- ❌ 不读写 `.docx` / `.pptx`（二进制 OOXML 的兼容成本极高，暂时用 `.md` / `.html` / `.trio` 代替）
- ❌ XLSX 只处理值、公式、数字格式、列宽行高、合并、冻结；**不导出图表**，也不支持透视表 / 宏
- ⚠️ 公式引擎覆盖 202 个常用函数，未覆盖冷门函数与数组广播的全部细节
- ⚠️ 表格上限 5000 行 × 200 列（虚拟滚动之下仍不建议塞满）
- ❌ 没有多人协作、云同步、评论、修订模式、PDF 高保真导出（用浏览器打印）
- ⚠️ 富文本编辑依赖 `document.execCommand`（浏览器仍普遍支持，但已是过时 API）

如果你需要这些，[ONLYOFFICE](https://github.com/ONLYOFFICE)、[LibreOffice](https://github.com/LibreOffice/core)、
[Univer](https://github.com/dream-num/univer) 等项目更合适；TriOffice 的目标是**够用、够小、够透明**。

## 参与贡献

欢迎任何形式的贡献：报 bug、提需求、补函数、改文案、翻译界面。

- 开发约定与 PR 流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)
- 有点子或想法欢迎开 issue（模板已备好）
- 参与即表示同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## 把仓库发布到 GitHub

仓库里已经写好 CI（`.github/workflows/ci.yml`，push / PR 时自动跑测试与构建）。

```bash
# 方式一：装了 gh CLI（推荐）
brew install gh && gh auth login
node scripts/set-repo.mjs <你的GitHub用户名>
npm run publish -- --owner <你的GitHub用户名>

# 方式二：只有 Personal Access Token（勾选 repo 权限）
# 网络受限、甚至只放行 api.github.com 时也能用（脚本走 REST API 重建提交历史）
GITHUB_TOKEN=<你的token> node scripts/publish.mjs --owner <你的GitHub用户名>

# 方式三：最朴素的手工推送
node scripts/set-repo.mjs <你的GitHub用户名>
git remote add origin git@github.com:<你的GitHub用户名>/trioffice.git
git push -u origin main
```

`scripts/publish.mjs` 会自动创建仓库、逐个提交上传（保留完整历史与提交信息）、建立 `main` 分支并设置主题标签。
先用 `npm run publish -- --owner <账号> --dry-run` 可以只看它打算上传什么，不联网。

## 许可

[MIT](./LICENSE) © TriOffice contributors

零依赖、零遥测。你可以把它用在学习、工作、内网系统里，也可以商用。
