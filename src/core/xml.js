/**
 * xml.js —— 极简 XML 解析/序列化（零依赖，浏览器与 Node 通用）。
 * 只覆盖 Office 文档需要的子集：元素、属性、文本、自闭合、注释、CDATA、处理指令。
 * 不做 DTD / 命名空间校验，但会保留带前缀的标签名与属性名。
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 解码 XML 实体 */
export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return body in ENTITIES ? ENTITIES[body] : match;
  });
}

/** 转义 XML 特殊字符 */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 节点：{ name, attrs: {}, children: [], text: '' } */
export function createNode(name, attrs = {}) {
  return { name, attrs, children: [], text: '' };
}

/**
 * 解析 XML 文本为节点树。
 * @param {string} source
 * @param {{keepTextNodes?: boolean}} [options] keepTextNodes=true 时会把文本按出现顺序
 *        作为 { name: '#text' } 节点放进 children，便于还原混排内容（HTML → Markdown 用到）
 * @returns {{name: string, attrs: object, children: any[], text: string}}
 */
export function parseXml(source, options = {}) {
  const keepTextNodes = Boolean(options.keepTextNodes);
  const text = String(source ?? '').replace(/^\ufeff/, '');
  const root = createNode('#document');
  const stack = [root];
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], text.slice(i), keepTextNodes);
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], text.slice(i, lt), keepTextNodes);

    // 注释
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    // CDATA
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const cdata = end === -1 ? text.slice(lt + 9) : text.slice(lt + 9, end);
      appendText(stack[stack.length - 1], cdata, keepTextNodes, true);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    // 处理指令 / DOCTYPE
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    // 闭合标签
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end).trim();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    // 开始标签
    const gt = findTagEnd(text, lt);
    if (gt === -1) break;
    const raw = text.slice(lt + 1, gt);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body.trim());
    const node = createNode(nameMatch ? nameMatch[1] : '', parseAttrs(body.slice(nameMatch ? nameMatch[1].length : 0)));
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root.children.find((child) => child.name) || root;
}

function findTagEnd(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseAttrs(body) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(body))) {
    attrs[match[1]] = decodeEntities(match[3] !== undefined ? match[3] : match[4] || '');
  }
  return attrs;
}

function appendText(node, raw, keepTextNodes = false, isCdata = false) {
  if (!raw) return;
  const value = isCdata ? raw : decodeEntities(raw);
  node.text += value;
  if (keepTextNodes) node.children.push({ name: '#text', attrs: {}, children: [], text: value, textNode: true });
}

/* ------------------------------------------------------------------ *
 * 查询辅助
 * ------------------------------------------------------------------ */
/** 按名字找直接子节点 */
export function child(node, name) {
  return node?.children.find((item) => item.name === name) || null;
}

/** 按名字找所有直接子节点 */
export function children(node, name) {
  return node?.children.filter((item) => item.name === name) || [];
}

/** 深度优先查找所有同名节点 */
export function findAll(node, name, out = []) {
  if (!node) return out;
  for (const item of node.children || []) {
    if (item.name === name) out.push(item);
    findAll(item, name, out);
  }
  return out;
}

/** 深度优先查找第一个同名节点 */
export function find(node, name) {
  if (!node) return null;
  for (const item of node.children || []) {
    if (item.name === name) return item;
    const nested = find(item, name);
    if (nested) return nested;
  }
  return null;
}
