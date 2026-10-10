/**
 * ui.js —— 共享 UI 组件层：图标、按钮、菜单、弹窗、提示条。
 * 只依赖 dom.js，不依赖任何业务模块。
 */
import { h, svg, qs, append } from './dom.js';
import { t, fmtDate } from './i18n.js';

/* ------------------------------------------------------------------ *
 * 图标：24x24 线性图标，统一 stroke=currentColor
 * ------------------------------------------------------------------ */
const ICONS = {
  'doc': 'M6 3h8l5 5v13H6z M14 3v5h5 M9 12h7 M9 16h7',
  'sheet': 'M4 5h16v14H4z M4 10h16 M4 15h16 M9 5v14 M15 5v14',
  'deck': 'M3 5h18v11H3z M12 16v3 M8 21h8 M8 9l3 4 2-2 3 3',
  'plus': 'M12 5v14 M5 12h14',
  'plus-square': 'M4 4h16v16H4z M12 8v8 M8 12h8',
  'minus-square': 'M4 4h16v16H4z M8 12h8',
  'close': 'M6 6l12 12 M18 6L6 18',
  'check': 'M4 13l5 5L20 6',
  'search': 'M11 4a7 7 0 100 14 7 7 0 000-14z M20 20l-4.5-4.5',
  'trash': 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 11v6 M14 11v6',
  'pencil': 'M4 20h4L20 8l-4-4L4 16z M14 6l4 4',
  'copy': 'M9 9h11v11H9z M4 15V4h11 M4 4h11v11',
  'pin': 'M9 3h6l-1 6 4 4H6l4-4z M12 13v8',
  'download': 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  'upload': 'M12 20V9 M7 13l5-5 5 5 M5 4h14',
  'save': 'M5 4h11l3 3v13H5z M8 4v5h7 M8 14h8v6H8z',
  'printer': 'M7 9V4h10v5 M4 9h16v7h-3 M7 16H4v-7 M7 13h10v7H7z',
  'sun': 'M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v2 M12 20v2 M4 12H2 M22 12h-2 M5 5l1.5 1.5 M17.5 17.5L19 19 M19 5l-1.5 1.5 M6.5 17.5L5 19',
  'moon': 'M20 14a8 8 0 11-10-10 7 7 0 0010 10z',
  'globe': 'M12 3a9 9 0 100 18 9 9 0 000-18z M3 12h18 M12 3c2.5 2.5 2.5 15 0 18 M12 3c-2.5 2.5-2.5 15 0 18',
  'gear': 'M4 8h9 M17 8h3 M4 16h3 M11 16h9 M15 5v6 M9 13v6',
  'info': 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 11v6 M12 7.5v.5',
  'alert': 'M12 4l9 16H3z M12 10v5 M12 17.5v.5',
  'bold': 'M7 4h6a4 4 0 010 8H7z M7 12h7a4 4 0 010 8H7z',
  'italic': 'M10 4h8 M6 20h8 M14 4l-4 16',
  'underline': 'M7 4v7a5 5 0 0010 0V4 M5 20h14',
  'strike': 'M4 12h16 M7 8a4 4 0 014-4h2a4 4 0 014 4 M17 16a4 4 0 01-4 4h-2a4 4 0 01-4-4',
  'code': 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
  'code-block': 'M4 4h16v16H4z M9 9l-2 3 2 3 M15 9l2 3-2 3',
  'list-ul': 'M5 7h.01 M5 12h.01 M5 17h.01 M9 7h11 M9 12h11 M9 17h11',
  'list-ol': 'M4 6h2v4H4 M4 14h2l-2 4h2 M9 7h11 M9 12h11 M9 17h11',
  'checklist': 'M4 6l2 2 3-3 M4 15l2 2 3-3 M12 7h8 M12 16h8',
  'quote': 'M7 7h4v4a4 4 0 01-4 4z M13 7h4v4a4 4 0 01-4 4z',
  'h1': 'M5 6v12 M13 6v12 M5 12h8 M17 10l2-1v9',
  'h2': 'M4 6v12 M12 6v12 M4 12h8 M16 10a2 2 0 114 0c0 3-4 3-4 8h4',
  'h3': 'M4 6v12 M12 6v12 M4 12h8 M16 9h4l-3 3h1a2 2 0 11-2 2',
  'paragraph': 'M5 5h14 M5 10h14 M5 15h9 M5 20h6',
  'align-left': 'M4 6h16 M4 11h10 M4 16h16 M4 21h10',
  'align-center': 'M4 6h16 M7 11h10 M4 16h16 M7 21h10',
  'align-right': 'M4 6h16 M10 11h10 M4 16h16 M10 21h10',
  'align-justify': 'M4 6h16 M4 11h16 M4 16h16 M4 21h16',
  'link': 'M10 13a4 4 0 005.7 0l2.3-2.3a4 4 0 10-5.7-5.7L11 6 M14 11a4 4 0 00-5.7 0L6 13.3A4 4 0 1011.7 19L13 18',
  'unlink': 'M9 15l-2.3 2.3a4 4 0 105.7 5.7 M15 9l2.3-2.3a4 4 0 10-5.7-5.7 M4 4l16 16',
  'image': 'M4 5h16v14H4z M8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M4 17l5-5 4 4 3-3 4 4',
  'table': 'M4 4h16v16H4z M4 10h16 M4 15h16 M9 4v16 M15 4v16',
  'minus': 'M5 12h14',
  'palette': 'M12 3a9 9 0 000 18c1.5 0 2-1 2-2s-.5-2-1.5-2H14a2 2 0 010-4h4a3 3 0 003-3c0-4-4-7-9-7z M7.5 11a1 1 0 100-2 1 1 0 000 2z',
  'undo': 'M9 10H5V6 M5 10a7 7 0 1113 5',
  'redo': 'M15 10h4V6 M19 10A7 7 0 106 15',
  'chevron-down': 'M7 10l5 5 5-5',
  'chevron-right': 'M10 7l5 5-5 5',
  'chevron-left': 'M14 7l-5 5 5 5',
  'chevron-up': 'M7 14l5-5 5 5',
  'more': 'M6 12h.01 M12 12h.01 M18 12h.01',
  'grid': 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  'play': 'M7 5l12 7-12 7z',
  'chart-bar': 'M5 20V10 M12 20V4 M19 20v-7',
  'chart-line': 'M4 19l5-6 4 3 7-9 M4 4v16h16',
  'chart-pie': 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 3v9h9',
  'merge': 'M4 4h16v16H4z M4 12h16 M9 8h6 M9 16h6',
  'freeze': 'M4 4h16v16H4z M4 9h16 M9 4v16',
  'sort-asc': 'M7 18V6 M4 9l3-3 3 3 M12 8h8 M12 13h6 M12 18h4',
  'sort-desc': 'M7 6v12 M4 15l3 3 3-3 M12 6h8 M12 11h6 M12 16h4',
  'fx': 'M6 4h5 M8 4v16 M4 20h8 M14 4l4 8-4 8 M18 4l-4 8 4 8',
  'sum': 'M6 5h12l-7 7 7 7H6',
  'eraser': 'M7 20h12 M4 15l6-6 6 6-5 5H8z',
  'arrow-up': 'M12 20V5 M6 11l6-6 6 6',
  'arrow-down': 'M12 4v15 M6 13l6 6 6-6',
  'eye': 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z M12 9a3 3 0 100 6 3 3 0 000-6z',
  'layers': 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  'text': 'M5 6V4h14v2 M12 4v16 M9 20h6',
  'shape-square': 'M4 4h16v16H4z',
  'shape-circle': 'M12 3a9 9 0 100 18 9 9 0 000-18z',
  'shape-triangle': 'M12 4l9 16H3z',
  'line': 'M4 20L20 4',
  'arrow': 'M4 20L20 4 M20 4h-7 M20 4v7',
  'folder': 'M3 6h6l2 2h10v11H3z',
  'clock': 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 7v5l3 2',
  'file-text': 'M6 3h8l5 5v13H6z M14 3v5h5 M9 13h6 M9 17h6',
  'file-csv': 'M6 3h8l5 5v13H6z M14 3v5h5 M9 14a2 2 0 100 3 M14 17l1-3 1 3',
  'file-code': 'M6 3h8l5 5v13H6z M14 3v5h5 M10 13l-2 2 2 2 M14 13l2 2-2 2',
  'external': 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  'expand': 'M4 9V4h5 M20 15v5h-5 M4 4l6 6 M20 20l-6-6',
  'font': 'M5 20L11 4h2l6 16 M8 14h8',
  'paint': 'M5 5h9v6H5z M14 8h3v8h-3z M9 14v6',
  'note': 'M5 4h14v11l-5 5H5z M14 20v-5h5 M8 8h8 M8 12h5',
  'columns': 'M4 4h16v16H4z M12 4v16',
  'dice': 'M4 4h16v16H4z M8.5 9a1 1 0 100-2 1 1 0 000 2z M15.5 17a1 1 0 100-2 1 1 0 000 2z',
};

const ICON_ALIAS = { 'text-box': 'text', 'rect': 'shape-square', 'ellipse': 'shape-circle', 'triangle': 'shape-triangle' };

/**
 * 生成图标元素。
 * @param {string} name
 * @param {{size?: number, stroke?: number, className?: string}} [options]
 */
export function icon(name, options = {}) {
  const key = ICON_ALIAS[name] || name;
  const path = ICONS[key] || ICONS['info'];
  const size = options.size || 18;
  const node = svg('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': options.stroke || 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: ['icon', options.className].filter(Boolean).join(' '),
    'aria-hidden': 'true',
  });
  node.appendChild(svg('path', { d: path }));
  return node;
}

/** 图标名称列表（供测试） */
export function iconNames() {
  return Object.keys(ICONS);
}

/* ------------------------------------------------------------------ *
 * 按钮
 * ------------------------------------------------------------------ */
/**
 * 工具按钮。
 * @param {{icon?: string, label?: string, title?: string, active?: boolean, disabled?: boolean,
 *          variant?: 'ghost'|'primary'|'danger'|'toolbar'|'solid', onClick?: Function, className?: string,
 *          iconSize?: number, hideLabel?: boolean, dataset?: object, testid?: string}} options
 */
export function button(options = {}) {
  const {
    icon: iconName, label, title, active, disabled, variant = 'ghost', onClick, className, iconSize, hideLabel,
    dataset, testid,
  } = options;
  const el = h('button', {
    class: ['btn', `btn--${variant}`, active ? 'is-active' : '', hideLabel ? 'btn--icon-only' : '', className]
      .filter(Boolean).join(' '),
    type: 'button',
    title: title || label || '',
    disabled: Boolean(disabled),
    'aria-label': title || label || iconName || '',
    dataset,
    testid,
    onclick: onClick,
  });
  if (iconName) el.appendChild(icon(iconName, { size: iconSize }));
  if (label && !hideLabel) el.appendChild(h('span.btn__label', { text: label }));
  return el;
}

/** 一组互斥按钮（工具栏里的 B/I/U 那种） */
export function toggleGroup(items, activeValue, onPick) {
  const wrap = h('div.btn-group', { role: 'group' });
  for (const item of items) {
    const btn = button({
      icon: item.icon,
      label: item.label,
      title: item.title || item.label,
      hideLabel: item.hideLabel,
      active: item.value === activeValue,
      variant: 'toolbar',
      dataset: { value: String(item.value) },
      onClick: () => onPick(item.value, item),
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

/** 分段控件 */
export function segmented(items, activeValue, onPick) {
  const wrap = h('div.segmented', { role: 'tablist' });
  for (const item of items) {
    wrap.appendChild(h('button', {
      class: ['segmented__item', item.value === activeValue ? 'is-active' : ''].filter(Boolean).join(' '),
      type: 'button',
      role: 'tab',
      title: item.title || item.label,
      onclick: () => onPick(item.value, item),
    }, [item.icon ? icon(item.icon, { size: 16 }) : null, item.label ? h('span', { text: item.label }) : null]));
  }
  return wrap;
}

/** 颜色选择按钮（原生 color input + 透明/无填充） */
export function colorPicker(value, onChange, options = {}) {
  const wrap = h('label.color-picker', { title: options.title || t('writer.textColor') });
  wrap.appendChild(icon(options.icon || 'palette', { size: 16 }));
  wrap.appendChild(h('input', {
    type: 'color',
    value: normalizeHex(value) || '#000000',
    oninput: (event) => onChange(event.target.value),
  }));
  if (options.allowNone) {
    wrap.appendChild(h('button', {
      class: 'color-picker__none',
      type: 'button',
      title: t('common.nothing'),
      onclick: () => onChange(null),
    }, [icon('close', { size: 12 })]));
  }
  return wrap;
}

function normalizeHex(value) {
  if (!value) return null;
  const hex = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/i.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(hex);
  if (rgb) {
    return `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */
let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = h('div.toast-host', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * 轻提示。
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} [type]
 * @param {{duration?: number, action?: {label: string, onClick: Function}}} [options]
 */
export function toast(message, type = 'info', options = {}) {
  const host = ensureToastHost();
  const node = h('div', { class: `toast toast--${type}` }, [
    icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : type === 'warn' ? 'alert' : 'info', { size: 16 }),
    h('span.toast__text', { text: message }),
  ]);
  if (options.action) {
    node.appendChild(h('button.toast__action', {
      type: 'button',
      text: options.action.label,
      onclick: () => {
        options.action.onClick();
        remove();
      },
    }));
  }
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-in'));

  const remove = () => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(remove, options.duration ?? 2600);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

export const toastError = (message) => toast(message, 'error', { duration: 4200 });
export const toastSuccess = (message) => toast(message, 'success');

/* ------------------------------------------------------------------ *
 * 弹窗
 * ------------------------------------------------------------------ */
let openDialogs = 0;

/**
 * 打开模态对话框。
 * @param {{title?: string, body?: Node|string, actions?: Array<any>, width?: number,
 *          onClose?: Function, className?: string, footer?: Node}} options
 * @returns {{el: HTMLElement, body: HTMLElement, close: Function, dialog: HTMLElement}}
 */
export function openDialog(options = {}) {
  const overlay = h('div.overlay', { role: 'presentation' });
  const dialog = h('div', {
    class: ['dialog', options.className].filter(Boolean).join(' '),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': options.title || t('common.ok'),
    style: options.width ? { width: `${options.width}px` } : null,
  });

  const header = h('div.dialog__header', {}, [
    h('h2.dialog__title', { text: options.title || '' }),
    h('button.dialog__close', {
      type: 'button',
      'aria-label': t('common.close'),
      onclick: () => close(),
    }, [icon('close', { size: 16 })]),
  ]);

  const body = h('div.dialog__body');
  append(body, options.body);

  const dialogActions = options.actions || [];
  const footer = options.footer || (dialogActions.length
    ? h('div.dialog__footer', {}, dialogActions.map((action) => button({
      label: action.label,
      variant: action.variant || 'ghost',
      onClick: () => action.onClick?.(close),
      testid: action.testid,
    })))
    : null);

  if (options.title) dialog.appendChild(header);
  dialog.appendChild(body);
  if (footer) dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  openDialogs += 1;

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    openDialogs -= 1;
    overlay.classList.remove('is-in');
    setTimeout(() => overlay.remove(), 180);
    document.removeEventListener('keydown', onKey, true);
    options.onClose?.(result);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      trapFocus(dialog, event);
    }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && options.dismissible !== false) close();
  });

  const focusTarget = qs('[autofocus], input, button, textarea, select', dialog);
  setTimeout(() => focusTarget?.focus(), 30);
  return { el: overlay, dialog, body, close, setActions: () => {} };
}

/** 焦点锁在弹窗内部 */
function trapFocus(container, event) {
  const focusable = Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
  )).filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 确认框 */
export function confirmDialog(message, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => {
      if (settled) return;
      settled = true;
      close();
      resolve(value);
    };
    const ref = openDialog({
      title: options.title || t('common.confirm'),
      width: 420,
      body: h('p.dialog__text', { text: message }),
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
      actions: [
        { label: options.cancelLabel || t('common.cancel'), variant: 'ghost', onClick: (close) => finish(false, close) },
        {
          label: options.confirmLabel || t('common.ok'),
          variant: options.danger ? 'danger' : 'primary',
          onClick: (close) => finish(true, close),
          testid: 'confirm-ok',
        },
      ],
    });
    qs('[data-testid="confirm-ok"]', ref.dialog)?.focus();
  });
}

/** 文本输入框 */
export function promptDialog(options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h('input.field__input', {
      type: 'text',
      value: options.value ?? '',
      placeholder: options.placeholder || '',
      autofocus: true,
      testid: 'prompt-input',
    });
    const finish = (value, close) => {
      if (settled) return;
      settled = true;
      close();
      resolve(value);
    };
    openDialog({
      title: options.title || t('common.rename'),
      width: 420,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
      body: h('div.dialog__form', {}, [
        options.label ? h('label.field__label', { text: options.label }) : null,
        input,
        options.hint ? h('p.field__hint', { text: options.hint }) : null,
      ]),
      actions: [
        { label: t('common.cancel'), onClick: (close) => finish(null, close) },
        { label: options.okLabel || t('common.ok'), variant: 'primary', onClick: (close) => finish(input.value, close) },
      ],
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const ok = qs('.dialog__footer .btn--primary');
        ok?.click();
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * 菜单
 * ------------------------------------------------------------------ */
let activeMenu = null;

/** 关闭当前打开的菜单 */
export function closeMenu() {
  if (activeMenu) {
    const closing = activeMenu;
    activeMenu = null;
    closing.el.remove();
    document.removeEventListener('mousedown', closing.onDocDown, true);
    document.removeEventListener('keydown', closing.onKey, true);
    closing.onClose?.();
  }
}

/**
 * 打开下拉菜单。
 * @param {HTMLElement} anchor
 * @param {Array<{label?: string, icon?: string, shortcut?: string, disabled?: boolean, danger?: boolean,
 *                checked?: boolean, separator?: boolean, onClick?: Function, header?: boolean, hint?: string}>} items
 * @param {{align?: 'left'|'right', width?: number}} [options]
 */
export function openMenu(anchor, items, options = {}) {
  closeMenu();
  const el = h('div.menu', { role: 'menu', style: options.width ? { minWidth: `${options.width}px` } : null });

  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      el.appendChild(h('div.menu__sep'));
      continue;
    }
    if (item.header) {
      el.appendChild(h('div.menu__header', { text: item.label }));
      continue;
    }
    const node = h('button', {
      class: ['menu__item', item.danger ? 'is-danger' : '', item.disabled ? 'is-disabled' : ''].filter(Boolean).join(' '),
      type: 'button',
      role: 'menuitem',
      disabled: Boolean(item.disabled),
      title: item.hint || item.label || '',
      onclick: (event) => {
        event.stopPropagation();
        if (item.disabled) return;
        closeMenu();
        item.onClick?.();
      },
    });
    if (item.checked !== undefined) {
      node.appendChild(h('span.menu__check', {}, [item.checked ? icon('check', { size: 14 }) : null]));
    } else if (item.icon) {
      node.appendChild(h('span.menu__icon', {}, [icon(item.icon, { size: 15 })]));
    } else {
      node.appendChild(h('span.menu__icon'));
    }
    node.appendChild(h('span.menu__label', { text: item.label || '' }));
    if (item.shortcut) node.appendChild(h('kbd.menu__shortcut', { text: item.shortcut }));
    el.appendChild(node);
  }

  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  const menuRect = el.getBoundingClientRect();
  const margin = 8;
  let left = options.align === 'right' ? rect.right - menuRect.width : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuRect.height - 6);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  requestAnimationFrame(() => el.classList.add('is-in'));

  const onDocDown = (event) => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  activeMenu = { el, onDocDown, onKey, onClose: options.onClose };
  return el;
}

/* ------------------------------------------------------------------ *
 * 其他小工具
 * ------------------------------------------------------------------ */
/** 空状态 */
export function emptyState(iconName, title, hint, action) {
  return h('div.empty', {}, [
    h('div.empty__icon', {}, [icon(iconName, { size: 34, stroke: 1.4 })]),
    h('p.empty__title', { text: title }),
    hint ? h('p.empty__hint', { text: hint }) : null,
    action || null,
  ]);
}

/** 带标签的表单字段 */
export function field(label, control, hint) {
  return h('div.field', {}, [
    h('label.field__label', { text: label }),
    control,
    hint ? h('p.field__hint', { text: hint }) : null,
  ]);
}

/** 数字输入 */
export function numberInput(value, onChange, options = {}) {
  return h('input.field__input', {
    type: 'number',
    value: String(value ?? 0),
    min: options.min ?? null,
    max: options.max ?? null,
    step: options.step ?? 1,
    oninput: (event) => onChange(Number(event.target.value)),
  });
}

/** 人类可读字节数 */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 时间戳 → 本地化字符串 */
export function timeLabel(value) {
  return fmtDate(value, true);
}

/** 拖拽/缩放手势通用封装（Pointer Events） */
export function dragGesture(target, handlers) {
  let state = null;

  const onDown = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (handlers.shouldStart && !handlers.shouldStart(event)) return;
    state = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      pointerId: event.pointerId,
    };
    target.setPointerCapture?.(event.pointerId);
    handlers.onStart?.(state, event);
  };

  const onMove = (event) => {
    if (!state) return;
    state.dx = event.clientX - state.startX;
    state.dy = event.clientY - state.startY;
    state.mx = event.clientX - state.lastX;
    state.my = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.event = event;
    if (handlers.threshold && Math.abs(state.dx) + Math.abs(state.dy) < handlers.threshold && !state.passed) return;
    state.passed = true;
    handlers.onMove?.(state, event);
  };

  const onUp = (event) => {
    if (!state) return;
    const final = state;
    state = null;
    target.releasePointerCapture?.(final.pointerId);
    handlers.onEnd?.(final, event);
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onUp);

  return () => {
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onUp);
  };
}
