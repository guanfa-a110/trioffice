/**
 * dom.js —— 极简 DOM 工具（零依赖）。
 * 纯函数、无副作用，可在无 DOM 环境下被 Node 解析（内部不接触 document）。
 */

/** 判断是否处于浏览器环境（SSR / 单测友好） */
export const hasDom = typeof document !== 'undefined';

/**
 * 创建元素：h('div', { class: 'a', onclick: fn }, ['文本', child])
 * @param {string} tag 支持 'div.cls#id' 简写
 * @param {object} [attrs]
 * @param {Array|string|Node} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs, children) {
  const [, name, id, cls] = /^([\w-]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/.exec(tag) || [];
  const el = document.createElement(name || 'div');
  if (id) el.id = id.slice(1);
  if (cls) el.className = cls.slice(1).split('.').join(' ');

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') {
        el.className = [el.className, value].filter(Boolean).join(' ');
      } else if (key === 'style' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
          else el.style[prop] = typeof val === 'number' ? `${val}px` : val;
        }
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) el.dataset[prop] = String(val);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'html') {
        el.innerHTML = value;
      } else if (key === 'text') {
        el.textContent = value;
      } else if (key in el && key !== 'list' && key !== 'form' && typeof value !== 'object') {
        try { el[key] = value; } catch { el.setAttribute(key, String(value)); }
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

/** 追加子节点，自动展开数组、忽略空值、转义字符串 */
export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

/** 清空元素 */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** el(tag, attrs, children) 的 SVG 命名空间版本 */
export function svg(tag, attrs, children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, String(value));
    }
  }
  if (children !== undefined && children !== null) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined) continue;
      el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return el;
}

/** 查询 */
export const qs = (sel, root) => (root || document).querySelector(sel);
export const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** 事件委托：on(root, 'click', '.btn', handler) */
export function on(root, type, selector, handler, options) {
  root.addEventListener(type, (event) => {
    const match = event.target instanceof Element ? event.target.closest(selector) : null;
    if (match && root.contains(match)) handler(event, match);
  }, options);
  return root;
}

/** 切换 class */
export function toggleClass(el, name, force) {
  if (force === undefined) el.classList.toggle(name);
  else el.classList.toggle(name, force);
  return el;
}

/** 下一帧 */
export const nextFrame = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

/** 防抖（返回值带 cancel()，便于在销毁时清理定时器） */
export function debounce(fn, wait = 200) {
  let timer = null;
  const debounced = function debouncedFn(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    fn();
  };
  return debounced;
}

export function throttle(fn, wait = 16) {
  let last = 0;
  let timer = null;
  return function throttled(...args) {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn.apply(this, args);
      }, remain);
    }
  };
}

/** 将 HTML 字符串安全转义为文本 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 卸载元素（触发自定义清理钩子） */
export function dispose(el) {
  if (!el) return;
  if (typeof el.__dispose === 'function') el.__dispose();
  el.remove();
}
