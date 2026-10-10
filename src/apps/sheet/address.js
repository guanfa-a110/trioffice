/**
 * address.js —— A1 引用记法的解析与格式化（0 基行列下标 ↔ "AB12"）。
 * 纯逻辑模块，无 DOM 依赖。
 */

const A_CODE = 65;

/** 0 基列号 → 列名（0 → A，26 → AA） */
export function colToLabel(col) {
  let value = Number(col);
  if (!Number.isFinite(value) || value < 0) return '';
  let label = '';
  do {
    label = String.fromCharCode(A_CODE + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

/** 列名 → 0 基列号（A → 0，AA → 26）；非法返回 -1 */
export function labelToCol(label) {
  const text = String(label || '').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(text)) return -1;
  let value = 0;
  for (const ch of text) value = value * 26 + (ch.charCodeAt(0) - A_CODE + 1);
  return value - 1;
}

/**
 * 解析单元格引用。
 * @param {string} text 例如 "A1"、"$B$7"、"aa10"
 * @returns {{r:number, c:number, absR:boolean, absC:boolean}|null}
 */
export function parseA1(text) {
  const match = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(String(text || '').trim());
  if (!match) return null;
  const c = labelToCol(match[2]);
  const r = Number(match[4]) - 1;
  if (c < 0 || r < 0) return null;
  return { r, c, absC: match[1] === '$', absR: match[3] === '$' };
}

/**
 * 生成 A1 文本。
 * @param {{r:number, c:number, absR?:boolean, absC?:boolean}} ref
 */
export function formatA1(ref) {
  if (!ref) return '';
  return `${ref.absC ? '$' : ''}${colToLabel(ref.c)}${ref.absR ? '$' : ''}${ref.r + 1}`;
}

/** 生成区域文本，例如 A1:C9 */
export function formatRange(from, to) {
  return `${formatA1(from)}:${formatA1(to)}`;
}

/** 生成带表名的完整引用 */
export function formatRef(sheetName, ref) {
  if (!sheetName) return formatA1(ref);
  const needsQuote = /[^A-Za-z0-9_\u4e00-\u9fa5]/.test(sheetName);
  const name = needsQuote ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  return `${name}!${formatA1(ref)}`;
}

/** 拆解 "Sheet1!A1:B2" */
export function parseRefText(text) {
  const raw = String(text || '').trim();
  let sheet = null;
  let rest = raw;
  const bang = raw.lastIndexOf('!');
  if (bang !== -1) {
    sheet = raw.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
    rest = raw.slice(bang + 1);
  }
  const [from, to] = rest.split(':');
  const start = parseA1(from);
  if (!start) return null;
  if (!to) return { sheet, from: start, to: start };
  const end = parseA1(to);
  if (!end) return null;
  return { sheet, from: start, to: end };
}

/**
 * 偏移引用（用于插入/删除行列、公式平移）。
 * 保持绝对引用不变，只平移相对引用。
 */
export function shiftRef(ref, { rows = 0, cols = 0 }) {
  return {
    r: ref.absR ? ref.r : ref.r + rows,
    c: ref.absC ? ref.c : ref.c + cols,
    absR: Boolean(ref.absR),
    absC: Boolean(ref.absC),
  };
}

/**
 * 生成区域内的所有坐标（行优先）。
 */
export function eachInRange(from, to) {
  const out = [];
  const r1 = Math.min(from.r, to.r);
  const r2 = Math.max(from.r, to.r);
  const c1 = Math.min(from.c, to.c);
  const c2 = Math.max(from.c, to.c);
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) out.push({ r, c });
  }
  return out;
}
