/**
 * markdown.js —— Markdown ↔ HTML 转换（纯逻辑，无 DOM 依赖的解析部分）。
 *
 * markdownToHtml：GFM 子集（标题、粗体/斜体/删除线、行内代码、链接、图片、
 *                 有序/无序/任务列表、引用、代码块、表格、分割线、段落、换行）。
 * htmlToMarkdown：接收 DOM 节点，输出 Markdown 文本（在浏览器中运行）。
 */

import { parseXml } from '../../core/xml.js';

const INLINE_RULES = [
  { re: /`([^`]+)`/g, html: (m, code) => `<code>${escapeHtml(code)}</code>` },
  { re: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, html: (m, alt, src, title) => `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''}>` },
  { re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, html: (m, text, href, title) => `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''}>${text}</a>` },
  { re: /\*\*\*([^*]+)\*\*\*/g, html: (m, text) => `<strong><em>${text}</em></strong>` },
  { re: /\*\*([^*]+)\*\*/g, html: (m, text) => `<strong>${text}</strong>` },
  { re: /__([^_]+)__/g, html: (m, text) => `<strong>${text}</strong>` },
  { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/g, html: (m, text) => `<em>${text}</em>` },
  { re: /(?<![_\w])_([^_\n]+)_(?!_)/g, html: (m, text) => `<em>${text}</em>` },
  { re: /~~([^~]+)~~/g, html: (m, text) => `<del>${text}</del>` },
  { re: /==([^=]+)==/g, html: (m, text) => `<mark>${text}</mark>` },
  { re: /  $/gm, html: () => '<br>\n' },
];

/** 转义 HTML */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/** 行内 Markdown → HTML */
export function inlineToHtml(text) {
  let out = escapeHtml(String(text));
  // 先把代码片段摘出来，避免内部被其他规则处理
  const stash = [];
  out = out.replace(/`([^`]+)`/g, (m, code) => {
    stash.push(code);
    return `\u0000${stash.length - 1}\u0000`;
  });
  for (const rule of INLINE_RULES) {
    if (rule.re.source.startsWith('`')) continue;
    out = out.replace(rule.re, rule.html);
  }
  out = out.replace(/\u0000(\d+)\u0000/g, (m, index) => `<code>${stash[Number(index)]}</code>`);
  return out;
}

/** 行内 HTML → Markdown（浏览器） */
function inlineToMarkdown(text) {
  return text;
}

/**
 * Markdown 文本 → HTML。
 * @param {string} source
 * @returns {string}
 */
export function markdownToHtml(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').replace(/^\ufeff/, '').split('\n');
  const html = [];
  let i = 0;

  const paragraphBuffer = [];
  const flushParagraph = () => {
    if (!paragraphBuffer.length) return;
    const text = paragraphBuffer.join('\n');
    html.push(`<p>${inlineToHtml(text)}</p>`);
    paragraphBuffer.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[2][0];
      const lang = fence[3] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      html.push(`<pre data-lang="${escapeAttr(lang)}"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph();
      html.push('<hr>');
      i += 1;
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${inlineToHtml(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>/.test(line)) {
      flushParagraph();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushParagraph();
      const parseRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const header = parseRow(line);
      const aligns = parseRow(lines[i + 1]).map((cell) => {
        if (/^:-+:$/.test(cell)) return 'center';
        if (/^-+:$/.test(cell)) return 'right';
        if (/^:-+$/.test(cell)) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i += 1;
      }
      const head = header.map((cell, index) => `<th${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${inlineToHtml(cell)}</th>`).join('');
      const body = rows.map((row) => `<tr>${header.map((_, index) => `<td${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${inlineToHtml(row[index] || '')}</td>`).join('')}</tr>`).join('');
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // 列表
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (i < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!match) break;
        if (/\d/.test(match[2]) !== ordered) break;
        let text = match[3];
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          items.push(`<li class="task" data-checked="${checked}"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${inlineToHtml(task[2])}</li>`);
        } else {
          items.push(`<li>${inlineToHtml(text)}</li>`);
        }
        i += 1;
        // 列表项续行
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) {
          text += ` ${lines[i].trim()}`;
          items[items.length - 1] = task
            ? items[items.length - 1]
            : `<li>${inlineToHtml(text)}</li>`;
          i += 1;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraphBuffer.push(line);
    i += 1;
  }
  flushParagraph();
  return html.join('\n');
}

/* ------------------------------------------------------------------ *
 * HTML → Markdown（纯逻辑实现，浏览器与 Node 通用）
 * ------------------------------------------------------------------ */
/**
 * HTML 字符串 → Markdown。
 * 用项目自带的极简 XML 解析器还原结构，因此不依赖 DOM，可以在 Node 里跑单测。
 * @param {string} html
 * @returns {string}
 */
export function htmlStringToMarkdown(html) {
  const source = String(html ?? '').trim();
  if (!source) return '';
  let root;
  try {
    root = parseXml(`<tri-root>${source}</tri-root>`, { keepTextNodes: true });
  } catch {
    return `${htmlToText(source)}\n`;
  }
  const blocks = [];
  for (const child of root.children) {
    const block = blockToMarkdown(child);
    if (block !== null && block !== '') blocks.push(block);
  }
  const text = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? `${text}\n` : '';
}

/**
 * DOM 节点或 HTML 字符串 → Markdown。
 * @param {Node|string} input
 */
export function htmlToMarkdown(input) {
  if (typeof input === 'string') return htmlStringToMarkdown(input);
  if (input && typeof input.innerHTML === 'string') return htmlStringToMarkdown(input.innerHTML);
  return '';
}

/** 节点是否是文本节点 */
const isTextNode = (node) => Boolean(node && (node.textNode || node.name === '#text'));

/** 元素的 class 列表 */
function classList(node) {
  return String(node?.attrs?.class || '').split(/\s+/).filter(Boolean);
}

/** 按名字查找后代元素 */
function findDescendants(node, name, out = []) {
  for (const child of node.children || []) {
    if (child.name === name) out.push(child);
    findDescendants(child, name, out);
  }
  return out;
}

function blockToMarkdown(node) {
  if (!node) return null;
  if (isTextNode(node)) {
    const text = String(node.text || '').trim();
    return text || null;
  }
  const tag = node.name;

  switch (tag) {
    case 'tri-root':
      return null;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${'#'.repeat(Number(tag[1]))} ${inlineToMd(node).trim()}`;
    case 'p':
      return inlineToMd(node).trim() || null;
    case 'div': {
      const inner = node.children.map(blockToMarkdown).filter((item) => item !== null && item !== '');
      return inner.join('\n\n') || null;
    }
    case 'br':
      return '';
    case 'hr':
      return '---';
    case 'blockquote': {
      const inner = node.children.map(blockToMarkdown).filter(Boolean).join('\n\n');
      return inner.split('\n').map((line) => `> ${line}`).join('\n');
    }
    case 'pre': {
      const code = findDescendants(node, 'code')[0];
      const raw = (code || node).text.replace(/\n$/, '');
      const lang = node.attrs?.['data-lang'] || '';
      return `\`\`\`${lang}\n${raw}\n\`\`\``;
    }
    case 'ul':
    case 'ol': {
      const items = [];
      let index = 1;
      for (const li of node.children) {
        if (li.name !== 'li') continue;
        const isTask = classList(li).includes('task') || li.attrs?.['data-checked'] !== undefined
          || findDescendants(li, 'input').length > 0;
        const checked = li.attrs?.['data-checked'] === 'true'
          || findDescendants(li, 'input').some((input) => input.attrs?.checked !== undefined);
        const prefix = isTask ? `- [${checked ? 'x' : ' '}]` : (tag === 'ol' ? `${index}.` : '-');
        items.push(`${prefix} ${inlineToMd(li).trim()}`);
        index += 1;
      }
      return items.join('\n');
    }
    case 'table': {
      const rows = findDescendants(node, 'tr');
      if (!rows.length) return null;
      const cellText = (cell) => inlineToMd(cell).replace(/\|/g, '\\|').trim();
      const alignOf = (cell) => {
        const style = cell.attrs?.style || '';
        const match = /text-align:\s*(left|center|right)/.exec(style);
        const align = match ? match[1] : cell.attrs?.align || '';
        if (align === 'center') return ':---:';
        if (align === 'right') return '---:';
        if (align === 'left') return ':---';
        return '---';
      };
      const headerCells = rows[0].children.filter((cell) => cell.name === 'th' || cell.name === 'td');
      if (!headerCells.length) return null;
      const body = rows.slice(1).map((row) => {
        const cells = row.children.filter((cell) => cell.name === 'td' || cell.name === 'th');
        return `| ${cells.map(cellText).join(' | ')} |`;
      });
      return [
        `| ${headerCells.map(cellText).join(' | ')} |`,
        `| ${headerCells.map(alignOf).join(' | ')} |`,
        ...body,
      ].join('\n');
    }
    default:
      return inlineToMd(node).trim() || null;
  }
}

/** 行内元素 → Markdown */
function inlineToMd(node) {
  let out = '';
  const walk = (current) => {
    if (isTextNode(current)) {
      out += String(current.text || '').replace(/([*_`~[\]\\])/g, '\\$1');
      return;
    }
    const tag = current.name;
    const before = out.length;
    switch (tag) {
      case 'strong':
      case 'b':
        out = `${out.slice(0, before)}**${childrenMarkdown(current).trim()}**`;
        return;
      case 'em':
      case 'i':
        out = `${out.slice(0, before)}*${childrenMarkdown(current).trim()}*`;
        return;
      case 'del':
      case 's':
      case 'strike':
        out = `${out.slice(0, before)}~~${childrenMarkdown(current).trim()}~~`;
        return;
      case 'mark':
        out = `${out.slice(0, before)}==${childrenMarkdown(current).trim()}==`;
        return;
      case 'code':
        out = `${out.slice(0, before)}\`${current.text}\``;
        return;
      case 'u':
        out = `${out.slice(0, before)}<u>${childrenMarkdown(current)}</u>`;
        return;
      case 'sub':
        out = `${out.slice(0, before)}<sub>${childrenMarkdown(current)}</sub>`;
        return;
      case 'sup':
        out = `${out.slice(0, before)}<sup>${childrenMarkdown(current)}</sup>`;
        return;
      case 'br':
        out = `${out.slice(0, before)}  \n`;
        return;
      case 'a': {
        const href = current.attrs?.href || '';
        const title = current.attrs?.title;
        out = `${out.slice(0, before)}[${childrenMarkdown(current)}](${href}${title ? ` "${title}"` : ''})`;
        return;
      }
      case 'img': {
        const src = current.attrs?.src || '';
        const alt = current.attrs?.alt || '';
        out = `${out.slice(0, before)}![${alt}](${src})`;
        return;
      }
      case 'span':
      case 'font': {
        let inner = childrenMarkdown(current);
        const style = current.attrs?.style || '';
        if (/font-weight:\s*(bold|[6-9]00)/.test(style)) inner = `**${inner}**`;
        if (/font-style:\s*italic/.test(style)) inner = `*${inner}*`;
        if (/line-through/.test(style)) inner = `~~${inner}~~`;
        const color = /color:\s*([^;]+)/.exec(style);
        if (color) inner = `<span style="color:${color[1].trim()}">${inner}</span>`;
        out = `${out.slice(0, before)}${inner}`;
        return;
      }
      default:
        for (const child of current.children || []) walk(child);
        return;
    }
  };

  for (const child of node.children || []) walk(child);
  if (!node.children?.length && node.text) {
    out += String(node.text).replace(/([*_`~[\]\\])/g, '\\$1');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

/** 直接拼接子节点的 Markdown（供行内标签包裹使用） */
function childrenMarkdown(node) {
  if (node.name === 'code') return node.text;
  let out = '';
  const collect = (current) => {
    if (isTextNode(current)) {
      out += String(current.text || '').replace(/([*_`~[\]\\])/g, '\\$1');
      return;
    }
    out += inlineToMd(current);
  };
  for (const child of node.children || []) collect(child);
  if (!node.children?.length && node.text) out += node.text;
  return out;
}

/** HTML → 纯文本 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 统计字数（中文按字计，英文按词计） */
export function countText(text) {
  const source = String(text ?? '');
  const cjk = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const words = (source.replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  const chars = [...source].length;
  const charsNoSpace = source.replace(/\s/g, '').length;
  const paras = source.split(/\n{1,}/).filter((line) => line.trim()).length;
  return { words: cjk + words, cjk, en: words, chars, charsNoSpace, paragraphs: paras };
}

/** 生成独立的 HTML 文档（导出用） */
export function buildStandaloneHtml({ title, html, footer, pageSize = 'a4', orientation = 'portrait' }) {
  const size = pageSize === 'letter' ? 'letter' : 'A4';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'TriOffice 文档')}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .page { box-sizing: border-box; width: ${size === 'letter' ? '8.5in' : '210mm'}; min-height: ${orientation === 'landscape' ? '8.27in' : '297mm'}; margin: 24px auto; padding: 22mm 18mm; background: #fff; box-shadow: 0 2px 16px rgba(16,24,40,.08); color: #1a1d21; line-height: 1.75; font-size: 15px; }
  .page h1 { font-size: 1.85em; margin: .6em 0 .5em; } .page h2 { font-size: 1.45em; } .page h3 { font-size: 1.2em; }
  .page p { margin: .75em 0; } .page blockquote { margin: 1em 0; padding: .4em 1em; border-left: 3px solid #4f7cf7; background: #f7f9ff; color: #414856; }
  .page pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; font-size: 13px; }
  .page code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; padding: 1px 5px; border-radius: 4px; font-size: .92em; }
  .page pre code { background: none; padding: 0; }
  .page table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  .page th, .page td { border: 1px solid #dfe3e8; padding: 7px 10px; }
  .page th { background: #f6f8fa; }
  .page img { max-width: 100%; }
  .page mark { background: #fff3bf; }
  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e6e9ee; color: #8a9099; font-size: 12px; text-align: center; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; padding: 0; } @page { size: ${size} ${orientation}; margin: 18mm; } }
</style>
</head>
<body data-size="${size}" data-orientation="${orientation}">
<article class="page">
${html || ''}
${footer ? `<div class="footer">${escapeHtml(footer)}</div>` : ''}
</article>
</body>
</html>`;
}
