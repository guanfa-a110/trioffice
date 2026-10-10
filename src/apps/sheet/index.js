/**
 * index.js —— TriOffice Sheet（表格）应用控制器。
 * 负责外壳菜单、工具条、公式栏、工作表标签、状态栏、图表与导入导出。
 */
import { h, clear, escapeHtml } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { button, openDialog, openMenu, confirmDialog, promptDialog, toast, toastError, toastSuccess, icon, segmented } from '../../core/ui.js';
import { bus, EVENTS } from '../../core/bus.js';
import { History } from '../../core/history.js';
import { registerExporter, registerImporter, serializeDoc, withPreview, findExporter, importFile } from '../../core/format.js';
import { download, safeFileName, pickFiles, printSection } from '../../core/fileio.js';
import { createAppFrame, exportMenuItems, showShortcuts, showAbout, applyTheme } from '../../shell/frame.js';
import { Workbook, createWorkbook, normalizeWorkbook, NUMBER_FORMATS, rangeToCsv, parseDelimited, sortRange, MAX_ROWS, MAX_COLS } from './workbook.js';
import { Grid } from './grid.js';
import { parseA1, formatA1, formatRange } from './address.js';
import { FUNCTIONS, functionNames, functionCatalog } from './functions.js';
import { isError, formatNumber } from './value.js';
import { workbookToXlsx, xlsxToWorkbook } from './xlsx.js';
import { renderChart, buildChartData, CHART_TYPES, CHART_PALETTE } from './chart.js';

/* ------------------------------------------------------------------ *
 * 导入 / 导出注册
 * ------------------------------------------------------------------ */
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

registerExporter('sheet', {
  id: 'xlsx',
  label: 'Excel 工作簿 (.xlsx)',
  ext: 'xlsx',
  mime: MIME_XLSX,
  run: async (doc) => {
    const bytes = workbookToXlsx(new Workbook(doc.data));
    return { filename: safeFileName(doc.title, 'xlsx'), content: bytes, mime: MIME_XLSX };
  },
});

registerExporter('sheet', {
  id: 'csv',
  label: 'CSV (.csv)',
  ext: 'csv',
  mime: 'text/csv;charset=utf-8',
  run: async (doc) => {
    const workbook = new Workbook(doc.data);
    const sheet = workbook.sheet;
    const used = workbook.usedRange(sheet);
    const text = used.empty ? '' : rangeToCsv(workbook, sheet.name, { r: 0, c: 0 }, used.to);
    return { filename: safeFileName(`${doc.title}-${sheet.name}`, 'csv'), content: `\ufeff${text}`, mime: 'text/csv;charset=utf-8' };
  },
});

registerExporter('sheet', {
  id: 'html',
  label: '网页表格 (.html)',
  ext: 'html',
  mime: 'text/html;charset=utf-8',
  run: async (doc) => {
    const workbook = new Workbook(doc.data);
    const html = sheetToHtml(workbook);
    return { filename: safeFileName(doc.title, 'html'), content: html, mime: 'text/html;charset=utf-8' };
  },
});

registerExporter('sheet', {
  id: 'trio',
  label: 'TriOffice 表格 (.trio)',
  ext: 'trio',
  mime: 'application/json',
  run: async (doc) => ({ filename: safeFileName(doc.title, 'trio'), content: serializeDoc(doc), mime: 'application/json' }),
});

registerImporter(['csv', 'tsv'], async (file, ctx) => {
  const text = await ctx.text;
  const rows = parseDelimited(text, file.name.endsWith('.tsv') ? '\t' : undefined);
  return { type: 'sheet', title: file.name.replace(/\.[^.]+$/, ''), data: workbookFromRows(rows) };
});

registerImporter(['xlsx'], async (file, ctx) => {
  const buffer = await ctx.buffer;
  return { type: 'sheet', title: file.name.replace(/\.[^.]+$/, ''), data: await xlsxToWorkbook(buffer) };
});

/** 二维数组 → 工作簿 */
function workbookFromRows(rows) {
  const workbook = new Workbook(createWorkbook());
  const entries = [];
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === '' || value === undefined) return;
      entries.push({ r, c, input: String(value) });
    });
  });
  workbook.setCells(workbook.sheet.name, entries);
  return workbook.toJSON();
}

/** 工作簿 → 独立 HTML（含表格与图表） */
function sheetToHtml(workbook) {
  const parts = [];
  parts.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">');
  parts.push('<title>TriOffice 表格导出</title><style>');
  parts.push('body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#1a1d21}');
  parts.push('table{border-collapse:collapse;font-size:13px}td{border:1px solid #dfe3e8;padding:4px 8px;min-width:60px}');
  parts.push('.err{color:#d93025}.bold{font-weight:600}h2{margin-top:32px}');
  parts.push('</style></head><body>');
  for (const sheet of workbook.data.sheets) {
    const used = workbook.usedRange(sheet);
    parts.push(`<h2>${escapeHtml(sheet.name)}</h2><table>`);
    if (!used.empty) {
      for (let r = 0; r <= used.to.r; r += 1) {
        parts.push('<tr>');
        for (let c = 0; c <= used.to.c; c += 1) {
          const value = workbook.getValue(sheet.name, r, c);
          const text = workbook.getText(sheet.name, r, c);
          const cell = workbook.getCell(sheet.name, r, c);
          const classes = [isError(value) ? 'err' : '', cell?.s?.b ? 'bold' : ''].filter(Boolean).join(' ');
          const align = cell?.s?.align || (typeof value === 'number' ? 'right' : 'left');
          parts.push(`<td class="${classes}" style="text-align:${align}">${escapeHtml(text)}</td>`);
        }
        parts.push('</tr>');
      }
    }
    parts.push('</table>');
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * 应用主体
 * ------------------------------------------------------------------ */
/**
 * 挂载表格应用。
 * @param {{doc: object, onSave: Function, onClose: Function}} options
 */
export function mountSheetApp({ doc, onSave, onClose }) {
  const workbook = new Workbook(doc.data || createWorkbook());

  // 这些声明必须早于任何回调触发点（History.onChange、工具栏构建等），否则会撞上 TDZ
  let dirty = false;
  let undoButtons = null;
  let zoom = 1;
  const chartBoxes = new Map();
  /** Grid 实例：用 let 先占位，避免 new Grid(...) 期间回调读它时踩 TDZ */
  let grid = null;

  const history = new History({
    limit: 200,
    onChange: (info) => updateHistoryButtons(info),
  });
  history.reset(workbook.toJSON());

  const frame = createAppFrame({
    title: doc.title,
    iconName: 'sheet',
    appLabel: t('home.sheet'),
    menus: () => buildMenus(),
    toolbar: () => buildToolbar(),
    onTitleChange: (title) => {
      doc.title = title;
      markDirty();
      frame.setTitle(title);
    },
    onClose: () => onClose?.(),
    onSave: () => saveNow(),
    extraActions: () => [],
  });

  /* ---------- 公式栏 ---------- */
  const nameBox = h('button.sheet__name-box', {
    type: 'button',
    text: 'A1',
    title: t('sheet.goto'),
    onclick: () => gotoDialog(),
  });
  const formulaInput = h('input.sheet__formula-input', {
    type: 'text',
    placeholder: t('sheet.helpHint'),
    spellcheck: 'false',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitFormulaBar();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        syncFormulaBar();
        grid.scroll.focus();
      }
    },
    oninput: () => grid.highlightFormulaRefs(formulaInput.value),
  });
  const formulaBar = h('div.sheet__formula', {}, [
    nameBox,
    h('span.sheet__fx', { text: 'fx', title: t('sheet.functions') }),
    formulaInput,
    h('button.sheet__fx-info', {
      type: 'button',
      title: t('sheet.helpTitle'),
      onclick: () => showFunctionHelp(),
    }, [icon('info', { size: 15 })]),
  ]);

  const gridMount = h('div.sheet__grid');
  const tabsBar = h('div.sheet__tabs');
  const summaryBar = h('div.sheet__summary');

  const content = h('div.sheet', {}, [formulaBar, gridMount, tabsBar]);
  frame.body.appendChild(content);
  frame.setStatusBar([summaryBar]);

  grid = new Grid({
    workbook,
    mount: gridMount,
    controller: {
      onSelectionChange: ({ range, raw, value }) => {
        nameBox.textContent = range.from.r === range.to.r && range.from.c === range.to.c
          ? formatA1({ r: range.from.r, c: range.from.c })
          : formatRange({ r: range.from.r, c: range.from.c }, { r: range.to.r, c: range.to.c });
        if (document.activeElement !== formulaInput) formulaInput.value = raw || '';
        updateSummary(range);
      },
      onCellCommit: ({ r, c, input }) => applyEdit(r, c, input),
      onClearSelection: (mode) => clearSelection(mode),
      onContextMenu: (event) => showContextMenu(event),
      onFill: ({ entries }) => fillCells(entries),
      onPasteBlock: ({ entries }) => pasteBlock(entries),
      onCutSelection: ({ from, to }) => clearRange(from, to, 'all', false),
      onUndo: (redo, forceRedo) => {
        if (forceRedo || redo) doRedo();
        else doUndo();
      },
      toggleStyle: (key) => toggleStyle(key),
      onFind: () => showFindDialog(),
      onViewportChange: () => positionCharts(),
      onEditStart: () => {},
      onEditInput: (value) => {
        if (document.activeElement !== formulaInput) formulaInput.value = value;
      },
      onZoom: (delta) => setZoom(zoom + delta),
    },
  });

  function setZoom(value) {
    zoom = Math.max(0.6, Math.min(1.6, Math.round(value * 10) / 10));
    gridMount.style.setProperty('--sheet-zoom', String(zoom));
    renderAll();
    frame.setStatus(`${Math.round(zoom * 100)}%`, 'idle', 1200);
  }

  /* ---------- 菜单 ---------- */
  function buildMenus() {
    return [
      {
        label: t('menu.file'),
        items: [
          { label: t('menu.save'), icon: 'save', shortcut: 'Ctrl/⌘+S', onClick: () => saveNow() },
          { label: t('menu.saveAs'), icon: 'copy', onClick: () => duplicateDocument() },
          { separator: true },
          { label: t('menu.import'), icon: 'upload', onClick: () => importInto() },
          { label: t('menu.export'), icon: 'download', onClick: () => openModalExport() },
          ...exportMenuItems(doc, (id) => exportAs(id)).map((item) => ({ ...item, label: `　${item.label}` })),
          { separator: true },
          { label: t('menu.print'), icon: 'printer', shortcut: 'Ctrl/⌘+P', onClick: () => printSheet() },
          { separator: true },
          { label: t('menu.close'), icon: 'chevron-left', onClick: () => onClose?.() },
        ],
      },
      {
        label: t('menu.edit'),
        items: [
          { label: `${t('writer.undo')} · ${history.undoLabel || ''}`, icon: 'undo', shortcut: 'Ctrl/⌘+Z', disabled: !history.canUndo, onClick: () => doUndo() },
          { label: `${t('writer.redo')} · ${history.redoLabel || ''}`, icon: 'redo', shortcut: 'Shift+Ctrl/⌘+Z', disabled: !history.canRedo, onClick: () => doRedo() },
          { separator: true },
          { label: t('sheet.clearContents'), icon: 'eraser', shortcut: 'Delete', onClick: () => clearSelection('contents') },
          { label: t('sheet.borderNone'), icon: 'eraser', onClick: () => clearSelection('format') },
          { separator: true },
          { label: t('writer.find'), icon: 'search', shortcut: 'Ctrl/⌘+F', onClick: () => showFindDialog() },
          { label: t('sheet.goto'), icon: 'expand', onClick: () => gotoDialog() },
        ],
      },
      {
        label: t('menu.insert'),
        items: [
          { label: t('sheet.insertRowAbove'), icon: 'plus-square', onClick: () => insertRows('above') },
          { label: t('sheet.insertRowBelow'), icon: 'plus-square', onClick: () => insertRows('below') },
          { label: t('sheet.insertColLeft'), icon: 'plus-square', onClick: () => insertCols('left') },
          { label: t('sheet.insertColRight'), icon: 'plus-square', onClick: () => insertCols('right') },
          { separator: true },
          { label: t('sheet.deleteRow'), icon: 'trash', onClick: () => deleteRows() },
          { label: t('sheet.deleteCol'), icon: 'trash', onClick: () => deleteCols() },
          { separator: true },
          { label: t('sheet.chart'), icon: 'chart-bar', onClick: () => insertChartDialog() },
          { label: t('sheet.addSheet'), icon: 'plus', onClick: () => addSheet() },
        ],
      },
      {
        label: t('menu.format'),
        items: [
          ...NUMBER_FORMATS.map((item) => ({
            label: t(item.labelKey),
            checked: currentFormat() === item.id,
            onClick: () => applyNumberFormatId(item.id),
          })),
          { separator: true },
          { label: t('sheet.borderAll'), icon: 'table', onClick: () => toggleBorder() },
          { label: t('sheet.merge'), icon: 'merge', onClick: () => mergeSelection() },
          { label: t('sheet.unmerge'), icon: 'columns', onClick: () => unmergeSelection() },
          { separator: true },
          { label: t('sheet.freeze'), icon: 'freeze', checked: hasFreeze(), onClick: () => toggleFreeze() },
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
          { label: '放大 110%', icon: 'search', onClick: () => setZoom(zoom + 0.1) },
          { label: '缩小 90%', icon: 'search', onClick: () => setZoom(zoom - 0.1) },
          { label: '恢复 100%', icon: 'search', onClick: () => setZoom(1) },
          { separator: true },
          { label: t('sheet.freeze'), icon: 'freeze', checked: hasFreeze(), onClick: () => toggleFreeze() },
          { label: `${t('sheet.rows')} ${MAX_ROWS} · ${t('sheet.cols')} ${MAX_COLS}`, disabled: true },
          { label: t('sheet.helpTitle'), icon: 'fx', onClick: () => showFunctionHelp() },
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

  /* ---------- 工具条 ---------- */
  function buildToolbar() {
    const group = (children) => h('div.toolbar__group', {}, children);
    return [
      group([
        (() => {
          const undo = button({ icon: 'undo', title: t('writer.undo'), variant: 'toolbar', hideLabel: true, disabled: !history.canUndo, onClick: () => doUndo() });
          const redo = button({ icon: 'redo', title: t('writer.redo'), variant: 'toolbar', hideLabel: true, disabled: !history.canRedo, onClick: () => doRedo() });
          undoButtons = { undo, redo };
          return undo;
        })(),
        (() => {
          const redo = button({ icon: 'redo', title: t('writer.redo'), variant: 'toolbar', hideLabel: true, disabled: !history.canRedo, onClick: () => doRedo() });
          undoButtons.redo = redo;
          return redo;
        })(),
      ]),
      group([
        button({
          icon: 'sum',
          label: t('sheet.autoSum'),
          title: `${t('sheet.autoSum')} (Alt+=)`,
          variant: 'toolbar',
          onClick: () => autoSum(),
        }),
      ]),
      group([
        button({ icon: 'bold', title: t('sheet.bold'), variant: 'toolbar', hideLabel: true, active: selectionHasStyle('b'), onClick: () => toggleStyle('b') }),
        button({ icon: 'italic', title: t('sheet.italic'), variant: 'toolbar', hideLabel: true, active: selectionHasStyle('i'), onClick: () => toggleStyle('i') }),
        button({ icon: 'underline', title: t('sheet.underline'), variant: 'toolbar', hideLabel: true, active: selectionHasStyle('u'), onClick: () => toggleStyle('u') }),
        button({ icon: 'strike', title: t('sheet.strike'), variant: 'toolbar', hideLabel: true, active: selectionHasStyle('st'), onClick: () => toggleStyle('st') }),
      ]),
      group([
        button({ icon: 'palette', title: t('sheet.textColor'), variant: 'toolbar', hideLabel: true, onClick: (event) => colorMenu(event.currentTarget, 'color') }),
        button({ icon: 'paint', title: t('sheet.fillColor'), variant: 'toolbar', hideLabel: true, onClick: (event) => colorMenu(event.currentTarget, 'bg') }),
      ]),
      group([
        button({ icon: 'align-left', title: t('writer.alignLeft'), variant: 'toolbar', hideLabel: true, onClick: () => setStyle({ align: 'left' }) }),
        button({ icon: 'align-center', title: t('writer.alignCenter'), variant: 'toolbar', hideLabel: true, onClick: () => setStyle({ align: 'center' }) }),
        button({ icon: 'align-right', title: t('writer.alignRight'), variant: 'toolbar', hideLabel: true, onClick: () => setStyle({ align: 'right' }) }),
        button({ icon: 'text', title: t('sheet.numberFormat'), variant: 'toolbar', hideLabel: true, onClick: (event) => numberFormatMenu(event.currentTarget) }),
      ]),
      group([
        button({ icon: 'table', title: t('sheet.borders'), variant: 'toolbar', hideLabel: true, onClick: (event) => borderMenu(event.currentTarget) }),
        button({ icon: 'merge', title: t('sheet.merge'), variant: 'toolbar', hideLabel: true, onClick: () => mergeSelection() }),
        button({ icon: 'freeze', title: t('sheet.freeze'), variant: 'toolbar', hideLabel: true, active: hasFreeze(), onClick: () => toggleFreeze() }),
      ]),
      group([
        button({ icon: 'sort-asc', title: t('sheet.sortAsc'), variant: 'toolbar', hideLabel: true, onClick: () => sortSelection(1) }),
        button({ icon: 'sort-desc', title: t('sheet.sortDesc'), variant: 'toolbar', hideLabel: true, onClick: () => sortSelection(-1) }),
      ]),
      group([
        button({ icon: 'chart-bar', label: t('sheet.chart'), variant: 'toolbar', onClick: () => insertChartDialog() }),
        button({ icon: 'download', label: t('sheet.exportXlsx'), variant: 'toolbar', onClick: () => exportAs('xlsx') }),
        button({ icon: 'search', title: t('writer.find'), variant: 'toolbar', hideLabel: true, onClick: () => showFindDialog() }),
      ]),
    ];
  }

  /* ---------- 编辑动作 ---------- */
  function mutate(label, fn, options = {}) {
    fn();
    history.commit(label, workbook.toJSON());
    if (!options.silent) markDirty();
    renderAll();
  }

  function markDirty() {
    dirty = true;
    frame.setDirty(true);
  }

  function applyEdit(r, c, input) {
    mutate(t('sheet.formula'), () => workbook.setCell(workbook.sheet.name, r, c, input));
  }

  function commitFormulaBar() {
    const { r, c } = grid.active;
    applyEdit(r, c, formulaInput.value);
    grid.scroll.focus();
  }

  function pasteBlock(entries) {
    mutate('粘贴', () => workbook.setCells(workbook.sheet.name, entries));
  }

  function fillCells(entries) {
    if (!entries.length) return;
    mutate('填充', () => {
      for (const entry of entries) {
        if (entry.r === undefined || entry.c === undefined) continue;
        workbook.setCell(workbook.sheet.name, entry.r, entry.c, entry.input);
        if (entry.style) workbook.setStyle(workbook.sheet.name, [{ r: entry.r, c: entry.c }], entry.style);
      }
    });
  }

  function clearSelection(mode) {
    mutate(t('sheet.clearContents'), () => {
      const { from, to } = grid.normalizedSelection();
      const list = [];
      for (let r = from.r; r <= to.r; r += 1) for (let c = from.c; c <= to.c; c += 1) list.push({ r, c });
      workbook.clearCells(workbook.sheet.name, list, mode);
    });
  }

  function clearRange(from, to, mode, record = true) {
    const apply = () => {
      const list = [];
      for (let r = from.r; r <= to.r; r += 1) for (let c = from.c; c <= to.c; c += 1) list.push({ r, c });
      workbook.clearCells(workbook.sheet.name, list, mode);
    };
    if (record) mutate('剪切', apply);
    else apply();
  }

  function selectionList() {
    const { from, to } = grid.normalizedSelection();
    const list = [];
    for (let r = from.r; r <= to.r; r += 1) for (let c = from.c; c <= to.c; c += 1) list.push({ r, c });
    return list;
  }

  function setStyle(style, label = '格式') {
    mutate(label, () => workbook.setStyle(workbook.sheet.name, selectionList(), style));
  }

  function toggleStyle(key) {
    const cell = workbook.getCell(workbook.sheet.name, grid.active.r, grid.active.c);
    const next = !cell?.s?.[key];
    setStyle({ [key]: next || null }, t('menu.format'));
  }

  function selectionHasStyle(key) {
    const cell = workbook.getCell(workbook.sheet.name, grid.active.r, grid.active.c);
    return Boolean(cell?.s?.[key]);
  }

  function currentFormat() {
    const cell = workbook.getCell(workbook.sheet.name, grid.active.r, grid.active.c);
    return cell?.fmt || 'general';
  }

  function applyNumberFormatId(id) {
    mutate(t('sheet.numberFormat'), () => workbook.setNumberFormat(workbook.sheet.name, selectionList(), id));
  }

  function toggleBorder() {
    const cell = workbook.getCell(workbook.sheet.name, grid.active.r, grid.active.c);
    setStyle({ border: !cell?.s?.border || null }, t('sheet.borders'));
  }

  function insertRows(where) {
    const { from } = grid.normalizedSelection();
    const at = where === 'above' ? from.r : from.r + 1;
    mutate(t('sheet.insertRowAbove'), () => workbook.insertRows(workbook.sheet.name, at));
  }

  function deleteRows() {
    const { from, to } = grid.normalizedSelection();
    mutate(t('sheet.deleteRow'), () => workbook.deleteRows(workbook.sheet.name, from.r, to.r - from.r + 1));
  }

  function insertCols(where) {
    const { from } = grid.normalizedSelection();
    const at = where === 'left' ? from.c : from.c + 1;
    mutate(t('sheet.insertColLeft'), () => workbook.insertCols(workbook.sheet.name, at));
  }

  function deleteCols() {
    const { from, to } = grid.normalizedSelection();
    mutate(t('sheet.deleteCol'), () => workbook.deleteCols(workbook.sheet.name, from.c, to.c - from.c + 1));
  }

  function sortSelection(direction) {
    const { from, to } = grid.normalizedSelection();
    if (from.r === to.r) {
      toast(t('toast.chartNoData'), 'warn');
      return;
    }
    const hasHeader = typeof workbook.getValue(workbook.sheet.name, from.r, grid.active.c) !== 'number';
    mutate(t('sheet.sortAsc'), () => sortRange(workbook, workbook.sheet.name, { from, to }, grid.active.c, direction, hasHeader));
  }

  function autoSum() {
    const { from, to } = grid.normalizedSelection();
    const targetRow = to.r + 1;
    const entries = [];
    for (let c = from.c; c <= to.c; c += 1) {
      entries.push({ r: targetRow, c, input: `=SUM(${formatA1({ r: from.r, c })}:${formatA1({ r: to.r, c })})` });
    }
    if (!entries.length) return;
    mutate(t('sheet.autoSum'), () => workbook.setCells(workbook.sheet.name, entries));
    grid.setSelection({ from: { r: targetRow, c: from.c }, to: { r: targetRow, c: to.c } });
  }

  function mergeSelection() {
    const { from, to } = grid.normalizedSelection();
    if (from.r === to.r && from.c === to.c) return;
    mutate(t('sheet.merge'), () => {
      const sheet = workbook.sheet;
      sheet.merges = (sheet.merges || []).filter(([r1, c1, r2, c2]) => {
        const overlap = !(c2 < from.c || c1 > to.c || r2 < from.r || r1 > to.r);
        return !overlap;
      });
      sheet.merges.push([from.r, from.c, to.r, to.c]);
      // 只保留左上角的值
      const list = [];
      for (let r = from.r; r <= to.r; r += 1) for (let c = from.c; c <= to.c; c += 1) if (r !== from.r || c !== from.c) list.push({ r, c });
      workbook.clearCells(workbook.sheet.name, list, 'all');
      workbook.touch({ type: 'merge' });
    });
  }

  function unmergeSelection() {
    const { from, to } = grid.normalizedSelection();
    mutate(t('sheet.unmerge'), () => {
      const sheet = workbook.sheet;
      sheet.merges = (sheet.merges || []).filter(([r1, c1, r2, c2]) => (c2 < from.c || c1 > to.c || r2 < from.r || r1 > to.r));
      workbook.touch({ type: 'unmerge' });
    });
  }

  function hasFreeze() {
    const frozen = workbook.sheet.frozen || {};
    return Boolean(frozen.rows || frozen.cols);
  }

  function toggleFreeze() {
    mutate(t('sheet.freeze'), () => {
      const sheet = workbook.sheet;
      if (hasFreeze()) sheet.frozen = { rows: 0, cols: 0 };
      else sheet.frozen = { rows: grid.active.r + 1, cols: grid.active.c + 1 };
      workbook.touch({ type: 'freeze' });
    });
  }

  /* ---------- 撤销/重做 ---------- */
  function updateHistoryButtons(info) {
    if (!undoButtons) return;
    undoButtons.undo.disabled = !info.canUndo;
    undoButtons.redo.disabled = !info.canRedo;
  }

  function doUndo() {
    const state = history.undo();
    if (state) {
      workbook.data = normalizeWorkbook(state);
      workbook.beginPass();
      markDirty();
      renderAll();
    }
  }

  function doRedo() {
    const state = history.redo();
    if (state) {
      workbook.data = normalizeWorkbook(state);
      workbook.beginPass();
      markDirty();
      renderAll();
    }
  }

  /* ---------- 工作表标签 ---------- */
  function renderTabs() {
    clear(tabsBar);
    workbook.data.sheets.forEach((sheet, index) => {
      const active = index === workbook.data.active;
      const node = h('button.sheet__tab', {
        class: active ? 'is-active' : '',
        type: 'button',
        text: sheet.name,
        onclick: () => switchSheet(index),
        oncontextmenu: (event) => {
          event.preventDefault();
          openMenu(node, [
            { label: t('sheet.renameSheet'), icon: 'pencil', onClick: () => renameSheet(index) },
            { label: t('sheet.duplicateSheet'), icon: 'copy', onClick: () => duplicateSheet(index) },
            { separator: true },
            { label: t('sheet.deleteSheet'), icon: 'trash', danger: true, disabled: workbook.data.sheets.length <= 1, onClick: () => deleteSheet(index) },
          ]);
        },
      });
      tabsBar.appendChild(node);
    });
    tabsBar.appendChild(h('div.sheet__tabs-actions', {}, [
      button({ icon: 'plus', title: t('sheet.addSheet'), variant: 'icon', onClick: () => addSheet() }),
      button({
        icon: 'more',
        title: t('menu.file'),
        variant: 'icon',
        onClick: (event) => openMenu(event.currentTarget, [
          { label: t('sheet.addSheet'), icon: 'plus', onClick: () => addSheet() },
          { label: t('sheet.duplicateSheet'), icon: 'copy', onClick: () => duplicateSheet(workbook.data.active) },
          { label: t('sheet.renameSheet'), icon: 'pencil', onClick: () => renameSheet(workbook.data.active) },
          { separator: true },
          { label: t('sheet.deleteSheet'), icon: 'trash', danger: true, onClick: () => deleteSheet(workbook.data.active) },
        ], { align: 'right' }),
      }),
    ]));
  }

  function switchSheet(index) {
    mutate('切换工作表', () => {
      workbook.data.active = index;
    }, { silent: true });
    grid.focusCell(0, 0);
  }

  async function addSheet() {
    mutate(t('sheet.addSheet'), () => {
      const name = nextSheetName();
      workbook.data.sheets.push({
        id: `s${Date.now().toString(36)}`,
        name,
        cells: {},
        colWidths: {},
        rowHeights: {},
        merges: [],
        frozen: { rows: 0, cols: 0 },
        charts: [],
        view: { row: 0, col: 0 },
      });
      workbook.data.active = workbook.data.sheets.length - 1;
    });
  }

  function nextSheetName() {
    let index = workbook.data.sheets.length + 1;
    while (workbook.hasSheet(`Sheet${index}`)) index += 1;
    return `Sheet${index}`;
  }

  async function renameSheet(index) {
    const sheet = workbook.data.sheets[index];
    const name = await promptDialog({ title: t('sheet.renameSheet'), value: sheet.name, label: t('sheet.sheetName') });
    if (name === null || !name.trim()) return;
    const trimmed = name.trim().slice(0, 31);
    if (workbook.hasSheet(trimmed) && trimmed !== sheet.name) {
      toastError('已存在同名工作表');
      return;
    }
    mutate(t('sheet.renameSheet'), () => {
      sheet.name = trimmed;
    });
  }

  function duplicateSheet(index) {
    mutate(t('sheet.duplicateSheet'), () => {
      const source = workbook.data.sheets[index];
      const copy = structuredCloneSource(source);
      copy.name = `${source.name}2`;
      while (workbook.hasSheet(copy.name)) copy.name = `${copy.name}2`;
      workbook.data.sheets.splice(index + 1, 0, copy);
      workbook.data.active = index + 1;
    });
  }

  async function deleteSheet(index) {
    if (workbook.data.sheets.length <= 1) return;
    const sheet = workbook.data.sheets[index];
    const ok = await confirmDialog(t('common.confirmDelete', { name: sheet.name }), { danger: true });
    if (!ok) return;
    mutate(t('sheet.deleteSheet'), () => {
      workbook.data.sheets.splice(index, 1);
      workbook.data.active = Math.max(0, index - 1);
    });
  }

  /* ---------- 图表 ---------- */
  function insertChartDialog() {
    const { from, to } = grid.normalizedSelection();
    if (from.r === to.r && from.c === to.c) {
      toast(t('toast.chartNoData'), 'warn');
      return;
    }
    let type = 'bar';
    let title = '';
    const preview = h('div.dialog__chart-preview');
    const updatePreview = () => {
      clear(preview);
      const data = buildChartData(workbook, workbook.sheet.name, { from, to });
      preview.appendChild(renderChart({ type, title: title || undefined }, data, { width: 460, height: 260 }));
    };
    const typeRow = segmented(CHART_TYPES.map((item) => ({ value: item.id, label: t(item.labelKey), icon: item.icon })), type, (value) => {
      type = value;
      updatePreview();
    });
    const titleInput = h('input.field__input', {
      type: 'text',
      placeholder: t('sheet.chartTitle'),
      oninput: (event) => {
        title = event.target.value;
        updatePreview();
      },
    });
    updatePreview();
    openDialog({
      title: t('dialog.chart'),
      width: 560,
      body: h('div.dialog__form', {}, [
        h('label.field__label', { text: t('sheet.chartType') }),
        typeRow,
        h('label.field__label', { text: t('sheet.chartTitle') }),
        titleInput,
        h('div.field__hint', { text: `${t('sheet.dataRange')}: ${formatRange(from, to)}` }),
        preview,
      ]),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          variant: 'primary',
          onClick: (close) => {
            close();
            mutate(t('sheet.chart'), () => {
              const sheet = workbook.sheet;
              const xp = grid.xPrefix();
              const yp = grid.yPrefix();
              sheet.charts.push({
                id: `c${Date.now().toString(36)}`,
                type,
                title,
                range: { from: { ...from }, to: { ...to } },
                x: xp[Math.min(to.c + 1, MAX_COLS - 1)] + 20,
                y: yp[from.r],
                w: 520,
                h: 300,
                colorOffset: sheet.charts.length % CHART_PALETTE.length,
              });
              workbook.touch({ type: 'chart' });
            });
          },
        },
      ],
    });
  }

  function positionCharts(force = false) {
    if (!grid) return;                 // Grid 构造期间就会被回调，此时还没有层
    const layer = grid.chartLayer;
    const charts = workbook.sheet.charts || [];
    const scrollLeft = grid.scroll.scrollLeft;
    const scrollTop = grid.scroll.scrollTop;

    const reusable = !force && charts.length === chartBoxes.size && charts.every((chart) => chartBoxes.has(chart.id));
    if (reusable) {
      for (const chart of charts) {
        const box = chartBoxes.get(chart.id);
        box.style.left = `${chart.x - scrollLeft}px`;
        box.style.top = `${chart.y - scrollTop}px`;
      }
      return;
    }

    clear(layer);
    chartBoxes.clear();
    if (!charts.length) return;
    for (const chart of charts) {
      const box = h('div.chart-box', {
        style: {
          left: `${chart.x - scrollLeft}px`,
          top: `${chart.y - scrollTop}px`,
          width: `${chart.w}px`,
          height: `${chart.h}px`,
        },
        dataset: { id: chart.id },
      });
      const data = buildChartData(workbook, workbook.sheet.name, chart.range);
      box.appendChild(renderChart(chart, data, { colorOffset: chart.colorOffset || 0 }));
      box.appendChild(h('div.chart-box__bar', {}, [
        h('span.chart-box__title', { text: chart.title || t('sheet.chart') }),
        button({ icon: 'gear', title: t('dialog.chart'), variant: 'icon', onClick: () => editChart(chart) }),
        button({
          icon: 'trash',
          title: t('common.delete'),
          variant: 'icon',
          onClick: async () => {
            const ok = await confirmDialog(t('common.confirmDelete', { name: chart.title || t('sheet.chart') }), { danger: true });
            if (!ok) return;
            mutate(t('common.delete'), () => {
              const sheet = workbook.sheet;
              sheet.charts = sheet.charts.filter((item) => item.id !== chart.id);
              workbook.touch({ type: 'chart' });
            });
          },
        }),
      ]));
      const handle = h('div.chart-box__resize');
      box.appendChild(handle);
      attachChartInteractions(box, handle, chart);
      layer.appendChild(box);
      chartBoxes.set(chart.id, box);
    }
  }

  function attachChartInteractions(box, handle, chart) {
    let mode = null;
    let start = null;
    const onDown = (event) => {
      if (event.target.closest('.chart-box__bar') && !event.target.closest('.chart-box')) return;
      const isHandle = event.target === handle;
      mode = isHandle ? 'resize' : 'move';
      start = { x: event.clientX, y: event.clientY, left: chart.x, top: chart.y, w: chart.w, h: chart.h };
      box.setPointerCapture(event.pointerId);
      event.stopPropagation();
    };
    const onMove = (event) => {
      if (!mode) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (mode === 'move') {
        chart.x = Math.max(0, start.left + dx);
        chart.y = Math.max(0, start.top + dy);
        box.style.left = `${chart.x - grid.scroll.scrollLeft}px`;
        box.style.top = `${chart.y - grid.scroll.scrollTop}px`;
      } else {
        chart.w = Math.max(220, start.w + dx);
        chart.h = Math.max(160, start.h + dy);
        box.style.width = `${chart.w}px`;
        box.style.height = `${chart.h}px`;
      }
      event.stopPropagation();
    };
    const onUp = () => {
      if (!mode) return;
      mode = null;
      workbook.touch({ type: 'chart' });
      markDirty();
      positionCharts(true);
    };
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  }

  function editChart(chart) {
    let title = chart.title || '';
    let type = chart.type;
    openDialog({
      title: t('dialog.chart'),
      width: 420,
      body: h('div.dialog__form', {}, [
        h('label.field__label', { text: t('sheet.chartType') }),
        segmented(CHART_TYPES.map((item) => ({ value: item.id, label: t(item.labelKey), icon: item.icon })), type, (value) => {
          type = value;
        }),
        h('label.field__label', { text: t('sheet.chartTitle') }),
        h('input.field__input', { type: 'text', value: title, oninput: (event) => { title = event.target.value; } }),
      ]),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          variant: 'primary',
          onClick: (close) => {
            close();
            mutate(t('dialog.chart'), () => {
              chart.type = type;
              chart.title = title;
              workbook.touch({ type: 'chart' });
            });
          },
        },
      ],
    });
  }

  /* ---------- 查找替换 / 定位 ---------- */
  function showFindDialog() {
    const findInput = h('input.field__input', { type: 'text', autofocus: true, placeholder: t('writer.find') });
    const replaceInput = h('input.field__input', { type: 'text', placeholder: t('writer.replace') });
    const matchCase = h('input', { type: 'checkbox' });
    const inFormula = h('input', { type: 'checkbox' });
    const status = h('p.field__hint');

    const search = (replaceAll) => {
      const needle = findInput.value;
      if (!needle) return;
      const sheet = workbook.sheet;
      const used = workbook.usedRange(sheet);
      if (used.empty) return;
      const flags = matchCase.checked ? '' : 'i';
      const re = new RegExp(escapeRegExp(needle), flags);
      const replaceValue = replaceInput.value;
      const entries = [];
      let count = 0;
      let first = null;
      for (let r = used.from.r; r <= used.to.r; r += 1) {
        for (let c = used.from.c; c <= used.to.c; c += 1) {
          const raw = workbook.getRawInput(sheet.name, r, c);
          const text = inFormula.checked ? raw : workbook.getText(sheet.name, r, c);
          if (!re.test(text)) continue;
          count += 1;
          if (!first) first = { r, c };
          if (replaceAll) entries.push({ r, c, input: inFormula.checked ? raw.replace(re, replaceValue) : raw.replace(new RegExp(escapeRegExp(workbook.getText(sheet.name, r, c)), flags), replaceValue) });
        }
      }
      if (!count) {
        status.textContent = '未找到匹配内容';
        return;
      }
      if (replaceAll) {
        mutate(t('writer.replaceAll'), () => workbook.setCells(sheet.name, entries));
        status.textContent = t('writer.replaceDone', { n: count });
        toastSuccess(t('writer.replaceDone', { n: count }));
      } else {
        grid.focusCell(first.r, first.c);
        status.textContent = `找到 ${count} 处`;
      }
    };

    openDialog({
      title: `${t('writer.find')} / ${t('writer.replace')}`,
      width: 480,
      body: h('div.dialog__form', {}, [
        h('label.field__label', { text: t('writer.find') }),
        findInput,
        h('label.field__label', { text: t('writer.replace') }),
        replaceInput,
        h('div.dialog__checks', {}, [
          h('label.checkbox', {}, [matchCase, h('span', { text: '区分大小写' })]),
          h('label.checkbox', {}, [inFormula, h('span', { text: '匹配公式原文' })]),
        ]),
        status,
      ]),
      actions: [
        { label: t('writer.findNext'), onClick: () => search(false) },
        { label: t('writer.replaceAll'), variant: 'primary', onClick: () => search(true) },
      ],
    });
    findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search(false);
    });
  }

  function gotoDialog() {
    const input = h('input.field__input', { type: 'text', value: formatA1({ r: grid.active.r, c: grid.active.c }), autofocus: true });
    openDialog({
      title: t('sheet.goto'),
      width: 380,
      body: h('div.dialog__form', {}, [h('label.field__label', { text: `${t('sheet.rows')} A1` }), input]),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          variant: 'primary',
          onClick: (close) => {
            const ref = parseA1(input.value.trim());
            if (ref) {
              grid.focusCell(ref.r, ref.c);
              close();
            }
          },
        },
      ],
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const ref = parseA1(input.value.trim());
        if (ref) {
          grid.focusCell(ref.r, ref.c);
          document.querySelector('.dialog__close')?.click();
        }
      }
    });
  }

  function showFunctionHelp() {
    const catalog = functionCatalog();
    const groups = catalog.map((group) => h('section.fn-group', {}, [
      h('h4', { text: fnGroupLabel(group.key) }),
      h('div.fn-list', {}, group.names.map((name) => h('button.fn-chip', {
        type: 'button',
        text: name,
        title: `${name}(${FUNCTIONS[name] ? '' : ''}…)`,
        onclick: () => {
          formulaInput.value = `=${name}(`;
          formulaInput.focus();
        },
      }))),
    ]));
    openDialog({
      title: `${t('sheet.helpTitle')} · ${functionNames().length}`,
      width: 720,
      body: h('div.fn-catalog', {}, [
        h('p.field__hint', { text: t('sheet.helpHint') }),
        ...groups,
      ]),
      actions: [{ label: t('common.close'), variant: 'primary' }],
    });
  }

  /* ---------- 颜色 / 格式菜单 ---------- */
  const SWATCHES = ['#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff', '#d93025', '#e8710a', '#f9ab00', '#188038', '#1a73e8', '#9334e6'];

  function colorMenu(anchor, key) {
    const items = SWATCHES.map((color) => ({
      label: color,
      onClick: () => setStyle({ [key]: color }, t('menu.format')),
    }));
    items.push({ separator: true });
    items.push({ label: t('common.nothing'), icon: 'close', onClick: () => setStyle({ [key]: null }, t('menu.format')) });
    openMenu(anchor, items, { width: 180 });
  }

  function numberFormatMenu(anchor) {
    openMenu(anchor, NUMBER_FORMATS.map((item) => ({
      label: t(item.labelKey),
      checked: currentFormat() === item.id,
      onClick: () => applyNumberFormatId(item.id),
    })));
  }

  function borderMenu(anchor) {
    const cell = workbook.getCell(workbook.sheet.name, grid.active.r, grid.active.c);
    openMenu(anchor, [
      { label: t('sheet.borderAll'), icon: 'table', onClick: () => setStyle({ border: true }, t('sheet.borders')) },
      { label: t('sheet.borderNone'), icon: 'eraser', onClick: () => setStyle({ border: null }, t('sheet.borders')) },
      { separator: true },
      { label: t('sheet.merge'), icon: 'merge', onClick: () => mergeSelection() },
      { label: t('sheet.unmerge'), icon: 'columns', onClick: () => unmergeSelection() },
      { separator: true },
      { label: t('sheet.freeze'), icon: 'freeze', checked: hasFreeze(), onClick: () => toggleFreeze() },
    ]);
    if (cell) return;
  }

  /* ---------- 右键菜单 ---------- */
  function showContextMenu(event) {
    const { from, to } = grid.normalizedSelection();
    const anchor = h('div.menu-anchor', { style: { left: `${event.clientX}px`, top: `${event.clientY}px` } });
    document.body.appendChild(anchor);
    openMenu(anchor, [
      { label: t('common.copy'), icon: 'copy', shortcut: 'Ctrl/⌘+C', onClick: () => document.execCommand?.('copy') },
      { label: t('sheet.clearContents'), icon: 'eraser', onClick: () => clearSelection('contents') },
      { separator: true },
      { label: t('sheet.insertRowAbove'), icon: 'plus-square', onClick: () => insertRows('above') },
      { label: t('sheet.insertRowBelow'), icon: 'plus-square', onClick: () => insertRows('below') },
      { label: t('sheet.deleteRow'), icon: 'trash', onClick: () => deleteRows() },
      { separator: true },
      { label: t('sheet.insertColLeft'), icon: 'plus-square', onClick: () => insertCols('left') },
      { label: t('sheet.insertColRight'), icon: 'plus-square', onClick: () => insertCols('right') },
      { label: t('sheet.deleteCol'), icon: 'trash', onClick: () => deleteCols() },
      { separator: true },
      { label: t('sheet.sortAsc'), icon: 'sort-asc', onClick: () => sortSelection(1) },
      { label: t('sheet.sortDesc'), icon: 'sort-desc', onClick: () => sortSelection(-1) },
      { separator: true },
      { label: t('sheet.merge'), icon: 'merge', onClick: () => mergeSelection() },
      { label: t('sheet.unmerge'), icon: 'columns', onClick: () => unmergeSelection() },
      { separator: true },
      { label: t('sheet.chart'), icon: 'chart-bar', onClick: () => insertChartDialog() },
      { label: t('sheet.freeze'), icon: 'freeze', checked: hasFreeze(), onClick: () => toggleFreeze() },
      { label: `选中 ${formatRange(from, to)}`, disabled: true },
    ], { align: 'left', onClose: () => anchor.remove() });

    event.preventDefault();
    return false;
  }

  /* ---------- 状态栏 ---------- */
  function updateSummary(range) {
    const sheetName = workbook.sheet.name;
    const values = [];
    let count = 0;
    for (let r = range.from.r; r <= range.to.r; r += 1) {
      for (let c = range.from.c; c <= range.to.c; c += 1) {
        const value = workbook.getValue(sheetName, r, c);
        if (isError(value) || value === null || value === '') continue;
        count += 1;
        const number = typeof value === 'number' ? value : null;
        if (number !== null) values.push(number);
      }
    }
    const cards = [
      `${t('sheet.countLabel')} ${count}`,
    ];
    if (values.length) {
      const sum = values.reduce((a, b) => a + b, 0);
      cards.push(`${t('sheet.sumLabel')} ${formatNumber(sum)}`);
      cards.push(`${t('sheet.avgLabel')} ${formatNumber(sum / values.length)}`);
      cards.push(`${t('sheet.minLabel')} ${formatNumber(Math.min(...values))}`);
      cards.push(`${t('sheet.maxLabel')} ${formatNumber(Math.max(...values))}`);
    }
    cards.push(`${workbook.data.sheets.length} ${t('home.sheet')}`);
    frame.setStatusBar(cards.map((text) => h('span.sheet__summary-item', { text })));
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    grid.invalidateSizes();
    grid.render();
    renderTabs();
    positionCharts(true);
    updateSummary(grid.normalizedSelection());
    frame.renderActions();
    frame.refreshMenus();
    frame.setToolbar(buildToolbar());
  }

  /* ---------- 保存 / 导出 ---------- */
  function documentSnapshot() {
    const stats = workbook.stats();
    return withPreview(
      { ...doc, data: workbook.toJSON(), stats: { cells: stats.cells, formulas: stats.formulas } },
      stats.preview,
      { cells: stats.cells, formulas: stats.formulas },
    );
  }

  async function saveNow() {
    const snapshot = documentSnapshot();
    Object.assign(doc, snapshot);
    await onSave?.(snapshot);
    dirty = false;
    frame.setDirty(false);
    frame.setStatus(t('common.saved'), 'ok', 1600);
    return snapshot;
  }

  async function duplicateDocument() {
    const snapshot = documentSnapshot();
    await onSave?.({ ...snapshot, __duplicate: true });
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

  function openModalExport() {
    openMenu(frame.titleInput, exportMenuItems(doc, (id) => exportAs(id)));
  }

  async function importInto() {
    const files = await pickFiles({ accept: '.csv,.tsv,.xlsx,.trio,.json' });
    if (!files.length) return;
    try {
      const { doc: imported } = await importFile(files[0]);
      if (imported.type !== 'sheet') {
        toastError('请选择表格类文件（.csv/.xlsx/.trio）');
        return;
      }
      mutate(t('menu.import'), () => {
        workbook.data = normalizeWorkbook(imported.data);
        workbook.beginPass();
      });
      if (imported.title) {
        doc.title = imported.title;
        frame.setTitle(imported.title);
      }
      toastSuccess(t('toast.imported', { name: files[0].name }));
    } catch (err) {
      toastError(t('toast.importFailed', { msg: err.message }));
    }
  }

  function printSheet() {
    const html = sheetToHtml(workbook);
    const holder = h('div', { html });
    printSection(holder, doc.title);
  }

  /* ---------- 初始化 ---------- */
  renderAll();
  frame.renderChrome();          // 此时网格、图表、历史栈都已就绪
  updateHistoryButtons({ canUndo: false, canRedo: false });
  bus.emit(EVENTS.DOC_OPENED, { id: doc.id, type: 'sheet' });

  // 全局快捷键
  const onGlobalKey = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
      return;
    }
    if (mod && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      printSheet();
      return;
    }
    if (event.altKey && event.key === '=') {
      event.preventDefault();
      autoSum();
    }
  };
  window.addEventListener('keydown', onGlobalKey);

  return {
    el: frame.el,
    save: saveNow,
    isDirty: () => dirty,
    destroy() {
      window.removeEventListener('keydown', onGlobalKey);
      grid.destroy();
      frame.el.__dispose?.();
    },
  };
}

/** 当前是否深色模式 */
function isDarkTheme() {
  return document.documentElement.dataset.theme === 'dark';
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function structuredCloneSource(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function fnGroupLabel(key) {
  const map = {
    math: '数学与统计 · Math & Stats',
    text: '文本 · Text',
    date: '日期时间 · Date & Time',
    lookup: '查找引用 · Lookup & Reference',
    logical: '逻辑 · Logical',
    array: '动态数组 · Dynamic Arrays',
    finance: '财务 · Financial',
    engineering: '工程 · Engineering',
    info: '信息 · Information',
  };
  return map[key] || key;
}
