/**
 * workbook.js —— 表格文档模型 + 计算引擎。
 *
 * 数据结构（可直接序列化进 .trio）：
 * {
 *   version: 1,
 *   active: 0,
 *   sheets: [{
 *     id, name,
 *     cells: { "A1": { f?: "=SUM(A1:A3)", v?: any, fmt?: "number", s?: {b,i,u,st,color,bg,align,size} } },
 *     colWidths: { "0": 120 }, rowHeights: { "3": 40 },
 *     merges: [[r1,c1,r2,c2]], frozen: { rows: 0, cols: 0 }, charts: [...],
 *     view: { row: 0, col: 0 }
 *   }]
 * }
 *
 * 求值策略：单次「计算轮次」内惰性 + 记忆化，遇到重入判定为循环引用（#CIRC!）。
 * 任何编辑都会开启新一轮计算，保证结果总是最新的。
 */
import { RangeValue, ERR, error, isError, isRange, isBlank, toText, formatNumber, applyNumberFormat, dateToSerial, parseDateText, compare } from './value.js';
import { evaluateFormula, translateFormula, adjustFormulaRefs } from './formula.js';
import { colToLabel, labelToCol, parseA1 } from './address.js';

export const MAX_ROWS = 5000;
export const MAX_COLS = 200;
export const DEFAULT_COL_WIDTH = 96;
export const DEFAULT_ROW_HEIGHT = 26;

const STYLE_KEYS = ['b', 'i', 'u', 'st', 'color', 'bg', 'align', 'valign', 'size', 'font', 'wrap'];

export const NUMBER_FORMATS = [
  { id: 'general', labelKey: 'sheet.fmtGeneral' },
  { id: 'number', labelKey: 'sheet.fmtNumber' },
  { id: 'currency', labelKey: 'sheet.fmtCurrency' },
  { id: 'percent', labelKey: 'sheet.fmtPercent' },
  { id: 'date', labelKey: 'sheet.fmtDate' },
  { id: 'time', labelKey: 'sheet.fmtTime' },
  { id: 'scientific', labelKey: 'sheet.fmtScientific' },
  { id: 'text', labelKey: 'sheet.fmtText' },
];

/** 单元格键 */
export const cellKey = (r, c) => `${colToLabel(c)}${r + 1}`;

/** 工作表 → 纯 JSON 模型 */
export function createSheet(name, index = 0) {
  return {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${index}`,
    name,
    cells: {},
    colWidths: {},
    rowHeights: {},
    merges: [],
    frozen: { rows: 0, cols: 0 },
    charts: [],
    view: { row: 0, col: 0 },
  };
}

/** 新建工作簿模型 */
export function createWorkbook() {
  return { version: 1, active: 0, sheets: [createSheet('Sheet1', 0)] };
}

/** 保证导入的数据结构完整 */
export function normalizeWorkbook(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sheets) || !raw.sheets.length) return createWorkbook();
  const sheets = raw.sheets.map((sheet, index) => ({
    id: sheet.id || `s${index}${Math.random().toString(36).slice(2, 6)}`,
    name: String(sheet.name || `Sheet${index + 1}`),
    cells: sheet.cells && typeof sheet.cells === 'object' ? sheet.cells : {},
    colWidths: sheet.colWidths || {},
    rowHeights: sheet.rowHeights || {},
    merges: Array.isArray(sheet.merges) ? sheet.merges : [],
    frozen: { rows: Number(sheet.frozen?.rows) || 0, cols: Number(sheet.frozen?.cols) || 0 },
    charts: Array.isArray(sheet.charts) ? sheet.charts : [],
    view: { row: Number(sheet.view?.row) || 0, col: Number(sheet.view?.col) || 0 },
  }));
  return {
    version: 1,
    active: Math.min(Math.max(0, Number(raw.active) || 0), sheets.length - 1),
    sheets,
  };
}

/** 计算引擎 + 编辑 API */
export class Workbook {
  /** @param {object} [data] 工作簿模型 */
  constructor(data) {
    this.data = normalizeWorkbook(data);
    this.cache = new Map();
    this.stack = [];
    this.listeners = new Set();
  }

  /* ---------------- 基础访问 ---------------- */
  get sheetNames() {
    return this.data.sheets.map((sheet) => sheet.name);
  }

  get sheet() {
    return this.data.sheets[this.data.active] || this.data.sheets[0];
  }

  sheetByName(name) {
    if (!name) return this.sheet;
    return this.data.sheets.find((sheet) => sheet.name === name) || null;
  }

  sheetIndexById(id) {
    return this.data.sheets.findIndex((sheet) => sheet.id === id);
  }

  /** 是否存在重名表 */
  hasSheet(name) {
    return this.data.sheets.some((sheet) => sheet.name === name);
  }

  /* ---------------- 计算轮次 ---------------- */
  /** 开启新一轮计算（任何数据变更后调用） */
  beginPass() {
    this.cache.clear();
    this.stack = [];
    this.pass += 1;
    return this;
  }

  /** 数据变更的统一出口：清缓存 + 通知订阅者 */
  touch(change = {}) {
    this.beginPass();
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error('[workbook] 监听器异常', err);
      }
    }
    return this;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------------- 单元格读写 ---------------- */
  getCell(sheetName, r, c) {
    const sheet = this.sheetByName(sheetName || this.sheet.name);
    if (!sheet) return null;
    return sheet.cells[cellKey(r, c)] || null;
  }

  /** 单元格的原始输入文本（编辑框显示用） */
  getRawInput(sheetName, r, c) {
    const cell = this.getCell(sheetName, r, c);
    if (!cell) return '';
    if (cell.f) return cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
    if (cell.v === null || cell.v === undefined) return '';
    if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
    if (cell.v instanceof Date) return formatNumber(dateToSerial(cell.v));
    return String(cell.v);
  }

  /**
   * 计算单元格的值（惰性 + 记忆化 + 循环检测）。
   * @returns {any} number | string | boolean | null | FormulaError
   */
  getValue(sheetName, r, c) {
    const sheet = this.sheetByName(sheetName || this.sheet.name);
    if (!sheet) return error(ERR.REF, '工作表不存在');
    if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) return error(ERR.REF, '超出表格范围');
    const key = `${sheet.name}!${r}:${c}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const cell = sheet.cells[cellKey(r, c)];
    if (!cell) {
      this.cache.set(key, null);
      return null;
    }
    if (cell.f) {
      if (this.stack.includes(key)) return error(ERR.CIRC, '循环引用');
      this.stack.push(key);
      const value = evaluateFormula(cell.f, this.contextFor(sheet.name, r, c));
      this.stack.pop();
      const hasCircular = isError(value) && value.code === ERR.CIRC;
      if (!hasCircular) this.cache.set(key, value);
      return value;
    }
    this.cache.set(key, cell.v === undefined ? null : cell.v);
    return cell.v === undefined ? null : cell.v;
  }

  /** 供 formula.js 使用的求值上下文 */
  contextFor(sheetName, r, c) {
    return {
      sheetName,
      currentRef: { r, c },
      getValue: (sheet, row, col) => this.getValue(sheet || sheetName, row, col),
      buildRange: (sheet, from, to) => this.buildRange(sheet || sheetName, from, to),
      buildColumnRange: (sheet, from, to) => this.buildColumnRange(sheet || sheetName, from, to),
      sheetNames: () => this.sheetNames,
      resolveText: (text) => this.resolveRefText(sheetName, text),
    };
  }

  buildRange(sheetName, from, to) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return error(ERR.REF);
    const r1 = Math.max(0, Math.min(from.r, to.r));
    const r2 = Math.min(MAX_ROWS - 1, Math.max(from.r, to.r));
    const c1 = Math.max(0, Math.min(from.c, to.c));
    const c2 = Math.min(MAX_COLS - 1, Math.max(from.c, to.c));
    const rows = [];
    for (let r = r1; r <= r2; r += 1) {
      const row = [];
      for (let c = c1; c <= c2; c += 1) row.push(this.getValue(sheetName, r, c));
      rows.push(row);
    }
    return new RangeValue(rows, { sheet: sheetName, from: { r: r1, c: c1 }, to: { r: r2, c: c2 } });
  }

  /** 整列引用 A:B（只覆盖到有数据的范围，避免 5000 行全量计算） */
  buildColumnRange(sheetName, fromLabel, toLabel) {
    const c1 = labelToCol(String(fromLabel).replace(/[$]/g, ''));
    const c2 = labelToCol(String(toLabel).replace(/[$]/g, ''));
    if (c1 < 0 || c2 < 0) return error(ERR.REF);
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return error(ERR.REF);
    const used = this.usedRange(sheet);
    const lastRow = Math.max(used.to.r, 0);
    return this.buildRange(sheetName, { r: 0, c: c1 }, { r: lastRow, c: c2 });
  }

  /** INDIRECT：解析文本引用 */
  resolveRefText(currentSheet, text) {
    const raw = String(text || '').trim();
    if (!raw) return undefined;
    const bang = raw.lastIndexOf('!');
    let sheetName = currentSheet;
    let rest = raw;
    if (bang !== -1) {
      sheetName = raw.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
      rest = raw.slice(bang + 1);
      if (!this.hasSheet(sheetName)) return error(ERR.REF, `工作表 ${sheetName} 不存在`);
    }
    const [fromText, toText] = rest.split(':');
    const from = parseA1(fromText);
    if (!from) return undefined;
    if (!toText) return this.getValue(sheetName, from.r, from.c);
    const to = parseA1(toText);
    if (!to) return undefined;
    return this.buildRange(sheetName, from, to);
  }

  /** 单元格的显示文本 */
  getText(sheetName, r, c) {
    const value = this.getValue(sheetName, r, c);
    const cell = this.getCell(sheetName, r, c);
    if (isError(value)) return value.code;
    if (isRange(value)) return toText(value);
    if (isBlank(value)) return '';
    const fmt = cell?.fmt;
    if (typeof value === 'number' && fmt && fmt !== 'general' && fmt !== 'text') {
      return applyNumberFormat(value, fmt);
    }
    if (typeof value === 'number') return formatNumber(value);
    return toText(value);
  }

  /* ---------------- 编辑 ---------------- */
  /**
   * 写入单元格。
   * @param {string} sheetName
   * @param {number} r
   * @param {number} c
   * @param {string} input 用户输入（公式以 = 开头）
   */
  setCell(sheetName, r, c, input) {
    const sheet = this.sheetByName(sheetName || this.sheet.name);
    if (!sheet) return this;
    const key = cellKey(r, c);
    const existing = sheet.cells[key];
    const parsed = parseInput(input, existing?.fmt);

    if (parsed === null) {
      if (existing) {
        delete existing.f;
        delete existing.v;
        if (!hasStyle(existing)) delete sheet.cells[key];
      }
    } else if (existing) {
      Object.assign(existing, parsed);
    } else {
      sheet.cells[key] = parsed;
    }
    this.touch({ type: 'setCell', sheet: sheet.name, r, c });
    return this;
  }

  /** 批量写入（导入 / 粘贴），一次性触发计算轮次 */
  setCells(sheetName, entries) {
    const sheet = this.sheetByName(sheetName || this.sheet.name);
    if (!sheet) return this;
    for (const { r, c, input } of entries) {
      const parsed = parseInput(input);
      const key = cellKey(r, c);
      if (parsed === null) delete sheet.cells[key];
      else sheet.cells[key] = { ...(sheet.cells[key] || {}), ...parsed };
    }
    this.touch({ type: 'setCells', sheet: sheet.name, count: entries.length });
    return this;
  }

  clearCells(sheetName, list, mode = 'all') {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    for (const { r, c } of list) {
      const key = cellKey(r, c);
      const cell = sheet.cells[key];
      if (!cell) continue;
      if (mode === 'all') delete sheet.cells[key];
      else if (mode === 'contents') {
        delete cell.v;
        delete cell.f;
        if (!hasStyle(cell)) delete sheet.cells[key];
      } else if (mode === 'format') {
        delete cell.fmt;
        delete cell.s;
        if (cell.v === undefined && !cell.f) delete sheet.cells[key];
      }
    }
    this.touch({ type: 'clearCells', sheet: sheet.name });
    return this;
  }

  /** 设置样式（合并到已有样式，null 表示移除该属性） */
  setStyle(sheetName, list, style) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    for (const { r, c } of list) {
      const key = cellKey(r, c);
      let cell = sheet.cells[key];
      if (!cell) {
        if (Object.values(style).every((value) => value === null)) continue;
        cell = {};
        sheet.cells[key] = cell;
      }
      const next = { ...(cell.s || {}) };
      for (const [prop, value] of Object.entries(style)) {
        if (value === null || value === undefined) delete next[prop];
        else next[prop] = value;
      }
      if (Object.keys(next).length) cell.s = next;
      else delete cell.s;
      if (cell.v === undefined && !cell.f && !hasStyle(cell) && !cell.fmt) delete sheet.cells[key];
    }
    this.touch({ type: 'setStyle', sheet: sheet.name });
    return this;
  }

  setNumberFormat(sheetName, list, fmt) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    for (const { r, c } of list) {
      const key = cellKey(r, c);
      const cell = sheet.cells[key] || (sheet.cells[key] = {});
      if (!fmt || fmt === 'general') delete cell.fmt;
      else cell.fmt = fmt;
      if (cell.v === undefined && !cell.f && !hasStyle(cell) && !cell.fmt) delete sheet.cells[key];
    }
    this.touch({ type: 'setNumberFormat', sheet: sheet.name });
    return this;
  }

  /* ---------------- 结构编辑 ---------------- */
  /**
   * 结构性调整：把某个工作表里插入/删除行列带来的引用变化传播到所有公式。
   * @param {string} sheetName 被修改的工作表
   * @param {'row'|'col'} axis
   * @param {number} at 起始下标（0 基）
   * @param {number} count 受影响的行/列数
   * @param {'insert'|'delete'} mode
   */
  adjustReferences(sheetName, axis, at, count, mode) {
    const shiftIndex = (index) => {
      if (mode === 'insert') return index >= at ? index + count : index;
      if (index >= at && index < at + count) return null;
      return index >= at + count ? index - count : index;
    };

    for (const sheet of this.data.sheets) {
      for (const [key, cell] of Object.entries(sheet.cells)) {
        if (!cell.f) continue;
        const next = adjustFormulaRefs(cell.f, (ref) => {
          // 只调整指向被修改工作表的引用（同表引用 sheet 为 null）
          const target = ref.sheet || sheet.name;
          if (target !== sheetName) return { r: ref.r, c: ref.c };
          if (axis === 'row') {
            const r = shiftIndex(ref.r);
            return r === null ? null : { r, c: ref.c };
          }
          const c = shiftIndex(ref.c);
          return c === null ? null : { r: ref.r, c };
        });
        if (next !== cell.f) cell.f = next;
      }
    }
  }

  insertRows(sheetName, at, count = 1) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    this.adjustReferences(sheet.name, 'row', at, count, 'insert');
    const next = {};
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const parsed = parseA1(key);
      if (!parsed) continue;
      const target = parsed.r >= at ? { r: parsed.r + count, c: parsed.c } : parsed;
      next[cellKey(target.r, target.c)] = cell;
    }
    sheet.cells = next;
    sheet.merges = sheet.merges.map(([r1, c1, r2, c2]) => [
      r1 >= at ? r1 + count : r1,
      c1,
      r2 >= at ? r2 + count : r2,
      c2,
    ]);
    this.touch({ type: 'insertRows', sheet: sheet.name });
    return this;
  }

  deleteRows(sheetName, at, count = 1) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    this.adjustReferences(sheet.name, 'row', at, count, 'delete');
    const next = {};
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const parsed = parseA1(key);
      if (!parsed) continue;
      if (parsed.r >= at && parsed.r < at + count) continue;
      const target = parsed.r >= at + count ? { r: parsed.r - count, c: parsed.c } : parsed;
      next[cellKey(target.r, target.c)] = cell;
    }
    sheet.cells = next;
    sheet.merges = sheet.merges
      .filter(([r1, , r2]) => !(r1 >= at && r2 < at + count))
      .map(([r1, c1, r2, c2]) => [Math.max(0, r1 - (r1 >= at + count ? count : Math.min(count, Math.max(0, r1 - at + 1)))), c1,
        Math.max(0, r2 - (r2 >= at + count ? count : Math.min(count, Math.max(0, r2 - at + 1)))), c2]);
    this.touch({ type: 'deleteRows', sheet: sheet.name });
    return this;
  }

  insertCols(sheetName, at, count = 1) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    this.adjustReferences(sheet.name, 'col', at, count, 'insert');
    const next = {};
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const parsed = parseA1(key);
      if (!parsed) continue;
      const target = parsed.c >= at ? { r: parsed.r, c: parsed.c + count } : parsed;
      next[cellKey(target.r, target.c)] = cell;
    }
    sheet.cells = next;
    sheet.merges = sheet.merges.map(([r1, c1, r2, c2]) => [r1, c1 >= at ? c1 + count : c1, r2, c2 >= at ? c2 + count : c2]);
    const widths = {};
    for (const [index, width] of Object.entries(sheet.colWidths || {})) {
      const value = Number(index);
      widths[String(value >= at ? value + count : value)] = width;
    }
    sheet.colWidths = widths;
    this.touch({ type: 'insertCols', sheet: sheet.name });
    return this;
  }

  deleteCols(sheetName, at, count = 1) {
    const sheet = this.sheetByName(sheetName);
    if (!sheet) return this;
    this.adjustReferences(sheet.name, 'col', at, count, 'delete');
    const next = {};
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const parsed = parseA1(key);
      if (!parsed) continue;
      if (parsed.c >= at && parsed.c < at + count) continue;
      const target = parsed.c >= at + count ? { r: parsed.r, c: parsed.c - count } : parsed;
      next[cellKey(target.r, target.c)] = cell;
    }
    sheet.cells = next;
    sheet.merges = sheet.merges.filter(([, c1, , c2]) => !(c1 >= at && c2 < at + count));
    const widths = {};
    for (const [index, width] of Object.entries(sheet.colWidths || {})) {
      const value = Number(index);
      if (value >= at && value < at + count) continue;
      widths[String(value >= at + count ? value - count : value)] = width;
    }
    sheet.colWidths = widths;
    this.touch({ type: 'deleteCols', sheet: sheet.name });
    return this;
  }

  /** 已使用区域（含样式单元格） */
  usedRange(sheetName) {
    const sheet = typeof sheetName === 'string' ? this.sheetByName(sheetName) : sheetName || this.sheet;
    let maxR = -1;
    let maxC = -1;
    let minR = Infinity;
    let minC = Infinity;
    for (const key of Object.keys(sheet.cells)) {
      const parsed = parseA1(key);
      if (!parsed) continue;
      if (parsed.r > maxR) maxR = parsed.r;
      if (parsed.c > maxC) maxC = parsed.c;
      if (parsed.r < minR) minR = parsed.r;
      if (parsed.c < minC) minC = parsed.c;
    }
    if (maxR === -1) return { from: { r: 0, c: 0 }, to: { r: 0, c: 0 }, empty: true };
    return { from: { r: minR, c: minC }, to: { r: maxR, c: maxC }, empty: false };
  }

  /** 表格统计信息（首页展示 / 预览） */
  stats() {
    let cells = 0;
    let formulas = 0;
    const samples = [];
    for (const sheet of this.data.sheets) {
      for (const [key, cell] of Object.entries(sheet.cells)) {
        if (cell.f) formulas += 1;
        if (cell.f || cell.v !== undefined) cells += 1;
        if (samples.length < 12 && cell.v !== undefined && typeof cell.v !== 'boolean') {
          const parsed = parseA1(key);
          if (parsed) samples.push(this.getText(sheet.name, parsed.r, parsed.c));
        }
      }
    }
    return { cells, formulas, sheets: this.data.sheets.length, preview: samples.filter(Boolean).join(' · ').slice(0, 140) };
  }

  toJSON() {
    return this.data;
  }
}

/** 是否含有样式 */
function hasStyle(cell) {
  return Boolean((cell.s && Object.keys(cell.s).length) || cell.fmt);
}

/**
 * 解析用户输入。
 * @returns {{v?: any, f?: string, fmt?: string}|null} null 表示清空单元格
 */
export function parseInput(input, existingFormat) {
  const text = input === null || input === undefined ? '' : String(input);
  if (text === '') return null;

  if (text.startsWith('=')) {
    const body = text.slice(1).trim();
    if (!body) return null;
    return { f: `=${body}` };
  }
  if (text.startsWith("'")) {
    // 单引号前缀 → 强制文本
    return { v: text.slice(1), fmt: 'text' };
  }
  if (/^-?\d+(\.\d+)?$/.test(text.trim())) {
    const value = Number(text.trim());
    return existingFormat === 'percent' ? { v: value, fmt: 'percent' } : { v: value };
  }
  if (/^-?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(text.trim())) {
    return { v: Number(text.trim()) };
  }
  if (/^-?\d+(\.\d+)?%$/.test(text.trim())) {
    return { v: Number(text.trim().replace('%', '')) / 100, fmt: 'percent' };
  }
  if (/^[-+]?[¥$€£]\s?-?[\d,]+(\.\d+)?$/.test(text.trim())) {
    const number = Number(text.replace(/[¥$€£,\s]/g, ''));
    if (Number.isFinite(number)) return { v: number, fmt: 'currency' };
  }
  const upper = text.trim().toUpperCase();
  if (upper === 'TRUE') return { v: true };
  if (upper === 'FALSE') return { v: false };
  const serial = parseDateText(text.trim());
  if (serial !== null) {
    const isTimeOnly = /^(\d{1,2}):(\d{2})(:(\d{2}))?$/.test(text.trim());
    return { v: serial, fmt: isTimeOnly ? 'time' : 'date' };
  }
  return { v: text };
}

/** 结构变更时平移公式里的绝对与相对引用 */
function translateFormulaForStructure(formula, { rows = 0, cols = 0 }) {
  try {
    return translateFormula(formula, { rows, cols });
  } catch {
    return formula;
  }
}

/** 复制区域到二维数组（内含公式平移与样式） */
export function cloneBlock(workbook, sheetName, from, to) {
  const out = [];
  for (let r = from.r; r <= to.r; r += 1) {
    const row = [];
    for (let c = from.c; c <= to.c; c += 1) {
      const cell = workbook.getCell(sheetName, r, c);
      row.push(cell ? structuredCloneSafe(cell) : null);
    }
    out.push(row);
  }
  return out;
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/** 把区域转成 CSV 文本（含公式的计算结果） */
export function rangeToCsv(workbook, sheetName, from, to, options = {}) {
  const lines = [];
  for (let r = from.r; r <= to.r; r += 1) {
    const cells = [];
    for (let c = from.c; c <= to.c; c += 1) {
      let text = workbook.getText(sheetName, r, c);
      if (options.raw && workbook.getCell(sheetName, r, c)?.f) text = workbook.getRawInput(sheetName, r, c);
      if (/[",\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
      cells.push(text);
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

/** 解析 CSV / TSV 文本为二维数组（支持引号包裹与换行） */
export function parseDelimited(text, delimiter) {
  const source = String(text ?? '').replace(/^\ufeff/, '');
  // Excel / 表格软件复制出来的内容一定用制表符，且制表符几乎不会出现在 CSV 数据里
  const firstLine = source.split('\n', 1)[0];
  const guess = delimiter || (firstLine.includes('\t') ? '\t' : ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === guess) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 排序：按某一列对区域重排（保留样式） */
export function sortRange(workbook, sheetName, range, keyColumn, direction = 1, hasHeader = true) {
  const sheet = workbook.sheetByName(sheetName);
  if (!sheet) return;
  const startR = hasHeader ? range.from.r + 1 : range.from.r;
  const rows = [];
  for (let r = startR; r <= range.to.r; r += 1) {
    const cells = [];
    for (let c = range.from.c; c <= range.to.c; c += 1) cells.push(workbook.getCell(sheetName, r, c) || null);
    rows.push({ cells, value: workbook.getValue(sheetName, r, keyColumn) });
  }
  rows.sort((a, b) => compare(a.value, b.value) * direction);
  rows.forEach((row, index) => {
    const target = startR + index;
    for (let c = range.from.c; c <= range.to.c; c += 1) {
      const key = cellKey(target, c);
      const cell = row.cells[c - range.from.c];
      if (cell) sheet.cells[key] = cell;
      else delete sheet.cells[key];
    }
  });
  workbook.touch({ type: 'sort', sheet: sheetName });
}
