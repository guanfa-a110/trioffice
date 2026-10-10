/**
 * dom-shim.mjs —— 极简 DOM 影子环境。
 *
 * 目的不是模拟浏览器，而是**在没有浏览器的环境下把应用的挂载流程真跑一遍**，
 * 从而抓出静态检查发现不了的问题，例如：
 *   - `let x` 声明晚于回调触发导致的 TDZ（ReferenceError: Cannot access 'x' before initialization）
 *   - 拼错的标识符（ReferenceError: xxx is not defined）
 *   - 依赖了不存在的方法（例如把 Map 当数组用）
 *
 * 任何一个属性和方法都会返回「能继续被调用」的假对象，所以业务代码不会因为
 * 影子环境太弱而崩溃；反过来，凡是 ReferenceError 都是真问题。
 */

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) { for (const name of names) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.set.has(name) : Boolean(force);
    if (next) this.set.add(name);
    else this.set.delete(name);
    return next;
  }
  get value() { return [...this.set].join(' '); }
}

class FakeStyle {
  constructor() {
    this.props = new Map();
  }
  setProperty(name, value) { this.props.set(name, value); }
  getPropertyValue(name) { return this.props.get(name) || ''; }
  removeProperty(name) { this.props.delete(name); }
  get cssText() { return [...this.props].map(([k, v]) => `${k}:${v}`).join(';'); }
  set cssText(value) {
    this.props.clear();
    for (const part of String(value || '').split(';')) {
      const index = part.indexOf(':');
      if (index > 0) this.props.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
  }
}

class FakeNode {
  constructor(name = 'div', ownerDocument = null) {
    this.nodeName = String(name).toUpperCase();
    this.name = String(name).toLowerCase();
    this.nodeType = 1;
    this.tagName = this.nodeName;
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.textContent = '';
    this._innerHTML = '';
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.offsetWidth = 800;
    this.offsetHeight = 600;
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollWidth = 1600;
    this.scrollHeight = 1200;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }

  get className() { return this.classList.value; }
  set className(value) {
    this.classList = new FakeClassList();
    for (const name of String(value || '').split(/\s+/).filter(Boolean)) this.classList.set.add(name);
  }

  /** iframe 用：给一个独立的假文档，让打印/导出逻辑能跑通 */
  get contentDocument() {
    if (this.name !== 'iframe') return undefined;
    if (!this._doc) {
      const doc = new FakeNode('#document', this.ownerDocument);
      doc.open = () => {};
      doc.write = () => {};
      doc.close = () => {};
      this._doc = doc;
    }
    return this._doc;
  }

  get contentWindow() {
    if (this.name !== 'iframe') return undefined;
    if (!this._win) {
      const win = {
        document: this.contentDocument,
        focus() {},
        print() {},
        addEventListener() {},
        removeEventListener() {},
      };
      this._win = win;
    }
    return this._win;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); this.childNodes = []; }

  appendChild(node) {
    if (node && typeof node === 'object') {
      node.parentNode = this;
      this.childNodes.push(node);
    }
    return node;
  }
  insertBefore(node, ref) {
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(node) { this.parentNode?.insertBefore(node, this); this.parentNode?.removeChild(this); }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains?.(node));
  }
  cloneNode() { return new FakeNode(this.name, this.ownerDocument); }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return name in this.attrs; }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); }
  blur() {}
  click() { this.dispatchEvent({ type: 'click', target: this, currentTarget: this }); }
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
  }
  animate() { return { finished: Promise.resolve() }; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatchEvent(event) {
    const payload = { type: event.type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const handler of this.listeners.get(event.type) || []) handler(payload);
    for (const handler of this.listeners.get('*') || []) handler(payload);
    return true;
  }

  /** 极简选择器：只支持单个 class / tag / [data-x] / 逗号分隔的兜底 */
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const selectors = String(selector).split(',').map((item) => item.trim()).filter(Boolean);
    const out = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (selectors.some((sel) => matchesSelector(child, sel))) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  matches(selector) { return matchesSelector(this, selector); }
  getElementsByTagName(name) { return this.querySelectorAll(String(name)); }
}

function matchesSelector(node, selector) {
  const text = String(selector).trim();
  if (!text) return false;
  if (text === '*') return true;
  // 只取最后一段（忽略祖先，够用了）
  const last = text.split(/\s+/).pop();
  const classMatches = last.match(/\.([\w-]+)/g) || [];
  if (classMatches.some((cls) => !node.classList.contains(cls.slice(1)))) return false;
  const attrMatches = last.match(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g) || [];
  for (const attr of attrMatches) {
    const [, name, value] = /\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/.exec(attr);
    if (value === undefined) {
      if (!(name in node.attrs) && !(name in node.dataset)) return false;
    } else if (node.attrs[name] !== value && node.dataset[name] !== value) {
      return false;
    }
  }
  const tagMatch = last.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch && !classMatches.length && !attrMatches.length) {
    return node.name === tagMatch[0].toLowerCase();
  }
  return classMatches.length > 0 || attrMatches.length > 0;
}

/** 建立全局 DOM 影子环境；返回卸载函数 */
export function installDomShim() {
  const document = new FakeNode('#document');
  document.documentElement = new FakeNode('html', document);
  document.head = new FakeNode('head', document);
  document.body = new FakeNode('body', document);
  document.documentElement.dataset = {};
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  document.appendChild(document.documentElement);

  const appRoot = new FakeNode('div', document);
  appRoot.id = 'app';
  document.body.appendChild(appRoot);

  document.createElement = (name) => new FakeNode(name, document);
  document.createElementNS = (ns, name) => new FakeNode(name, document);
  document.createTextNode = (text) => {
    const node = new FakeNode('#text', document);
    node.nodeType = 3;
    node.textContent = String(text);
    return node;
  };
  document.createDocumentFragment = () => new FakeNode('#fragment', document);
  document.createTreeWalker = () => {
    const nodes = [];
    const collect = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) nodes.push(child);
        collect(child);
      }
    };
    collect(document.body);
    let index = -1;
    return { nextNode: () => (index += 1, nodes[index] || null) };
  };
  document.execCommand = () => true;
  document.queryCommandState = () => false;
  document.elementFromPoint = () => null;
  document.setAttribute = FakeNode.prototype.setAttribute.bind(document.documentElement);
  document.readyState = 'complete';
  document.activeElement = document.body;

  const window = {
    document,
    innerWidth: 1440,
    innerHeight: 900,
    location: { hash: '#/home', href: 'http://localhost/#/home' },
    navigator: { language: 'zh-CN', clipboard: null, storage: { estimate: async () => ({ usage: 1024 * 200, quota: 1024 * 1024 * 100 }) } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    queueMicrotask,
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => ({
      anchorNode: null,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
      removeAllRanges() {},
      addRange() {},
      getRangeAt: () => ({ startContainer: document.body, startOffset: 0, collapsed: true }),
    }),
    focus() {},
    print() {},
    open() {},
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    Blob: class { constructor() {} },
    File: class { constructor() {} },
    NodeFilter: { SHOW_TEXT: 4 },
    Node: FakeNode,
    Element: FakeNode,
    HTMLElement: FakeNode,
    HTMLInputElement: class {},
    XMLSerializer: class { serializeToString() { return '<svg/>'; } },
    structuredClone: globalThis.structuredClone,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  // 有些全局（如 navigator）在 Node 里是只读的 getter，必须用 defineProperty 覆盖
  const install = (key, value) => Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  const globals = {
    document,
    window,
    navigator: window.navigator,
    location: window.location,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    getSelection: window.getSelection,
    matchMedia: window.matchMedia,
    Blob: window.Blob,
    NodeFilter: window.NodeFilter,
    Node: FakeNode,
    Element: FakeNode,
    HTMLElement: FakeNode,
    XMLSerializer: window.XMLSerializer,
    FileReader: undefined,
    getComputedStyle: window.getComputedStyle,
  };

  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, {
      existed: Object.prototype.hasOwnProperty.call(globalThis, key),
      descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    });
    if (value === undefined) {
      try {
        delete globalThis[key];
      } catch { /* 只读全局删不掉也无所谓 */ }
    } else {
      install(key, value);
    }
  }

  return {
    document,
    window,
    appRoot,
    FakeNode,
    restore() {
      for (const [key, record] of previous) {
        if (record.existed && record.descriptor) Object.defineProperty(globalThis, key, record.descriptor);
        else {
          try {
            delete globalThis[key];
          } catch { /* ignore */ }
        }
      }
    },
  };
}

export { FakeNode };
