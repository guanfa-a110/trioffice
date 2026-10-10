/**
 * main.js —— 应用入口：主题、路由、页面挂载与保存编排。
 */
import { clear } from './core/dom.js';
import { t } from './core/i18n.js';
import { Router } from './core/router.js';
import { store } from './core/store.js';
import { toast, toastError } from './core/ui.js';
import { bus, EVENTS } from './core/bus.js';
import { initTheme } from './shell/frame.js';
import { mountHome } from './shell/home.js';
import { mountWriterApp } from './apps/writer/index.js';
import { mountSheetApp } from './apps/sheet/index.js';
import { mountDeckApp } from './apps/deck/index.js';
import { markdownToHtml } from './apps/writer/markdown.js';

const MOUNTERS = {
  doc: mountWriterApp,
  sheet: mountSheetApp,
  deck: mountDeckApp,
};

let currentApp = null;
let homeView = null;
/** @type {HTMLElement|null} */
let rootEl = null;

/** 惰性获取挂载点，保证模块在无 DOM 环境下也能被导入（单测用） */
function root() {
  if (!rootEl) rootEl = document.getElementById('app');
  return rootEl;
}

/* ------------------------------------------------------------------ *
 * 视图切换
 * ------------------------------------------------------------------ */
function unmount() {
  if (currentApp) {
    try {
      currentApp.destroy?.();
    } catch (err) {
      console.error('[main] 卸载应用失败', err);
    }
    currentApp = null;
  }
  if (homeView) {
    homeView.destroy?.();
    homeView = null;
  }
  clear(root());
  if (document.body.classList.contains('is-presenting')) document.body.classList.remove('is-presenting');
}

function showHome() {
  unmount();
  document.title = `${t('app.name')} · ${t('app.tagline')}`;
  homeView = mountHome({
    onOpen: (doc) => router.go(doc.type, doc.id),
    onCreate: async (type, data, title) => {
      const created = await store.create(type, { data: data ?? defaultDataFor(type), title: title || undefined });
      return created;
    },
  });
  root().appendChild(homeView.el);
}

function defaultDataFor(type) {
  if (type === 'doc') return { html: '<h1>未命名文档</h1><p></p>', footer: '', pageSize: 'a4', orientation: 'portrait' };
  if (type === 'sheet') return null;
  return null;
}

async function showDocument(type, id) {
  const doc = await store.get(id);
  if (!doc) {
    toast(t('home.empty'), 'warn');
    router.go('home');
    return;
  }
  unmount();
  document.title = `${doc.title} · ${t('app.name')}`;
  const mounter = MOUNTERS[doc.type] || mountWriterApp;
  currentApp = mounter({
    doc,
    onSave: (payload) => handleSave(payload),
    onClose: () => router.go('home'),
  });
  root().appendChild(currentApp.el);
  bus.emit(EVENTS.DOC_OPENED, doc);
}

/** 统一的保存入口：普通保存 + 「另存为副本」 */
async function handleSave(payload) {
  if (!payload) return null;
  if (payload.__duplicate) {
    const { __duplicate, ...rest } = payload;
    void __duplicate;
    const copy = await store.create(rest.type, {
      title: `${rest.title} 副本`,
      data: rest.data,
      stats: rest.stats,
      preview: rest.preview,
    });
    toastSuccess(t('toast.duplicated'));
    return copy;
  }
  const { __duplicate, ...doc } = payload;
  void __duplicate;
  try {
    const saved = await store.save(doc);
    document.title = `${saved.title} · ${t('app.name')}`;
    return saved;
  } catch (err) {
    toastError(t('toast.saveFailed', { msg: err.message }));
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 首次使用：生成一篇欢迎文档
 * ------------------------------------------------------------------ */
async function ensureWelcomeDoc() {
  let welcomed = null;
  try {
    welcomed = localStorage.getItem('trioffice.welcomed');
  } catch { /* ignore */ }
  if (welcomed) return;
  const docs = await store.list();
  if (docs.length) {
    try {
      localStorage.setItem('trioffice.welcomed', '1');
    } catch { /* ignore */ }
    return;
  }
  const html = markdownToHtml(WELCOME_MARKDOWN);
  await store.create('doc', {
    title: '欢迎使用 TriOffice',
    data: { html, footer: 'TriOffice · 本地运行，数据不出浏览器', pageSize: 'a4', orientation: 'portrait' },
    stats: { words: 320 },
    preview: '零依赖的开源办公三件套：Writer / Sheet / Deck',
  });
  try {
    localStorage.setItem('trioffice.welcomed', '1');
  } catch { /* ignore */ }
}

const WELCOME_MARKDOWN = `# 欢迎使用 TriOffice 👋

**TriOffice** 是一套零依赖、纯前端的开源办公三件套 —— 文档、表格、演示，全部跑在浏览器里，不需要后端、不上传数据。

## 三件套能做什么

- **Writer 文档**：富文本排版、大纲导航、表格与图片，导出 Markdown / HTML / PDF
- **Sheet 表格**：202 个公式函数、图表、CSV 与 XLSX 导入导出、冻结窗格与条件排序
- **Deck 演示**：拖拽式幻灯片编辑、5 套主题、全屏放映、导出独立 HTML

## 快速上手

1. 回到工作台，点任一卡片新建文件
2. 也可以用「模板」一键生成会议纪要、预算表、项目汇报
3. 所有文件都保存在浏览器本地（IndexedDB），用「备份全部」导出成一份 JSON

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 保存 | Ctrl / ⌘ + S |
| 撤销 / 重做 | Ctrl / ⌘ + Z 、Shift + Ctrl / ⌘ + Z |
| 查找替换 | Ctrl / ⌘ + F |
| 放映演示 | F5 |

> 提示：把这份文档留着当备忘，或者直接删掉 —— 它只是用来打个招呼。

祝使用愉快！
`;

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function boot() {
  initTheme();
  document.documentElement.setAttribute('lang', (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');

  const router = new Router((route) => {
    if (route.name === 'doc' || route.name === 'sheet' || route.name === 'deck') {
      if (!route.params[0]) {
        router.go('home');
        return;
      }
      showDocument(route.name, route.params[0]);
      return;
    }
    showHome();
  });

  ensureWelcomeDoc().finally(() => router.start());

  window.addEventListener('beforeunload', (event) => {
    const dirty = currentApp?.isDirty?.();
    if (dirty) {
      event.preventDefault();
      event.returnValue = t('common.unsaved');
      return t('common.unsaved');
    }
    return undefined;
  });

  window.addEventListener('error', (event) => {
    console.error('[trioffice] 未捕获异常', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[trioffice] Promise 未处理', event.reason);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

export { boot };
