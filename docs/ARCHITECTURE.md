# 架构设计 / Architecture

TriOffice 的代码量不大（约 1.2 万行 JS），刻意保持「一个文件一件事」的结构。
本文说明各层的职责边界、关键数据流，以及为什么这么设计。

## 分层

```
┌──────────────────────────────────────────────────────────────────────┐
│ shell/            工作台（home.js）、应用外壳（frame.js）、模板        │
├──────────────────────────────────────────────────────────────────────┤
│ apps/             writer / sheet / deck —— 每个应用自带控制器与视图    │
├──────────────────────────────────────────────────────────────────────┤
│ core/             dom · ui · idb · store · format · zip · xml ·       │
│                   history · router · i18n                            │
└──────────────────────────────────────────────────────────────────────┘
```

依赖方向**只有向下**，没有反向引用，也没有循环依赖：

- `core/*` 不知道任何应用的存在；
- 应用之间只通过 `core/format.js` 的导出/导入注册表交互，不互相 import（唯一的例外是
  `deck/render.js` 复用 `writer/markdown.js` 的 `escapeHtml`，属于纯函数复用）；
- `shell/*` 只负责路由与编排。

### 纯逻辑 vs 有 DOM

一条硬规则：**凡是能被单测覆盖的模块，都不碰 DOM**。

| 模块 | DOM | 说明 |
| --- | --- | --- |
| `sheet/formula.js` `functions.js` `value.js` `address.js` `workbook.js` | ❌ | 公式引擎与数据模型，Node 里直接跑 |
| `sheet/xlsx.js` `chart.js` | 仅 `chart.js` 用 `svg()` 建节点 | XLSX 读写完全不碰 DOM |
| `writer/markdown.js` | ❌ | md ↔ html 双向都是纯逻辑（自研 XML 解析器） |
| `core/zip.js` `xml.js` `store.js` `format.js` `history.js` | ❌ | 基础设施 |
| `core/dom.js` `ui.js`、各应用 `index.js`、`grid.js`、`render.js` | ✅ | 视图层 |

这条规则带来两个好处：`npm test` 不需要浏览器（`node --test` 即可），以及核心逻辑可以在
Node 脚本里复用（`scripts/make-examples.mjs` 就是这样生成示例 XLSX 的）。

## 数据流

```
用户输入
   │
   ▼
应用控制器 (apps/*/index.js)          ← 菜单、工具条、对话框
   │  ① 校验/规范化
   ▼
数据模型 (workbook.js / 文档 data)     ← 唯一的真相来源
   │  ② 变更通知 touch()
   ▼
视图重绘 (grid.js / render.js)         ← 只读模型，绘制可见部分
   │  ③ 脏标记
   ▼
自动保存 (main.js → store.save)        ← 防抖写入 IndexedDB
```

撤销/重做采用**快照式**（`core/history.js`）：每次编辑把整个文档模型的结构化克隆压栈，上限 200 步。
选择快照而不是命令模式，是因为文档模型不大（几万个单元格的量级），而快照能保证任何复杂操作
（排序、合并、插入行列）都能被正确回滚，没有「忘记写逆操作」的风险。

## 表格：公式引擎

### 三个阶段

```
公式文本 "=SUM(A1:B2)*2"
   │ tokenize()   词法分析
   ▼
Token 流  name(lparen) ref colon ref rparen op num
   │ parse()      递归下降 + 优先级爬升
   ▼
AST      bin(*, call(SUM, [range]), lit(2))
   │ evaluate()   带上下文的求值
   ▼
值       number | string | boolean | FormulaError | RangeValue
```

- 优先级：比较 < `&` < `+ -` < `* /` < `^`（右结合） < 一元 `- +` < 后缀 `%`
- 支持 `{1,2;3,4}` 数组常量、整列引用 `A:A`、跨表 `Sheet2!A1`、带空格的表名 `'我的 表'!A1`
- `RangeValue` 是一等公民：`SUM` 之类的聚合函数直接消费二维矩阵；比较运算在
  区域与标量之间按元素展开（Excel 的数组语义），因此 `FILTER(A1:A9, A1:A9>60)` 能工作

### 求值策略：惰性 + 记忆化 + 循环检测

`Workbook.getValue()` 是唯一的值入口：

```js
key = `${sheet}!${r}:${c}`
if (cache.has(key)) return cache.get(key)          // 记忆化
if (stack.includes(key)) return #CIRC!             // 循环引用
stack.push(key); value = evaluate(...); stack.pop()
```

- **惰性**：只有被真正读取的单元格才参与计算。表格有 5000×200 个格子，但初始化时零计算，
  虚拟滚动只渲染可见窗口，因此打开大表也是瞬时的。
- **记忆化**：一次「计算轮次」内每个单元格最多算一次；任何编辑都会 `touch()` →
  `beginPass()` 清空缓存，保证结果永远是最新的（牺牲了增量重算，换来了实现的简单与正确）。
- **循环检测**：求值栈里出现过的 key 再次入栈即判定循环，返回 `#CIRC!` 而不是栈溢出。
- **惰性函数**：`IF` / `IFERROR` / `AND` / `OR` / `FILTER` 等注册为 `lazy`，
  直接拿到 AST 节点，只对命中的分支求值 —— 所以 `IF(A1<0, 1/0, "ok")` 不会报 `#DIV/0!`。

### 引用维护

行列的插入/删除会用 `adjustFormulaRefs()` 重写**所有工作表**里的公式：

- 插入：位于插入点之后的引用整体平移（**绝对引用也跟着动**，与 Excel 一致）
- 删除：落在被删范围内的引用变成 `#REF!`，其余左移
- 填充柄走另一条路径 `translateFormula()`：只平移相对引用，`$A$1` 保持不变

## 表格：虚拟滚动网格

`grid.js` 的渲染策略：

1. 列宽/行高维护成前缀和数组（`xPrefix()` / `yPrefix()`），任何坐标 → 索引都是二分查找
2. 滚动事件里只计算可见窗口（±3 行的 overscan），重建窗口内的格子 DOM
3. 覆盖层（选区、填充柄、就地编辑框、引用高亮、图表）与网格分层，滚动时只需更新 `left/top`
4. 因为覆盖层会挡住原生滚动条，运行时会测量滚动条宽度并写入 CSS 变量 `--sb-w/--sb-h`，
   让覆盖层内缩，同时把滚轮事件手动转发给滚动容器

## 文件格式与导入导出

- 原生格式 `.trio` 是 UTF-8 JSON（规范见 [FORMAT.md](./FORMAT.md)），人可读、可 diff、可手改
- 导入/导出通过注册表解耦：应用启动时调用

  ```js
  registerExporter('sheet', { id: 'xlsx', label: '…', ext: 'xlsx', run: (doc) => … });
  registerImporter(['csv', 'tsv'], async (file, ctx) => ({ type: 'sheet', data: … }));
  ```

  因此工作台、菜单、对话框都不需要知道具体格式，加一种格式只要新增一次注册。
  同名扩展名允许多个应用注册，用 `priority` 决定谁生效（`.md` 默认导入成文档，
  从演示应用里导入则走大纲模式）。

- XLSX 是自研实现的：`zip.js` 负责容器（写入用 store 方式，读取支持 deflate，浏览器用
  `DecompressionStream`、Node 注入 zlib），`xlsx.js` 负责 OOXML 结构
  （`[Content_Types].xml` / `workbook.xml` / `worksheets/*.xml` / `styles.xml` / `sharedStrings.xml`），
  公式单元格同时写入 `<f>` 与缓存值 `<v>`，所以对方打开就能看到数字。

## 构建

`scripts/build.mjs` 自带一个约 150 行的 ESM 打包器：

1. 从 `src/main.js` 出发递归解析相对 import，得到后序模块列表
2. 把每个模块改写成 `function (__exports__, __import__) { ... }` 塞进注册表
3. 把 CSS 与注册表内联进 `index.html`，产出**单文件离线版**；同时复制一份可部署目录到 `dist/`
4. 最后对产物跑 `node --check`

为了让正则改写可靠，源码必须遵守三条约定（由 `tests/build.test.mjs` 强制校验）：
只用 `import { a } from './x.js'` 与 `import './x.js'` 两种导入写法、不使用 `export * from`
与 `export { a as b }`、不使用动态 `import()`（Node 侧需要的 zlib 通过 `setInflateRaw()` 注入）。

## 无浏览器测试策略

前端项目最大的痛点是没有浏览器就测不了。TriOffice 的做法是：

1. **把逻辑挤到纯模块里**（上表），核心功能全部可以 `node --test` 覆盖；
2. **补一组静态一致性检查**（`tests/integrity.test.mjs`），用文本级校验兜住低级错误：
   - 每个相对 `import` 指向的文件存在，且名字真的被目标模块导出
   - 没有「导入了却没用」的名字
   - `t('key')` 用到的词条在 zh / en 两份字典里都存在（含通过 `labelKey` / `i18n` 间接引用的）
   - `icon('name')` 用到的图标真的定义过
   - JS 里声明/使用的 CSS 类名在样式表里都有对应规则
   - CSS `var(--x)` 用到的变量都有定义
   - `index.html` 引用的资源真实存在
3. **打包产物校验**：确认单文件版里不残留任何 ESM 语句。

4. **DOM 影子环境**（`tests/dom-shim.mjs` + `tests/mount.test.mjs`）补上最后一块：
   用一个约 400 行的假 DOM（`FakeNode` 支持 classList / style / dataset / 事件派发 / 选择器匹配 /
   iframe 的 contentDocument）把**工作台与三个应用真的挂载起来**，然后把工具栏按钮与菜单全点一遍。

   影子环境只保证「不因为环境太假而崩」，因此凡是 `ReferenceError`（`xxx is not defined`、
   `Cannot access 'x' before initialization`）都一定是真 bug —— 这一层上线第一天就抓出了四个
   真实崩溃（工具栏在网格创建前被构建导致 TDZ、`printDoc` 拿到 null、加粗按钮捕获了空元素等），
   这些在静态检查里完全看不见。

这套组合仍然抓不到「按钮点下去没反应」这类问题，但能拦住白屏、改名、拼错键、漏写样式这一类
最常见的低级错误，且整个测试套件跑完只要几秒（无浏览器依赖）。
