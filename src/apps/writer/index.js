/**
 * index.js —— TriOffice Writer（文档）应用控制器。
 * 富文本编辑、大纲导航、查找替换、页面设置、导出 Markdown/HTML/纯文本/PDF。
 */
import { h, clear, qs, debounce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { button, openDialog, openMenu, toast, toastError, toastSuccess, icon, segmented, field } from '../../core/ui.js';
import { bus, EVENTS } from '../../core/bus.js';
import { History } from '../../core/history.js';
import { registerExporter, registerImporter, serializeDoc, withPreview, findExporter, importFile } from '../../core/format.js';
import { download, safeFileName, pickFiles, readDataUrl } from '../../core/fileio.js';
import { createAppFrame, exportMenuItems, showShortcuts, showAbout, applyTheme } from '../../shell/frame.js';
import {
  markdownToHtml, htmlStringToMarkdown, htmlToText, countText, buildStandaloneHtml, escapeHtml,
} from './markdown.js';

/* ------------------------------------------------------------------ *
 * 文档模型
 * ------------------------------------------------------------------ */
export function createWriterData() {
  return {
    html: '<h1>未命名文档</h1><p></p>',
    footer: '',
    pageSize: 'a4',
    orientation: 'portrait',
  };
}

function normalizeWriterData(raw) {
  const base = createWriterData();
  if (!raw || typeof raw !== 'object') return base;
  return {
    html: typeof raw.html === 'string' ? raw.html : base.html,
    footer: typeof raw.footer === 'string' ? raw.footer : '',
    pageSize: raw.pageSize === 'letter' ? 'letter' : 'a4',
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

const FONT_SIZES = {
  1: '11px', 2: '13px', 3: '15px', 4: '17px', 5: '20px', 6: '24px', 7: '30px',
};

const BLOCK_STYLES = [
  { id: 'p', labelKey: 'writer.paragraph' },
  { id: 'h1', labelKey: 'writer.h1' },
  { id: 'h2', labelKey: 'writer.h2' },
  { id: 'h3', labelKey: 'writer.h3' },
  { id: 'blockquote', labelKey: 'writer.quote' },
  { id: 'pre', labelKey: 'writer.codeBlock' },
];

const SWATCHES = ['#1a1d21', '#5f6368', '#9aa0a6', '#d93025', '#e8710a', '#f9ab00', '#188038', '#1a73e8', '#7b1fa2', '#ffffff'];

/* ------------------------------------------------------------------ *
 * 导入 / 导出注册
 * ------------------------------------------------------------------ */
registerExporter('doc', {
  id: 'md',
  label: 'Markdown (.md)',
  ext: 'md',
  mime: 'text/markdown;charset=utf-8',
  run: async (doc) => {
    const data = normalizeWriterData(doc.data);
    const text = htmlStringToMarkdown(data.html);
    return { filename: safeFileName(doc.title, 'md'), content: text, mime: 'text/markdown;charset=utf-8' };
  },
});

registerExporter('doc', {
  id: 'html',
  label: '网页文档 (.html)',
  ext: 'html',
  mime: 'text/html;charset=utf-8',
  run: async (doc) => {
    const data = normalizeWriterData(doc.data);
    const html = buildStandaloneHtml({ title: doc.title, html: data.html, footer: data.footer, pageSize: data.pageSize, orientation: data.orientation });
    return { filename: safeFileName(doc.title, 'html'), content: html, mime: 'text/html;charset=utf-8' };
  },
});

registerExporter('doc', {
  id: 'txt',
  label: '纯文本 (.txt)',
  ext: 'txt',
  mime: 'text/plain;charset=utf-8',
  run: async (doc) => {
    const data = normalizeWriterData(doc.data);
    return { filename: safeFileName(doc.title, 'txt'), content: htmlToText(data.html), mime: 'text/plain;charset=utf-8' };
  },
});

registerExporter('doc', {
  id: 'trio',
  label: 'TriOffice 文档 (.trio)',
  ext: 'trio',
  mime: 'application/json',
  run: async (doc) => ({ filename: safeFileName(doc.title, 'trio'), content: serializeDoc(doc), mime: 'application/json' }),
});

// .md 同时可能被演示模块注册为「大纲导入」，这里用更高优先级保证默认导入成文档
registerImporter(['md', 'markdown'], async (file, ctx) => {
  const text = await ctx.text;
  return { type: 'doc', title: file.name.replace(/\.[^.]+$/, ''), data: { ...createWriterData(), html: markdownToHtml(text) } };
}, { priority: 10 });

registerImporter(['txt'], async (file, ctx) => {
  const text = await ctx.text;
  const html = text.split(/\n{2,}/).map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('\n');
  return { type: 'doc', title: file.name.replace(/\.[^.]+$/, ''), data: { ...createWriterData(), html } };
});

registerImporter(['html', 'htm'], async (file, ctx) => {
  const text = await ctx.text;
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
  const inner = bodyMatch ? bodyMatch[1] : text.replace(/<[^>]*xml[^>]*>/gi, '');
  return {
    type: 'doc',
    title: file.name.replace(/\.[^.]+$/, ''),
    data: { ...createWriterData(), html: stripDangerous(inner) },
  };
});

/** 移除脚本/事件属性，避免导入的 HTML 带毒 */
function stripDangerous(html) {
  return String(html)
    .replace(/<(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

/* ------------------------------------------------------------------ *
 * 应用主体
 * ------------------------------------------------------------------ */
/**
 * @param {{doc: object, onSave: Function, onClose: Function}} options
 */
export function mountWriterApp({ doc, onSave, onClose }) {
  let data = normalizeWriterData(doc.data);
  doc.data = data;
  let dirty = false;
  let historyButtons = null;

  const history = new History({ limit: 150, onChange: () => refreshHistoryButtons() });

  const frame = createAppFrame({
    title: doc.title,
    iconName: 'doc',
    appLabel: t('home.doc'),
    menus: () => buildMenus(),
    toolbar: () => buildToolbar(),
    onTitleChange: (title) => {
      doc.title = title;
      goDirty();
    },
    onClose: () => onClose?.(),
    onSave: () => saveNow(),
  });

  /* ---------- 编辑器结构 ---------- */
  const paper = h('div.writer__paper', {
    contenteditable: 'true',
    spellcheck: 'false',
    role: 'textbox',
    'aria-multiline': 'true',
    'data-placeholder': t('writer.placeholder'),
    html: data.html,
  });
  const outlineList = h('div.writer__outline-list');
  const outlinePanel = h('aside.writer__outline', {}, [
    h('div.writer__outline-head', {}, [
      h('span', { text: t('writer.outline') }),
      h('span.writer__outline-count', { text: '0' }),
    ]),
    outlineList,
  ]);
  const zoomBadge = h('span.writer__zoom', { text: '100%' });
  const stage = h('div.writer__stage', {}, [paper]);
  const main = h('div.writer__main', {}, [stage]);
  const root = h('div.writer', {}, [outlinePanel, main]);
  frame.body.appendChild(root);

  /* ---------- 工具条状态 ---------- */
  let zoom = 1;

  function setZoom(value) {
    zoom = Math.max(0.5, Math.min(2, Math.round(value * 10) / 10));
    stage.style.setProperty('--writer-zoom', String(zoom));
    zoomBadge.textContent = `${Math.round(zoom * 100)}%`;
  }

  /* ---------- 菜单 ---------- */
  function buildMenus() {
    return [
      {
        label: t('menu.file'),
        items: [
          { label: t('menu.save'), icon: 'save', shortcut: 'Ctrl/⌘+S', onClick: () => saveNow() },
          { label: t('menu.import'), icon: 'upload', onClick: () => importInto() },
          { label: t('menu.export'), icon: 'download', onClick: () => openExportMenu() },
          ...exportMenuItems(doc, (id) => exportAs(id)).map((item) => ({ ...item, label: `　${item.label}` })),
          { separator: true },
          { label: t('menu.print'), icon: 'printer', shortcut: 'Ctrl/⌘+P', onClick: () => printDoc() },
          { label: t('writer.pageSetup'), icon: 'grid', onClick: () => pageSetupDialog() },
          { separator: true },
          { label: t('menu.close'), icon: 'chevron-left', onClick: () => onClose?.() },
        ],
      },
      {
        label: t('menu.edit'),
        items: [
          { label: t('writer.undo'), icon: 'undo', shortcut: 'Ctrl/⌘+Z', onClick: () => doUndo() },
          { label: t('writer.redo'), icon: 'redo', shortcut: 'Shift+Ctrl/⌘+Z', onClick: () => doRedo() },
          { separator: true },
          { label: t('writer.find'), icon: 'search', shortcut: 'Ctrl/⌘+F', onClick: () => findReplaceDialog() },
          { label: t('writer.clearFormat'), icon: 'eraser', onClick: () => exec('removeFormat') },
          { separator: true },
          { label: t('menu.shortcuts'), icon: 'info', onClick: () => showShortcuts() },
        ],
      },
      {
        label: t('menu.insert'),
        items: [
          { label: t('writer.image'), icon: 'image', onClick: () => insertImage() },
          { label: t('writer.table'), icon: 'table', onClick: () => tableDialog() },
          { label: t('writer.link'), icon: 'link', onClick: () => linkDialog() },
          { label: t('writer.hr'), icon: 'minus', onClick: () => exec('insertHorizontalRule') },
          { separator: true },
          { label: t('writer.checkList'), icon: 'checklist', onClick: () => insertTaskList() },
          { label: t('writer.codeBlock'), icon: 'code-block', onClick: () => exec('formatBlock', '<pre>') },
          { label: t('writer.quote'), icon: 'quote', onClick: () => exec('formatBlock', '<blockquote>') },
        ],
      },
      {
        label: t('menu.format'),
        items: [
          ...BLOCK_STYLES.map((item) => ({
            label: t(item.labelKey),
            checked: currentBlock() === item.id,
            onClick: () => exec('formatBlock', `<${item.id === 'p' ? 'p' : item.id}>`),
          })),
          { separator: true },
          { label: t('writer.bold'), icon: 'bold', shortcut: 'Ctrl/⌘+B', onClick: () => exec('bold') },
          { label: t('writer.italic'), icon: 'italic', shortcut: 'Ctrl/⌘+I', onClick: () => exec('italic') },
          { label: t('writer.underline'), icon: 'underline', shortcut: 'Ctrl/⌘+U', onClick: () => exec('underline') },
          { label: t('writer.strike'), icon: 'strike', onClick: () => exec('strikeThrough') },
        ],
      },
      {
        label: t('menu.view'),
        items: [
          {
            label: isDarkTheme() ? t('menu.light') : t('menu.theme'),
            icon: isDarkTheme() ? 'sun' : 'moon',
            onClick: () => {
              applyTheme(isDarkTheme() ? 'light' : 'dark');
              frame.refreshMenus();
              frame.renderActions();
            },
          },
          { separator: true },
          { label: '放大', icon: 'search', onClick: () => setZoom(zoom + 0.1) },
          { label: '缩小', icon: 'search', onClick: () => setZoom(zoom - 0.1) },
          { label: '100%', icon: 'search', onClick: () => setZoom(1) },
          { separator: true },
          { label: t('writer.outline'), icon: 'paragraph', onClick: () => outlinePanel.classList.toggle('is-collapsed') },
        ],
      },
      {
        label: t('menu.help'),
        items: [
          { label: t('dialog.shortcuts'), icon: 'info', onClick: () => showShortcuts() },
          { label: t('dialog.about'), icon: 'info', onClick: () => showAbout() },
        ],
      },
    ];
  }

  /* ---------- 工具条 ---------- */
  function buildToolbar() {
    const group = (children) => h('div.toolbar__group', {}, children);
    const styleItems = BLOCK_STYLES.map((item) => ({ value: item.id, label: t(item.labelKey) }));
    const styleSelect = h('select.toolbar__select', {
      onchange: (event) => exec('formatBlock', `<${event.target.value === 'p' ? 'p' : event.target.value}>`),
    }, styleItems.map((item) => h('option', { value: item.value, text: item.label })));
    styleSelect.value = currentBlock();

    const sizeSelect = h('select.toolbar__select.toolbar__select--narrow', {
      onchange: (event) => exec('fontSize', event.target.value),
    }, Object.keys(FONT_SIZES).map((key) => h('option', { value: key, text: FONT_SIZES[key].replace('px', '') })));
    sizeSelect.value = '3';

    return [
      group([
        (() => {
          const undo = button({ icon: 'undo', title: t('writer.undo'), variant: 'toolbar', hideLabel: true, disabled: !history.canUndo, onClick: () => doUndo() });
          const redo = button({ icon: 'redo', title: t('writer.redo'), variant: 'toolbar', hideLabel: true, disabled: !history.canRedo, onClick: () => doRedo() });
          historyButtons = { undo, redo };
          return undo;
        })(),
        (() => {
          const redo = button({ icon: 'redo', title: t('writer.redo'), variant: 'toolbar', hideLabel: true, disabled: !history.canRedo, onClick: () => doRedo() });
          historyButtons.redo = redo;
          return redo;
        })(),
      ]),
      group([styleSelect, sizeSelect]),
      group([
        button({ icon: 'bold', title: t('writer.bold'), variant: 'toolbar', hideLabel: true, active: isActive('bold'), onClick: () => exec('bold') }),
        button({ icon: 'italic', title: t('writer.italic'), variant: 'toolbar', hideLabel: true, active: isActive('italic'), onClick: () => exec('italic') }),
        button({ icon: 'underline', title: t('writer.underline'), variant: 'toolbar', hideLabel: true, active: isActive('underline'), onClick: () => exec('underline') }),
        button({ icon: 'strike', title: t('writer.strike'), variant: 'toolbar', hideLabel: true, active: isActive('strikeThrough'), onClick: () => exec('strikeThrough') }),
        button({ icon: 'code', title: t('writer.code'), variant: 'toolbar', hideLabel: true, onClick: () => wrapInline('code') }),
      ]),
      group([
        button({ icon: 'palette', title: t('writer.textColor'), variant: 'toolbar', hideLabel: true, onClick: (event) => colorMenu(event.currentTarget, 'foreColor') }),
        button({ icon: 'paint', title: t('writer.highlight'), variant: 'toolbar', hideLabel: true, onClick: (event) => highlightMenu(event.currentTarget) }),
      ]),
      group([
        button({ icon: 'list-ul', title: t('writer.bulletList'), variant: 'toolbar', hideLabel: true, onClick: () => exec('insertUnorderedList') }),
        button({ icon: 'list-ol', title: t('writer.numberList'), variant: 'toolbar', hideLabel: true, onClick: () => exec('insertOrderedList') }),
        button({ icon: 'checklist', title: t('writer.checkList'), variant: 'toolbar', hideLabel: true, onClick: () => insertTaskList() }),
      ]),
      group([
        button({ icon: 'align-left', title: t('writer.alignLeft'), variant: 'toolbar', hideLabel: true, onClick: () => exec('justifyLeft') }),
        button({ icon: 'align-center', title: t('writer.alignCenter'), variant: 'toolbar', hideLabel: true, onClick: () => exec('justifyCenter') }),
        button({ icon: 'align-right', title: t('writer.alignRight'), variant: 'toolbar', hideLabel: true, onClick: () => exec('justifyRight') }),
        button({ icon: 'align-justify', title: t('writer.alignJustify'), variant: 'toolbar', hideLabel: true, onClick: () => exec('justifyFull') }),
      ]),
      group([
        button({ icon: 'link', title: t('writer.link'), variant: 'toolbar', hideLabel: true, onClick: () => linkDialog() }),
        button({ icon: 'image', title: t('writer.image'), variant: 'toolbar', hideLabel: true, onClick: () => insertImage() }),
        button({ icon: 'table', title: t('writer.table'), variant: 'toolbar', hideLabel: true, onClick: () => tableDialog() }),
        button({ icon: 'minus', title: t('writer.hr'), variant: 'toolbar', hideLabel: true, onClick: () => exec('insertHorizontalRule') }),
      ]),
      group([
        button({ icon: 'search', label: t('writer.find'), variant: 'toolbar', onClick: () => findReplaceDialog() }),
        button({ icon: 'printer', label: t('menu.print'), variant: 'toolbar', onClick: () => printDoc() }),
        zoomBadge,
      ]),
    ];
  }

  /* ---------- 编辑命令 ---------- */
  function exec(command, value) {
    paper.focus();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(command, false, value);
    scheduleSnapshot();
    refreshOutline();
  }

  function currentBlock() {
    const selection = window.getSelection();
    let node = selection?.anchorNode;
    while (node && node !== paper) {
      if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        if (['h1', 'h2', 'h3', 'blockquote', 'pre', 'p', 'li'].includes(tag)) return tag === 'li' ? 'p' : tag;
      }
      node = node.parentNode;
    }
    return 'p';
  }

  function isActive(command) {
    try {
      return document.queryCommandState(command);
    } catch {
      return false;
    }
  }

  function wrapInline(tag) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      exec('insertHTML', `<${tag}></${tag}>`);
      return;
    }
    const text = selection.toString();
    exec('insertHTML', `<${tag}>${escapeHtml(text)}</${tag}>`);
  }

  function colorMenu(anchor, command) {
    openMenu(anchor, SWATCHES.map((color) => ({
      label: color,
      onClick: () => exec(command, color),
    })), { width: 170 });
  }

  function highlightMenu(anchor) {
    openMenu(anchor, [
      { label: '#fff3bf', onClick: () => exec('hiliteColor', '#fff3bf') },
      { label: '#d3f9d8', onClick: () => exec('hiliteColor', '#d3f9d8') },
      { label: '#d0ebff', onClick: () => exec('hiliteColor', '#d0ebff') },
      { label: '#ffe3e3', onClick: () => exec('hiliteColor', '#ffe3e3') },
      { label: '#f3d9fa', onClick: () => exec('hiliteColor', '#f3d9fa') },
      { separator: true },
      { label: t('common.nothing'), icon: 'close', onClick: () => exec('hiliteColor', 'transparent') },
    ], { width: 170 });
  }

  function insertTaskList() {
    exec('insertHTML', '<ul class="task-list"><li class="task" data-checked="false"><input type="checkbox"> 待办事项</li></ul><p><br></p>');
  }

  function linkDialog() {
    const urlInput = h('input.field__input', { type: 'text', placeholder: 'https://', autofocus: true });
    const textInput = h('input.field__input', { type: 'text', placeholder: t('common.nothing') });
    openDialog({
      title: t('dialog.insertLink'),
      width: 460,
      body: h('div.dialog__form', {}, [
        field(t('writer.linkUrl'), urlInput),
        field('链接文字', textInput),
      ]),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          variant: 'primary',
          onClick: (close) => {
            const url = urlInput.value.trim();
            if (!url) return;
            close();
            const text = textInput.value.trim();
            if (text) exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
            else exec('createLink', url);
          },
        },
      ],
    });
  }

  function tableDialog() {
    const rowsInput = h('input.field__input', { type: 'number', value: '3', min: '1', max: '50' });
    const colsInput = h('input.field__input', { type: 'number', value: '3', min: '1', max: '20' });
    openDialog({
      title: t('dialog.insertTable'),
      width: 420,
      body: h('div.dialog__form.dialog__form--row', {}, [
        field(t('writer.tableRows'), rowsInput),
        field(t('writer.tableCols'), colsInput),
      ]),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          variant: 'primary',
          onClick: (close) => {
            const rows = Math.max(1, Math.min(50, Number(rowsInput.value) || 3));
            const cols = Math.max(1, Math.min(20, Number(colsInput.value) || 3));
            close();
            const head = `<tr>${Array.from({ length: cols }, (_, index) => `<th>列 ${index + 1}</th>`).join('')}</tr>`;
            const body = Array.from({ length: Math.max(1, rows - 1) }, () => `<tr>${Array.from({ length: cols }, () => '<td><br></td>').join('')}</tr>`).join('');
            exec('insertHTML', `<table><thead>${head}</thead><tbody>${body}</tbody></table><p><br></p>`);
          },
        },
      ],
    });
  }

  async function insertImage() {
    const files = await pickFiles({ accept: 'image/*' });
    if (!files.length) return;
    const dataUrl = await readDataUrl(files[0]);
    if (dataUrl.length > 3_500_000) {
      toast(t('toast.notSupported'), 'warn');
      return;
    }
    exec('insertHTML', `<img src="${dataUrl}" alt="${escapeHtml(files[0].name)}">`);
  }

  /* ---------- 大纲 ---------- */
  function refreshOutline() {
    const headings = Array.from(paper.querySelectorAll('h1, h2, h3'));
    clear(outlineList);
    qs('.writer__outline-count', outlinePanel).textContent = String(headings.length);
    if (!headings.length) {
      outlineList.appendChild(h('p.writer__outline-empty', { text: t('writer.noOutline') }));
      return;
    }
    headings.forEach((heading) => {
      const level = Number(heading.tagName[1]);
      outlineList.appendChild(h('button.writer__outline-item', {
        class: `is-h${level}`,
        type: 'button',
        text: heading.textContent.trim() || '—',
        onclick: () => {
          heading.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const range = document.createRange();
          range.selectNodeContents(heading);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        },
      }));
    });
  }

  /* ---------- 统计 ---------- */
  function updateStats() {
    const text = htmlToText(paper.innerHTML);
    const stats = countText(text);
    frame.setStatusBar([
      h('span.writer__stat', { text: `${t('writer.words')} ${stats.words}` }),
      h('span.writer__stat', { text: `${t('writer.chars')} ${stats.chars}` }),
      h('span.writer__stat', { text: `${t('writer.wordsNoSpace')} ${stats.charsNoSpace}` }),
      h('span.writer__stat', { text: `${t('writer.paras')} ${stats.paragraphs}` }),
      h('span.writer__stat', { text: data.pageSize.toUpperCase() }),
    ]);
    return stats;
  }

  /* ---------- 历史 / 脏标记 ---------- */
  function snapshot() {
    return { html: paper.innerHTML, footer: data.footer, pageSize: data.pageSize, orientation: data.orientation };
  }

  const commitSnapshot = debounce(() => {
    history.commit('编辑', snapshot());
  }, 600);

  function scheduleSnapshot() {
    goDirty();
    commitSnapshot();
  }

  function goDirty() {
    dirty = true;
    frame.setDirty(true);
  }

  function refreshHistoryButtons() {
    if (!historyButtons) return;
    historyButtons.undo.disabled = !history.canUndo;
    historyButtons.redo.disabled = !history.canRedo;
  }

  function doUndo() {
    const state = history.undo();
    if (!state) return;
    applyState(state);
  }

  function doRedo() {
    const state = history.redo();
    if (!state) return;
    applyState(state);
  }

  function applyState(state) {
    data = normalizeWriterData({ ...data, ...state });
    doc.data = data;
    paper.innerHTML = data.html;
    goDirty();
    refreshOutline();
    updateStats();
  }

  /* ---------- 查找替换 ---------- */
  function findReplaceDialog() {
    const findInput = h('input.field__input', { type: 'text', autofocus: true });
    const replaceInput = h('input.field__input', { type: 'text' });
    const matchCase = h('input', { type: 'checkbox' });
    const info = h('p.field__hint');

    const collectTextNodes = () => {
      const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      return nodes;
    };

    const findNext = () => {
      const needle = findInput.value;
      if (!needle) return;
      const haystack = collectTextNodes();
      const flags = matchCase.checked ? '' : 'i';
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      let total = 0;
      let first = null;
      for (const node of haystack) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(node.nodeValue))) {
          total += 1;
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          if (!first) first = range;
          if (match[0].length === 0) break;
        }
      }
      info.textContent = total ? `共 ${total} 处匹配` : '未找到匹配内容';
      if (first) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(first);
        first.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      }
    };

    const replaceAll = () => {
      const needle = findInput.value;
      if (!needle) return;
      const flags = matchCase.checked ? 'g' : 'gi';
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      let count = 0;
      for (const node of collectTextNodes()) {
        const next = node.nodeValue.replace(re, () => {
          count += 1;
          return replaceInput.value;
        });
        if (next !== node.nodeValue) node.nodeValue = next;
      }
      info.textContent = t('writer.replaceDone', { n: count });
      if (count) scheduleSnapshot();
      refreshOutline();
      updateStats();
    };

    openDialog({
      title: `${t('writer.find')} / ${t('writer.replace')}`,
      width: 480,
      body: h('div.dialog__form', {}, [
        field(t('writer.find'), findInput),
        field(t('writer.replace'), replaceInput),
        h('label.checkbox', {}, [matchCase, h('span', { text: '区分大小写' })]),
        info,
      ]),
      actions: [
        { label: t('writer.findNext'), onClick: findNext },
        { label: t('writer.replaceAll'), variant: 'primary', onClick: replaceAll },
      ],
    });
    findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') findNext();
    });
  }

  /* ---------- 页面设置 ---------- */
  function pageSetupDialog() {
    let pageSize = data.pageSize;
    let orientation = data.orientation;
    const footerInput = h('input.field__input', { type: 'text', value: data.footer, placeholder: t('writer.footer') });
    openDialog({
      title: t('writer.pageSetup'),
      width: 440,
      body: h('div.dialog__form', {}, [
        h('label.field__label', { text: '纸张' }),
        segmented([{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }], pageSize, (value) => {
          pageSize = value;
        }),
        h('label.field__label', { text: '方向' }),
        segmented([
          { value: 'portrait', label: '纵向', icon: 'text' },
          { value: 'landscape', label: '横向', icon: 'columns' },
        ], orientation, (value) => {
          orientation = value;
        }),
        field(t('writer.footer'), footerInput),
      ]),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          variant: 'primary',
          onClick: (close) => {
            close();
            data.pageSize = pageSize;
            data.orientation = orientation;
            data.footer = footerInput.value;
            applyPageStyle();
            scheduleSnapshot();
          },
        },
      ],
    });
  }

  function applyPageStyle() {
    paper.dataset.size = data.pageSize;
    paper.dataset.orientation = data.orientation;
    const footerNode = qs('.writer__footer', root);
    if (data.footer) {
      if (footerNode) footerNode.textContent = data.footer;
      else root.appendChild(h('div.writer__footer', { text: data.footer, style: { display: 'none' } }));
    } else if (footerNode) {
      footerNode.remove();
    }
  }

  /* ---------- 保存 / 导出 ---------- */
  function documentSnapshot() {
    const text = htmlToText(paper.innerHTML);
    const stats = countText(text);
    const next = {
      ...doc,
      data: { ...data, html: paper.innerHTML },
      stats: { words: stats.words, chars: stats.chars },
    };
    return withPreview(next, text, { words: stats.words, chars: stats.chars });
  }

  async function saveNow() {
    const snapshotDoc = documentSnapshot();
    Object.assign(doc, snapshotDoc);
    data = normalizeWriterData(doc.data);
    await onSave?.(snapshotDoc);
    dirty = false;
    frame.setDirty(false);
    frame.setStatus(t('common.saved'), 'ok', 1500);
    return snapshotDoc;
  }

  async function exportAs(id) {
    const exporter = findExporter(doc.type, id);
    if (!exporter) return;
    try {
      const result = await exporter.run(documentSnapshot());
      download(result.content, result.filename, result.mime || exporter.mime);
      toastSuccess(t('toast.exported', { name: result.filename }));
    } catch (err) {
      toastError(t('toast.importFailed', { msg: err.message }));
    }
  }

  function openExportMenu() {
    openMenu(qs('.app__title', frame.el) || frame.el, exportMenuItems(doc, (id) => exportAs(id)));
  }

  async function importInto() {
    const files = await pickFiles({ accept: '.md,.markdown,.txt,.html,.htm,.trio,.json' });
    if (!files.length) return;
    try {
      const { doc: imported } = await importFile(files[0]);
      if (imported.type !== 'doc') {
        toastError('请选择文档类文件（.md/.txt/.html/.trio）');
        return;
      }
      data = normalizeWriterData(imported.data);
      doc.data = data;
      paper.innerHTML = data.html;
      if (imported.title) {
        doc.title = imported.title;
        frame.setTitle(imported.title);
      }
      history.reset(snapshot());
      goDirty();
      refreshOutline();
      updateStats();
      toastSuccess(t('toast.imported', { name: files[0].name }));
    } catch (err) {
      toastError(t('toast.importFailed', { msg: err.message }));
    }
  }

  function printDoc() {
    const html = buildStandaloneHtml({
      title: doc.title,
      html: paper.innerHTML,
      footer: data.footer,
      pageSize: data.pageSize,
      orientation: data.orientation,
    });
    const frame2 = document.createElement('iframe');
    frame2.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame2);
    frame2.contentDocument.open();
    frame2.contentDocument.write(html);
    frame2.contentDocument.close();
    setTimeout(() => {
      try {
        frame2.contentWindow.focus();
        frame2.contentWindow.print();
      } finally {
        setTimeout(() => frame2.remove(), 1500);
      }
    }, 250);
  }

  /* ---------- 事件绑定 ---------- */
  const onInput = () => {
    scheduleSnapshot();
    refreshOutline();
    updateStats();
  };
  paper.addEventListener('input', onInput);
  paper.addEventListener('keyup', () => {
    if (document.activeElement === paper) refreshToolbarState();
  });
  paper.addEventListener('mouseup', () => refreshToolbarState());
  paper.addEventListener('paste', (event) => {
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain');
    if (!html && text) return;
    if (html) {
      event.preventDefault();
      exec('insertHTML', stripDangerous(html));
    }
  });

  // 任务列表勾选
  paper.addEventListener('change', (event) => {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement && checkbox.type === 'checkbox') {
      const li = checkbox.closest('li');
      if (li) li.dataset.checked = String(checkbox.checked);
      scheduleSnapshot();
    }
  });

  // 表格内 Tab 跳转
  paper.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      const cell = window.getSelection()?.anchorNode?.parentElement?.closest('td, th');
      if (cell) {
        event.preventDefault();
        const cells = Array.from(paper.querySelectorAll('td, th'));
        const index = cells.indexOf(cell);
        const next = cells[index + (event.shiftKey ? -1 : 1)];
        if (next) {
          const range = document.createRange();
          range.selectNodeContents(next);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      const li = window.getSelection()?.anchorNode?.parentElement?.closest('li.task');
      if (li && !li.textContent.trim().replace(/^待办事项$/, '')) {
        // 空任务项回车退出列表
        event.preventDefault();
        exec('insertParagraph');
        exec('insertHTML', '<p><br></p>');
      }
    }
  });

  let refreshToolbarTimer = null;
  function refreshToolbarState() {
    clearTimeout(refreshToolbarTimer);
    refreshToolbarTimer = setTimeout(() => {
      frame.setToolbar(buildToolbar());
    }, 60);
  }

  const onGlobalKey = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
    } else if (mod && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      printDoc();
    }
  };
  window.addEventListener('keydown', onGlobalKey);

  /* ---------- 初始化 ---------- */
  applyPageStyle();
  refreshOutline();
  updateStats();
  history.reset(snapshot());
  refreshHistoryButtons();
  frame.setToolbar(buildToolbar());   // 同步先出一版，避免工具栏闪空
  frame.renderChrome();
  bus.emit(EVENTS.DOC_OPENED, { id: doc.id, type: 'doc' });

  return {
    el: frame.el,
    save: saveNow,
    isDirty: () => dirty,
    destroy() {
      window.removeEventListener('keydown', onGlobalKey);
      clearTimeout(refreshToolbarTimer);
      commitSnapshot.cancel?.();
      frame.el.__dispose?.();
    },
  };
}

function isDarkTheme() {
  return document.documentElement.dataset.theme === 'dark';
}
