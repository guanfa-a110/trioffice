/**
 * formula.js —— 公式的词法分析、语法分析与求值。
 *
 * 支持：
 *   - 字面量：数字、字符串（"" 转义）、TRUE/FALSE、错误常量（#N/A 等）、数组常量 {1,2;3,4}
 *   - 引用：A1、$A$1、A1:B9、$A:$B（整列）、Sheet2!A1、'我的 表'!A1:A9
 *   - 运算：+ - * / ^ & = <> < > <= >= % 以及一元正负
 *   - 函数：见 functions.js（202 个）
 *
 * 纯逻辑模块，无 DOM 依赖；宿主（workbook）负责记忆化与循环引用检测。
 */
import { ERR, RangeValue, error, isError, toNumber, toText, compare, isRange, isBlank } from './value.js';
import { parseA1, formatA1 } from './address.js';
import { FUNCTIONS } from './functions.js';

/** 语法错误 */
export class FormulaSyntaxError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'FormulaSyntaxError';
    this.position = position;
  }
}

const OPERATORS = new Set(['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>', '<=', '>=']);
const ERROR_LITERALS = new Set(['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#NULL!', '#CIRC!', '#GETTING_DATA']);

const REF_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![A-Za-z0-9_])/;
const NAME_RE = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5]*)/;

/* ------------------------------------------------------------------ *
 * 词法分析
 * ------------------------------------------------------------------ */
/**
 * @param {string} text 公式正文（不含前导 =）
 * @returns {Array<{type: string, value?: any}>}
 */
export function tokenize(text) {
  const source = String(text ?? '');
  const tokens = [];
  let i = 0;

  const push = (type, value) => tokens.push({ type, value, start: i });

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const match = /^(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      push('num', Number(match[0]));
      i += match[0].length;
      continue;
    }

    // 字符串字面量
    if (ch === '"') {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += source[j];
        j += 1;
      }
      if (!closed) throw new FormulaSyntaxError('字符串缺少结束引号', i);
      push('str', value);
      i = j;
      continue;
    }

    // 表名（单引号包裹）
    if (ch === "'") {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        if (source[j] === "'") {
          if (source[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += source[j];
        j += 1;
      }
      if (!closed) throw new FormulaSyntaxError('表名缺少结束引号', i);
      push('sheet', value);
      i = j;
      continue;
    }

    // 错误常量
    if (ch === '#') {
      const match = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|NULL!|CIRC!|GETTING_DATA)/i.exec(source.slice(i));
      if (match) {
        push('err', match[0].toUpperCase());
        i += match[0].length;
        continue;
      }
      throw new FormulaSyntaxError('无法识别的错误常量', i);
    }

    // 引用 / 名称
    if (/[A-Za-z_$\u4e00-\u9fa5]/.test(ch)) {
      const rest = source.slice(i);
      const refMatch = REF_RE.exec(rest);
      if (refMatch) {
        push('ref', { text: refMatch[0], ...parseA1(refMatch[0]) });
        i += refMatch[0].length;
        continue;
      }
      const nameMatch = NAME_RE.exec(rest);
      if (!nameMatch) throw new FormulaSyntaxError(`无法识别的字符 "${ch}"`, i);
      push('name', nameMatch[1]);
      i += nameMatch[1].length;
      continue;
    }

    // 双字符运算符
    const two = source.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      push('op', two);
      i += 2;
      continue;
    }

    if ('+-*/^&=<>'.includes(ch)) {
      push('op', ch);
      i += 1;
      continue;
    }
    if (ch === '%') {
      push('percent', '%');
      i += 1;
      continue;
    }
    if (ch === '(') {
      push('lparen', ch);
      i += 1;
      continue;
    }
    if (ch === ')') {
      push('rparen', ch);
      i += 1;
      continue;
    }
    if (ch === ',') {
      push('comma', ch);
      i += 1;
      continue;
    }
    if (ch === ';') {
      push('semicolon', ch);
      i += 1;
      continue;
    }
    if (ch === ':') {
      push('colon', ch);
      i += 1;
      continue;
    }
    if (ch === '!') {
      push('bang', ch);
      i += 1;
      continue;
    }
    if (ch === '{') {
      push('lbrace', ch);
      i += 1;
      continue;
    }
    if (ch === '}') {
      push('rbrace', ch);
      i += 1;
      continue;
    }
    throw new FormulaSyntaxError(`无法识别的字符 "${ch}"`, i);
  }

  tokens.push({ type: 'eof', start: source.length });
  return tokens;
}

/* ------------------------------------------------------------------ *
 * 语法分析
 * ------------------------------------------------------------------ */
/**
 * 把公式解析成 AST。
 * @param {string} text 公式正文（可带前导 =）
 */
export function parse(text) {
  const source = String(text ?? '').replace(/^=/, '');
  if (!source.trim()) throw new FormulaSyntaxError('公式为空', 0);
  const tokens = tokenize(source);
  let pos = 0;

  const peek = (offset = 0) => tokens[pos + offset] || { type: 'eof' };
  const next = () => tokens[pos++];
  const expect = (type, message) => {
    const token = peek();
    if (token.type !== type) throw new FormulaSyntaxError(message || `缺少 ${type}`, token.start);
    return next();
  };
  const isOp = (value, offset = 0) => {
    const token = peek(offset);
    return token.type === 'op' && token.value === value;
  };

  function parseExpression() {
    return parseComparison();
  }

  function parseComparison() {
    let left = parseConcat();
    while (peek().type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().value)) {
      const op = next().value;
      left = { type: 'bin', op, left, right: parseConcat() };
    }
    return left;
  }

  function parseConcat() {
    let left = parseAdditive();
    while (isOp('&')) {
      next();
      left = { type: 'bin', op: '&', left, right: parseAdditive() };
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (isOp('+') || isOp('-')) {
      const op = next().value;
      left = { type: 'bin', op, left, right: parseMultiplicative() };
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parsePower();
    while (isOp('*') || isOp('/')) {
      const op = next().value;
      left = { type: 'bin', op, left, right: parsePower() };
    }
    return left;
  }

  function parsePower() {
    const left = parseUnary();
    if (isOp('^')) {
      next();
      return { type: 'bin', op: '^', left, right: parsePower() };
    }
    return left;
  }

  function parseUnary() {
    if (isOp('-') || isOp('+')) {
      const op = next().value;
      return { type: 'un', op, operand: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    while (peek().type === 'percent') {
      next();
      node = { type: 'post', op: '%', operand: node };
    }
    return node;
  }

  function parsePrimary() {
    const token = peek();

    if (token.type === 'num') {
      next();
      return { type: 'lit', value: token.value };
    }
    if (token.type === 'str') {
      next();
      return { type: 'lit', value: token.value };
    }
    if (token.type === 'err') {
      next();
      return { type: 'error', code: token.value };
    }
    if (token.type === 'lparen') {
      next();
      const inner = parseExpression();
      expect('rparen', '缺少右括号');
      return inner;
    }
    if (token.type === 'lbrace') {
      return parseArrayLiteral();
    }
    if (token.type === 'ref') {
      next();
      return parseRefTail(token.value, null);
    }
    if (token.type === 'sheet') {
      next();
      expect('bang', '表名后面需要 !');
      return parseQualifiedTail(token.value);
    }
    if (token.type === 'name') {
      return parseNameOrFunction();
    }
    throw new FormulaSyntaxError('公式语法错误', token.start);
  }

  function parseNameOrFunction() {
    const token = next();
    const upper = token.value.toUpperCase();

    if (peek().type === 'lparen') {
      next();
      const args = [];
      if (peek().type !== 'rparen') {
        args.push(parseExpression());
        while (peek().type === 'comma') {
          next();
          args.push(parseExpression());
        }
      }
      expect('rparen', `函数 ${upper} 缺少右括号`);
      return { type: 'call', name: upper, args };
    }

    if (upper === 'TRUE' || upper === 'FALSE') return { type: 'lit', value: upper === 'TRUE' };

    if (peek().type === 'bang') {
      next();
      return parseQualifiedTail(token.value);
    }

    // 整列引用 A:B
    if (peek().type === 'colon') {
      next();
      const end = peek();
      if (end.type === 'name' || end.type === 'ref') {
        next();
        const label = end.type === 'ref' ? formatA1ColOnly(end.value) : end.value;
        return { type: 'rangeCol', sheet: null, from: token.value, to: label };
      }
      throw new FormulaSyntaxError('整列引用格式错误', end.start);
    }

    return { type: 'name', name: upper };
  }

  function formatA1ColOnly(ref) {
    return `${ref.text.replace(/\d+$/, '')}`;
  }

  /** 解析表名限定后的引用：Sheet1!A1、Sheet1!A:A */
  function parseQualifiedTail(sheetName) {
    const token = peek();
    if (token.type === 'ref') {
      next();
      return parseRefTail(token.value, sheetName);
    }
    if (token.type === 'name') {
      next();
      if (peek().type === 'colon') {
        next();
        const end = expect('name', '整列引用格式错误');
        return { type: 'rangeCol', sheet: sheetName, from: token.value, to: end.value };
      }
      throw new FormulaSyntaxError('表名后面需要单元格引用', token.start);
    }
    throw new FormulaSyntaxError('表名后面需要单元格引用', token.start);
  }

  /** 解析 A1 之后的 :B2 部分 */
  function parseRefTail(ref, sheetName) {
    let node = { type: 'ref', sheet: sheetName, r: ref.r, c: ref.c, absR: ref.absR, absC: ref.absC };
    if (peek().type === 'colon') {
      next();
      const end = peek();
      if (end.type === 'ref') {
        next();
        return {
          type: 'range',
          sheet: sheetName,
          from: { r: ref.r, c: ref.c, absR: ref.absR, absC: ref.absC },
          to: { r: end.value.r, c: end.value.c, absR: end.value.absR, absC: end.value.absC },
        };
      }
      if (end.type === 'name') {
        next();
        return { type: 'rangeCol', sheet: sheetName, from: formatA1ColOnly(ref), to: end.value };
      }
      throw new FormulaSyntaxError('区域引用格式错误', end.start);
    }
    return node;
  }

  function parseArrayLiteral() {
    expect('lbrace');
    const rows = [];
    let current = [];
    for (;;) {
      const token = peek();
      if (token.type === 'rbrace') {
        next();
        if (current.length) rows.push(current);
        break;
      }
      if (token.type === 'semicolon') {
        next();
        rows.push(current);
        current = [];
        continue;
      }
      if (token.type === 'comma') {
        next();
        continue;
      }
      current.push(parseExpression());
      if (peek().type === 'eof') throw new FormulaSyntaxError('数组常量缺少 }', token.start);
    }
    if (!rows.length) throw new FormulaSyntaxError('数组常量不能为空', 0);
    return { type: 'array', rows };
  }

  const ast = parseExpression();
  if (peek().type !== 'eof') throw new FormulaSyntaxError('公式末尾有多余内容', peek().start);
  return ast;
}

/* ------------------------------------------------------------------ *
 * 求值
 * ------------------------------------------------------------------ */
/**
 * 求值上下文（由 workbook 提供）。
 * @typedef {{
 *   sheetName: string,
 *   currentRef: {r: number, c: number},
 *   getValue: (sheet: string|null, r: number, c: number) => any,
 *   buildRange: (sheet: string|null, from: any, to: any) => any,
 *   buildColumnRange: (sheet: string|null, from: string, to: string) => any,
 *   sheetNames: () => string[],
 *   resolveText?: (text: string) => any
 * }} EvalContext
 */

const evaluatorCache = new WeakMap();

/** 为上下文包装出带 eval/getRange/getRef 的能力 */
function makeHelpers(ctx) {
  let helpers = evaluatorCache.get(ctx);
  if (helpers) return helpers;

  const evaluator = {
    get sheetName() {
      return ctx.sheetName;
    },
    get currentRef() {
      return ctx.currentRef;
    },
    setRef(ref) {
      ctx.currentRef = ref;
    },
    eval(node) {
      return evalNode(node, ctx, evaluator);
    },
    getRange(node) {
      const value = evalNode(node, ctx, evaluator);
      return value;
    },
    getRef(node) {
      return refOf(node, ctx);
    },
    resolve(text) {
      if (ctx.resolveText) return ctx.resolveText(text);
      return undefined;
    },
    buildRange(sheet, from, to) {
      return ctx.buildRange(sheet, from, to);
    },
    sheetNames() {
      return ctx.sheetNames();
    },
  };
  evaluatorCache.set(ctx, evaluator);
  return evaluator;
}

/** 从节点取出引用信息（用于 ROW/COLUMN/OFFSET） */
function refOf(node, ctx) {
  if (!node) return null;
  if (node.type === 'ref') {
    if (node.sheet && !ctx.sheetNames().includes(node.sheet)) return error(ERR.REF, `工作表 ${node.sheet} 不存在`);
    return { sheet: node.sheet, r: node.r, c: node.c, to: { r: node.r, c: node.c } };
  }
  if (node.type === 'range') {
    if (node.sheet && !ctx.sheetNames().includes(node.sheet)) return error(ERR.REF, `工作表 ${node.sheet} 不存在`);
    return { sheet: node.sheet, r: Math.min(node.from.r, node.to.r), c: Math.min(node.from.c, node.to.c), to: { r: Math.max(node.from.r, node.to.r), c: Math.max(node.from.c, node.to.c) } };
  }
  return null;
}

/** 求值单个 AST 节点 */
function evalNode(node, ctx, evaluator) {
  switch (node.type) {
    case 'lit':
      return node.value;
    case 'error':
      return error(node.code);
    case 'name':
      return error(ERR.NAME, `未定义的名称 ${node.name}`);
    case 'ref': {
      if (node.sheet && !ctx.sheetNames().includes(node.sheet)) return error(ERR.REF, `工作表 ${node.sheet} 不存在`);
      if (node.r < 0 || node.c < 0) return error(ERR.REF);
      return ctx.getValue(node.sheet, node.r, node.c);
    }
    case 'range': {
      if (node.sheet && !ctx.sheetNames().includes(node.sheet)) return error(ERR.REF, `工作表 ${node.sheet} 不存在`);
      return ctx.buildRange(node.sheet, node.from, node.to);
    }
    case 'rangeCol':
      return ctx.buildColumnRange(node.sheet, node.from, node.to);
    case 'array': {
      const rows = node.rows.map((row) => row.map((cell) => evaluator.eval(cell)));
      return new RangeValue(rows);
    }
    case 'un': {
      const value = evaluator.eval(node.operand);
      if (isError(value)) return value;
      const number = toNumber(firstScalar(value));
      if (isError(number)) return number;
      return node.op === '-' ? -number : number;
    }
    case 'post': {
      const value = evaluator.eval(node.operand);
      if (isError(value)) return value;
      const number = toNumber(firstScalar(value));
      return isError(number) ? number : number / 100;
    }
    case 'bin':
      return evalBinary(node, ctx, evaluator);
    case 'call':
      return evalCall(node, ctx, evaluator);
    default:
      return error(ERR.VALUE, '未知的表达式类型');
  }
}

function firstScalar(value) {
  if (isRange(value)) {
    const cell = value.flat().find((item) => !isBlank(item));
    return cell === undefined ? null : cell;
  }
  return value;
}

function evalBinary(node, ctx, evaluator) {
  const left = evaluator.eval(node.left);
  const right = evaluator.eval(node.right);
  const op = node.op;

  if (op === '&') {
    if (isError(left)) return left;
    if (isError(right)) return right;
    return `${toText(firstScalar(left))}${toText(firstScalar(right))}`;
  }

  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    if (isError(left)) return left;
    if (isError(right)) return right;

    // 区域与标量比较时按元素展开（Excel 的数组语义），让 FILTER / AND / 数组条件可用
    const leftRange = isRange(left);
    const rightRange = isRange(right);
    if (leftRange || rightRange) {
      if (leftRange && rightRange && left.rows === right.rows && left.cols === right.cols) {
        const matrix = left.values.map((row, r) => row.map((cell, c) => compareOp(cell, right.at(r, c), op)));
        return new RangeValue(matrix, left.ref);
      }
      const range = leftRange ? left : right;
      const scalar = leftRange ? right : left;
      const matrix = range.values.map((row) => row.map((cell) => (leftRange
        ? compareOp(cell, firstScalar(scalar), op)
        : compareOp(firstScalar(scalar), cell, op))));
      return new RangeValue(matrix, range.ref);
    }

    return compareOp(firstScalar(left), firstScalar(right), op);
  }

  if (isError(left)) return left;
  if (isError(right)) return right;
  const a = toNumber(firstScalar(left));
  const b = toNumber(firstScalar(right));
  if (isError(a)) return a;
  if (isError(b)) return b;

  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      return b === 0 ? error(ERR.DIV0, '除数为 0') : a / b;
    case '^': {
      const result = a ** b;
      return Number.isFinite(result) ? result : error(ERR.NUM);
    }
    default:
      return error(ERR.VALUE, `未知运算符 ${op}`);
  }
}

/** 比较运算：返回布尔值；操作符非法时返回错误值 */
function compareOp(a, b, op) {
  const cmp = compare(a, b);
  switch (op) {
    case '=': return cmp === 0;
    case '<>': return cmp !== 0;
    case '<': return cmp < 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '>=': return cmp >= 0;
    default: return error(ERR.VALUE, `未知比较运算符 ${op}`);
  }
}

function evalCall(node, ctx, evaluator) {
  const def = FUNCTIONS[node.name] || FUNCTIONS[node.name.replace(/_/g, '.')] || FUNCTIONS[node.name.replace(/\./g, '_')];
  if (!def) return error(ERR.NAME, `未知函数 ${node.name}`);
  if (node.args.length < def.min || node.args.length > def.max) {
    return error(ERR.VALUE, `函数 ${node.name} 参数个数不正确`);
  }
  try {
    if (def.lazy) return def.fn(node.args, evaluator);
    const args = node.args.map((arg) => evaluator.eval(arg));
    return def.fn(args, evaluator);
  } catch (err) {
    return error(ERR.VALUE, `${node.name} 计算失败：${err.message}`);
  }
}

/**
 * 求值一个已解析的 AST。
 * @param {any} ast
 * @param {EvalContext} ctx
 */
export function evaluate(ast, ctx) {
  const evaluator = makeHelpers(ctx);
  return evalNode(ast, ctx, evaluator);
}

/**
 * 一步到位：文本公式 → 值。语法错误会转成 #NAME?/#VALUE! 值而不是抛异常。
 * @param {string} text
 * @param {EvalContext} ctx
 */
export function evaluateFormula(text, ctx) {
  try {
    const ast = parse(text);
    return evaluate(ast, ctx);
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return error(ERR.VALUE, err.message);
    return error(ERR.VALUE, err.message || '公式错误');
  }
}

/* ------------------------------------------------------------------ *
 * AST 工具：引用提取与公式平移
 * ------------------------------------------------------------------ */
/**
 * 收集公式里引用的所有区域（用于依赖分析 / 循环检测辅助）。
 * @param {string} text
 * @param {string} currentSheet
 * @returns {Array<{sheet: string, from: {r:number,c:number}, to: {r:number,c:number}}>}
 */
export function collectRefs(text, currentSheet) {
  const out = [];
  let ast;
  try {
    ast = parse(text);
  } catch {
    return out;
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'ref':
        out.push({ sheet: node.sheet || currentSheet, from: { r: node.r, c: node.c }, to: { r: node.r, c: node.c } });
        break;
      case 'range':
        out.push({
          sheet: node.sheet || currentSheet,
          from: { r: Math.min(node.from.r, node.to.r), c: Math.min(node.from.c, node.to.c) },
          to: { r: Math.max(node.from.r, node.to.r), c: Math.max(node.from.c, node.to.c) },
        });
        break;
      case 'rangeCol':
        out.push({ sheet: node.sheet || currentSheet, wholeColumns: [node.from, node.to] });
        break;
      case 'bin':
        visit(node.left);
        visit(node.right);
        break;
      case 'un':
      case 'post':
        visit(node.operand);
        break;
      case 'call':
        for (const arg of node.args) visit(arg);
        break;
      case 'array':
        for (const row of node.rows) for (const cell of row) visit(cell);
        break;
      default:
        break;
    }
  };
  visit(ast);
  return out;
}

/**
 * 按引用重写公式（插入/删除行列时使用）。
 *
 * 与 translateFormula 的区别：这里由调用方决定每个引用「新的位置」，
 * 因此绝对引用（$A$1）也会跟着移动，落在被删除范围内的引用会变成 #REF!，
 * 这正是 Excel 的行为。
 *
 * @param {string} text 公式正文
 * @param {(ref: {sheet: string|null, r: number, c: number}, kind: 'ref'|'range'|'rangeCol') => ({r: number, c: number}|null)} adjust
 *        返回 null 表示该引用已失效
 * @returns {string} 调整后的公式（解析失败时原样返回）
 */
export function adjustFormulaRefs(text, adjust) {
  try {
    const ast = parse(text);
    const next = rewriteRefs(ast, adjust, { changed: false });
    return `=${serializeAst(next)}`;
  } catch {
    return text.startsWith('=') ? text : `=${text}`;
  }
}

function rewriteRefs(node, adjust, state) {
  if (!node || typeof node !== 'object') return node;
  switch (node.type) {
    case 'ref': {
      const target = adjust({ sheet: node.sheet, r: node.r, c: node.c }, 'ref');
      if (!target) {
        state.changed = true;
        return { type: 'error', code: ERR.REF };
      }
      if (target.r === node.r && target.c === node.c) return node;
      state.changed = true;
      return { ...node, r: target.r, c: target.c };
    }
    case 'range': {
      const from = adjust({ sheet: node.sheet, r: node.from.r, c: node.from.c }, 'range');
      const to = adjust({ sheet: node.sheet, r: node.to.r, c: node.to.c }, 'range');
      if (!from || !to) {
        state.changed = true;
        return { type: 'error', code: ERR.REF };
      }
      if (from.r === node.from.r && from.c === node.from.c && to.r === node.to.r && to.c === node.to.c) return node;
      state.changed = true;
      return { ...node, from: { ...node.from, r: from.r, c: from.c }, to: { ...node.to, r: to.r, c: to.c } };
    }
    case 'rangeCol': {
      const from = adjust({ sheet: node.sheet, r: 0, c: node.colIndexes ? node.colIndexes[0] : 0 }, 'rangeCol');
      // rangeCol 的列名需要单独处理，交由调用方通过 colAdjust 处理
      state.changed = state.changed || false;
      void from;
      return node;
    }
    case 'bin':
      return { ...node, left: rewriteRefs(node.left, adjust, state), right: rewriteRefs(node.right, adjust, state) };
    case 'un':
    case 'post':
      return { ...node, operand: rewriteRefs(node.operand, adjust, state) };
    case 'call':
      return { ...node, args: node.args.map((arg) => rewriteRefs(arg, adjust, state)) };
    case 'array':
      return { ...node, rows: node.rows.map((row) => row.map((cell) => rewriteRefs(cell, adjust, state))) };
    default:
      return node;
  }
}

/**
 * 平移公式中的相对引用（填充柄使用）。
 * @param {string} text 公式正文
 * @param {{rows?: number, cols?: number}} delta
 */
export function translateFormula(text, delta = {}) {
  const rows = delta.rows || 0;
  const cols = delta.cols || 0;
  if (!rows && !cols) return text;
  try {
    const ast = parse(text);
    return `=${serializeAst(shiftAst(ast, rows, cols))}`;
  } catch {
    return text.startsWith('=') ? text : `=${text}`;
  }
}

function shiftAst(node, rows, cols) {
  if (!node || typeof node !== 'object') return node;
  switch (node.type) {
    case 'ref':
      return node.sheet
        ? node
        : {
          ...node,
          r: node.absR ? node.r : node.r + rows,
          c: node.absC ? node.c : node.c + cols,
          absR: Boolean(node.absR),
          absC: Boolean(node.absC),
        };
    case 'range':
      return node.sheet ? node : {
        ...node,
        from: { ...node.from, r: node.from.absR ? node.from.r : node.from.r + rows, c: node.from.absC ? node.from.c : node.from.c + cols },
        to: { ...node.to, r: node.to.absR ? node.to.r : node.to.r + rows, c: node.to.absC ? node.to.c : node.to.c + cols },
      };
    case 'bin':
      return { ...node, left: shiftAst(node.left, rows, cols), right: shiftAst(node.right, rows, cols) };
    case 'un':
    case 'post':
      return { ...node, operand: shiftAst(node.operand, rows, cols) };
    case 'call':
      return { ...node, args: node.args.map((arg) => shiftAst(arg, rows, cols)) };
    case 'array':
      return { ...node, rows: node.rows.map((row) => row.map((cell) => shiftAst(cell, rows, cols))) };
    default:
      return node;
  }
}

/** AST → 公式文本（用于显示与填充） */
export function serializeAst(node) {
  if (!node) return '';
  switch (node.type) {
    case 'lit':
      if (typeof node.value === 'boolean') return node.value ? 'TRUE' : 'FALSE';
      if (typeof node.value === 'string') return `"${node.value.replace(/"/g, '""')}"`;
      return String(node.value);
    case 'error':
      return node.code;
    case 'name':
      return node.name;
    case 'ref': {
      const text = formatA1(node);
      return node.sheet ? `${quoteSheet(node.sheet)}!${text}` : text;
    }
    case 'range':
      return `${node.sheet ? `${quoteSheet(node.sheet)}!` : ''}${formatA1(node.from)}:${formatA1(node.to)}`;
    case 'rangeCol':
      return `${node.sheet ? `${quoteSheet(node.sheet)}!` : ''}${node.from}:${node.to}`;
    case 'array':
      return `{${node.rows.map((row) => row.map(serializeAst).join(',')).join(';')}}`;
    case 'un':
      return `${node.op}${serializeAst(node.operand)}`;
    case 'post':
      return `${serializeAst(node.operand)}%`;
    case 'bin':
      return `${serializeAst(node.left)}${node.op}${serializeAst(node.right)}`;
    case 'call':
      return `${node.name}(${node.args.map(serializeAst).join(',')})`;
    default:
      return '';
  }
}

function quoteSheet(name) {
  return /^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}

/** 判断文本是否为一个公式 */
export const isFormula = (text) => typeof text === 'string' && text.trim().startsWith('=');
