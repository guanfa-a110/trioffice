/**
 * index.js —— TriOffice Deck（演示）应用控制器。
 * 幻灯片列表、拖拽缩放编辑、主题、版式、演讲者备注、全屏放映、独立 HTML 导出。
 */
import { h, clear, qs, debounce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { button, openMenu, toast, toastError, toastSuccess, icon } from '../../core/ui.js';
import { bus, EVENTS } from '../../core/bus.js';
import { History } from '../../core/history.js';
import { registerExporter, registerImporter, serializeDoc, withPreview, findExporter, importFile } from '../../core/format.js';
import { download, safeFileName, pickFiles, readDataUrl } from '../../core/fileio.js';
import { createAppFrame, exportMenuItems, showShortcuts, showAbout, applyTheme } from '../../shell/frame.js';
import { THEME_LIST, getTheme, CANVAS, TRANSITIONS, LAYOUTS } from './themes.js';
import { createSlide, renderSlideNode, buildDeckHtml, elementDefaults } from './render.js';

/* ------------------------------------------------------------------ *
 * 文档模型
 * ------------------------------------------------------------------ */
export function createDeckData() {
  const theme = getTheme('aurora');
  return {
    theme: theme.id,
    canvas: { ...CANVAS },
    slides: [
      createSlide('title', theme, 0),
      createSlide('titleBody', theme, 1),
    ],
  };
}

function normalizeDeckData(raw) {
  const base = createDeckData();
  if (!raw || typeof raw !== 'object') return base;
  const slides = Array.isArray(raw.slides) && raw.slides.length
    ? raw.slides.map((slide) => ({
      id: slide.id || `s${Math.random().toString(36).slice(2, 8)}`,
      layout: slide.layout || 'blank',
      transition: slide.transition || 'fade',
      notes: slide.notes || '',
      background: slide.background || null,
      elements: Array.isArray(slide.elements) ? slide.elements.map((element) => ({ ...element })) : [],
    }))
    : base.slides;
  return {
    theme: getTheme(raw.theme).id,
    canvas: { ...CANVAS, ...(raw.canvas || {}) },
    slides,
  };
}

/* ------------------------------------------------------------------ *
 * 导入导出注册
 * ------------------------------------------------------------------ */
registerExporter('deck', {
  id: 'html',
  label: '独立网页演示 (.html)',
  ext: 'html',
  mime: 'text/html;charset=utf-8',
  run: async (doc) => {
    const data = normalizeDeckData(doc.data);
    return {
      filename: safeFileName(doc.title, 'html'),
      content: buildDeckHtml({ title: doc.title, slides: data.slides, themeId: data.theme, showNotes: true }),
      mime: 'text/html;charset=utf-8',
    };
  },
});

registerExporter('deck', {
  id: 'md',
  label: '大纲 Markdown (.md)',
  ext: 'md',
  mime: 'text/markdown;charset=utf-8',
  run: async (doc) => {
    const data = normalizeDeckData(doc.data);
    const lines = [`# ${doc.title}`, ''];
    data.slides.forEach((slide, index) => {
      const texts = slide.elements.filter((element) => element.type === 'text' || element.type === 'heading');
      const title = texts[0]?.text?.split('\n')[0] || `第 ${index + 1} 页`;
      lines.push(`## ${title}`, '');
      for (const element of texts.slice(1)) {
        for (const line of String(element.text || '').split('\n')) {
          if (line.trim()) lines.push(line.trim().startsWith('·') ? `- ${line.replace(/^·\s*/, '')}` : `- ${line.trim()}`);
        }
      }
      lines.push('');
    });
    return { filename: safeFileName(doc.title, 'md'), content: lines.join('\n'), mime: 'text/markdown;charset=utf-8' };
  },
});

registerExporter('deck', {
  id: 'trio',
  label: 'TriOffice 演示 (.trio)',
  ext: 'trio',
  mime: 'application/json',
  run: async (doc) => ({ filename: safeFileName(doc.title, 'trio'), content: serializeDoc(doc), mime: 'application/json' }),
});

// 低优先级：.md 默认导入成文档，只有从演示应用里主动导入时才走这里
registerImporter(['md', 'markdown'], async (file, ctx) => {
  const text = await ctx.text;
  return { type: 'deck', title: file.name.replace(/\.[^.]+$/, ''), data: deckFromMarkdown(text) };
}, { priority: 0 });

/** Markdown 大纲 → 演示文稿 */
export function deckFromMarkdown(text) {
  const theme = getTheme('aurora');
  const data = { theme: theme.id, canvas: { ...CANVAS }, slides: [] };
  const lines = String(text || '').split(/\r?\n/);
  let current = null;

  const push = () => {
    if (current) data.slides.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      push();
      const level = heading[1].length;
      current = createSlide(level <= 2 ? 'titleBody' : 'blank', theme, data.slides.length);
      current.elements = [];
      const titleElement = { ...elementDefaults('heading', theme), y: CANVAS.h * 0.12, h: CANVAS.h * 0.16, text: heading[2].trim(), fontSize: level <= 2 ? theme.titleSize - 10 : theme.bodySize + 6, x: CANVAS.w * 0.09, w: CANVAS.w * 0.82 };
      current.elements.push(titleElement);
      continue;
    }
    if (!line.trim()) continue;
    if (!current) {
      current = createSlide('titleBody', theme, data.slides.length);
      current.elements = [];
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const bodyText = bullet ? bullet[1] : numbered ? numbered[1] : line.trim();
    const body = current.elements.find((element) => element.type === 'text');
    if (body) body.text += `\n· ${bodyText}`;
    else {
      current.elements.push({
        ...elementDefaults('text', theme),
        y: CANVAS.h * 0.34,
        h: CANVAS.h * 0.5,
        x: CANVAS.w * 0.09,
        w: CANVAS.w * 0.82,
        text: `· ${bodyText}`,
        color: theme.textDim,
        lineHeight: 1.6,
      });
    }
  }
  push();
  if (!data.slides.length) return createDeckData();
  return data;
}

/* ------------------------------------------------------------------ *
 * 应用主体
 * ------------------------------------------------------------------ */
export function mountDeckApp({ doc, onSave, onClose }) {
  let data = normalizeDeckData(doc.data);
  doc.data = data;
  let activeIndex = 0;
  let selectedId = null;
  let dirty = false;
  let scale = 0.6;
  let historyButtons = null;
  let lastThemeAnchor = null;
  let lastLayoutAnchor = null;
  const history = new History({ limit: 120, onChange: () => refreshHistoryButtons() });

  const frame = createAppFrame({
    title: doc.title,
    iconName: 'deck',
    appLabel: t('home.deck'),
    menus: () => buildMenus(),
    toolbar: () => buildToolbar(),
    onTitleChange: (title) => {
      doc.title = title;
      goDirty();
    },
    onClose: () => onClose?.(),
    onSave: () => saveNow(),
  });

  /* ---------- 结构 ---------- */
  const slideList = h('div.deck__list');
  const sidebar = h('aside.deck__sidebar', {}, [
    h('div.deck__sidebar-head', {}, [
      h('span', { text: t('home.deck') }),
      button({ icon: 'plus', title: t('deck.newSlide'), variant: 'icon', onClick: (event) => layoutMenu(event.currentTarget) }),
    ]),
    slideList,
  ]);

  const canvasBox = h('div.deck__canvas');
  const selectionLayer = h('div.deck__selection-layer');
  const notesInput = h('textarea.deck__notes-input', {
    placeholder: t('deck.notesPlaceholder'),
    spellcheck: 'false',
    oninput: () => {
      slide().notes = notesInput.value;
      scheduleSnapshot();
    },
  });
  const notesPanel = h('div.deck__notes', {}, [
    h('div.deck__notes-head', {}, [icon('note', { size: 15 }), h('span', { text: t('deck.notes') })]),
    notesInput,
  ]);
  const stage = h('div.deck__stage', {}, [canvasBox, notesPanel]);
  const main = h('div.deck__main', {}, [stage]);
  const root = h('div.deck', {}, [sidebar, main]);
  frame.body.appendChild(root);

  /* ---------- 渲染 ---------- */
  const slide = () => data.slides[Math.min(activeIndex, data.slides.length - 1)];

  function selectedElement() {
    if (!selectedId) return null;
    return slide().elements.find((element) => element.id === selectedId) || null;
  }

  function renderAll() {
    renderCanvas();
    renderSlideList();
    renderNotes();
    refreshSelectionLayer();
    frame.refreshMenus();
    frame.setToolbar(buildToolbar());
    frame.setStatusBar([
      h('span.deck__status', { text: t('deck.slideCount', { n: data.slides.length }) }),
      h('span.deck__status', { text: `${Math.round(scale * 100)}%` }),
      h('span.deck__status', { text: getTheme(data.theme).name }),
      h('span.deck__status', { text: t('deck.presentHint') }),
    ]);
  }

  function computeScale() {
    const available = main.clientWidth - 64;
    const availableHeight = stage.clientHeight - notesPanel.offsetHeight - 48;
    const next = Math.min(available / CANVAS.w, Math.max(120, availableHeight) / CANVAS.h);
    scale = Math.max(0.28, Math.min(1.1, next));
  }

  function renderCanvas() {
    computeScale();
    clear(canvasBox);
    const node = renderSlideNode(slide(), data.theme, { canvas: data.canvas, className: 'slide--canvas' });
    node.style.transform = `scale(${scale})`;
    node.style.transformOrigin = 'top left';
    canvasBox.style.width = `${data.canvas.w * scale}px`;
    canvasBox.style.height = `${data.canvas.h * scale}px`;
    canvasBox.appendChild(node);
    canvasBox.appendChild(selectionLayer);
    canvasBox.dataset.scale = String(scale);
    bindCanvasEvents(node);
  }

  function renderSlideList() {
    clear(slideList);
    data.slides.forEach((item, index) => {
      const thumbWrap = h('div.deck__thumb-wrap', { class: index === activeIndex ? 'is-active' : '' });
      const thumb = h('div.deck__thumb', {
        onclick: () => selectSlide(index),
        oncontextmenu: (event) => {
          event.preventDefault();
          openMenu(thumbWrap, [
            { label: t('deck.duplicateSlide'), icon: 'copy', onClick: () => duplicateSlide(index) },
            { label: t('deck.moveUp'), icon: 'arrow-up', disabled: index === 0, onClick: () => moveSlide(index, -1) },
            { label: t('deck.moveDown'), icon: 'arrow-down', disabled: index === data.slides.length - 1, onClick: () => moveSlide(index, 1) },
            { separator: true },
            { label: t('deck.deleteSlide'), icon: 'trash', danger: true, disabled: data.slides.length <= 1, onClick: () => deleteSlide(index) },
          ]);
        },
      });
      const mini = renderSlideNode(item, data.theme, { canvas: data.canvas, className: 'slide--thumb' });
      const thumbScale = 168 / data.canvas.w;
      mini.style.transform = `scale(${thumbScale})`;
      mini.style.transformOrigin = 'top left';
      thumb.style.width = '168px';
      thumb.style.height = `${data.canvas.h * thumbScale}px`;
      thumb.appendChild(mini);
      thumbWrap.appendChild(thumb);
      thumbWrap.appendChild(h('span.deck__thumb-index', { text: String(index + 1) }));
      slideList.appendChild(thumbWrap);
    });
    const activeNode = slideList.children[activeIndex];
    activeNode?.scrollIntoView({ block: 'nearest' });
  }

  function renderNotes() {
    notesInput.value = slide().notes || '';
  }

  /* ---------- 选区 ---------- */
  function refreshSelectionLayer() {
    clear(selectionLayer);
    const element = selectedElement();
    if (!element) return;
    const box = h('div.deck__sel-box', {
      style: {
        left: `${element.x}px`, top: `${element.y}px`,
        width: `${Math.max(1, element.w)}px`, height: `${Math.max(1, element.h)}px`,
      },
    });
    selectionLayer.appendChild(box);
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const handle of handles) {
      const node = h('div', { class: `deck__handle deck__handle--${handle}`, dataset: { handle } });
      box.appendChild(node);
    }
    selectionLayer.style.transform = `scale(${scale})`;
    selectionLayer.style.transformOrigin = 'top left';
    selectionLayer.style.setProperty('--handle-scale', String(Math.max(0.5, scale)));
  }

  /* ---------- 画布交互 ---------- */
  function bindCanvasEvents(node) {
    node.addEventListener('pointerdown', (event) => {
      const target = event.target.closest('.slide__element');
      if (!target) {
        selectedId = null;
        refreshSelectionLayer();
        return;
      }
      const id = target.dataset.id;
      if (selectedId !== id) {
        selectedId = id;
        refreshSelectionLayer();
        frame.setToolbar(buildToolbar());
      }
      const element = selectedElement();
      if (!element) return;
      const mode = event.target.dataset.handle ? 'resize' : 'move';
      startDrag(event, element, mode, event.target.dataset.handle);
    });

    node.addEventListener('dblclick', (event) => {
      const target = event.target.closest('.slide__element');
      if (!target) return;
      const element = slide().elements.find((item) => item.id === target.dataset.id);
      if (!element || (element.type !== 'text' && element.type !== 'heading')) return;
      editText(element, target);
    });
  }

  function startDrag(event, element, mode, handle) {
    event.preventDefault();
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: element.x,
      top: element.y,
      w: element.w,
      h: element.h,
    };
    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - start.x) / scale;
      const dy = (moveEvent.clientY - start.y) / scale;
      if (mode === 'move') {
        element.x = snap(start.left + dx);
        element.y = snap(start.top + dy);
      } else {
        if (handle.includes('e')) element.w = Math.max(24, snap(start.w + dx));
        if (handle.includes('s')) element.h = Math.max(12, snap(start.h + dy));
        if (handle.includes('w')) {
          element.w = Math.max(24, snap(start.w - dx));
          element.x = snap(start.left + (start.w - element.w));
        }
        if (handle.includes('n')) {
          element.h = Math.max(12, snap(start.h - dy));
          element.y = snap(start.top + (start.h - element.h));
        }
        if (element.type === 'line' || element.type === 'arrow') element.h = 0;
      }
      renderCanvas();
      renderSelectionPreview(element);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      commit(t('deck.present'));
      renderAll();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** 拖动过程中只更新选中框，避免整页重排 */
  function renderSelectionPreview(element) {
    const box = qs('.deck__sel-box', selectionLayer);
    if (box) {
      box.style.left = `${element.x}px`;
      box.style.top = `${element.y}px`;
      box.style.width = `${Math.max(1, element.w)}px`;
      box.style.height = `${Math.max(1, element.h)}px`;
    }
    const host = qs('.slide--canvas', canvasBox);
    const target = host?.querySelector(`.slide__element[data-id="${element.id}"]`);
    if (target) {
      target.style.left = `${element.x}px`;
      target.style.top = `${element.y}px`;
      target.style.width = `${Math.max(1, element.w)}px`;
      target.style.height = `${Math.max(1, element.h)}px`;
    }
  }

  function snap(value) {
    return Math.round(value);
  }

  /** 就地编辑文字 */
  function editText(element, target) {
    const inner = target.querySelector('.slide__text-inner') || target;
    inner.setAttribute('contenteditable', 'true');
    inner.focus();
    const range = document.createRange();
    range.selectNodeContents(inner);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const finish = () => {
      inner.removeAttribute('contenteditable');
      element.text = inner.innerText.replace(/\n{3,}/g, '\n\n');
      inner.removeEventListener('blur', finish);
      inner.removeEventListener('keydown', onKey);
      commit('编辑文字');
      renderAll();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        inner.blur();
      }
      event.stopPropagation();
    };
    inner.addEventListener('blur', finish);
    inner.addEventListener('keydown', onKey);
  }

  /* ---------- 幻灯片操作 ---------- */
  function selectSlide(index) {
    activeIndex = Math.max(0, Math.min(data.slides.length - 1, index));
    selectedId = null;
    renderAll();
  }

  function addSlide(layout) {
    commit(t('deck.newSlide'), () => {
      data.slides.splice(activeIndex + 1, 0, createSlide(layout, getTheme(data.theme), data.slides.length));
      activeIndex += 1;
    });
  }

  function duplicateSlide(index) {
    commit(t('deck.duplicateSlide'), () => {
      const copy = structuredCloneNode(data.slides[index]);
      copy.id = `s${Date.now().toString(36)}`;
      copy.elements = copy.elements.map((element) => ({ ...element, id: `e${Math.random().toString(36).slice(2, 9)}` }));
      data.slides.splice(index + 1, 0, copy);
      activeIndex = index + 1;
    });
  }

  function deleteSlide(index) {
    if (data.slides.length <= 1) return;
    commit(t('deck.deleteSlide'), () => {
      data.slides.splice(index, 1);
      activeIndex = Math.max(0, Math.min(activeIndex, data.slides.length - 1));
      selectedId = null;
    });
  }

  function moveSlide(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= data.slides.length) return;
    commit(t('deck.moveUp'), () => {
      const [item] = data.slides.splice(index, 1);
      data.slides.splice(target, 0, item);
      activeIndex = target;
    });
  }

  function changeLayout(layout) {
    commit(t('deck.layout'), () => {
      const template = createSlide(layout, getTheme(data.theme), activeIndex);
      const current = slide();
      if (!current.elements.length) {
        current.elements = template.elements;
      } else {
        current.elements = template.elements.length ? template.elements : current.elements;
      }
      current.layout = layout;
      selectedId = null;
    });
  }

  /* ---------- 元素操作 ---------- */
  function addElement(type) {
    commit(t('deck.text'), () => {
      const theme = getTheme(data.theme);
      const element = elementDefaults(type, theme, data.canvas);
      slide().elements.push(element);
      selectedId = element.id;
    });
  }

  function deleteElement() {
    if (!selectedId) return;
    commit(t('deck.deleteElement'), () => {
      const current = slide();
      current.elements = current.elements.filter((element) => element.id !== selectedId);
      selectedId = null;
    });
  }

  function duplicateElement() {
    const element = selectedElement();
    if (!element) return;
    commit(t('common.duplicate'), () => {
      const copy = { ...element, id: `e${Math.random().toString(36).slice(2, 9)}`, x: element.x + 24, y: element.y + 24 };
      slide().elements.push(copy);
      selectedId = copy.id;
    });
  }

  function updateElement(patch, label = t('menu.format')) {
    const element = selectedElement();
    if (!element) return;
    commit(label, () => Object.assign(element, patch));
  }

  /** 切换元素的布尔样式（自行读取当前选中元素，避免闭包捕获到 null） */
  function toggleElementFlag(flag, label) {
    const element = selectedElement();
    if (!element) return;
    updateElement({ [flag]: !element[flag] }, label);
  }

  function orderElement(mode) {
    const element = selectedElement();
    if (!element) return;
    commit(t('deck.bringFront'), () => {
      const list = slide().elements;
      const index = list.indexOf(element);
      list.splice(index, 1);
      if (mode === 'front') list.push(element);
      else list.unshift(element);
    });
  }

  function alignElements(mode) {
    const element = selectedElement();
    if (!element) return;
    const map = {
      left: { x: data.canvas.w * 0.09 },
      centerH: { x: (data.canvas.w - element.w) / 2 },
      right: { x: data.canvas.w * 0.91 - element.w },
      top: { y: data.canvas.h * 0.06 },
      middleV: { y: (data.canvas.h - element.h) / 2 },
      bottom: { y: data.canvas.h * 0.94 - element.h },
    };
    if (map[mode]) updateElement(map[mode], '对齐');
  }

  function distribute(mode) {
    commit(t('deck.distributeH'), () => {
      const list = slide().elements;
      if (list.length < 3) return;
      if (mode === 'h') {
        const sorted = [...list].sort((a, b) => a.x - b.x);
        const total = sorted[sorted.length - 1].x - sorted[0].x;
        const step = total / (sorted.length - 1);
        sorted.forEach((element, index) => {
          element.x = Math.round(sorted[0].x + step * index);
        });
      } else {
        const sorted = [...list].sort((a, b) => a.y - b.y);
        const total = sorted[sorted.length - 1].y - sorted[0].y;
        const step = total / (sorted.length - 1);
        sorted.forEach((element, index) => {
          element.y = Math.round(sorted[0].y + step * index);
        });
      }
    });
  }

  /* ---------- 主题 / 版式菜单 ---------- */
  function layoutMenu(anchor) {
    openMenu(anchor, LAYOUTS.map((layout) => ({
      label: t(layout.labelKey),
      icon: layout.id === 'blank' ? 'plus-square' : 'columns',
      onClick: () => addSlide(layout.id),
    })));
  }

  function themeMenu(anchor) {
    openMenu(anchor, THEME_LIST.map((theme) => ({
      label: theme.name,
      checked: data.theme === theme.id,
      onClick: () => changeTheme(theme.id),
    })));
  }

  function changeTheme(id) {
    commit(t('deck.theme'), () => {
      const theme = getTheme(id);
      data.theme = theme.id;
      for (const item of data.slides) {
        item.background = null;
        for (const element of item.elements) {
          if (element.color && Object.values(THEME_LIST).some((item2) => item2.text === element.color || item2.textDim === element.color)) {
            element.color = element.color === getTheme(data.theme).textDim ? theme.textDim : theme.text;
          }
        }
      }
    });
  }

  /* ---------- 历史 ---------- */
  function snapshot() {
    return { theme: data.theme, canvas: data.canvas, slides: data.slides };
  }

  function commit(label, fn) {
    if (fn) fn();
    history.commit(label, snapshot());
    goDirty();
    renderAll();
  }

  const scheduleSnapshot = debounce(() => history.commit('编辑备注', snapshot()), 700);

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
    data = normalizeDeckData(state);
    doc.data = data;
    activeIndex = Math.min(activeIndex, data.slides.length - 1);
    selectedId = null;
    goDirty();
    renderAll();
  }

  function doRedo() {
    const state = history.redo();
    if (!state) return;
    data = normalizeDeckData(state);
    doc.data = data;
    activeIndex = Math.min(activeIndex, data.slides.length - 1);
    selectedId = null;
    goDirty();
    renderAll();
  }

  /* ---------- 菜单 / 工具条 ---------- */
  function buildMenus() {
    const element = selectedElement();
    return [
      {
        label: t('menu.file'),
        items: [
          { label: t('menu.save'), icon: 'save', shortcut: 'Ctrl/⌘+S', onClick: () => saveNow() },
          { label: t('menu.import'), icon: 'upload', onClick: () => importInto() },
          { label: t('menu.export'), icon: 'download', onClick: () => openExportMenu() },
          ...exportMenuItems(doc, (id) => exportAs(id)).map((item) => ({ ...item, label: `　${item.label}` })),
          { separator: true },
          { label: t('deck.present'), icon: 'play', shortcut: 'F5', onClick: () => present() },
          { separator: true },
          { label: t('menu.close'), icon: 'chevron-left', onClick: () => onClose?.() },
        ],
      },
      {
        label: t('menu.edit'),
        items: [
          { label: t('writer.undo'), icon: 'undo', shortcut: 'Ctrl/⌘+Z', disabled: !history.canUndo, onClick: () => doUndo() },
          { label: t('writer.redo'), icon: 'redo', disabled: !history.canRedo, onClick: () => doRedo() },
          { separator: true },
          { label: t('deck.duplicateSlide'), icon: 'copy', onClick: () => duplicateSlide(activeIndex) },
          { label: t('deck.deleteSlide'), icon: 'trash', danger: true, onClick: () => deleteSlide(activeIndex) },
          { separator: true },
          { label: t('deck.duplicateSlide'), icon: 'copy', disabled: !element, onClick: () => duplicateElement() },
          { label: t('deck.deleteElement'), icon: 'trash', danger: true, disabled: !element, onClick: () => deleteElement() },
        ],
      },
      {
        label: t('menu.insert'),
        items: [
          { label: t('deck.text'), icon: 'text', onClick: () => addElement('text') },
          { label: t('deck.image'), icon: 'image', onClick: () => insertImage() },
          { separator: true },
          { label: t('deck.shape'), header: true },
          { label: t('deck.rect'), icon: 'shape-square', onClick: () => addElement('rect') },
          { label: t('deck.ellipse'), icon: 'shape-circle', onClick: () => addElement('ellipse') },
          { label: t('deck.triangle'), icon: 'shape-triangle', onClick: () => addElement('triangle') },
          { label: t('deck.line'), icon: 'line', onClick: () => addElement('line') },
          { label: t('deck.arrow'), icon: 'arrow', onClick: () => addElement('arrow') },
        ],
      },
      {
        label: t('menu.format'),
        items: [
          { label: t('deck.theme'), icon: 'palette', onClick: () => themeMenu(lastThemeAnchor || frame.el) },
          { label: t('deck.layout'), icon: 'grid', onClick: () => layoutMenu(lastLayoutAnchor || frame.el) },
          { separator: true },
          { label: t('deck.bringFront'), icon: 'layers', disabled: !element, onClick: () => orderElement('front') },
          { label: t('deck.sendBack'), icon: 'layers', disabled: !element, onClick: () => orderElement('back') },
          { separator: true },
          { label: t('deck.transition'), header: true },
          ...TRANSITIONS.map((transition) => ({
            label: t(transition.labelKey),
            checked: slide().transition === transition.id,
            onClick: () => commit(t('deck.transition'), () => { slide().transition = transition.id; }),
          })),
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
          { label: t('deck.present'), icon: 'play', onClick: () => present() },
          { label: t('deck.notes'), icon: 'note', onClick: () => notesPanel.classList.toggle('is-collapsed') },
        ],
      },
      {
        label: t('menu.help'),
        items: [
          { label: t('menu.shortcuts'), icon: 'info', onClick: () => showShortcuts() },
          { label: t('menu.about'), icon: 'info', onClick: () => showAbout() },
        ],
      },
    ];
  }

  function buildToolbar() {
    const group = (children) => h('div.toolbar__group', {}, children);
    const element = selectedElement();
    const isText = element && (element.type === 'text' || element.type === 'heading');
    return [
      group([
        (() => {
          const undo = button({ icon: 'undo', title: t('writer.undo'), variant: 'toolbar', hideLabel: true, disabled: !history.canUndo, onClick: () => doUndo() });
          historyButtons = { undo, redo: null };
          return undo;
        })(),
        (() => {
          const redo = button({ icon: 'redo', title: t('writer.redo'), variant: 'toolbar', hideLabel: true, disabled: !history.canRedo, onClick: () => doRedo() });
          historyButtons.redo = redo;
          return redo;
        })(),
      ]),
      group([
        button({ icon: 'plus', label: t('deck.newSlide'), variant: 'toolbar', onClick: (event) => { lastLayoutAnchor = event.currentTarget; layoutMenu(event.currentTarget); } }),
        button({ icon: 'grid', label: t('deck.layout'), variant: 'toolbar', onClick: (event) => { lastLayoutAnchor = event.currentTarget; layoutMenu(event.currentTarget); } }),
        button({ icon: 'palette', label: getTheme(data.theme).name, variant: 'toolbar', onClick: (event) => { lastThemeAnchor = event.currentTarget; themeMenu(event.currentTarget); } }),
      ]),
      group([
        button({ icon: 'text', title: t('deck.text'), variant: 'toolbar', hideLabel: true, onClick: () => addElement('text') }),
        button({ icon: 'image', title: t('deck.image'), variant: 'toolbar', hideLabel: true, onClick: () => insertImage() }),
        button({ icon: 'shape-square', title: t('deck.rect'), variant: 'toolbar', hideLabel: true, onClick: () => addElement('rect') }),
        button({ icon: 'shape-circle', title: t('deck.ellipse'), variant: 'toolbar', hideLabel: true, onClick: () => addElement('ellipse') }),
        button({ icon: 'arrow', title: t('deck.arrow'), variant: 'toolbar', hideLabel: true, onClick: () => addElement('arrow') }),
      ]),
      group([
        button({
          icon: 'bold',
          title: t('sheet.bold'),
          variant: 'toolbar',
          hideLabel: true,
          disabled: !isText,
          active: Boolean(element?.bold),
          onClick: () => toggleElementFlag('bold', t('sheet.bold')),
        }),
        button({
          icon: 'italic',
          title: t('sheet.italic'),
          variant: 'toolbar',
          hideLabel: true,
          disabled: !isText,
          active: Boolean(element?.italic),
          onClick: () => toggleElementFlag('italic', t('sheet.italic')),
        }),
        button({
          icon: 'font',
          title: t('deck.fontSize'),
          variant: 'toolbar',
          hideLabel: true,
          disabled: !isText,
          onClick: (event) => fontSizeMenu(event.currentTarget),
        }),
        button({
          icon: 'palette',
          title: t('deck.fill'),
          variant: 'toolbar',
          hideLabel: true,
          disabled: !element,
          onClick: (event) => fillMenu(event.currentTarget),
        }),
      ]),
      group([
        button({ icon: 'align-left', title: t('deck.alignLeft'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => alignElements('left') }),
        button({ icon: 'align-center', title: t('deck.alignCenterH'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => alignElements('centerH') }),
        button({ icon: 'align-right', title: t('deck.alignRight'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => alignElements('right') }),
        button({ icon: 'arrow-up', title: t('deck.alignTop'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => alignElements('top') }),
        button({ icon: 'align-center', title: t('deck.alignMiddleV'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => alignElements('middleV') }),
        button({ icon: 'arrow-down', title: t('deck.alignBottom'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => alignElements('bottom') }),
      ]),
      group([
        button({ icon: 'layers', title: t('deck.bringFront'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => orderElement('front') }),
        button({ icon: 'copy', title: t('deck.duplicateSlide'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => duplicateElement() }),
        button({ icon: 'trash', title: t('deck.deleteElement'), variant: 'toolbar', hideLabel: true, disabled: !element, onClick: () => deleteElement() }),
      ]),
      group([
        button({ icon: 'play', label: t('deck.present'), variant: 'primary', onClick: () => present() }),
        button({ icon: 'download', label: t('deck.exportHtml'), variant: 'toolbar', onClick: () => exportAs('html') }),
      ]),
    ];
  }

  function fontSizeMenu(anchor) {
    const element = selectedElement();
    if (!element) return;
    const sizes = [16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 88];
    openMenu(anchor, sizes.map((size) => ({
      label: `${size}px`,
      checked: element.fontSize === size,
      onClick: () => updateElement({ fontSize: size }, t('deck.fontSize')),
    })), { width: 140 });
  }

  function fillMenu(anchor) {
    const swatches = ['#4f7cf7', '#27ae60', '#f2994a', '#eb5757', '#9b51e0', '#2d9cdb', '#f2c94c', '#111827', '#ffffff'];
    openMenu(anchor, swatches.map((color) => ({
      label: color,
      onClick: () => updateElement({ fill: color }, t('deck.fill')),
    })), { width: 160 });
  }

  async function insertImage() {
    const files = await pickFiles({ accept: 'image/*' });
    if (!files.length) return;
    const dataUrl = await readDataUrl(files[0]);
    if (dataUrl.length > 3_500_000) {
      toast(t('toast.notSupported'), 'warn');
      return;
    }
    commit(t('deck.image'), () => {
      const element = { ...elementDefaults('image', getTheme(data.theme), data.canvas), src: dataUrl, alt: files[0].name };
      slide().elements.push(element);
      selectedId = element.id;
    });
  }

  /* ---------- 放映 ---------- */
  function present() {
    const overlay = h('div.deck-present', { tabindex: '0' });
    let index = activeIndex;
    let notesVisible = true;

    const stageNode = h('div.deck-present__stage');
    const progress = h('div.deck-present__progress');
    const notes = h('div.deck-present__notes', { text: '' });
    const hint = h('div.deck-present__hint', { text: t('deck.presentHint') });
    const counter = h('div.deck-present__counter', { text: '' });
    overlay.appendChild(stageNode);
    overlay.appendChild(progress);
    overlay.appendChild(notes);
    overlay.appendChild(hint);
    overlay.appendChild(counter);
    overlay.appendChild(h('div.deck-present__toolbar', {}, [
      button({ icon: 'chevron-left', title: t('deck.moveUp'), variant: 'icon', onClick: () => show(index - 1) }),
      button({ icon: 'chevron-right', title: t('deck.moveDown'), variant: 'icon', onClick: () => show(index + 1) }),
      button({ icon: 'note', title: t('deck.notes'), variant: 'icon', onClick: () => { notesVisible = !notesVisible; notes.style.display = notesVisible ? '' : 'none'; } }),
      button({ icon: 'close', title: t('deck.exitPresent'), variant: 'icon', onClick: () => exit() }),
    ]));
    document.body.appendChild(overlay);

    function show(next) {
      index = Math.max(0, Math.min(data.slides.length - 1, next));
      const item = data.slides[index];
      clear(stageNode);
      const node = renderSlideNode(item, data.theme, { canvas: data.canvas, className: 'slide--present' });
      node.style.animation = 'none';
      stageNode.appendChild(node);
      const transition = item.transition || 'fade';
      if (transition !== 'none') {
        node.classList.add(`is-${transition}`);
        requestAnimationFrame(() => node.classList.add('is-in'));
      }
      progress.style.width = `${((index + 1) / data.slides.length) * 100}%`;
      counter.textContent = `${index + 1} / ${data.slides.length}`;
      notes.textContent = item.notes || '';
      fit();
    }

    function fit() {
      const node = qs('.slide--present', stageNode);
      if (!node) return;
      const scaleFit = Math.min(window.innerWidth / data.canvas.w, window.innerHeight / data.canvas.h);
      node.style.transform = `scale(${scaleFit})`;
      node.style.transformOrigin = 'center center';
      stageNode.style.width = `${data.canvas.w * scaleFit}px`;
      stageNode.style.height = `${data.canvas.h * scaleFit}px`;
    }

    function exit() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      overlay.remove();
      if (document.fullscreenElement) document.exitFullscreen?.();
      activeIndex = index;
      renderAll();
    }

    function onKey(event) {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        show(index + 1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        show(index - 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        exit();
      } else if (event.key === 'Home') show(0);
      else if (event.key === 'End') show(data.slides.length - 1);
      else if (event.key.toLowerCase() === 'f') {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else overlay.requestFullscreen?.();
      }
    }

    overlay.addEventListener('click', (event) => {
      if (event.target.closest('.deck-present__toolbar')) return;
      show(index + 1);
    });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', fit);
    overlay.requestFullscreen?.().catch?.(() => {});
    overlay.focus();
    show(index);
  }

  /* ---------- 保存 / 导出 ---------- */
  function documentSnapshot() {
    const stats = { slides: data.slides.length };
    const text = data.slides.map((item) => item.elements.filter((element) => element.text).map((element) => element.text).join(' ')).join('\n');
    const next = { ...doc, data: { theme: data.theme, canvas: data.canvas, slides: data.slides }, stats };
    return withPreview(next, text, stats);
  }

  async function saveNow() {
    const snapshotDoc = documentSnapshot();
    Object.assign(doc, snapshotDoc);
    data = normalizeDeckData(doc.data);
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
    const files = await pickFiles({ accept: '.md,.markdown,.trio,.json' });
    if (!files.length) return;
    try {
      const file = files[0];
      let imported;
      if (/\.(md|markdown|txt)$/i.test(file.name)) {
        // 从演示应用导入 Markdown：按大纲拆成多页
        const text = await file.text();
        imported = { type: 'deck', title: file.name.replace(/\.[^.]+$/, ''), data: deckFromMarkdown(text) };
      } else {
        imported = (await importFile(file)).doc;
      }
      if (imported.type !== 'deck') {
        toastError('请选择演示文件（.md / .trio）');
        return;
      }
      data = normalizeDeckData(imported.data);
      doc.data = data;
      if (imported.title) {
        doc.title = imported.title;
        frame.setTitle(imported.title);
      }
      activeIndex = 0;
      selectedId = null;
      history.reset(snapshot());
      goDirty();
      renderAll();
      toastSuccess(t('toast.imported', { name: files[0].name }));
    } catch (err) {
      toastError(t('toast.importFailed', { msg: err.message }));
    }
  }

  /* ---------- 快捷键 ---------- */
  const onGlobalKey = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
      return;
    }
    if (event.key === 'F5') {
      event.preventDefault();
      present();
      return;
    }
    if (document.activeElement?.isContentEditable || document.activeElement instanceof HTMLTextAreaElement) return;
    if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSlide(activeIndex);
      return;
    }
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedId) {
        event.preventDefault();
        deleteElement();
      }
      return;
    }
    if (event.key === 'Escape') {
      selectedId = null;
      renderAll();
      return;
    }
    if (event.key === 'PageDown') {
      event.preventDefault();
      selectSlide(activeIndex + 1);
      return;
    }
    if (event.key === 'PageUp') {
      event.preventDefault();
      selectSlide(activeIndex - 1);
      return;
    }
    const element = selectedElement();
    if (element && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (delta) updateElement({ x: Math.max(0, element.x + delta[0]), y: Math.max(0, element.y + delta[1]) }, '移动');
    }
  };
  window.addEventListener('keydown', onGlobalKey);

  const onResize = debounce(() => renderCanvas(), 120);
  window.addEventListener('resize', onResize);

  /* ---------- 初始化 ---------- */
  renderAll();
  refreshHistoryButtons();
  history.reset(snapshot());
  frame.renderChrome();
  bus.emit(EVENTS.DOC_OPENED, { id: doc.id, type: 'deck' });

  return {
    el: frame.el,
    save: saveNow,
    isDirty: () => dirty,
    destroy() {
      window.removeEventListener('keydown', onGlobalKey);
      window.removeEventListener('resize', onResize);
      onResize.cancel?.();
      scheduleSnapshot.cancel?.();
      frame.el.__dispose?.();
    },
  };
}

function structuredCloneNode(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function isDarkTheme() {
  return document.documentElement.dataset.theme === 'dark';
}
