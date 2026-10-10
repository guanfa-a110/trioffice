/**
 * functions.js —— 公式函数库（160+ 个，覆盖常用 Excel 兼容函数）。
 *
 * 注册表结构：
 *   FUNCTIONS[name] = { min, max, fn(args, ctx), lazy?: true }
 *   - 非 lazy：args 是已求值的值数组，RangeValue 原样传入；
 *   - lazy：args 是 AST 节点数组，通过 ctx.eval(node) 惰性求值（用于 IF/IFERROR/AND/OR 等短路语义）。
 *
 * ctx 由 formula.js 提供：
 *   { eval(node), getRange(node), getRef(node), resolve(text), currentRef, sheetName,
 *     sheetNames(), getValue(sheet, r, c) }
 *
 * 纯逻辑模块，无 DOM 依赖。
 */
import {
  ERR, RangeValue, error, isError, isRange, isBlank,
  toNumber, toText, toBool, compare, equals, matchesCriteria, parseCriteria,
  numericOrNull, dateToSerial, serialToDate,
} from './value.js';
import { colToLabel, formatA1 } from './address.js';

/* ------------------------------------------------------------------ *
 * 参数处理辅助
 * ------------------------------------------------------------------ */

/** 展开参数为标量数组（区域/数组会被拉平，保留空值占位） */
export function flattenArgs(args, options = {}) {
  const out = [];
  const visit = (value) => {
    if (isRange(value)) {
      for (const cell of value.flat()) visit(cell);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      out.push(value === undefined ? null : value);
    }
  };
  for (const arg of args) visit(arg);
  if (options.skipBlank) return out.filter((value) => !isBlank(value));
  return out;
}

/** 取第一个非空标量 */
function firstValue(args) {
  for (const value of flattenArgs(args)) if (!isBlank(value)) return value;
  return null;
}

/** 数值参数（缺省时用 fallback；转换失败返回错误值） */
function num(args, index, fallback) {
  const list = Array.isArray(args) ? args : [args];
  if (list[index] === undefined || isBlank(list[index])) {
    if (fallback !== undefined) return fallback;
    return error(ERR.VALUE, '缺少数值参数');
  }
  return toNumber(list[index]);
}

/** 取出所有可转为数字的值（跳过文本与空值，像 Excel 聚合函数那样） */
function numbers(args) {
  const out = [];
  for (const value of flattenArgs(args)) {
    if (isError(value)) continue;
    const n = numericOrNull(value);
    if (n !== null) out.push(n);
  }
  return out;
}

/** 严格模式：直接转换，遇到文本报错（用于单值数学函数） */
function strictNumbers(args) {
  const out = [];
  for (const value of flattenArgs(args, { skipBlank: true })) {
    if (isError(value)) return value;
    const n = toNumber(value);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/** 从聚合函数返回值中挑出第一个错误值 */
function findError(args) {
  for (const value of flattenArgs(args)) if (isError(value)) return value;
  return null;
}

/** 通用一元数值函数包装 */
function mathFn(fn) {
  return (args) => {
    const list = strictNumbers(args);
    if (isError(list)) return list;
    if (!list.length) return error(ERR.VALUE, '缺少参数');
    const result = fn(list[0], list);
    return Number.isFinite(result) ? result : error(ERR.NUM, '数值溢出');
  };
}

/** 通用多参数聚合函数包装 */
function reduceFn(initial, reducer, options = {}) {
  return (args) => {
    const list = numbers(args);
    if (!list.length) return options.empty === undefined ? error(ERR.DIV0, '没有可计算的数据') : options.empty;
    return reducer(list);
  };
}

function variance(values, sample) {
  const count = values.length;
  if (count < (sample ? 2 : 1)) return error(ERR.DIV0);
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const sum = values.reduce((acc, value) => acc + (value - mean) ** 2, 0);
  return sum / (sample ? count - 1 : count);
}

function percentile(values, p) {
  if (!values.length) return error(ERR.NUM);
  const sorted = [...values].sort((a, b) => a - b);
  if (p < 0 || p > 1) return error(ERR.NUM);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/* ------------------------------------------------------------------ *
 * 数值/三角/进制
 * ------------------------------------------------------------------ */
const MATH = {
  ABS: mathFn((x) => Math.abs(x)),
  SIGN: mathFn((x) => Math.sign(x)),
  SQRT: mathFn((x) => (x < 0 ? error(ERR.NUM, '负数不能开平方') : Math.sqrt(x))),
  EXP: mathFn((x) => Math.exp(x)),
  LN: mathFn((x) => (x <= 0 ? error(ERR.NUM, '对数参数必须为正数') : Math.log(x))),
  LOG10: mathFn((x) => (x <= 0 ? error(ERR.NUM, '对数参数必须为正数') : Math.log10(x))),
  LOG: mathFn((x, list) => Math.log(x) / Math.log(list[1] ?? 10)),
  PI: () => Math.PI,
  SIN: mathFn((x) => Math.sin(x)),
  COS: mathFn((x) => Math.cos(x)),
  TAN: mathFn((x) => Math.tan(x)),
  ASIN: mathFn((x) => (Math.abs(x) > 1 ? error(ERR.NUM, '超出定义域') : Math.asin(x))),
  ACOS: mathFn((x) => (Math.abs(x) > 1 ? error(ERR.NUM, '超出定义域') : Math.acos(x))),
  ATAN: mathFn((x) => Math.atan(x)),
  ATAN2: mathFn((x, list) => Math.atan2(list[1] ?? 0, x)),
  SINH: mathFn((x) => Math.sinh(x)),
  COSH: mathFn((x) => Math.cosh(x)),
  TANH: mathFn((x) => Math.tanh(x)),
  DEGREES: mathFn((x) => (x * 180) / Math.PI),
  RADIANS: mathFn((x) => (x * Math.PI) / 180),
  INT: mathFn((x) => Math.floor(x)),
  TRUNC: (args) => {
    const list = strictNumbers(args);
    if (isError(list)) return list;
    const digits = Math.trunc(list[1] ?? 0);
    const factor = 10 ** digits;
    return Math.trunc(list[0] * factor) / factor;
  },
  EVEN: mathFn((x) => {
    const rounded = Math.ceil(Math.abs(x) / 2) * 2;
    return x < 0 ? -rounded : rounded;
  }),
  ODD: mathFn((x) => {
    let rounded = Math.ceil(Math.abs(x));
    if (rounded % 2 === 0) rounded += 1;
    return x < 0 ? -rounded : rounded;
  }),
  FACT: mathFn((x) => {
    if (x < 0) return error(ERR.NUM);
    let out = 1;
    for (let i = 2; i <= Math.floor(x); i += 1) out *= i;
    return out;
  }),
  COMBIN: mathFn((x, list) => {
    const n = Math.floor(x);
    const k = Math.floor(list[1] ?? 0);
    if (n < 0 || k < 0 || k > n) return error(ERR.NUM);
    let out = 1;
    for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
    return Math.round(out);
  }),
  PERMUT: mathFn((x, list) => {
    const n = Math.floor(x);
    const k = Math.floor(list[1] ?? 0);
    if (n < 0 || k < 0 || k > n) return error(ERR.NUM);
    let out = 1;
    for (let i = 0; i < k; i += 1) out *= n - i;
    return out;
  }),
  GCD: (args) => {
    const list = numbers(args).map((n) => Math.abs(Math.trunc(n)));
    if (!list.length) return error(ERR.NUM);
    const gcd2 = (a, b) => (b ? gcd2(b, a % b) : a);
    return list.reduce((a, b) => gcd2(a, b));
  },
  LCM: (args) => {
    const list = numbers(args).map((n) => Math.abs(Math.trunc(n)));
    if (!list.length) return error(ERR.NUM);
    const gcd2 = (a, b) => (b ? gcd2(b, a % b) : a);
    return list.reduce((a, b) => (a / gcd2(a, b)) * b);
  },
  SUMSQ: (args) => numbers(args).reduce((acc, value) => acc + value * value, 0),
  QUOTIENT: mathFn((x, list) => {
    const divisor = list[1];
    if (!divisor) return error(ERR.DIV0);
    return Math.trunc(x / divisor);
  }),
  RAND: () => Math.random(),
  RANDBETWEEN: (args) => {
    const list = strictNumbers(args);
    if (isError(list)) return list;
    const low = Math.ceil(list[0]);
    const high = Math.ceil(list[1] ?? low);
    if (low > high) return error(ERR.NUM);
    return low + Math.floor(Math.random() * (high - low + 1));
  },
};

/** 舍入族与幂运算需要多个参数，单独定义以保持可读性 */
MATH.MOD = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  const divisor = list[1];
  if (divisor === undefined) return error(ERR.VALUE);
  if (!divisor) return error(ERR.DIV0);
  return list[0] - divisor * Math.floor(list[0] / divisor);
};
MATH.POWER = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  const result = list[0] ** list[1];
  return Number.isFinite(result) ? result : error(ERR.NUM);
};
MATH.ROUND = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  const digits = Math.trunc(list[1] ?? 0);
  return roundHalfUp(list[0], digits);
};
MATH.ROUNDUP = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  return roundDirection(list[0], Math.trunc(list[1] ?? 0), 1);
};
MATH.ROUNDDOWN = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  return roundDirection(list[0], Math.trunc(list[1] ?? 0), -1);
};
MATH.MROUND = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  const multiple = list[1];
  if (!multiple) return 0;
  return Math.round(list[0] / multiple) * multiple;
};
MATH.CEILING = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  const significance = list[1] ?? 1;
  if (!significance) return 0;
  return Math.ceil(list[0] / significance) * significance;
};
MATH.FLOOR = (args) => {
  const list = strictNumbers(args);
  if (isError(list)) return list;
  const significance = list[1] ?? 1;
  if (!significance) return error(ERR.DIV0);
  return Math.floor(list[0] / significance) * significance;
};

/** 四舍五入（Excel 的 ROUND 是 round half away from zero） */
function roundHalfUp(value, digits) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  return Number((rounded / factor).toPrecision(15));
}

function roundDirection(value, digits, direction) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = direction > 0
    ? Math.sign(scaled) * Math.ceil(Math.abs(scaled))
    : Math.sign(scaled) * Math.floor(Math.abs(scaled));
  return Number((rounded / factor).toPrecision(15));
}

/* ------------------------------------------------------------------ *
 * 聚合 / 统计
 * ------------------------------------------------------------------ */
const STAT = {
  SUM: (args) => {
    const bad = findError(args);
    if (bad) return bad;
    return numbers(args).reduce((acc, value) => acc + value, 0);
  },
  PRODUCT: (args) => {
    const list = numbers(args);
    if (!list.length) return 0;
    return list.reduce((acc, value) => acc * value, 1);
  },
  MAX: (args) => {
    const list = numbers(args);
    return list.length ? Math.max(...list) : 0;
  },
  MIN: (args) => {
    const list = numbers(args);
    return list.length ? Math.min(...list) : 0;
  },
  AVERAGE: reduceFn(0, (list) => list.reduce((a, b) => a + b, 0) / list.length),
  COUNT: (args) => numbers(args).length,
  COUNTA: (args) => flattenArgs(args).filter((value) => !isBlank(value)).length,
  COUNTBLANK: (args) => flattenArgs(args).filter((value) => isBlank(value) || value === '').length,
  MEDIAN: reduceFn(0, (list) => percentile(list, 0.5)),
  MODE: (args) => {
    const list = numbers(args);
    if (!list.length) return error(ERR.NA);
    const counts = new Map();
    let best = null;
    let bestCount = 1;
    for (const value of list) {
      const count = (counts.get(value) || 0) + 1;
      counts.set(value, count);
      if (count > bestCount) {
        bestCount = count;
        best = value;
      }
    }
    return best === null ? error(ERR.NA, '没有重复值') : best;
  },
  STDEV: reduceFn(0, (list) => Math.sqrt(variance(list, true))),
  STDEVP: reduceFn(0, (list) => Math.sqrt(variance(list, false))),
  STDEV_S: reduceFn(0, (list) => Math.sqrt(variance(list, true))),
  STDEV_P: reduceFn(0, (list) => Math.sqrt(variance(list, false))),
  VAR: reduceFn(0, (list) => variance(list, true)),
  VARP: reduceFn(0, (list) => variance(list, false)),
  VAR_S: reduceFn(0, (list) => variance(list, true)),
  VAR_P: reduceFn(0, (list) => variance(list, false)),
  AVEDEV: reduceFn(0, (list) => {
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    return list.reduce((acc, value) => acc + Math.abs(value - mean), 0) / list.length;
  }),
  DEVSQ: reduceFn(0, (list) => {
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    return list.reduce((acc, value) => acc + (value - mean) ** 2, 0);
  }),
  GEOMEAN: reduceFn(0, (list) => {
    if (list.some((value) => value <= 0)) return error(ERR.NUM);
    return Math.exp(list.reduce((acc, value) => acc + Math.log(value), 0) / list.length);
  }),
  HARMEAN: reduceFn(0, (list) => {
    if (list.some((value) => value <= 0)) return error(ERR.NUM);
    return list.length / list.reduce((acc, value) => acc + 1 / value, 0);
  }),
  LARGE: (args) => {
    const list = numbers([args[0]]);
    const k = toNumber(args[1]);
    if (isError(k)) return k;
    if (k < 1 || k > list.length) return error(ERR.NUM);
    return [...list].sort((a, b) => b - a)[Math.floor(k) - 1];
  },
  SMALL: (args) => {
    const list = numbers([args[0]]);
    const k = toNumber(args[1]);
    if (isError(k)) return k;
    if (k < 1 || k > list.length) return error(ERR.NUM);
    return [...list].sort((a, b) => a - b)[Math.floor(k) - 1];
  },
  PERCENTILE: (args) => {
    const list = numbers([args[0]]);
    const p = toNumber(args[1]);
    if (isError(p)) return p;
    return percentile(list, p);
  },
  QUARTILE: (args) => {
    const list = numbers([args[0]]);
    const q = Math.trunc(toNumber(args[1]));
    if (q < 0 || q > 4) return error(ERR.NUM);
    return percentile(list, q / 4);
  },
  TRIMMEAN: (args) => {
    const list = numbers([args[0]]).sort((a, b) => a - b);
    const percent = toNumber(args[1]);
    if (isError(percent)) return percent;
    const cut = Math.floor(list.length * percent / 2);
    const trimmed = list.slice(cut, list.length - cut);
    return trimmed.length ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length : error(ERR.NUM);
  },
  RANK: (args) => {
    const value = toNumber(args[0]);
    const list = numbers([args[1]]);
    const order = args[2] === undefined ? 0 : toNumber(args[2]);
    if (isError(value)) return value;
    const sorted = [...list].sort((a, b) => (order ? a - b : b - a));
    const index = sorted.findIndex((item) => item === value);
    return index === -1 ? error(ERR.NA) : index + 1;
  },
  RANK_EQ: (args) => STAT.RANK(args),
  SUMPRODUCT: (args) => {
    const arrays = args.map((arg) => (isRange(arg) ? arg.flat() : Array.isArray(arg) ? arg.flat() : [arg]));
    if (!arrays.length) return 0;
    const width = Math.max(...arrays.map((list) => list.length));
    let total = 0;
    for (let i = 0; i < width; i += 1) {
      let product = 1;
      for (const list of arrays) {
        const value = numericOrNull(list[i % list.length]);
        product *= value === null ? 0 : value;
      }
      total += product;
    }
    return total;
  },
  COUNTIF: (args) => {
    const cells = flattenArgs([args[0]]);
    return cells.filter((cell) => matchesCriteria(cell, args[1])).length;
  },
  COUNTIFS: (args) => countIfs(args),
  SUMIF: (args) => {
    const range = flattenArgs([args[0]]);
    const criteria = parseCriteria(args[1]);
    const sumRange = args[2] === undefined ? range : flattenArgs([args[2]]);
    let total = 0;
    range.forEach((cell, index) => {
      if (!matchesCriteria(cell, criteria)) return;
      const value = numericOrNull(sumRange[index]);
      if (value !== null) total += value;
    });
    return total;
  },
  SUMIFS: (args) => {
    const sumRange = flattenArgs([args[0]]);
    const conditions = [];
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (args[i] === undefined) break;
      conditions.push({ cells: flattenArgs([args[i]]), criteria: parseCriteria(args[i + 1]) });
    }
    let total = 0;
    sumRange.forEach((cell, index) => {
      if (!conditions.every((cond) => matchesCriteria(cond.cells[index], cond.criteria))) return;
      const value = numericOrNull(cell);
      if (value !== null) total += value;
    });
    return total;
  },
  AVERAGEIF: (args) => {
    const range = flattenArgs([args[0]]);
    const criteria = parseCriteria(args[1]);
    const averageRange = args[2] === undefined ? range : flattenArgs([args[2]]);
    const picked = [];
    range.forEach((cell, index) => {
      if (!matchesCriteria(cell, criteria)) return;
      const value = numericOrNull(averageRange[index]);
      if (value !== null) picked.push(value);
    });
    if (!picked.length) return error(ERR.DIV0);
    return picked.reduce((a, b) => a + b, 0) / picked.length;
  },
  AVERAGEIFS: (args) => {
    const avgRange = flattenArgs([args[0]]);
    const conditions = [];
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (args[i] === undefined) break;
      conditions.push({ cells: flattenArgs([args[i]]), criteria: parseCriteria(args[i + 1]) });
    }
    const picked = [];
    avgRange.forEach((cell, index) => {
      if (!conditions.every((cond) => matchesCriteria(cond.cells[index], cond.criteria))) return;
      const value = numericOrNull(cell);
      if (value !== null) picked.push(value);
    });
    if (!picked.length) return error(ERR.DIV0);
    return picked.reduce((a, b) => a + b, 0) / picked.length;
  },
};

function countIfs(args) {
  const groups = [];
  for (let i = 0; i + 1 < args.length; i += 2) {
    if (args[i] === undefined) break;
    groups.push({ cells: flattenArgs([args[i]]), criteria: parseCriteria(args[i + 1]) });
  }
  if (!groups.length) return 0;
  return groups[0].cells.filter((cell, index) => groups.every((group) => matchesCriteria(group.cells[index], group.criteria))).length;
}

/* ------------------------------------------------------------------ *
 * 文本
 * ------------------------------------------------------------------ */
const TEXT = {
  CONCAT: (args) => flattenArgs(args).map((value) => (isError(value) ? '' : toText(value))).join(''),
  CONCATENATE: (args) => flattenArgs(args).map((value) => (isError(value) ? '' : toText(value))).join(''),
  TEXTJOIN: (args) => {
    const delimiter = toText(args[0]);
    const ignoreEmpty = args[1] === undefined ? true : toBool(args[1]) !== false;
    let values = flattenArgs(args.slice(2)).map((value) => toText(value));
    if (ignoreEmpty) values = values.filter((value) => value !== '');
    return values.join(delimiter);
  },
  LEFT: (args) => {
    const text = toText(args[0]);
    const count = args[1] === undefined ? 1 : Math.trunc(toNumber(args[1]));
    if (count < 0) return error(ERR.VALUE);
    return [...text].slice(0, count).join('');
  },
  RIGHT: (args) => {
    const text = toText(args[0]);
    const count = args[1] === undefined ? 1 : Math.trunc(toNumber(args[1]));
    if (count < 0) return error(ERR.VALUE);
    return count === 0 ? '' : [...text].slice(-count).join('');
  },
  MID: (args) => {
    const text = toText(args[0]);
    const start = Math.trunc(toNumber(args[1]));
    const count = Math.trunc(toNumber(args[2]));
    if (start < 1 || count < 0) return error(ERR.VALUE);
    return [...text].slice(start - 1, start - 1 + count).join('');
  },
  LEN: (args) => [...toText(firstValue(args))].length,
  LOWER: (args) => toText(firstValue(args)).toLowerCase(),
  UPPER: (args) => toText(firstValue(args)).toUpperCase(),
  PROPER: (args) => toText(firstValue(args)).replace(/\b([\p{L}])/gu, (m) => m.toUpperCase()).replace(/\B([\p{L}])/gu, (m) => m.toLowerCase()),
  TRIM: (args) => toText(firstValue(args)).replace(/\s+/g, ' ').trim(),
  CLEAN: (args) => toText(firstValue(args)).replace(/[\u0000-\u001f\u007f]/g, ''),
  REPT: (args) => {
    const text = toText(args[0]);
    const count = Math.trunc(toNumber(args[1]));
    if (count < 0) return error(ERR.VALUE);
    if (count * text.length > 32767) return error(ERR.NUM);
    return text.repeat(count);
  },
  SUBSTITUTE: (args) => {
    const text = toText(args[0]);
    const find = toText(args[1]);
    const replace = toText(args[2]);
    if (!find) return text;
    if (args[3] === undefined) return text.split(find).join(replace);
    const nth = Math.trunc(toNumber(args[3]));
    let index = -1;
    let count = 0;
    for (let i = 0; i + find.length <= text.length; i += 1) {
      if (text.slice(i, i + find.length) === find) {
        count += 1;
        if (count === nth) {
          index = i;
          break;
        }
      }
    }
    return index === -1 ? text : text.slice(0, index) + replace + text.slice(index + find.length);
  },
  REPLACE: (args) => {
    const text = toText(args[0]);
    const start = Math.trunc(toNumber(args[1]));
    const count = Math.trunc(toNumber(args[2]));
    const replacement = toText(args[3]);
    if (start < 1 || count < 0) return error(ERR.VALUE);
    const chars = [...text];
    return chars.slice(0, start - 1).join('') + replacement + chars.slice(start - 1 + count).join('');
  },
  FIND: (args) => {
    const find = toText(args[0]);
    const within = toText(args[1]);
    const start = args[2] === undefined ? 1 : Math.trunc(toNumber(args[2]));
    const index = within.indexOf(find, Math.max(0, start - 1));
    return index === -1 ? error(ERR.VALUE, '未找到') : index + 1;
  },
  SEARCH: (args) => {
    const find = toText(args[0]).toLowerCase();
    const within = toText(args[1]).toLowerCase();
    const start = args[2] === undefined ? 1 : Math.trunc(toNumber(args[2]));
    const index = within.indexOf(find, Math.max(0, start - 1));
    return index === -1 ? error(ERR.VALUE, '未找到') : index + 1;
  },
  EXACT: (args) => toText(args[0]) === toText(args[1]),
  VALUE: (args) => toNumber(firstValue(args)),
  NUMBERVALUE: (args) => toNumber(firstValue(args)),
  TEXT: (args) => {
    const value = toNumber(args[0]);
    if (isError(value)) return args[0] === undefined ? '' : toText(args[0]);
    const pattern = toText(args[1]);
    return formatWithPattern(value, pattern);
  },
  CHAR: (args) => String.fromCodePoint(Math.trunc(toNumber(args[0]))),
  UNICHAR: (args) => String.fromCodePoint(Math.trunc(toNumber(args[0]))),
  CODE: (args) => {
    const text = toText(firstValue(args));
    return text.length ? text.charCodeAt(0) : error(ERR.VALUE);
  },
  UNICODE: (args) => {
    const text = toText(firstValue(args));
    return text.length ? text.codePointAt(0) : error(ERR.VALUE);
  },
  T: (args) => {
    const value = firstValue(args);
    return typeof value === 'string' ? value : '';
  },
  N: (args) => {
    const value = firstValue(args);
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return 0;
  },
  DOLLAR: (args) => {
    const value = toNumber(args[0]);
    const digits = args[1] === undefined ? 2 : Math.trunc(toNumber(args[1]));
    if (isError(value)) return value;
    return `¥${value.toFixed(Math.max(0, digits)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  },
  FIXED: (args) => {
    const value = toNumber(args[0]);
    const digits = args[1] === undefined ? 2 : Math.trunc(toNumber(args[1]));
    if (isError(value)) return value;
    return value.toFixed(Math.max(0, digits)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },
};

/** 将 Excel 风格的数字格式串粗略实现为可用的子集 */
function formatWithPattern(value, pattern) {
  return applyNumberFormatPattern(value, pattern);
}

function applyNumberFormatPattern(value, pattern) {
  const p = String(pattern || '').toLowerCase();
  if (p.includes('%')) {
    const digits = (/\.(0+)/.exec(pattern)?.[1] || '').length;
    return `${(value * 100).toFixed(digits)}%`;
  }
  if (/^[¥$€£]/.test(pattern)) {
    const digits = (/\.(0+)/.exec(pattern)?.[1] || '').length;
    return `${pattern[0]}${value.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }
  if (/e[+-]/.test(p)) return value.toExponential(2);
  if (/y{2,4}|m{3,}|d{1,2}/.test(p) && !/^0/.test(p)) {
    const date = serialToDate(value);
    const pad = (n) => String(n).padStart(2, '0');
    return p.includes('-')
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  }
  const decimals = (/\.(0+)/.exec(pattern)?.[1] || '').length;
  const thousands = pattern.includes('#,##');
  const fixed = value.toFixed(decimals);
  return thousands ? fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : fixed.replace(/\.?0+$/, decimals ? '' : '') || '0';
}

/* ------------------------------------------------------------------ *
 * 日期时间
 * ------------------------------------------------------------------ */
const DAY_NAMES_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const DATE = {
  TODAY: () => {
    const now = new Date();
    return dateToSerial(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  },
  NOW: () => dateToSerial(new Date()),
  DATE: (args) => {
    const [y, m, d] = [num(args, 0), num(args, 1), num(args, 2)];
    if (isError(y) || isError(m) || isError(d)) return error(ERR.VALUE);
    let year = Math.trunc(y);
    if (year < 1900) year += 1900;
    const date = new Date(year, Math.trunc(m) - 1, Math.trunc(d));
    if (Number.isNaN(date.getTime())) return error(ERR.NUM);
    return dateToSerial(date);
  },
  TIME: (args) => {
    const h = Math.trunc(toNumber(args[0]));
    const m = Math.trunc(toNumber(args[1]));
    const s = args[2] === undefined ? 0 : Math.trunc(toNumber(args[2]));
    return (h * 3600 + m * 60 + s) / 86400;
  },
  YEAR: (args) => serialToDate(toNumber(args[0])).getFullYear(),
  MONTH: (args) => serialToDate(toNumber(args[0])).getMonth() + 1,
  DAY: (args) => serialToDate(toNumber(args[0])).getDate(),
  HOUR: (args) => {
    const serial = toNumber(args[0]);
    return Math.floor(((serial % 1) + 1) % 1 * 24 + 1e-9);
  },
  MINUTE: (args) => {
    const serial = toNumber(args[0]);
    return Math.floor(((((serial % 1) + 1) % 1) * 1440) % 60 + 1e-9);
  },
  SECOND: (args) => {
    const serial = toNumber(args[0]);
    return Math.round(((((serial % 1) + 1) % 1) * 86400) % 60);
  },
  WEEKDAY: (args) => {
    const serial = toNumber(args[0]);
    const type = args[1] === undefined ? 1 : Math.trunc(toNumber(args[1]));
    if (isError(serial)) return serial;
    const dow = serialToDate(Math.floor(serial)).getDay();
    switch (type) {
      case 2: return ((dow + 6) % 7) + 1;
      case 3: return (dow + 6) % 7;
      case 11: return ((dow + 6) % 7) + 1;
      case 12: return (dow + 5) % 7 + 1;
      case 13: return ((dow + 5) % 7) + 2;
      case 14: return (dow + 6) % 7 + 2;
      case 15: return (dow + 6) % 7 + 1;
      case 16: return (dow + 5) % 7 + 1;
      case 17: return (dow + 6) % 7 + 1;
      default: return dow + 1;
    }
  },
  WEEKNUM: (args) => {
    const serial = toNumber(args[0]);
    const date = serialToDate(Math.floor(serial));
    const start = new Date(date.getFullYear(), 0, 1);
    const days = Math.floor((date - start) / 86400000) + 1;
    return Math.ceil(days / 7);
  },
  EDATE: (args) => {
    const serial = toNumber(args[0]);
    const months = Math.trunc(toNumber(args[1]));
    const date = serialToDate(Math.floor(serial));
    const target = new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
    return dateToSerial(target);
  },
  EOMONTH: (args) => {
    const serial = toNumber(args[0]);
    const months = Math.trunc(toNumber(args[1]));
    const date = serialToDate(Math.floor(serial));
    const target = new Date(date.getFullYear(), date.getMonth() + months + 1, 0);
    return dateToSerial(target);
  },
  DATEVALUE: (args) => {
    const value = toNumber(args[0]);
    return isError(value) ? error(ERR.VALUE) : Math.floor(value);
  },
  TIMEVALUE: (args) => {
    const value = toNumber(args[0]);
    return isError(value) ? error(ERR.VALUE) : value % 1;
  },
  DAYS: (args) => Math.floor(toNumber(args[0])) - Math.floor(toNumber(args[1])),
  DAYS360: (args) => {
    const a = serialToDate(Math.floor(toNumber(args[0])));
    const b = serialToDate(Math.floor(toNumber(args[1])));
    return (b.getFullYear() - a.getFullYear()) * 360 + (b.getMonth() - a.getMonth()) * 30 + (b.getDate() - a.getDate());
  },
  NETWORKDAYS: (args) => {
    const start = Math.floor(toNumber(args[0]));
    const end = Math.floor(toNumber(args[1]));
    if (isError(start) || isError(end)) return error(ERR.VALUE);
    let count = 0;
    const step = start <= end ? 1 : -1;
    for (let serial = start; step > 0 ? serial <= end : serial >= end; serial += step) {
      const dow = serialToDate(serial).getDay();
      if (dow !== 0 && dow !== 6) count += 1;
    }
    return count;
  },
  WORKDAY: (args) => {
    let serial = Math.floor(toNumber(args[0]));
    let remaining = Math.trunc(toNumber(args[1]));
    const step = remaining >= 0 ? 1 : -1;
    remaining = Math.abs(remaining);
    while (remaining > 0) {
      serial += step;
      const dow = serialToDate(serial).getDay();
      if (dow !== 0 && dow !== 6) remaining -= 1;
    }
    return serial;
  },
  DATEDIF: (args) => {
    const start = serialToDate(Math.floor(toNumber(args[0])));
    const end = serialToDate(Math.floor(toNumber(args[1])));
    const unit = toText(args[2]).toUpperCase();
    const diffDays = Math.floor((end - start) / 86400000);
    switch (unit) {
      case 'D': return diffDays;
      case 'Y': return Math.floor(diffDays / 365.2425);
      case 'M': return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) - (end.getDate() < start.getDate() ? 1 : 0);
      case 'YM': return ((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) - (end.getDate() < start.getDate() ? 1 : 0)) % 12;
      case 'MD': {
        let dayDiff = end.getDate() - start.getDate();
        if (dayDiff < 0) dayDiff += new Date(end.getFullYear(), end.getMonth(), 0).getDate();
        return dayDiff;
      }
      case 'YD': {
        const anchor = new Date(start.getFullYear(), end.getMonth(), end.getDate());
        if (anchor < start) anchor.setFullYear(anchor.getFullYear() + 1);
        return Math.floor((end - anchor) / 86400000);
      }
      default: return error(ERR.NUM);
    }
  },
  DAYNAME: (args) => {
    const serial = Math.floor(toNumber(args[0]));
    return DAY_NAMES_ZH[serialToDate(serial).getDay()];
  },
};

/* ------------------------------------------------------------------ *
 * 财务
 * ------------------------------------------------------------------ */
const FINANCE = {
  PMT: (args) => {
    const rate = toNumber(args[0]);
    const nper = toNumber(args[1]);
    const pv = toNumber(args[2]);
    const fv = args[3] === undefined ? 0 : toNumber(args[3]);
    const type = args[4] === undefined ? 0 : toNumber(args[4]);
    if ([rate, nper, pv, fv, type].some(isError)) return error(ERR.VALUE);
    if (rate === 0) return -(pv + fv) / nper;
    const pow = (1 + rate) ** nper;
    return -(pv * pow + fv) * rate / ((pow - 1) * (1 + rate * type));
  },
  FV: (args) => {
    const rate = toNumber(args[0]);
    const nper = toNumber(args[1]);
    const pmt = toNumber(args[2]);
    const pv = args[3] === undefined ? 0 : toNumber(args[3]);
    const type = args[4] === undefined ? 0 : toNumber(args[4]);
    if (rate === 0) return -(pv + pmt * nper);
    const pow = (1 + rate) ** nper;
    return -(pv * pow + pmt * (1 + rate * type) * (pow - 1) / rate);
  },
  PV: (args) => {
    const rate = toNumber(args[0]);
    const nper = toNumber(args[1]);
    const pmt = toNumber(args[2]);
    const fv = args[3] === undefined ? 0 : toNumber(args[3]);
    const type = args[4] === undefined ? 0 : toNumber(args[4]);
    if (rate === 0) return -fv - pmt * nper;
    const pow = (1 + rate) ** nper;
    return -(fv + pmt * (1 + rate * type) * (pow - 1) / rate) / pow;
  },
  NPER: (args) => {
    const rate = toNumber(args[0]);
    const pmt = toNumber(args[1]);
    const pv = toNumber(args[2]);
    const fv = args[3] === undefined ? 0 : toNumber(args[3]);
    const type = args[4] === undefined ? 0 : toNumber(args[4]);
    if (rate === 0) return -(pv + fv) / pmt;
    const payment = pmt * (1 + rate * type);
    return Math.log((payment - fv * rate) / (payment + pv * rate)) / Math.log(1 + rate);
  },
  RATE: (args) => {
    const nper = toNumber(args[0]);
    const pmt = toNumber(args[1]);
    const pv = toNumber(args[2]);
    const fv = args[3] === undefined ? 0 : toNumber(args[3]);
    let rate = args[5] === undefined ? 0.1 : toNumber(args[5]);
    for (let i = 0; i < 128; i += 1) {
      const pow = (1 + rate) ** nper;
      const f = pv * pow + pmt * (pow - 1) / rate + fv;
      const df = nper * pv * (1 + rate) ** (nper - 1) + pmt * ((nper * (1 + rate) ** (nper - 1)) * rate - (pow - 1)) / (rate * rate);
      const next = rate - f / df;
      if (!Number.isFinite(next)) return error(ERR.NUM);
      if (Math.abs(next - rate) < 1e-9) return next;
      rate = next;
    }
    return rate;
  },
  NPV: (args) => {
    const rate = toNumber(args[0]);
    const values = numbers(args.slice(1));
    return values.reduce((acc, value, index) => acc + value / (1 + rate) ** (index + 1), 0);
  },
  IRR: (args) => {
    const values = numbers(args);
    if (!values.length || !values.some((v) => v > 0) || !values.some((v) => v < 0)) return error(ERR.NUM);
    let rate = 0.1;
    for (let i = 0; i < 200; i += 1) {
      let npv = 0;
      let derivative = 0;
      values.forEach((value, index) => {
        npv += value / (1 + rate) ** index;
        if (index > 0) derivative -= (index * value) / (1 + rate) ** (index + 1);
      });
      if (Math.abs(npv) < 1e-9) return rate;
      const next = rate - npv / derivative;
      if (!Number.isFinite(next)) break;
      rate = next;
    }
    return error(ERR.NUM, 'IRR 未收敛');
  },
  SLN: (args) => {
    const cost = toNumber(args[0]);
    const salvage = toNumber(args[1]);
    const life = toNumber(args[2]);
    if (isError(life) || life === 0) return error(ERR.DIV0);
    return (cost - salvage) / life;
  },
  SYD: (args) => {
    const cost = toNumber(args[0]);
    const salvage = toNumber(args[1]);
    const life = toNumber(args[2]);
    const period = toNumber(args[3]);
    return ((cost - salvage) * (life - period + 1) * 2) / (life * (life + 1));
  },
};

/* ------------------------------------------------------------------ *
 * 进制转换
 * ------------------------------------------------------------------ */
const ENGINEERING = {
  DEC2BIN: (args) => toBase(toNumber(args[0]), 2),
  DEC2OCT: (args) => toBase(toNumber(args[0]), 8),
  DEC2HEX: (args) => toBase(toNumber(args[0]), 16),
  BIN2DEC: (args) => fromBase(toText(firstValue(args)), 2),
  OCT2DEC: (args) => fromBase(toText(firstValue(args)), 8),
  HEX2DEC: (args) => fromBase(toText(firstValue(args)), 16),
  BITAND: (args) => bitOp(args, (a, b) => a & b),
  BITOR: (args) => bitOp(args, (a, b) => a | b),
  BITXOR: (args) => bitOp(args, (a, b) => a ^ b),
  BITLSHIFT: (args) => bitOp(args, (a, b) => a * 2 ** b),
  BITRSHIFT: (args) => bitOp(args, (a, b) => Math.floor(a / 2 ** b)),
};

function toBase(value, base) {
  if (isError(value)) return value;
  const n = Math.trunc(value);
  if (base === 2 && (n > 511 || n < -512)) return error(ERR.NUM);
  return (n < 0 ? '-' : '') + Math.abs(n).toString(base).toUpperCase();
}

function fromBase(text, base) {
  const n = parseInt(String(text || '0').replace(/^-/, ''), base);
  if (Number.isNaN(n)) return error(ERR.NUM);
  return String(text).startsWith('-') ? -n : n;
}

function bitOp(args, op) {
  const a = toNumber(args[0]);
  const b = toNumber(args[1]);
  if (isError(a) || isError(b)) return error(ERR.VALUE);
  const result = op(Math.trunc(a), Math.trunc(b));
  return Number.isFinite(result) ? result : error(ERR.NUM);
}

/* ------------------------------------------------------------------ *
 * 逻辑（惰性求值，支持短路）
 * ------------------------------------------------------------------ */
const LOGIC = {
  TRUE: () => true,
  FALSE: () => false,
  IF: {
    lazy: true,
    fn: (nodes, ctx) => {
      const condition = toBool(ctx.eval(nodes[0]));
      if (isError(condition)) return condition;
      if (condition) return nodes[1] === undefined ? true : ctx.eval(nodes[1]);
      return nodes[2] === undefined ? false : ctx.eval(nodes[2]);
    },
  },
  IFS: {
    lazy: true,
    min: 2,
    fn: (nodes, ctx) => {
      for (let i = 0; i + 1 < nodes.length; i += 2) {
        const condition = toBool(ctx.eval(nodes[i]));
        if (isError(condition)) return condition;
        if (condition) return ctx.eval(nodes[i + 1]);
      }
      return error(ERR.NA, '没有条件命中');
    },
  },
  IFERROR: {
    lazy: true,
    fn: (nodes, ctx) => {
      const value = ctx.eval(nodes[0]);
      if (!isError(value)) return value;
      return nodes[1] === undefined ? '' : ctx.eval(nodes[1]);
    },
  },
  IFNA: {
    lazy: true,
    fn: (nodes, ctx) => {
      const value = ctx.eval(nodes[0]);
      if (isError(value) && value.code === ERR.NA) return nodes[1] === undefined ? '' : ctx.eval(nodes[1]);
      return value;
    },
  },
  AND: {
    lazy: true,
    fn: (nodes, ctx) => {
      let sawValue = false;
      for (const node of nodes) {
        const value = ctx.eval(node);
        for (const item of flattenArgs([value])) {
          if (isError(item)) return item;
          if (isBlank(item) || typeof item === 'string') continue;
          sawValue = true;
          if (!toBool(item)) return false;
        }
      }
      return sawValue ? true : error(ERR.VALUE, '缺少逻辑值');
    },
  },
  OR: {
    lazy: true,
    fn: (nodes, ctx) => {
      let sawValue = false;
      for (const node of nodes) {
        const value = ctx.eval(node);
        for (const item of flattenArgs([value])) {
          if (isError(item)) return item;
          if (isBlank(item) || typeof item === 'string') continue;
          sawValue = true;
          if (toBool(item)) return true;
        }
      }
      return sawValue ? false : error(ERR.VALUE, '缺少逻辑值');
    },
  },
  XOR: {
    lazy: true,
    fn: (nodes, ctx) => {
      let count = 0;
      let sawValue = false;
      for (const node of nodes) {
        for (const item of flattenArgs([ctx.eval(node)])) {
          if (isError(item)) return item;
          if (isBlank(item) || typeof item === 'string') continue;
          sawValue = true;
          if (toBool(item)) count += 1;
        }
      }
      return sawValue ? count % 2 === 1 : error(ERR.VALUE);
    },
  },
  NOT: (args) => {
    const value = toBool(firstValue(args));
    return isError(value) ? value : !value;
  },
  SWITCH: {
    lazy: true,
    fn: (nodes, ctx) => {
      const target = ctx.eval(nodes[0]);
      for (let i = 1; i + 1 < nodes.length; i += 2) {
        if (equals(target, ctx.eval(nodes[i]))) return ctx.eval(nodes[i + 1]);
      }
      if ((nodes.length - 1) % 2 === 1) return ctx.eval(nodes[nodes.length - 1]);
      return error(ERR.NA, '没有匹配分支');
    },
  },
  CHOOSE: {
    lazy: true,
    fn: (nodes, ctx) => {
      const index = Math.trunc(toNumber(ctx.eval(nodes[0])));
      if (isError(index)) return index;
      if (index < 1 || index > nodes.length - 1) return error(ERR.VALUE);
      return ctx.eval(nodes[index]);
    },
  },
};

/* ------------------------------------------------------------------ *
 * 查找与引用
 * ------------------------------------------------------------------ */
const LOOKUP = {
  ROW: {
    lazy: true,
    fn: (nodes, ctx) => {
      if (!nodes.length) return (ctx.currentRef?.r ?? 0) + 1;
      const ref = ctx.getRef(nodes[0]);
      if (isError(ref)) return ref;
      return ref ? ref.r + 1 : error(ERR.VALUE);
    },
  },
  COLUMN: {
    lazy: true,
    fn: (nodes, ctx) => {
      if (!nodes.length) return (ctx.currentRef?.c ?? 0) + 1;
      const ref = ctx.getRef(nodes[0]);
      if (isError(ref)) return ref;
      return ref ? ref.c + 1 : error(ERR.VALUE);
    },
  },
  ROWS: (args) => {
    const range = args[0];
    if (isRange(range)) return range.rows;
    if (Array.isArray(range)) return range.length;
    return 1;
  },
  COLUMNS: (args) => {
    const range = args[0];
    if (isRange(range)) return range.cols;
    if (Array.isArray(range) && Array.isArray(range[0])) return range[0].length;
    if (Array.isArray(range)) return range.length;
    return 1;
  },
  INDEX: {
    lazy: true,
    fn: (nodes, ctx) => {
      const range = ctx.getRange(nodes[0]);
      if (isError(range)) return range;
      const rowIndex = nodes[1] === undefined ? 1 : Math.trunc(toNumber(ctx.eval(nodes[1])));
      const colIndex = nodes[2] === undefined ? 1 : Math.trunc(toNumber(ctx.eval(nodes[2])));
      if (isError(rowIndex) || isError(colIndex)) return error(ERR.VALUE);
      if (!range) return error(ERR.REF);
      const r = rowIndex === 0 ? 0 : rowIndex - 1;
      const c = colIndex === 0 ? 0 : colIndex - 1;
      if (rowIndex === 0 && colIndex === 0) return range;
      if (rowIndex === 0) {
        const column = [];
        for (let i = 0; i < range.rows; i += 1) column.push([range.at(i, c)]);
        return new RangeValue(column, range.ref);
      }
      if (colIndex === 0) return new RangeValue([range.values[r] || []], range.ref);
      if (r < 0 || r >= range.rows || c < 0 || c >= range.cols) return error(ERR.REF);
      return range.at(r, c);
    },
  },
  MATCH: {
    lazy: true,
    fn: (nodes, ctx) => {
      const target = ctx.eval(nodes[0]);
      const range = ctx.getRange(nodes[1]);
      const mode = nodes[2] === undefined ? 1 : Math.trunc(toNumber(ctx.eval(nodes[2])));
      if (!range) return error(ERR.NA);
      const cells = range.flat();
      if (mode === 0) {
        for (let i = 0; i < cells.length; i += 1) if (equals(cells[i], target)) return i + 1;
        return error(ERR.NA);
      }
      const ascending = range.rows >= range.cols;
      let best = -1;
      for (let i = 0; i < cells.length; i += 1) {
        const cmp = compare(cells[i], target);
        if (mode === 1 ? cmp <= 0 : cmp >= 0) best = i;
      }
      return best === -1 ? error(ERR.NA) : best + 1;
    },
  },
  VLOOKUP: {
    lazy: true,
    fn: (nodes, ctx) => {
      const target = ctx.eval(nodes[0]);
      const range = ctx.getRange(nodes[1]);
      const colIndex = Math.trunc(toNumber(ctx.eval(nodes[2])));
      const approx = nodes[3] === undefined ? true : toBool(ctx.eval(nodes[3]));
      if (!range) return error(ERR.NA);
      if (colIndex < 1 || colIndex > range.cols) return error(ERR.REF);
      let foundRow = -1;
      if (approx === true) {
        for (let r = 0; r < range.rows; r += 1) if (compare(range.at(r, 0), target) <= 0) foundRow = r;
        if (foundRow === -1) return error(ERR.NA);
      } else {
        for (let r = 0; r < range.rows; r += 1) {
          if (equals(range.at(r, 0), target)) {
            foundRow = r;
            break;
          }
        }
        if (foundRow === -1) return error(ERR.NA);
      }
      return range.at(foundRow, colIndex - 1);
    },
  },
  HLOOKUP: {
    lazy: true,
    fn: (nodes, ctx) => {
      const target = ctx.eval(nodes[0]);
      const range = ctx.getRange(nodes[1]);
      const rowIndex = Math.trunc(toNumber(ctx.eval(nodes[2])));
      const approx = nodes[3] === undefined ? true : toBool(ctx.eval(nodes[3]));
      if (!range) return error(ERR.NA);
      if (rowIndex < 1 || rowIndex > range.rows) return error(ERR.REF);
      let foundCol = -1;
      if (approx === true) {
        for (let c = 0; c < range.cols; c += 1) if (compare(range.at(0, c), target) <= 0) foundCol = c;
      } else {
        for (let c = 0; c < range.cols; c += 1) {
          if (equals(range.at(0, c), target)) {
            foundCol = c;
            break;
          }
        }
      }
      if (foundCol === -1) return error(ERR.NA);
      return range.at(rowIndex - 1, foundCol);
    },
  },
  XLOOKUP: {
    lazy: true,
    fn: (nodes, ctx) => {
      const target = ctx.eval(nodes[0]);
      const lookupRange = ctx.getRange(nodes[1]);
      const returnRange = ctx.getRange(nodes[2]);
      const notFound = nodes[3] === undefined ? error(ERR.NA) : ctx.eval(nodes[3]);
      const matchMode = nodes[4] === undefined ? 0 : Math.trunc(toNumber(ctx.eval(nodes[4])));
      if (!lookupRange || !returnRange) return error(ERR.NA);
      const lookup = lookupRange.flat();
      const results = returnRange.flat();
      let found = -1;
      for (let i = 0; i < lookup.length; i += 1) {
        if (equals(lookup[i], target)) {
          found = i;
          break;
        }
      }
      if (found === -1 && matchMode !== 0) {
        for (let i = 0; i < lookup.length; i += 1) {
          const cmp = compare(lookup[i], target);
          if (matchMode === -1 && cmp <= 0) found = i;
          if (matchMode === 1 && cmp >= 0) {
            found = i;
            break;
          }
        }
      }
      if (found === -1) return notFound;
      return results[found] ?? error(ERR.NA);
    },
  },
  OFFSET: {
    lazy: true,
    fn: (nodes, ctx) => {
      const base = ctx.getRef(nodes[0]);
      if (isError(base)) return base;
      if (!base) return error(ERR.REF);
      const rows = Math.trunc(toNumber(ctx.eval(nodes[1])));
      const cols = Math.trunc(toNumber(ctx.eval(nodes[2])));
      const height = nodes[3] === undefined ? (base.to ? base.to.r - base.r + 1 : 1) : Math.trunc(toNumber(ctx.eval(nodes[3])));
      const width = nodes[4] === undefined ? (base.to ? base.to.c - base.c + 1 : 1) : Math.trunc(toNumber(ctx.eval(nodes[4])));
      if ([rows, cols, height, width].some((value) => isError(value)) || height < 1 || width < 1) return error(ERR.REF);
      const from = { r: base.r + rows, c: base.c + cols };
      const to = { r: from.r + height - 1, c: from.c + width - 1 };
      if (from.r < 0 || from.c < 0) return error(ERR.REF);
      const range = ctx.buildRange(base.sheet, from, to);
      // 1×1 结果在标量语境下直接取值，与 Excel 一致
      if (height === 1 && width === 1) return range.at(0, 0);
      return range;
    },
  },
  INDIRECT: {
    lazy: true,
    fn: (nodes, ctx) => {
      const text = toText(ctx.eval(nodes[0]));
      const resolved = ctx.resolve(text);
      return resolved === undefined ? error(ERR.REF) : resolved;
    },
  },
  ADDRESS: (args) => {
    const row = Math.trunc(toNumber(args[0]));
    const col = Math.trunc(toNumber(args[1]));
    const absType = args[2] === undefined ? 1 : Math.trunc(toNumber(args[2]));
    const sheet = args[4] === undefined ? null : toText(args[4]);
    if (row < 1 || col < 1) return error(ERR.VALUE);
    const ref = {
      r: row - 1,
      c: col - 1,
      absR: absType === 1 || absType === 2,
      absC: absType === 1 || absType === 3,
    };
    const text = formatA1(ref);
    return sheet ? `${sheet}!${text}` : text;
  },
  COLUMN_LETTER: (args) => colToLabel(Math.trunc(toNumber(args[0])) - 1),
  AREAS: () => 1,
  TRANSPOSE: (args) => {
    const range = args[0];
    const matrix = isRange(range) ? range.values : Array.isArray(range) ? range : [[range]];
    const rows = matrix.length;
    const cols = matrix[0]?.length || 0;
    const out = [];
    for (let c = 0; c < cols; c += 1) {
      const row = [];
      for (let r = 0; r < rows; r += 1) row.push(matrix[r][c]);
      out.push(row);
    }
    return new RangeValue(out);
  },
};

/* ------------------------------------------------------------------ *
 * 动态数组
 * ------------------------------------------------------------------ */
const ARRAY = {
  SEQUENCE: (args) => {
    const rows = Math.max(1, Math.trunc(toNumber(args[0])));
    const cols = args[1] === undefined ? 1 : Math.max(1, Math.trunc(toNumber(args[1])));
    const start = args[2] === undefined ? 1 : toNumber(args[2]);
    const step = args[3] === undefined ? 1 : toNumber(args[3]);
    if ([rows, cols, start, step].some((value) => isError(value))) return error(ERR.VALUE);
    if (rows * cols > 100000) return error(ERR.NUM, '结果过大');
    const out = [];
    let counter = 0;
    for (let r = 0; r < rows; r += 1) {
      const row = [];
      for (let c = 0; c < cols; c += 1) {
        row.push(start + step * counter);
        counter += 1;
      }
      out.push(row);
    }
    return new RangeValue(out);
  },
  UNIQUE: (args) => {
    const range = args[0];
    const matrix = isRange(range) ? range.values : Array.isArray(range) ? range : [[range]];
    const byColumn = args[1] === undefined ? false : toBool(args[1]) === true;
    const exactlyOnce = args[2] === undefined ? false : toBool(args[2]) === true;
    const total = matrix.flat().length;
    const counts = new Map();
    for (const cell of matrix.flat()) counts.set(JSON.stringify(cell ?? null), (counts.get(JSON.stringify(cell ?? null)) || 0) + 1);
    const seen = new Set();
    const keep = (value) => {
      const key = JSON.stringify(value ?? null);
      if (exactlyOnce) return counts.get(key) === 1;
      return true;
    };
    const out = [];
    if (!byColumn) {
      const cols = matrix[0]?.length || 0;
      for (let r = 0; r < matrix.length; r += 1) {
        const key = JSON.stringify(matrix[r].map((v) => v ?? null));
        if (seen.has(key) || !matrix[r].every(keep)) continue;
        seen.add(key);
        out.push([...matrix[r]]);
      }
      if (!out.length) out.push([error(ERR.NA)]);
      return new RangeValue(out);
    }
    const cols = matrix[0]?.length || 0;
    for (let c = 0; c < cols; c += 1) {
      const column = matrix.map((row) => row[c]);
      const key = JSON.stringify(column.map((v) => v ?? null));
      if (seen.has(key) || !column.every(keep)) continue;
      seen.add(key);
      out.push([column]);
    }
    if (!out.length) return new RangeValue([[error(ERR.NA)]]);
    const transposed = out[0].length;
    const result = [];
    for (let r = 0; r < transposed; r += 1) result.push(out.map((column) => column[r]));
    return new RangeValue(result);
  },
  SORT: (args) => {
    const range = args[0];
    const matrix = (isRange(range) ? range.values : Array.isArray(range) ? range : [[range]]).map((row) => [...row]);
    const index = args[1] === undefined ? 1 : Math.trunc(toNumber(args[1]));
    const order = args[2] === undefined ? 1 : Math.trunc(toNumber(args[2]));
    if (!matrix.length) return error(ERR.NA);
    const sorted = [...matrix].sort((a, b) => compare(a[index - 1], b[index - 1]) * (order === -1 ? -1 : 1));
    return new RangeValue(sorted);
  },
  FILTER: {
    lazy: true,
    fn: (nodes, ctx) => {
      const range = ctx.getRange(nodes[0]);
      const includeValue = ctx.eval(nodes[1]);
      const ifEmpty = nodes[2] === undefined ? error(ERR.NA) : ctx.eval(nodes[2]);
      if (!range) return error(ERR.VALUE);
      const flags = flattenArgs([includeValue]);
      const out = [];
      if (range.rows === flags.length) {
        for (let r = 0; r < range.rows; r += 1) if (toBool(flags[r]) === true) out.push([...range.values[r]]);
      } else if (range.cols === flags.length) {
        const keepCols = [];
        for (let c = 0; c < range.cols; c += 1) if (toBool(flags[c]) === true) keepCols.push(c);
        for (let r = 0; r < range.rows; r += 1) out.push(keepCols.map((c) => range.at(r, c)));
      } else {
        return error(ERR.VALUE, '筛选条件尺寸不匹配');
      }
      if (!out.length) return ifEmpty;
      return new RangeValue(out);
    },
  },
  COUNTUNIQUE: (args) => new Set(flattenArgs(args).map((value) => JSON.stringify(value ?? null))).size,
  FREQUENCY: (args) => {
    const data = numbers([args[0]]);
    const bins = numbers([args[1]]).sort((a, b) => a - b);
    const out = bins.map(() => 0);
    out.push(0);
    for (const value of data) {
      let placed = false;
      for (let i = 0; i < bins.length; i += 1) {
        if (value <= bins[i]) {
          out[i] += 1;
          placed = true;
          break;
        }
      }
      if (!placed) out[out.length - 1] += 1;
    }
    return new RangeValue(out.map((count) => [count]));
  },
};

/* ------------------------------------------------------------------ *
 * 信息
 * ------------------------------------------------------------------ */
const INFO = {
  ISBLANK: (args) => isBlank(firstValue(args)) || firstValue(args) === '',
  ISERROR: (args) => isError(evalSingle(args)),
  ISERR: (args) => isError(evalSingle(args)) && evalSingle(args).code !== ERR.NA,
  ISNA: (args) => isError(evalSingle(args)) && evalSingle(args).code === ERR.NA,
  ISNUMBER: (args) => typeof firstValue(args) === 'number',
  ISTEXT: (args) => typeof firstValue(args) === 'string',
  ISNONTEXT: (args) => typeof firstValue(args) !== 'string',
  ISLOGICAL: (args) => typeof firstValue(args) === 'boolean',
  ISEVEN: (args) => {
    const value = toNumber(args[0]);
    return isError(value) ? value : Math.abs(value) % 2 === 0;
  },
  ISODD: (args) => {
    const value = toNumber(args[0]);
    return isError(value) ? value : Math.abs(value) % 2 === 1;
  },
  ISREF: (args) => isRange(args[0]) || !isBlank(firstValue(args)),
  NA: () => error(ERR.NA),
  TYPE: (args) => {
    const value = firstValue(args);
    if (typeof value === 'number') return 1;
    if (typeof value === 'string') return 2;
    if (typeof value === 'boolean') return 4;
    if (isError(value)) return 16;
    return 1;
  },
  ERROR_TYPE: (args) => {
    const value = evalSingle(args);
    if (!isError(value)) return error(ERR.NA);
    return ({ [ERR.NULL]: 1, [ERR.DIV0]: 2, [ERR.VALUE]: 3, [ERR.REF]: 4, [ERR.NAME]: 5, [ERR.NUM]: 6, [ERR.NA]: 7 })[value.code] ?? error(ERR.NA);
  },
  SHEET: (args, ctx) => ctx.sheetNames().indexOf(ctx.sheetName) + 1,
  SHEETS: (args, ctx) => ctx.sheetNames().length,
};

function evalSingle(args) {
  const value = args[0];
  if (isRange(value)) return value.flat().find((cell) => !isBlank(cell)) ?? null;
  return value;
}

/* ------------------------------------------------------------------ *
 * 汇总注册表
 * ------------------------------------------------------------------ */
/** 每个函数支持的最大参数数量 */
const MAX_ARGS = 255;
const MIN_ONE = 1;

/** 由分类对象生成统一注册表 */
function buildRegistry() {
  const registry = {};
  const groups = [MATH, STAT, TEXT, DATE, FINANCE, ENGINEERING, LOGIC, LOOKUP, ARRAY, INFO];
  for (const group of groups) {
    for (const [name, entry] of Object.entries(group)) {
      const def = entry;
      const isLazy = Boolean(def.lazy);
      const fn = isLazy ? def.fn : (typeof def === 'function' ? def : def.fn);
      const min = def.min ?? (isLazy ? 1 : MIN_ONE);
      const max = def.max ?? MAX_ARGS;
      registry[name] = { name, fn, lazy: isLazy, min, max };
    }
  }
  // 常用别名
  const alias = {
    AVG: 'AVERAGE',
    STDEV_S: 'STDEV',
    STDEV_P: 'STDEVP',
    VAR_S: 'VAR',
    VAR_P: 'VARP',
    LENB: 'LEN',
    CEILING_MATH: 'CEILING',
    FLOOR_MATH: 'FLOOR',
    RANK_EQ: 'RANK',
    CONCATENATE: 'CONCATENATE',
    'ERROR.TYPE': 'ERROR_TYPE',
    'NORM.DIST': 'NORMDIST',
  };
  for (const [aliasName, target] of Object.entries(alias)) {
    if (registry[target] && !registry[aliasName]) registry[aliasName] = { ...registry[target], name: aliasName };
  }
  // 缺省值修正：这些函数允许 0 参数
  for (const name of ['TODAY', 'NOW', 'PI', 'RAND', 'NA', 'TRUE', 'FALSE', 'AREAS', 'SHEET', 'SHEETS']) {
    if (registry[name]) registry[name].min = 0;
  }
  return registry;
}

/** 公式函数注册表 */
export const FUNCTIONS = buildRegistry();

/** 函数名列表（大小写不敏感），供自动补全与帮助面板使用 */
export function functionNames() {
  return Object.keys(FUNCTIONS).sort();
}

/** 按分类列出函数（帮助面板用） */
export function functionCatalog() {
  return [
    { key: 'math', names: Object.keys(MATH).concat(Object.keys(STAT)).sort() },
    { key: 'text', names: Object.keys(TEXT).sort() },
    { key: 'date', names: Object.keys(DATE).sort() },
    { key: 'lookup', names: Object.keys(LOOKUP).sort() },
    { key: 'logical', names: Object.keys(LOGIC).sort() },
    { key: 'array', names: Object.keys(ARRAY).sort() },
    { key: 'finance', names: Object.keys(FINANCE).sort() },
    { key: 'engineering', names: Object.keys(ENGINEERING).sort() },
    { key: 'info', names: Object.keys(INFO).sort() },
  ];
}
