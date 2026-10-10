# 贡献指南 / Contributing

感谢你想为 **TriOffice** 做贡献！这是一个零依赖、纯前端的开源办公套件。

## 快速开始

```bash
git clone <本仓库地址>
cd trioffice
npm start              # 启动本地静态服务器（零依赖，仅用 Node 内置模块）
npm test               # 运行单元测试（node --test）
npm run build          # 产出 dist/ 与单文件离线版
npm run docs           # 由函数注册表重新生成 docs/FUNCTIONS.md
npm run examples       # 重新生成 examples/ 下的示例文件
```

打开终端输出的地址（默认 http://127.0.0.1:5173）即可使用。

> 本项目**不依赖任何第三方运行库**，请勿引入 `dependencies`。开发工具也只用 Node 内置模块。

## 目录结构

```
index.html            应用外壳（单页入口）
src/core/             与业务无关的基础设施（存储/事件/路由/UI 组件/i18n/ZIP…）
src/apps/writer/      文档编辑器
src/apps/sheet/       表格编辑器 + 公式引擎 + XLSX 导出
src/apps/deck/        演示编辑器
src/shell/            工作台（最近文件、模板、导入导出）
src/styles/           CSS（原生，按应用拆分）
tests/                node --test 单元测试
docs/                 架构、快捷键、路线图
```

## 开发约定

- **纯 ESM**，浏览器原生 `<script type="module">` 直接跑，无打包步骤（`npm run build` 只在发离线版时用，自研打包器见 `scripts/build.mjs`）。
- **不允许任何依赖**：`dependencies` 与 `devDependencies` 必须始终为空，CI 会强制校验。需要能力就自己写，标准库优先。
- **纯逻辑模块不得碰 DOM**：`src/core/*`、`src/apps/sheet/{address,value,formula,functions,workbook,xlsx}.js`、
  `src/apps/writer/markdown.js` 必须能在 Node 里直接 import。判断标准很简单：`node -e "import('./该文件.js')"` 不报错。
- 使用 `snake_case` 文件名，`camelCase` 函数，`PascalCase` 类。
- 新增公式函数：同时补 `tests/formula.test.mjs` 用例，并跑 `npm run docs` 更新函数手册。
- 新增界面文案：必须在 `src/core/i18n.js` 的 `zh` 与 `en` 里同时补词条（`tests/integrity.test.mjs` 会校验）。
- 新增图标：加到 `src/core/ui.js` 的 `ICONS` 里（同样会被测试校验）。
- 提交信息建议遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat(sheet): 支持 XLOOKUP`。

## 测试策略

改代码前请先看一眼 `tests/integrity.test.mjs` —— 它是一组**静态一致性检查**，能在没有浏览器的情况下抓出：
import 名字不存在、i18n 词条缺失、图标名拼错、CSS 类名没有对应样式、打包产物残留 ESM 语句等。
这类问题占了实际开发中低级错误的一大半，跑一遍只要一秒。

## 提交 PR

1. Fork → 新建分支 `feat/xxx`
2. `npm test` 必须全绿
3. 填写 PR 模板，说明动机与验证方式
4. 保持改动聚焦，一个大 PR 拆成多个小 PR

## 分支与发布

- `main` 为稳定分支，CI 全绿才合并。
- 版本号遵循语义化版本，变更记录写入 `CHANGELOG.md`。

## 行为准则

参与本项目即表示你同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
