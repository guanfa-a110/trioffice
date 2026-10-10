/**
 * frame.js —— 三个应用共用的外壳：顶栏、下拉菜单、工具条插槽、状态栏。
 * 应用只需描述菜单项与工具条，外壳负责交互与状态展示。
 */
import { h, clear } from '../core/dom.js';
import { button, icon, openMenu, openDialog } from '../core/ui.js';
import { t, lang, setLang, LANGS } from '../core/i18n.js';
import { listExporters } from '../core/format.js';
import { bus, EVENTS } from '../core/bus.js';

/**
 * 创建应用外壳。
 * @param {{title: string, iconName: string, appLabel: string, menus: Function, toolbar: Function,
 *          onTitleChange?: Function, onClose: Function, onSave: Function, onExport: Function,
 *          extraActions?: Function, statusItems?: Function}} options
 */
export function createAppFrame(options) {
  const titleInput = h('input.app__title', {
    type: 'text',
    value: options.title || t('common.untitled'),
    spellcheck: 'false',
    'aria-label': t('common.name'),
    onchange: () => options.onTitleChange?.(titleInput.value.trim() || options.title),
    onkeydown: (event) => {
      if (event.key === 'Enter') titleInput.blur();
    },
  });

  const menuBar = h('nav.app__menus', {});
  const statusText = h('span.app__status', { text: '' });
  const actions = h('div.app__actions');

  const topbar = h('header.app__bar', {}, [
    h('div.app__brand', {}, [
      button({
        icon: 'chevron-left',
        title: t('menu.close'),
        variant: 'icon',
        onClick: () => options.onClose?.(),
      }),
      h('span.app__brand-icon', {}, [icon(options.iconName, { size: 17 })]),
    ]),
    h('div.app__title-wrap', {}, [
      titleInput,
      statusText,
    ]),
    menuBar,
    actions,
  ]);

  const toolbar = h('div.app__toolbar');
  const body = h('div.app__body');
  const statusBar = h('footer.app__statusbar');

  const el = h('div.app', {}, [topbar, toolbar, body, statusBar]);

  let dirty = false;
  let statusTimer = null;

  const api = {
    el,
    body,
    toolbar,
    statusBar,
    titleInput,

    setTitle(title) {
      titleInput.value = title;
    },

    get title() {
      return titleInput.value;
    },

    setDirty(value) {
      dirty = Boolean(value);
      renderStatus();
    },

    setStatus(text, tone = 'idle', autoClear = 0) {
      statusText.textContent = text || '';
      statusText.className = `app__status is-${tone}`;
      clearTimeout(statusTimer);
      if (autoClear) {
        statusTimer = setTimeout(() => {
          statusText.textContent = dirty ? t('common.unsaved') : '';
          statusText.className = 'app__status';
        }, autoClear);
      }
    },

    renderStatus: renderStatus,

    /** 重建菜单（例如导出列表变化时） */
    refreshMenus() {
      clear(menuBar);
      const groups = options.menus?.({ frame: api }) || [];
      for (const group of groups) {
        const trigger = h('button.app__menu', {
          type: 'button',
          text: group.label,
          onclick: () => openMenu(trigger, typeof group.items === 'function' ? group.items() : group.items),
        });
        menuBar.appendChild(trigger);
      }
    },

    /** 重建工具条 */
    setToolbar(nodes) {
      clear(toolbar);
      const content = Array.isArray(nodes) ? nodes : [nodes];
      for (const node of content) if (node) toolbar.appendChild(node);
      toolbar.style.display = content.filter(Boolean).length ? '' : 'none';
    },

    /** 设置状态栏内容 */
    setStatusBar(nodes) {
      clear(statusBar);
      const content = Array.isArray(nodes) ? nodes : [nodes];
      for (const node of content) if (node) statusBar.appendChild(node);
    },

    /** 更新右侧全局按钮 */
    renderActions() {
      clear(actions);
      const custom = options.extraActions?.({ frame: api }) || [];
      for (const node of custom) actions.appendChild(node);
      actions.appendChild(button({
        icon: 'save',
        title: `${t('menu.save')} (Ctrl/⌘+S)`,
        variant: 'primary',
        onClick: () => options.onSave?.(),
      }));
      actions.appendChild(themeToggle());
      actions.appendChild(button({
        icon: 'globe',
        title: t('menu.language'),
        variant: 'icon',
        onClick: (event) => openMenu(event.currentTarget, LANGS.map((item) => ({
          label: item.label,
          checked: item.code === lang(),
          onClick: () => setLang(item.code),
        })), { align: 'right' }),
      }));
      actions.appendChild(button({
        icon: 'info',
        title: t('menu.about'),
        variant: 'icon',
        onClick: () => showAbout(),
      }));
    },
  };

  function renderStatus() {
    statusText.textContent = dirty ? t('common.unsaved') : t('common.saved');
    statusText.className = `app__status${dirty ? ' is-dirty' : ''}`;
  }

  api.renderMenus = api.refreshMenus;

  let disposed = false;

  /**
   * 构建（或重建）菜单、工具条与右侧按钮。
   *
   * 刻意**不在 createAppFrame 内部调用**：菜单与工具条会读取应用自己的对象
   * （网格、画布、历史栈……），而它们是在 createAppFrame 之后才创建的。
   * 由应用在初始化完成后显式调用，才能避免踩到 let/const 的暂时性死区（TDZ）。
   */
  const renderChrome = () => {
    if (disposed) return;
    renderStatus();
    try {
      api.refreshMenus();
      api.setToolbar(options.toolbar?.({ frame: api }));
      api.renderActions();
    } catch (err) {
      console.error('[frame] 构建界面外壳失败：', err);
    }
  };

  api.renderChrome = renderChrome;

  const offLang = bus.on(EVENTS.LANG_CHANGED, () => {
    if (disposed) return;
    renderChrome();
  });

  api.el.__dispose = () => {
    disposed = true;
    offLang();
    clearTimeout(statusTimer);
  };

  return api;
}

/** 深色模式切换按钮 */
export function themeToggle() {
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  const node = button({
    icon: isDark() ? 'sun' : 'moon',
    title: t('menu.theme'),
    variant: 'icon',
    onClick: () => {
      applyTheme(isDark() ? 'light' : 'dark');
      clear(node);
      node.appendChild(icon(isDark() ? 'sun' : 'moon', { size: 18 }));
    },
  });
  return node;
}

/** 应用主题 */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('trioffice.theme', theme);
  } catch { /* ignore */ }
  bus.emit(EVENTS.THEME_CHANGED, theme);
}

/** 初始化主题（跟随系统） */
export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('trioffice.theme');
  } catch { /* ignore */ }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

/** 生成「导出」菜单项（从导出插件注册表来） */
export function exportMenuItems(doc, onExport) {
  const list = listExporters(doc.type);
  return list.map((item) => ({
    label: item.label,
    icon: 'download',
    onClick: () => onExport(item.id),
  }));
}

/** 关于对话框 */
export function showAbout() {
  openDialog({
    title: `${t('app.name')} · ${t('dialog.about')}`,
    width: 560,
    body: h('div.about', {}, [
      h('div.about__head', {}, [
        h('span.about__logo', {}, [icon('deck', { size: 26 })]),
        h('div', {}, [
          h('h3.about__name', { text: `${t('app.name')} 0.1.0` }),
          h('p.about__slogan', { text: t('app.tagline') }),
        ]),
      ]),
      h('p.about__text', { text: t('dialog.aboutText') }),
      h('ul.about__list', {}, [
        h('li', { text: 'MIT License · 零依赖 · 零构建' }),
        h('li', { text: 'IndexedDB 本地存储 · 数据不出浏览器' }),
        h('li', { text: 'Writer / Sheet / Deck 三件套，统一 .trio 格式' }),
      ]),
    ]),
    actions: [
      { label: t('menu.shortcuts'), onClick: () => { showShortcuts(); } },
      { label: t('common.close'), variant: 'primary' },
    ],
  });
}

/** 快捷键说明 */
export function showShortcuts() {
  const rows = SHORTCUTS.map(([keys, label]) => h('div.shortcut', {}, [
    h('kbd', { text: keys }),
    h('span', { text: label }),
  ]));
  openDialog({
    title: t('dialog.shortcuts'),
    width: 520,
    body: h('div.shortcuts', {}, rows),
    actions: [{ label: t('common.close'), variant: 'primary' }],
  });
}

const SHORTCUTS = [
  ['Ctrl/⌘ + S', '保存 / Save'],
  ['Ctrl/⌘ + Z / Shift+Z', '撤销 / 重做 · Undo / Redo'],
  ['Ctrl/⌘ + B / I / U', '加粗 / 斜体 / 下划线'],
  ['Ctrl/⌘ + F', '查找替换 · Find'],
  ['Ctrl/⌘ + A', '全选 · Select all'],
  ['Enter / Tab', '确认并下移 / 右移'],
  ['F2', '编辑当前单元格'],
  ['Alt + Enter', '单元格内换行'],
  ['方向键 + Shift', '扩展选区'],
  ['Ctrl/⌘ + 方向键', '跳到数据边界'],
  ['Esc', '取消编辑 / 退出放映'],
  ['Ctrl/⌘ + P', '打印 / 导出 PDF'],
];
