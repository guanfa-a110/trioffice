/**
 * value.js —— 公式值语义：类型、错误、强制转换、比较、数字格式化。
 * 纯逻辑模块，无 DOM 依赖。
 */

/** Excel 风格错误码 */
export const ERR = {
  DIV0: '#DIV/0!',
  VALUE: '#VALUE!',
  REF: '#REF!',
  NAME: '#NAME?',
  NUM: '#NUM!',
  NA: '#N/A',
  NULL: '#NULL!',
  CIRC: '#CIRC!',
};

const ERROR_CODES = new Set(Object.values(ERR));

/** 值层面的错误对象（不抛异常，随值传播） */
export class FormulaError {
  constructor(code, message) {
    this.code = ERROR_CODES.has(code) ? code : ERR.VALUE;
    this.message = message || '';
    this.isError = true;
  }
  toString() {
    return this.code;
  }
}

export const error = (code, message) => new FormulaError(code, message);

/** 判断是否为错误值 */
export const isError = (value) => value instanceof FormulaError || (value && value.isError === true);

/** 区域值：二维矩阵，函数可整体消费 */
export class RangeValue {
  /** @param {any[][]} values 行优先二维数组 */
  constructor(values, ref) {
    this.values = values;
    this.ref = ref || null;
    this.isRange = true;
    this.rows = values.length;
    this.cols = values.length ? values[0].length : 0;
  }
  /** 拉平成一维（行优先） */
  flat() {
    const out = [];
    for (const row of this.values) for (const cell of row) out.push(cell);
    return out;
  }
  at(r, c) {
    const row = this.values[r];
    return row ? row[c] : undefined;
  }
}

export const isRange = (value) => value instanceof RangeValue || (value && value.isRange === true);

/** 空单元格用 null 表示 */
export const isBlank = (value) => value === null || value === undefined;

/** 值 → 展示文本（空单元格 → ''） */
export function toText(value, numberFormat) {
  if (isBlank(value)) return '';
  if (isError(value)) return value.code;
  if (isRange(value)) {
    const first = value.flat().find((cell) => !isBlank(cell));
    return toText(isBlank(first) ? null : first);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return formatDateTime(value);
  if (typeof value === 'number') return numberFormat ? applyNumberFormat(value, numberFormat) : formatNumber(value);
  return String(value);
}

/** 数值 → 一般格式文本（避免出现 0.30000000000000004） */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(15));
  if (Math.abs(rounded) >= 1e15 || (rounded !== 0 && Math.abs(rounded) < 1e-9)) {
    return rounded.toExponential(9).replace(/\.?0+e/, 'e');
  }
  return String(rounded);
}

function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (time === '00:00') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** 值 → 数值（Excel 风格宽松转换） */
export function toNumber(value) {
  if (isBlank(value)) return 0;
  if (isError(value)) return value;
  if (isRange(value)) return toNumber(value.flat().find((cell) => !isBlank(cell)));
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return dateToSerial(value);
  const text = String(value).trim();
  if (text === '') return 0;
  const percent = /^(-?[\d.]+(?:e[+-]?\d+)?)\s*%$/i.exec(text);
  if (percent) return Number(percent[1]) / 100;
  const currency = /^[-+]?[¥$€£]?\s?-?[\d,]*\.?\d+(?:e[+-]?\d+)?%?$/i.exec(text);
  if (currency) {
    const cleaned = text.replace(/[¥$€£,\s]/g, '');
    const parsed = Number(cleaned.replace(/%$/, ''));
    if (Number.isFinite(parsed)) return /%$/.test(cleaned) ? parsed / 100 : parsed;
  }
  const dateSerial = parseDateText(text);
  if (dateSerial !== null) return dateSerial;
  return error(ERR.VALUE, `无法把 "${text}" 转换为数字`);
}

/**
 * 值 → 布尔（Excel 规则：数字 0 为 FALSE，文本 "TRUE"/"FALSE" 可识别，其余报错）
 */
export function toBool(value) {
  if (isBlank(value)) return false;
  if (isError(value)) return value;
  if (isRange(value)) return toBool(value.flat().find((cell) => !isBlank(cell)));
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toUpperCase();
  if (text === 'TRUE') return true;
  if (text === 'FALSE') return false;
  return error(ERR.VALUE, `无法把 "${value}" 转换为逻辑值`);
}

/** 值 → 字符串（用于 & 与文本函数，任何值都能转） */
export function toStr(value) {
  if (isError(value)) return value;
  return toText(value);
}

/** 数值排序权重：数字 < 文本 < 逻辑值（Excel 规则） */
function rank(value) {
  if (isBlank(value)) return 0;
  if (typeof value === 'number') return 1;
  if (value instanceof Date) return 1;
  if (typeof value === 'string') return 2;
  if (typeof value === 'boolean') return 3;
  return 4;
}

/**
 * 通用比较：返回 -1 / 0 / 1；类型不可比时按 Excel 顺序处理。
 */
export function compare(a, b) {
  const av = isRange(a) ? a.flat()[0] : a;
  const bv = isRange(b) ? b.flat()[0] : b;
  if (isError(av)) return 0;
  if (isError(bv)) return 0;
  if (isBlank(av) && isBlank(bv)) return 0;
  if (isBlank(av)) return -1;
  if (isBlank(bv)) return 1;

  const ra = rank(av);
  const rb = rank(bv);
  if (ra !== rb) return ra < rb ? -1 : 1;

  if (ra === 1) {
    const na = av instanceof Date ? dateToSerial(av) : Number(av);
    const nb = bv instanceof Date ? dateToSerial(bv) : Number(bv);
    if (Number.isNaN(na) || Number.isNaN(nb)) return 0;
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (ra === 3) {
    const na = av ? 1 : 0;
    const nb = bv ? 1 : 0;
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = String(av).toLowerCase();
  const sb = String(bv).toLowerCase();
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** 宽松相等（忽略大小写） */
export const equals = (a, b) => compare(a, b) === 0;

/* ------------------------------------------------------------------ *
 * 日期序列值（Excel 序列：1899-12-30 为 0，按「墙上时间」计算）
 * ------------------------------------------------------------------ */
export const EPOCH_OFFSET = Date.UTC(1899, 11, 30) / 86400000;

/**
 * Date → 序列号。
 * 采用「墙上时间」语义：2026-10-10 00:00（本地）→ 46304，与 Excel 完全一致。
 * 这样整日期的序列号一定是整数，跨时区不会出现 0.666 这类小数。
 */
export function dateToSerial(date) {
  const days = (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(1970, 0, 1)) / 86400000;
  const time = (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000) / 86400;
  return Number((days + 25569 + time).toFixed(9));
}

/** 序列号 → Date（本地时间，序列号的整数部分为日期、小数部分为时间） */
export function serialToDate(serial) {
  const value = Number(serial) || 0;
  const totalDays = value - 25569;
  const days = Math.floor(totalDays);
  const fraction = totalDays - days;
  // 用毫秒取整消除浮点误差（Excel 内部同样按 1e-7 天取整）
  const ms = Math.round(fraction * 86400000);
  const base = new Date(Date.UTC(1970, 0, 1) + days * 86400000);
  return new Date(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
    0, 0, 0, ms,
  );
}

/** 文本日期解析（支持 YYYY-MM-DD、YYYY/MM/DD、MM-DD-YYYY 等常见写法） */
export function parseDateText(text) {
  const raw = String(text).trim();
  let match = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (match) {
    return dateToSerial(new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0),
    ));
  }
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw);
  if (match) {
    return dateToSerial(new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  }
  match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (match) {
    return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0)) / 86400;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 数字格式
 * ------------------------------------------------------------------ */
/**
 * 套用数字格式。
 * @param {number} value
 * @param {string} fmt general/number/currency/percent/date/time/scientific/text
 */
export function applyNumberFormat(value, fmt) {
  switch (fmt) {
    case 'number':
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'currency':
      return `¥${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      return `${(value * 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
    case 'date': {
      const date = serialToDate(value);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }
    case 'time': {
      const serial = Math.abs(value) % 1;
      const totalSeconds = Math.round(serial * 86400);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
    }
    case 'scientific':
      return Number(value).toExponential(6).replace(/\.?0+e/, 'e');
    case 'text':
      return String(value);
    default:
      return formatNumber(value);
  }
}

/* ------------------------------------------------------------------ *
 * 条件匹配（COUNTIF / SUMIF / 条件格式）
 * ------------------------------------------------------------------ */
/**
 * 解析条件表达式：" >60 "、"<>"、"苹果"、"=A1"
 * @returns {{op: string, value: any}}
 */
export function parseCriteria(criteria) {
  if (isBlank(criteria)) return { op: '=', value: '' };
  if (typeof criteria === 'number' || typeof criteria === 'boolean') return { op: '=', value: criteria };
  if (isError(criteria)) return { op: '=', value: criteria };
  const text = String(criteria);
  const match = /^\s*(<=|>=|<>|=|<|>)?\s*([\s\S]*)$/.exec(text);
  const op = match[1] || '=';
  const raw = match[2] ?? '';
  const numeric = raw.trim() === '' ? null : toNumberLoose(raw);
  return { op, value: numeric === null ? raw : numeric };
}

function toNumberLoose(text) {
  const trimmed = String(text).trim();
  if (!/^[-+]?\d*\.?\d+(?:e[+-]?\d+)?%?$/i.test(trimmed)) return null;
  const isPercent = trimmed.endsWith('%');
  const value = Number(trimmed.replace('%', ''));
  if (!Number.isFinite(value)) return null;
  return isPercent ? value / 100 : value;
}

/** 判断单元格值是否命中条件 */
export function matchesCriteria(cell, criteria) {
  const { op, value } = typeof criteria === 'object' && criteria && 'op' in criteria
    ? criteria
    : parseCriteria(criteria);
  if (op === '<>') return !equals(cell, value);
  const cmp = compare(cell, value);
  switch (op) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    default: return false;
  }
}

/** 判断是否为“数字样”的值 */
export function isNumeric(value) {
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return false;
  if (isBlank(value)) return false;
  return toNumberLoose(String(value)) !== null;
}

/** 把值转为数字，失败返回 null（不产生错误值，供聚合函数跳过） */
export function numericOrNull(value) {
  if (typeof value === 'number') return value;
  if (isBlank(value) || typeof value === 'boolean' || isError(value)) return null;
  if (value instanceof Date) return dateToSerial(value);
  return toNumberLoose(String(value));
}
