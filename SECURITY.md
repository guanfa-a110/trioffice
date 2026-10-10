# 安全策略 / Security Policy

## 设计前提

TriOffice 是完全运行在浏览器本地的静态应用：

- 没有后端、没有数据库、没有账号体系
- 所有文档保存在访问者自己的 IndexedDB 里，不会上传到任何服务器
- 不引入第三方运行时依赖（`package.json` 的 `dependencies` 为空），因此没有供应链投毒面
- 不加载任何外部资源（字体、CDN、统计脚本）—— 全部使用系统字体与内联资源

## 已知的攻击面

| 面 | 处理方式 |
| --- | --- |
| 导入的 HTML 文档 | `stripDangerous()` 会移除 `<script>` `<iframe>` `<object>` `<embed>` 以及所有 `on*` 事件属性与 `javascript:` 协议；粘贴同样会过滤 |
| 导入的 XLSX | 只用自研的非压缩/解压读取器解析 OOXML，不执行任何宏；压缩包解压大小受限 |
| 公式 | 词法/语法分析器不执行 `eval`，函数表是白名单，未知函数返回 `#NAME?` |
| 单文件离线版 | 无外部请求，CSP 友好（可自行加 `default-src 'self'`） |

## 报告漏洞

请**不要**公开开 issue，改用 GitHub 的私有漏洞报告（Security → Report a vulnerability）。
如果仓库未开启该功能，可以先开一个不含细节的 issue 索取联系方式。

我们会在 7 天内确认收到，并在修复后于 CHANGELOG 中致谢（如果你愿意署名）。
