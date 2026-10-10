import test from 'node:test';
import assert from 'node:assert/strict';

import {
  markdownToHtml, htmlToText, countText, buildStandaloneHtml, inlineToHtml, escapeHtml,
  htmlStringToMarkdown, htmlToMarkdown,
} from '../src/apps/writer/markdown.js';
import { createWriterData } from '../src/apps/writer/index.js';
import { deckFromMarkdown, createDeckData } from '../src/apps/deck/index.js';
import { THEMES, getTheme, CANVAS, LAYOUTS, TRANSITIONS } from '../src/apps/deck/themes.js';
import { createSlide, elementDefaults, buildDeckHtml, slideToHtml } from '../src/apps/deck/render.js';

test('Markdown → HTML：块级结构', () => {
  const html = markdownToHtml(`# 标题

段落一。

## 二级

- a
- b

1. x
2. y

> 引用

\`\`\`js
const a = 1;
\`\`\`

---
`);
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<p>段落一。</p>'));
  assert.ok(html.includes('<h2>二级</h2>'));
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('<ol><li>x</li><li>y</li></ol>'));
  assert.ok(html.includes('<blockquote><p>引用</p></blockquote>'));
  assert.ok(html.includes('<pre data-lang="js"><code>const a = 1;</code></pre>'));
  assert.ok(html.includes('<hr>'));
});

test('Markdown → HTML：行内样式', () => {
  const html = inlineToHtml('**粗** *斜* ~~删~~ `代码` [链接](https://a.b) ![图](x.png)');
  assert.ok(html.includes('<strong>粗</strong>'));
  assert.ok(html.includes('<em>斜</em>'));
  assert.ok(html.includes('<del>删</del>'));
  assert.ok(html.includes('<code>代码</code>'));
  assert.ok(html.includes('<a href="https://a.b">链接</a>'));
  assert.ok(html.includes('<img src="x.png" alt="图">'));
  assert.equal(inlineToHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', '必须转义 HTML');
});

test('Markdown → HTML：表格与任务列表', () => {
  const html = markdownToHtml(`| 名称 | 数量 |
| :--- | ---: |
| 苹果 | 3 |

- [x] 完成
- [ ] 未完成
`);
  assert.ok(html.includes('<table><thead><tr><th style="text-align:left">名称</th><th style="text-align:right">数量</th></tr></thead>'));
  assert.ok(html.includes('<td style="text-align:left">苹果</td>'));
  assert.ok(html.includes('data-checked="true"'));
  assert.ok(html.includes('data-checked="false"'));
});

test('Markdown → HTML：嵌套引用与转义', () => {
  const html = markdownToHtml('> 一级\n>\n> > 二级');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('二级'));
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; "b"&gt;');
});

test('HTML → 纯文本', () => {
  const text = htmlToText('<h1>标题</h1><p>正文 <strong>加粗</strong></p><ul><li>一</li><li>二</li></ul><table><tr><td>甲</td><td>乙</td></tr></table>');
  assert.ok(text.startsWith('标题'));
  assert.ok(text.includes('正文 加粗'));
  assert.ok(text.includes('• 一'));
  assert.ok(text.includes('甲乙'));
  assert.ok(!text.includes('<'));
});

test('字数统计：中英文分别计数', () => {
  const stats = countText('你好世界 hello world foo');
  assert.equal(stats.cjk, 4);
  assert.equal(stats.en, 3);
  assert.equal(stats.words, 7);
  assert.ok(stats.chars > stats.words);
  const noSpace = countText('ab cd');
  assert.equal(noSpace.charsNoSpace, 4);
});

test('导出独立 HTML：包含样式、标题与页脚', () => {
  const html = buildStandaloneHtml({
    title: '季度报告',
    html: '<h1>季度报告</h1><p>内容</p>',
    footer: '第 1 页',
    pageSize: 'letter',
    orientation: 'landscape',
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>季度报告</title>'));
  assert.ok(html.includes('letter landscape'));
  assert.ok(html.includes('第 1 页'));
  assert.ok(html.includes('<h1>季度报告</h1>'));
  assert.ok(html.includes('@page'));
});

test('Writer 默认文档结构完整', () => {
  const data = createWriterData();
  assert.equal(typeof data.html, 'string');
  assert.equal(data.pageSize, 'a4');
  assert.equal(data.orientation, 'portrait');
});

test('演示：主题与版式定义', () => {
  const ids = Object.keys(THEMES);
  assert.ok(ids.length >= 4);
  for (const theme of Object.values(THEMES)) {
    assert.ok(theme.background && theme.text && theme.accent);
    assert.ok(theme.titleSize > theme.bodySize);
  }
  assert.equal(getTheme('不存在').id, ids[0], '未知主题回退到默认');
  assert.equal(getTheme('aurora').id, 'aurora');
  assert.equal(CANVAS.w / CANVAS.h, 16 / 9);
  assert.ok(LAYOUTS.length >= 4);
  assert.ok(TRANSITIONS.length >= 3);
});

test('演示：按版式生成幻灯片', () => {
  const theme = getTheme('aurora');
  const title = createSlide('title', theme, 0);
  assert.ok(title.elements.length >= 2);
  assert.equal(title.elements[0].type, 'heading');

  const body = createSlide('titleBody', theme, 1);
  assert.ok(body.elements.some((element) => element.type === 'text'));

  const twoCol = createSlide('twoCol', theme, 2);
  assert.equal(twoCol.elements.filter((element) => element.type === 'text').length, 2);

  const blank = createSlide('blank', theme, 3);
  assert.equal(blank.elements.length, 0);

  for (const slide of [title, body, twoCol]) {
    for (const element of slide.elements) {
      assert.ok(element.id, '元素必须有 id');
      assert.equal(typeof element.x, 'number');
      assert.equal(typeof element.w, 'number');
    }
  }
});

test('演示：元素默认样式来自主题', () => {
  const theme = getTheme('mono');
  const rect = elementDefaults('rect', theme);
  assert.equal(rect.type, 'rect');
  assert.equal(rect.fill, theme.accent);
  const text = elementDefaults('text', theme);
  assert.equal(text.fontSize, theme.bodySize);
  assert.equal(text.color, theme.text);
  const image = elementDefaults('image', theme);
  assert.equal(image.src, '');
});

test('演示：导出独立 HTML', () => {
  const theme = getTheme('paper');
  const slides = [createSlide('title', theme, 0), createSlide('titleBody', theme, 1)];
  slides[1].notes = '记得讲清楚背景';
  const html = buildDeckHtml({ title: '项目汇报', slides, themeId: 'paper', showNotes: true });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>项目汇报</title>'));
  assert.ok(html.includes('class="deck-slide"'));
  assert.ok(html.includes('记得讲清楚背景'));
  assert.ok(html.includes('addEventListener'));
  const single = slideToHtml(slides[0], 'paper');
  assert.ok(single.includes('position:relative'));
  assert.ok(single.includes('absolute'));
});

test('演示：Markdown 大纲 → 幻灯片', () => {
  const data = deckFromMarkdown(`# 项目汇报

## 背景

- 问题一
- 问题二

## 方案

1. 步骤一
2. 步骤二
`);
  assert.ok(data.slides.length >= 3, `应至少生成 3 页，实际 ${data.slides.length}`);
  const first = data.slides[0];
  assert.ok(first.elements.some((element) => element.type === 'heading' && element.text.includes('项目汇报')));
  const background = data.slides.find((slide) => slide.elements.some((element) => element.text?.includes('背景')));
  assert.ok(background, '应生成「背景」页');
  assert.ok(background.elements.some((element) => element.text?.includes('问题一')));
  const empty = deckFromMarkdown('');
  assert.ok(empty.slides.length >= 2, '空内容回退到默认演示');
  assert.equal(createDeckData().slides.length, 2);
});

test('HTML → Markdown：纯逻辑实现（无 DOM）', () => {
  const html = '<h1>标题</h1><p>一段 <strong>粗体</strong> 与 <em>斜体</em>，还有 <code>code</code> 与 <a href="https://x.y">链接</a>。</p>'
    + '<ul><li class="task" data-checked="true"><input type="checkbox" checked> 已完成</li><li>普通项</li></ul>'
    + '<blockquote><p>引用</p></blockquote>'
    + '<pre data-lang="js"><code>const a = 1;</code></pre>'
    + '<table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  const md = htmlStringToMarkdown(html);
  assert.ok(md.startsWith('# 标题'));
  assert.ok(md.includes('**粗体**'));
  assert.ok(md.includes('*斜体*'));
  assert.ok(md.includes('`code`'));
  assert.ok(md.includes('[链接](https://x.y)'));
  assert.ok(md.includes('- [x] 已完成'));
  assert.ok(md.includes('- 普通项'));
  assert.ok(md.includes('> 引用'));
  assert.ok(md.includes('```js\nconst a = 1;\n```'));
  assert.ok(md.includes('| A | B |'));
  assert.ok(md.includes('| :--- | ---: |'));
  assert.equal(htmlStringToMarkdown(''), '');
});

test('Markdown 往返：md → html → md 稳定收敛', () => {
  const sample = [
    '# 标题', '',
    '一段 **粗体** 与 *斜体*，还有 `code` 与 [链接](https://x.y)。', '',
    '## 二级', '',
    '- 项目一', '- 项目二', '- [x] 已完成', '- [ ] 未完成', '',
    '1. 一', '2. 二', '',
    '> 引用内容', '',
    '```js', 'const a = 1;', '```', '',
    '| A | B |', '| --- | ---: |', '| 1 | 2 |', '',
    '---', '',
  ].join('\n');
  const html = markdownToHtml(sample);
  const roundTrip = htmlStringToMarkdown(html);
  assert.equal(roundTrip, sample, '一次往返应当无损');
  assert.equal(markdownToHtml(roundTrip), html, '再次转换应得到完全相同的 HTML');
});

test('htmlToMarkdown 同时接受字符串和 DOM 节点', () => {
  assert.equal(htmlToMarkdown('<p>hi</p>'), 'hi\n');
  const fake = { innerHTML: '<h2>标题</h2>' };
  assert.equal(htmlToMarkdown(fake), '## 标题\n');
});
