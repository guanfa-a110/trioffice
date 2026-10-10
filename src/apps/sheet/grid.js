/**
 * grid.js —— 表格网格视图（虚拟滚动 + 选区 + 就地编辑 + 填充柄）。
 *
 * 设计要点：
 *  - 只渲染可见窗口内的单元格，5000×200 的表格依然顺滑；
 *  - 列宽/行高用前缀和缓存，支持任意位置二分查找；
 *  - 所有编辑动作通过回调交给 controller（sheet/index.js），自身不写数据模型。
 */
import { h, clear } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { colToLabel, parseA1 } from './address.js';
import { MAX_ROWS, MAX_COLS, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, cellKey, parseDelimited } from './workbook.js';
import { translateFormula } from './formula.js';
import { isError } from './value.js';

const HEADER_WIDTH = 46;
const HEADER_HEIGHT = 26;
const OVERSCAN = 3;

export class Grid {
  /**
   * @param {{workbook: any, mount: HTMLElement, controller: any}} options
   */
  constructor({ workbook, mount, controller }) {
    this.workbook = workbook;
    this.mount = mount;
    this.controller = controller;
    this.selection = { from: { r: 0, c: 0 }, to: { r: 0, c: 0 } };
    this.active = { r: 0, c: 0 };
    this.editing = null;
    this.anchorRect = null;
    this.widthCache = { key: '', prefix: [0], total: 0 };
    this.heightCache = { key: '', prefix: [0], total: 0 };
    this.destroyed = false;
    this.build();
  }

  /* ------------------------------------------------------------------ *
   * 结构
   * ------------------------------------------------------------------ */
  build() {
    this.corner = h('div.grid__corner', {
      onclick: () => this.setSelection({ from: { r: 0, c: 0 }, to: { r: MAX_ROWS - 1, c: MAX_COLS - 1 } }),
      title: t('common.apply'),
    });
    this.colHead = h('div.grid__colhead');
    this.rowHead = h('div.grid__rowhead');
    this.cells = h('div.grid__cells');
    this.overlay = h('div.grid__overlay');
    this.chartLayer = h('div.grid__charts');
    this.editor = null;

    this.spacer = h('div.grid__spacer');
    this.scroll = h('div.grid__scroll', { tabindex: '0' }, [this.spacer]);
    this.stage = h('div.grid__stage', {}, [
      this.colHead, this.rowHead, this.cells, this.chartLayer, this.overlay, this.corner,
    ]);

    this.el = h('div.grid', {}, [this.scroll, this.stage]);
    this.mount.appendChild(this.el);

    this.bindEvents();
    this.render();
  }

  bindEvents() {
    const isTargetCell = (event) => !event.target.closest('.grid__colhead, .grid__rowhead, .grid__corner, .cell-editor, .chart-box');

    this.onScroll = () => this.renderWindow();
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true });

    this.onPointerDown = (event) => {
      if (this.editing) this.commitEdit(true);
      if (!isTargetCell(event)) {
        if (event.target.closest('.grid__colhead')) this.handleHeaderPointer(event, 'col');
        else if (event.target.closest('.grid__rowhead')) this.handleHeaderPointer(event, 'row');
        return;
      }
      this.scroll.focus({ preventScroll: true });
      const cell = this.cellFromEvent(event);
      if (!cell) return;
      if (event.button === 2) {
        // 右键：先调整选区再交给 controller 弹菜单
        if (!this.inSelection(cell)) this.setSelection({ from: cell, to: cell });
        return;
      }
      if (event.detail === 2) {
        this.focusCell(cell.r, cell.c, false);
        this.beginEdit();
        return;
      }
      if (event.shiftKey) {
        this.setSelection({ from: this.selection.from, to: cell }, false);
      } else {
        this.setSelection({ from: cell, to: cell }, false);
        this.dragStart = cell;
        this.dragging = true;
        this.el.classList.add('is-dragging');
      }
      this.updateActiveFromSelection();
    };
    this.el.addEventListener('pointerdown', this.onPointerDown);

    this.onPointerMove = (event) => {
      if (!this.dragging) return;
      const cell = this.cellFromEvent(event);
      if (!cell) return;
      this.setSelection({ from: this.dragStart, to: cell }, false);
      this.updateActiveFromSelection();
      this.autoScroll(event);
    };
    this.el.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove('is-dragging');
    });

    this.onKeyDown = (event) => this.handleKeyDown(event);
    this.scroll.addEventListener('keydown', this.onKeyDown);

    this.onCopy = (event) => this.handleCopy(event, 'copy');
    this.onCut = (event) => this.handleCopy(event, 'cut');
    this.onPaste = (event) => this.handlePaste(event);
    this.el.addEventListener('copy', this.onCopy);
    this.el.addEventListener('cut', this.onCut);
    this.el.addEventListener('paste', this.onPaste);

    this.onWheel = (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        this.controller.onZoom?.(event.deltaY > 0 ? -0.1 : 0.1);
        return;
      }
      // 覆盖层会挡住滚动容器，这里手动转发滚轮
      event.preventDefault();
      if (event.shiftKey && !event.deltaX) this.scroll.scrollLeft += event.deltaY;
      else {
        this.scroll.scrollTop += event.deltaY;
        this.scroll.scrollLeft += event.deltaX;
      }
    };
    this.el.addEventListener('wheel', this.onWheel, { passive: false });

    this.onContextMenu = (event) => {
      if (event.target.closest('.chart-box')) return;
      event.preventDefault();
      const cell = this.cellFromEvent(event);
      if (cell && !this.inSelection(cell)) this.setSelection({ from: cell, to: cell });
      this.controller.onContextMenu?.(event);
    };
    this.el.addEventListener('contextmenu', this.onContextMenu);
  }

  destroy() {
    this.destroyed = true;
    this.el.remove();
  }

  /* ------------------------------------------------------------------ *
   * 尺寸缓存
   * ------------------------------------------------------------------ */
  get sheet() {
    return this.workbook.sheet;
  }

  colWidth(c) {
    const custom = this.sheet.colWidths?.[String(c)];
    return Number(custom) > 12 ? Number(custom) : DEFAULT_COL_WIDTH;
  }

  rowHeight(r) {
    const custom = this.sheet.rowHeights?.[String(r)];
    return Number(custom) > 8 ? Number(custom) : DEFAULT_ROW_HEIGHT;
  }

  invalidateSizes() {
    this.widthCache.key = '';
    this.heightCache.key = '';
    this.render();
  }

  /** 前缀和：x 坐标 */
  xPrefix() {
    const key = `${this.sheet.id}:${JSON.stringify(this.sheet.colWidths || {})}`;
    if (this.widthCache.key === key) return this.widthCache.prefix;
    const prefix = [0];
    for (let c = 0; c < MAX_COLS; c += 1) prefix.push(prefix[c] + this.colWidth(c));
    this.widthCache = { key, prefix, total: prefix[prefix.length - 1] };
    return prefix;
  }

  /** 前缀和：y 坐标 */
  yPrefix() {
    const key = `${this.sheet.id}:${JSON.stringify(this.sheet.rowHeights || {})}`;
    if (this.heightCache.key === key) return this.heightCache.prefix;
    const prefix = [0];
    for (let r = 0; r < MAX_ROWS; r += 1) prefix.push(prefix[r] + this.rowHeight(r));
    this.heightCache = { key, prefix, total: prefix[prefix.length - 1] };
    return prefix;
  }

  /** 二分查找：坐标 → 索引 */
  findIndex(prefix, value) {
    let low = 0;
    let high = prefix.length - 2;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (prefix[mid] <= value) low = mid;
      else high = mid - 1;
    }
    return Math.max(0, Math.min(low, prefix.length - 2));
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  render() {
    if (this.destroyed) return;
    // 覆盖层要避开原生滚动条，避免挡住拖拽
    const sbW = Math.max(0, this.scroll.offsetWidth - this.scroll.clientWidth);
    const sbH = Math.max(0, this.scroll.offsetHeight - this.scroll.clientHeight);
    this.el.style.setProperty('--sb-w', `${sbW}px`);
    this.el.style.setProperty('--sb-h', `${sbH}px`);
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    this.spacer.style.width = `${xp[xp.length - 1]}px`;
    this.spacer.style.height = `${yp[yp.length - 1]}px`;
    this.renderWindow();
  }

  renderWindow() {
    if (this.destroyed) return;
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    const scrollLeft = this.scroll.scrollLeft;
    const scrollTop = this.scroll.scrollTop;
    const viewWidth = this.scroll.clientWidth - HEADER_WIDTH;
    const viewHeight = this.scroll.clientHeight - HEADER_HEIGHT;

    const firstCol = Math.max(0, this.findIndex(xp, scrollLeft) - OVERSCAN);
    const lastCol = Math.min(MAX_COLS - 1, this.findIndex(xp, scrollLeft + viewWidth) + OVERSCAN);
    const firstRow = Math.max(0, this.findIndex(yp, scrollTop) - OVERSCAN);
    const lastRow = Math.min(MAX_ROWS - 1, this.findIndex(yp, scrollTop + viewHeight) + OVERSCAN);

    this.window = { firstRow, lastRow, firstCol, lastCol };
    this.rect = {
      left: xp[firstCol] - scrollLeft,
      top: yp[firstRow] - scrollTop,
    };

    this.renderColumnHeaders(firstCol, lastCol, scrollLeft);
    this.renderRowHeaders(firstRow, lastRow, scrollTop);
    this.renderCells(firstRow, lastRow, firstCol, lastCol, xp, yp, scrollLeft, scrollTop, viewWidth, viewHeight);
    this.renderSelection(xp, yp, scrollLeft, scrollTop);
    this.controller.onViewportChange?.(this.window);
  }

  renderColumnHeaders(first, last, scrollLeft) {
    const xp = this.xPrefix();
    const nodes = [];
    for (let c = first; c <= last; c += 1) {
      const left = xp[c] - scrollLeft;
      const selected = c >= this.selection.from.c && c <= this.selection.to.c;
      nodes.push(h('div', {
        class: ['grid__colhead-cell', selected ? 'is-selected' : ''].filter(Boolean).join(' '),
        style: { left: `${left}px`, width: `${this.colWidth(c)}px` },
        text: colToLabel(c),
        dataset: { col: String(c) },
      }));
    }
    clear(this.colHead);
    for (const node of nodes) this.colHead.appendChild(node);
  }

  renderRowHeaders(first, last, scrollTop) {
    const yp = this.yPrefix();
    const nodes = [];
    for (let r = first; r <= last; r += 1) {
      const top = yp[r] - scrollTop;
      const selected = r >= this.selection.from.r && r <= this.selection.to.r;
      nodes.push(h('div', {
        class: ['grid__rowhead-cell', selected ? 'is-selected' : ''].filter(Boolean).join(' '),
        style: { top: `${top}px`, height: `${this.rowHeight(r)}px` },
        text: String(r + 1),
        dataset: { row: String(r) },
      }));
    }
    clear(this.rowHead);
    for (const node of nodes) this.rowHead.appendChild(node);
  }

  renderCells(firstRow, lastRow, firstCol, lastCol, xp, yp, scrollLeft, scrollTop, viewWidth, viewHeight) {
    const fragment = document.createDocumentFragment();
    const covered = new Set();
    const mergeMap = this.buildMergeMap();
    const sheetName = this.sheet.name;

    for (let r = firstRow; r <= lastRow; r += 1) {
      const top = yp[r] - scrollTop;
      const height = this.rowHeight(r);
      for (let c = firstCol; c <= lastCol; c += 1) {
        const left = xp[c] - scrollLeft;
        const width = this.colWidth(c);
        if (left > viewWidth || top > viewHeight) continue;

        const merge = mergeMap.anchors.get(cellKey(r, c));
        if (merge) {
          const spanW = xp[merge.c2 + 1] - xp[merge.c1];
          const spanH = yp[merge.r2 + 1] - yp[merge.r1];
          fragment.appendChild(this.buildCellNode(sheetName, merge.r1, merge.c1, left, top, spanW, spanH, true));
          continue;
        }
        if (covered.has(cellKey(r, c))) continue;
        fragment.appendChild(this.buildCellNode(sheetName, r, c, left, top, width, height, false));
      }
    }

    clear(this.cells);
    this.cells.appendChild(fragment);
  }

  /** 合并单元格映射：anchors 只包含左上角 */
  buildMergeMap() {
    const merges = this.sheet.merges || [];
    if (!merges.length) return { anchors: new Map(), covered: new Set() };
    const anchors = new Map();
    const covered = new Set();
    for (const [r1, c1, r2, c2] of merges) {
      anchors.set(cellKey(r1, c1), { r1, c1, r2, c2 });
      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          if (r === r1 && c === c1) continue;
          covered.add(cellKey(r, c));
        }
      }
    }
    return { anchors, covered };
  }

  buildCellNode(sheetName, r, c, left, top, width, height, isMergeAnchor) {
    const cell = this.workbook.getCell(sheetName, r, c);
    const value = cell ? this.workbook.getValue(sheetName, r, c) : null;
    let text = cell ? this.workbook.getText(sheetName, r, c) : '';
    const numeric = typeof value === 'number';
    const style = cell?.s || {};

    const classes = ['grid__cell'];
    if (isError(value)) classes.push('is-error');
    if (style.b) classes.push('is-bold');
    if (style.i) classes.push('is-italic');
    if (style.u) classes.push('is-underline');
    if (style.st) classes.push('is-strike');
    if (style.border) classes.push('has-border');
    if (isMergeAnchor) classes.push('is-merged');

    const css = {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    };
    if (style.color) css.color = style.color;
    if (style.bg) css.background = style.bg;
    if (style.size) css.fontSize = `${style.size}px`;
    if (style.font) css.fontFamily = style.font;
    if (style.align) css.textAlign = style.align;
    else css.textAlign = numeric || typeof value === 'boolean' ? 'right' : 'left';
    if (style.wrap) css.whiteSpace = 'pre-wrap';

    const node = h('div', {
      class: classes.join(' '),
      style: css,
      dataset: { r: String(r), c: String(c) },
      title: text.length > 24 ? text : null,
    });
    let display = text;
    if (style.wrap) display = text;
    else if (display.length > Math.floor(width / 7.6)) display = display.slice(0, Math.max(0, Math.floor(width / 7.6)));
    node.textContent = display;
    return node;
  }

  renderSelection(xp, yp, scrollLeft, scrollTop) {
    const { from, to } = this.normalizedSelection();
    const left = xp[from.c] - scrollLeft;
    const top = yp[from.r] - scrollTop;
    const width = xp[to.c + 1] - xp[from.c];
    const height = yp[to.r + 1] - yp[from.r];

    clear(this.overlay);
    this.overlay.appendChild(h('div.grid__selection', { style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` } }));
    this.overlay.appendChild(h('div.grid__active', {
      style: {
        left: `${xp[this.active.c] - scrollLeft}px`,
        top: `${yp[this.active.r] - scrollTop}px`,
        width: `${this.colWidth(this.active.c)}px`,
        height: `${this.rowHeight(this.active.r)}px`,
      },
    }));
    this.selectionRect = { left, top, width, height };

    this.fillHandle = h('div.grid__fill-handle', {
      style: { left: `${left + width - 4}px`, top: `${top + height - 4}px` },
    });
    this.fillHandle.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.startFillDrag(event);
    });
    this.overlay.appendChild(this.fillHandle);

    this.syncEditorPosition();
  }

  /** 让公式栏与状态栏拿到最新选区 */
  updateActiveFromSelection() {
    const { from, to } = this.normalizedSelection();
    this.active = { r: from.r, c: from.c };
    this.renderWindow();
    this.controller.onSelectionChange?.({
      range: { from, to },
      active: this.active,
      raw: this.workbook.getRawInput(this.sheet.name, this.active.r, this.active.c),
      value: this.workbook.getValue(this.sheet.name, this.active.r, this.active.c),
    });
  }

  /* ------------------------------------------------------------------ *
   * 选区
   * ------------------------------------------------------------------ */
  normalizedSelection() {
    const { from, to } = this.selection;
    return {
      from: { r: Math.min(from.r, to.r), c: Math.min(from.c, to.c) },
      to: { r: Math.max(from.r, to.r), c: Math.max(from.c, to.c) },
    };
  }

  setSelection(range, render = true) {
    this.selection = {
      from: { r: clamp(range.from.r, 0, MAX_ROWS - 1), c: clamp(range.from.c, 0, MAX_COLS - 1) },
      to: { r: clamp(range.to.r, 0, MAX_ROWS - 1), c: clamp(range.to.c, 0, MAX_COLS - 1) },
    };
    if (render) {
      this.updateActiveFromSelection();
    } else {
      this.renderWindow();
    }
    this.controller.onSelectionChange?.({
      range: this.normalizedSelection(),
      active: this.active,
      raw: this.workbook.getRawInput(this.sheet.name, this.active.r, this.active.c),
      value: this.workbook.getValue(this.sheet.name, this.active.r, this.active.c),
    });
  }

  inSelection(cell) {
    const { from, to } = this.normalizedSelection();
    return cell.r >= from.r && cell.r <= to.r && cell.c >= from.c && cell.c <= to.c;
  }

  /** 选中整块数据（Ctrl+A / Ctrl+方向键用） */
  selectAll() {
    this.setSelection({ from: { r: 0, c: 0 }, to: { r: MAX_ROWS - 1, c: MAX_COLS - 1 } });
  }

  /** 以活动单元格为起点跳到数据区边界 */
  jumpToEdge(dr, dc) {
    const sheetName = this.sheet.name;
    let { r, c } = this.active;
    const isBlank = (row, col) => {
      const cell = this.workbook.getCell(sheetName, row, col);
      if (!cell) return true;
      const value = this.workbook.getValue(sheetName, row, col);
      return value === null || value === '';
    };
    const startBlank = isBlank(r, c);
    for (let step = 0; step < MAX_ROWS + MAX_COLS; step += 1) {
      const nr = clamp(r + dr, 0, MAX_ROWS - 1);
      const nc = clamp(c + dc, 0, MAX_COLS - 1);
      if (nr === r && nc === c) break;
      if (startBlank) {
        if (!isBlank(nr, nc)) {
          r = nr;
          c = nc;
          break;
        }
      } else if (isBlank(nr, nc)) {
        break;
      }
      r = nr;
      c = nc;
    }
    this.focusCell(r, c);
  }

  /** 滚动到指定单元格 */
  focusCell(r, c, render = true) {
    this.active = { r: clamp(r, 0, MAX_ROWS - 1), c: clamp(c, 0, MAX_COLS - 1) };
    this.selection = { from: this.active, to: this.active };
    this.scrollToCell(this.active.r, this.active.c);
    if (render) {
      this.renderWindow();
      this.controller.onSelectionChange?.({
        range: { from: this.active, to: this.active },
        active: this.active,
        raw: this.workbook.getRawInput(this.sheet.name, this.active.r, this.active.c),
        value: this.workbook.getValue(this.sheet.name, this.active.r, this.active.c),
      });
    }
  }

  scrollToCell(r, c) {
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    const left = xp[c];
    const right = xp[c + 1];
    const top = yp[r];
    const bottom = yp[r + 1];
    const viewWidth = this.scroll.clientWidth - HEADER_WIDTH;
    const viewHeight = this.scroll.clientHeight - HEADER_HEIGHT;
    if (left < this.scroll.scrollLeft) this.scroll.scrollLeft = left;
    else if (right > this.scroll.scrollLeft + viewWidth) this.scroll.scrollLeft = right - viewWidth;
    if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
    else if (bottom > this.scroll.scrollTop + viewHeight) this.scroll.scrollTop = bottom - viewHeight;
  }

  cellFromEvent(event) {
    const rect = this.el.getBoundingClientRect();
    const x = event.clientX - rect.left - HEADER_WIDTH + this.scroll.scrollLeft;
    const y = event.clientY - rect.top - HEADER_HEIGHT + this.scroll.scrollTop;
    if (event.clientX - rect.left < HEADER_WIDTH || event.clientY - rect.top < HEADER_HEIGHT) return null;
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    return { r: this.findIndex(yp, Math.max(0, y)), c: this.findIndex(xp, Math.max(0, x)) };
  }

  autoScroll(event) {
    const rect = this.el.getBoundingClientRect();
    const margin = 28;
    if (event.clientX > rect.right - margin) this.scroll.scrollLeft += 18;
    if (event.clientX < rect.left + HEADER_WIDTH + margin) this.scroll.scrollLeft = Math.max(0, this.scroll.scrollLeft - 18);
    if (event.clientY > rect.bottom - margin) this.scroll.scrollTop += 12;
    if (event.clientY < rect.top + HEADER_HEIGHT + margin) this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop - 12);
  }

  handleHeaderPointer(event, kind) {
    const cell = this.cellFromEvent(event);
    if (!cell) return;
    if (kind === 'col') this.setSelection({ from: { r: 0, c: cell.c }, to: { r: MAX_ROWS - 1, c: cell.c } });
    else this.setSelection({ from: { r: cell.r, c: 0 }, to: { r: cell.r, c: MAX_COLS - 1 } });
  }

  /* ------------------------------------------------------------------ *
   * 就地编辑
   * ------------------------------------------------------------------ */
  beginEdit(initialText) {
    if (this.editing) return;
    const { r, c } = this.active;
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    const left = xp[c] - this.scroll.scrollLeft;
    const top = yp[r] - this.scroll.scrollTop;
    const width = Math.max(this.colWidth(c), 120);
    const height = this.rowHeight(r);

    const node = h('textarea.cell-editor', {
      style: {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        textAlign: this.workbook.getCell(this.sheet.name, r, c)?.s?.align || 'left',
      },
      spellcheck: 'false',
    });
    node.value = initialText !== undefined ? initialText : this.workbook.getRawInput(this.sheet.name, r, c);
    this.overlay.appendChild(node);
    this.editing = { node, r, c, original: node.value };

    node.focus();
    if (initialText === undefined) node.select();
    else node.setSelectionRange(node.value.length, node.value.length);
    node.style.height = `${Math.max(height, Math.min(160, node.scrollHeight))}px`;

    node.addEventListener('input', () => {
      node.style.height = 'auto';
      node.style.height = `${Math.max(height, Math.min(200, node.scrollHeight))}px`;
      this.controller.onEditInput?.(node.value, { r, c });
      // 公式编辑时高亮引用的单元格
      this.highlightFormulaRefs(node.value);
    });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelEdit();
        this.scroll.focus();
        return;
      }
      if (event.key === 'Enter' && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const moveDown = this.controller.shouldMoveDownOnEnter?.() ?? true;
        this.commitEdit();
        const next = { r: Math.min(MAX_ROWS - 1, r + (moveDown ? 1 : 0)), c: moveDown ? c : Math.min(MAX_COLS - 1, c + 1) };
        this.focusCell(next.r, next.c);
        return;
      }
      if (event.key === 'Enter' && event.altKey) {
        event.preventDefault();
        const start = node.selectionStart;
        node.value = `${node.value.slice(0, start)}\n${node.value.slice(node.selectionEnd)}`;
        node.selectionStart = node.selectionEnd = start + 1;
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        this.commitEdit();
        this.focusCell(r, Math.min(MAX_COLS - 1, c + (event.shiftKey ? -1 : 1)));
        return;
      }
      event.stopPropagation();
    });
    node.addEventListener('blur', () => {
      if (this.editing && this.editing.node === node) this.commitEdit();
    });
    this.editingNode = node;
    this.controller.onEditStart?.({ r, c });
  }

  highlightFormulaRefs(text) {
    clear(this.refOverlay || (this.refOverlay = h('div.grid__ref-overlay')));
    if (!this.refOverlay.isConnected) this.overlay.appendChild(this.refOverlay);
    clear(this.refOverlay);
    if (!text || !text.startsWith('=')) return;
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    const re = /(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g;
    let match;
    while ((match = re.exec(text))) {
      const from = parseA1(match[1]);
      if (!from) continue;
      const to = match[2] ? parseA1(match[2]) : from;
      if (!to) continue;
      const r1 = Math.min(from.r, to.r);
      const r2 = Math.max(from.r, to.r);
      const c1 = Math.min(from.c, to.c);
      const c2 = Math.max(from.c, to.c);
      this.refOverlay.appendChild(h('div.grid__ref', {
        style: {
          left: `${xp[c1] - this.scroll.scrollLeft}px`,
          top: `${yp[r1] - this.scroll.scrollTop}px`,
          width: `${xp[c2 + 1] - xp[c1]}px`,
          height: `${yp[r2 + 1] - yp[r1]}px`,
        },
      }));
    }
  }

  syncEditorPosition() {
    if (!this.editing) return;
    const { r, c } = this.editing;
    const xp = this.xPrefix();
    const yp = this.yPrefix();
    this.editing.node.style.left = `${xp[c] - this.scroll.scrollLeft}px`;
    this.editing.node.style.top = `${yp[r] - this.scroll.scrollTop}px`;
  }

  commitEdit(moveAfter = false) {
    if (!this.editing) return;
    const { node, r, c, original } = this.editing;
    const value = node.value;
    this.editing = null;
    node.remove();
    if (this.refOverlay) clear(this.refOverlay);
    if (value === original) return;
    this.controller.onCellCommit?.({ r, c, input: value });
    if (moveAfter) this.renderWindow();
  }

  cancelEdit() {
    if (!this.editing) return;
    const { node } = this.editing;
    this.editing = null;
    node.remove();
    if (this.refOverlay) clear(this.refOverlay);
  }

  /** 由 controller 在外部（工具条/公式栏）提交编辑 */
  applyEdit(input, { move = 'down' } = {}) {
    const { r, c } = this.active;
    this.controller.onCellCommit?.({ r, c, input });
    if (move === 'down') this.focusCell(r + 1, c);
    else if (move === 'right') this.focusCell(r, c + 1);
    else this.renderWindow();
  }

  /* ------------------------------------------------------------------ *
   * 键盘
   * ------------------------------------------------------------------ */
  handleKeyDown(event) {
    if (this.editing) return;
    const { key, shiftKey, ctrlKey, metaKey, altKey } = event;
    const mod = ctrlKey || metaKey;

    if (mod && key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }
    if (mod && key.toLowerCase() === 'c') return; // 交给 copy 事件
    if (mod && key.toLowerCase() === 'x') return;
    if (mod && key.toLowerCase() === 'v') return;
    if (mod && key.toLowerCase() === 'z') {
      event.preventDefault();
      this.controller.onUndo?.(event.shiftKey);
      return;
    }
    if (mod && key.toLowerCase() === 'y') {
      event.preventDefault();
      this.controller.onUndo?.(false, true);
      return;
    }
    if (mod && key.toLowerCase() === 'b') {
      event.preventDefault();
      this.controller.toggleStyle?.('b');
      return;
    }
    if (mod && key.toLowerCase() === 'i') {
      event.preventDefault();
      this.controller.toggleStyle?.('i');
      return;
    }
    if (mod && key.toLowerCase() === 'u') {
      event.preventDefault();
      this.controller.toggleStyle?.('u');
      return;
    }
    if (mod && key.toLowerCase() === 'f') {
      event.preventDefault();
      this.controller.onFind?.();
      return;
    }
    if (mod && (key === 'Home' || key === 'End')) {
      event.preventDefault();
      this.focusCell(0, key === 'Home' ? 0 : MAX_COLS - 1);
      return;
    }
    if (mod && key.toLowerCase() === 'arrowleft') {
      event.preventDefault();
      this.jumpToEdge(0, -1);
      return;
    }
    if (mod && key.toLowerCase() === 'arrowright') {
      event.preventDefault();
      this.jumpToEdge(0, 1);
      return;
    }
    if (mod && key.toLowerCase() === 'arrowup') {
      event.preventDefault();
      this.jumpToEdge(-1, 0);
      return;
    }
    if (mod && key.toLowerCase() === 'arrowdown') {
      event.preventDefault();
      this.jumpToEdge(1, 0);
      return;
    }

    const extend = shiftKey;
    const from = this.selection.from;

    const moveTo = (r, c) => {
      const target = { r: clamp(r, 0, MAX_ROWS - 1), c: clamp(c, 0, MAX_COLS - 1) };
      if (extend) {
        this.setSelection({ from, to: target });
        this.active = target;
        this.renderWindow();
      } else {
        this.focusCell(target.r, target.c);
      }
    };

    switch (key) {
      case 'ArrowUp': event.preventDefault(); moveTo(this.active.r - 1, this.active.c); return;
      case 'ArrowDown': event.preventDefault(); moveTo(this.active.r + 1, this.active.c); return;
      case 'ArrowLeft': event.preventDefault(); moveTo(this.active.r, this.active.c - 1); return;
      case 'ArrowRight': event.preventDefault(); moveTo(this.active.r, this.active.c + 1); return;
      case 'Tab': event.preventDefault(); moveTo(this.active.r, this.active.c + (shiftKey ? -1 : 1)); return;
      case 'Enter': event.preventDefault(); moveTo(this.active.r + (shiftKey ? -1 : 1), this.active.c); return;
      case 'Home': event.preventDefault(); moveTo(this.active.r, 0); return;
      case 'End': event.preventDefault(); moveTo(this.active.r, MAX_COLS - 1); return;
      case 'PageDown': event.preventDefault(); moveTo(this.active.r + 24, this.active.c); return;
      case 'PageUp': event.preventDefault(); moveTo(this.active.r - 24, this.active.c); return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        this.controller.onClearSelection?.(key === 'Delete' ? 'contents' : 'all');
        return;
      case 'F2':
        event.preventDefault();
        this.beginEdit();
        return;
      case 'Escape':
        event.preventDefault();
        this.setSelection({ from: this.active, to: this.active });
        return;
      default:
        break;
    }

    // 直接输入进入编辑
    if (!mod && !altKey && key.length === 1) {
      event.preventDefault();
      this.beginEdit(key);
    }
  }

  /* ------------------------------------------------------------------ *
   * 剪贴板
   * ------------------------------------------------------------------ */
  handleCopy(event, mode) {
    if (this.editing) return;
    const { from, to } = this.normalizedSelection();
    const lines = [];
    for (let r = from.r; r <= to.r; r += 1) {
      const cells = [];
      for (let c = from.c; c <= to.c; c += 1) {
        cells.push(this.workbook.getRawInput(this.sheet.name, r, c).replace(/\t/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    const text = lines.join('\n');
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
    this.copiedRange = mode === 'cut' ? { from, to } : null;
    this.el.classList.add('is-copied');
    setTimeout(() => this.el.classList.remove('is-copied'), 400);
    if (mode === 'cut') this.controller.onCutSelection?.({ from, to });
  }

  handlePaste(event) {
    if (this.editing) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const rows = parseDelimited(text, text.includes('\t') ? '\t' : ',');
    const start = this.active;
    const entries = [];
    rows.forEach((row, ri) => {
      row.forEach((value, ci) => {
        entries.push({ r: start.r + ri, c: start.c + ci, input: value });
      });
    });
    this.controller.onPasteBlock?.({ start, rows, entries });
    this.setSelection({
      from: start,
      to: { r: start.r + Math.max(0, rows.length - 1), c: start.c + Math.max(0, (rows[0]?.length || 1) - 1) },
    });
  }

  /* ------------------------------------------------------------------ *
   * 填充柄
   * ------------------------------------------------------------------ */
  startFillDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    const start = this.normalizedSelection();
    const preview = h('div.grid__fill-preview');
    this.overlay.appendChild(preview);

    const onMove = (moveEvent) => {
      const cell = this.cellFromEvent(moveEvent);
      if (!cell) return;
      const xp = this.xPrefix();
      const yp = this.yPrefix();
      const target = {
        from: { r: Math.min(start.from.r, cell.r), c: Math.min(start.from.c, cell.c) },
        to: { r: Math.max(start.from.r, cell.r), c: Math.max(start.from.c, cell.c) },
      };
      this.fillTarget = target;
      preview.style.left = `${xp[target.from.c] - this.scroll.scrollLeft}px`;
      preview.style.top = `${yp[target.from.r] - this.scroll.scrollTop}px`;
      preview.style.width = `${xp[target.to.c + 1] - xp[target.from.c]}px`;
      preview.style.height = `${yp[target.to.r + 1] - yp[target.from.r]}px`;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      preview.remove();
      if (this.fillTarget) this.applyFill(start, this.fillTarget);
      this.fillTarget = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** 计算填充结果并交给 controller 写入 */
  applyFill(source, target) {
    const sheetName = this.sheet.name;
    const patterns = [];
    const sourceHeight = source.to.r - source.from.r + 1;
    const sourceWidth = source.to.c - source.from.c + 1;
    const down = target.to.r > source.to.r;
    const right = target.to.c > source.to.c;
    const up = target.from.r < source.from.r;
    const left = target.from.c < source.from.c;

    if (down || up) {
      for (let c = source.from.c; c <= source.to.c; c += 1) {
        const series = [];
        for (let r = source.from.r; r <= source.to.r; r += 1) {
          series.push({
            input: this.workbook.getRawInput(sheetName, r, c),
            value: this.workbook.getValue(sheetName, r, c),
            style: this.workbook.getCell(sheetName, r, c)?.s || null,
          });
        }
        const plan = buildSeries(series, target.to.r - target.from.r + 1, down ? source.to.r : source.from.r, down ? 'down' : 'up');
        plan.forEach((entry) => patterns.push({ ...entry, c }));
      }
    } else {
      for (let r = source.from.r; r <= source.to.r; r += 1) {
        const series = [];
        for (let c = source.from.c; c <= source.to.c; c += 1) {
          series.push({
            input: this.workbook.getRawInput(sheetName, r, c),
            value: this.workbook.getValue(sheetName, r, c),
            style: this.workbook.getCell(sheetName, r, c)?.s || null,
          });
        }
        const plan = buildSeries(series, target.to.c - target.from.c + 1, right ? source.to.c : source.from.c, right ? 'right' : 'left');
        plan.forEach((entry) => patterns.push({ ...entry, r }));
      }
    }
    this.controller.onFill?.({ entries: patterns.filter((entry) => entry.inTarget !== false) });
    this.setSelection(target);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 生成填充序列：等差数字、日期、公式平移、文本重复。
 * @param {Array<{input: string, value: any, style: any}>} series 源序列（按方向排列）
 * @param {number} total 目标区域总长度（含源区域）
 * @param {number} anchor 源区域的边界坐标
 * @param {'down'|'up'|'right'|'left'} direction
 */
function buildSeries(series, total, anchor, direction) {
  const out = [];
  const numbers = series.map((item) => (typeof item.value === 'number' ? item.value : null));
  const allNumeric = numbers.every((value) => value !== null);
  const formulas = series.map((item) => (item.input.startsWith('=') ? item.input : null));
  const allFormulas = formulas.every(Boolean);

  if (allNumeric && series.length >= 1) {
    const step = series.length > 1 ? numbers[1] - numbers[0] : 1;
    const consistent = series.length <= 2 || numbers.every((value, index) => index === 0 || Math.abs(value - numbers[index - 1] - step) < 1e-9);
    const delta = consistent ? step : 1;
    for (let i = series.length; i < total; i += 1) {
      const value = numbers[0] + delta * i;
      const position = positionFor(i, anchor, direction, series.length);
      out.push({ ...position, input: String(value), style: series[0].style });
    }
    return out;
  }

  if (allFormulas) {
    for (let i = series.length; i < total; i += 1) {
      const sourceIndex = i % series.length;
      const base = series[sourceIndex];
      const shift = direction === 'down' || direction === 'up'
        ? { rows: i - sourceIndex, cols: 0 }
        : { rows: 0, cols: i - sourceIndex };
      const position = positionFor(i, anchor, direction, series.length);
      out.push({ ...position, input: translateFormula(base.input, shift), style: base.style });
    }
    return out;
  }

  // 文本：循环重复
  for (let i = series.length; i < total; i += 1) {
    const base = series[i % series.length];
    const position = positionFor(i, anchor, direction, series.length);
    out.push({ ...position, input: base.input, style: base.style });
  }
  return out;
}

function positionFor(index, anchor, direction, sourceLength) {
  const offset = index - sourceLength + 1;
  if (direction === 'down') return { r: anchor + offset, inTarget: true };
  if (direction === 'up') return { r: anchor - offset, inTarget: true };
  if (direction === 'right') return { c: anchor + offset, inTarget: true };
  return { c: anchor - offset, inTarget: true };
}
