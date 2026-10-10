/**
 * home.js —— 工作台：新建、最近文件、模板、导入/备份、搜索排序、主题与语言。
 */
import { h, clear, debounce } from '../core/dom.js';
import { t, lang, setLang, LANGS, fmtRelative, fmtDate } from '../core/i18n.js';
import { button, openMenu, confirmDialog, promptDialog, toast, toastError, toastSuccess, icon, segmented, formatBytes, emptyState } from '../core/ui.js';
import { bus, EVENTS } from '../core/bus.js';
import { store, DOC_TYPES } from '../core/store.js';
import { listExporters, findExporter, importFile, buildBackup, parseBackup } from '../core/format.js';
import { download, safeFileName, pickFiles } from '../core/fileio.js';
import { applyTheme, showAbout, showShortcuts } from './frame.js';
import { TEMPLATES } from './templates.js';

/* ------------------------------------------------------------------ *
 * 新建文档的默认内容
 * ------------------------------------------------------------------ */
function defaultDataFor(type) {
  return null;
}

/**
 * 挂载工作台。
 * @param {{onOpen: (doc: any) => void, onCreate: (type: string, data?: any, title?: string) => Promise<any>}} options
 */
export function mountHome({ onOpen, onCreate }) {
  let docs = [];
  let view = loadPreference('trioffice.home.view', 'grid');
  let sortMode = loadPreference('trioffice.home.sort', 'updated');
  let keyword = '';

  const searchInput = h('input.home__search-input', {
    type: 'search',
    placeholder: t('home.search'),
    spellcheck: 'false',
    oninput: debounce((event) => {
      keyword = event.target.value.trim().toLowerCase();
      renderRecent();
    }, 160),
  });

  const recentGrid = h('div.home__recent-body');
  const newCards = h('div.home__new-cards');
  const templateRow = h('div.home__templates');
  const storageLabel = h('span.home__storage');

  const root = h('div.home', {}, [
    buildHero(),
    h('section.home__section', {}, [
      h('div.home__section-head', {}, [
        h('h2.home__section-title', { text: t('home.new') }),
        h('div.home__section-actions', {}, [
          button({ icon: 'upload', label: t('home.import'), variant: 'ghost', onClick: () => importDocuments() }),
          button({ icon: 'download', label: t('home.exportAll'), variant: 'ghost', onClick: () => backupAll() }),
        ]),
      ]),
      newCards,
    ]),
    h('section.home__section', {}, [
      h('div.home__section-head', {}, [
        h('h2.home__section-title', { text: t('home.templates') }),
        h('span.home__hint', { text: '一键生成常用文档骨架' }),
      ]),
      templateRow,
    ]),
    h('section.home__section', {}, [
      h('div.home__section-head', {}, [
        h('h2.home__section-title', { text: t('home.recent') }),
        h('div.home__section-actions', {}, [
          searchInput,
          segmented([
            { value: 'grid', title: t('home.grid'), icon: 'grid' },
            { value: 'list', title: t('home.list'), icon: 'align-left' },
          ], view, (value) => {
            view = value;
            savePreference('trioffice.home.view', value);
            recentGrid.className = `home__recent-body is-${view}`;
          }),
          button({
            icon: 'sort-asc',
            title: t('home.sortBy'),
            variant: 'ghost',
            onClick: (event) => openMenu(event.currentTarget, [
              { label: t('home.sortUpdated'), checked: sortMode === 'updated', onClick: () => setSort('updated') },
              { label: t('home.sortCreated'), checked: sortMode === 'created', onClick: () => setSort('created') },
              { label: t('home.sortName'), checked: sortMode === 'name', onClick: () => setSort('name') },
            ], { align: 'right' }),
          }),
        ]),
      ]),
      recentGrid,
    ]),
    h('footer.home__footer', {}, [
      h('span', { text: `${t('app.name')} 0.1.0 · MIT License · 数据保存在本地浏览器` }),
      h('span.home__footer-right', {}, [
        storageLabel,
        button({ icon: 'info', label: t('menu.shortcuts'), variant: 'ghost', onClick: () => showShortcuts() }),
        button({ icon: 'info', label: t('dialog.about'), variant: 'ghost', onClick: () => showAbout() }),
      ]),
    ]),
  ]);

  /* ---------- 顶部 ---------- */
  function buildHero() {
    return h('header.home__hero', {}, [
      h('div.home__hero-main', {}, [
        h('div.home__logo', {}, [icon('deck', { size: 30 })]),
        h('div', {}, [
          h('h1.home__title', { text: t('app.name') }),
          h('p.home__tagline', { text: t('app.tagline') }),
          h('p.home__subtitle', { text: t('app.subtitle') }),
        ]),
      ]),
      h('div.home__hero-actions', {}, [
        themeToggleButton(),
        button({
          icon: 'globe',
          label: lang() === 'zh' ? '简体中文' : 'English',
          variant: 'ghost',
          onClick: (event) => openMenu(event.currentTarget, LANGS.map((item) => ({
            label: item.label,
            checked: item.code === lang(),
            onClick: () => {
              setLang(item.code);
              render();
            },
          })), { align: 'right' }),
        }),
      ]),
    ]);
  }

  function themeToggleButton() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    return button({
      icon: isDark ? 'sun' : 'moon',
      label: isDark ? t('menu.light') : t('menu.theme'),
      variant: 'ghost',
      onClick: (event) => {
        applyTheme(isDark ? 'light' : 'dark');
        event.currentTarget.replaceWith(themeToggleButton());
      },
    });
  }

  /* ---------- 新建卡片 ---------- */
  function renderNewCards() {
    clear(newCards);
    const cards = [
      { type: 'doc', icon: 'doc', title: t('home.doc'), desc: t('home.docDesc'), tone: 'doc' },
      { type: 'sheet', icon: 'sheet', title: t('home.sheet'), desc: t('home.sheetDesc'), tone: 'sheet' },
      { type: 'deck', icon: 'deck', title: t('home.deck'), desc: t('home.deckDesc'), tone: 'deck' },
    ];
    for (const card of cards) {
      newCards.appendChild(h('button', {
        class: `home__new-card is-${card.tone}`,
        type: 'button',
        onclick: () => createAndOpen(card.type),
      }, [
        h('span.home__new-icon', {}, [icon(card.icon, { size: 24 })]),
        h('span.home__new-title', { text: card.title }),
        h('span.home__new-desc', { text: card.desc }),
        h('span.home__new-cta', {}, [h('span', { text: t('home.open') }), icon('chevron-right', { size: 14 })]),
      ]));
    }
  }

  /* ---------- 模板 ---------- */
  function renderTemplates() {
    clear(templateRow);
    for (const template of TEMPLATES) {
      templateRow.appendChild(h('button.home__template', {
        type: 'button',
        onclick: async () => {
          const data = template.build();
          await createAndOpen(template.type, data, template.name);
        },
      }, [
        h('span.home__template-icon', {}, [icon(template.icon, { size: 18 })]),
        h('span.home__template-body', {}, [
          h('span.home__template-name', { text: template.name }),
          h('span.home__template-hint', { text: template.hint }),
        ]),
      ]));
    }
  }

  /* ---------- 最近文件 ---------- */
  function visibleDocs() {
    let list = [...docs];
    if (keyword) {
      list = list.filter((doc) => `${doc.title} ${doc.preview || ''}`.toLowerCase().includes(keyword));
    }
    const comparators = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt,
      name: (a, b) => a.title.localeCompare(b.title, 'zh-CN'),
    };
    return list.sort(comparators[sortMode] || comparators.updated);
  }

  function renderRecent() {
    clear(recentGrid);
    recentGrid.className = `home__recent-body is-${view}`;
    const list = visibleDocs();
    if (!list.length) {
      recentGrid.appendChild(emptyState('folder', keyword ? '没有匹配的文件' : t('home.empty'), keyword ? '换个关键词试试' : t('home.importTip')));
      return;
    }
    for (const doc of list) recentGrid.appendChild(doc.type === 'doc' && view === 'list' ? buildListRow(doc) : buildCard(doc));
  }

  function buildCard(doc) {
    const meta = DOC_TYPES[doc.type] || DOC_TYPES.doc;
    const statsText = doc.type === 'sheet'
      ? `${doc.stats?.cells || 0} ${t('home.cells')}`
      : doc.type === 'deck'
        ? `${doc.stats?.slides || 0} ${t('home.slides')}`
        : `${doc.stats?.words || 0} ${t('home.words')}`;

    const card = h('article', { class: ['home__card', doc.pinned ? 'is-pinned' : ''].filter(Boolean).join(' ') }, [
      h('div.home__card-top', {}, [
        h('span.home__card-icon', { class: `is-${doc.type}` }, [icon(meta.icon, { size: 18 })]),
        h('span.home__card-type', { text: t(meta.i18n) }),
        doc.pinned ? h('span.home__card-pin', { title: t('home.unpin') }, [icon('pin', { size: 14 })]) : null,
        button({
          icon: 'more',
          title: t('home.open'),
          variant: 'icon',
          onClick: (event) => {
            event.stopPropagation();
            docMenu(event.currentTarget, doc);
          },
        }),
      ]),
      h('h3.home__card-title', { text: doc.title }),
      h('p.home__card-preview', { text: doc.preview || '（空白文档）' }),
      h('div.home__card-foot', {}, [
        h('span', { text: fmtRelative(doc.updatedAt) }),
        h('span', { text: statsText }),
      ]),
    ]);
    card.addEventListener('click', () => onOpen(doc));
    return card;
  }

  function buildListRow(doc) {
    const meta = DOC_TYPES[doc.type] || DOC_TYPES.doc;
    const row = h('div', { class: ['home__row', doc.pinned ? 'is-pinned' : ''].filter(Boolean).join(' ') }, [
      h('span.home__row-icon', { class: `is-${doc.type}` }, [icon(meta.icon, { size: 16 })]),
      h('span.home__row-title', { text: doc.title }),
      h('span.home__row-preview', { text: doc.preview || '（空白文档）' }),
      h('span.home__row-time', { text: fmtDate(doc.updatedAt, false) }),
      button({ icon: 'more', title: t('home.open'), variant: 'icon', onClick: (event) => { event.stopPropagation(); docMenu(event.currentTarget, doc); } }),
    ]);
    row.addEventListener('click', () => onOpen(doc));
    return row;
  }

  function docMenu(anchor, doc) {
    const exporters = listExporters(doc.type);
    openMenu(anchor, [
      { label: t('home.open'), icon: 'external', onClick: () => onOpen(doc) },
      { label: t('home.rename'), icon: 'pencil', onClick: () => renameDocument(doc) },
      { label: t('home.duplicate'), icon: 'copy', onClick: () => duplicateDocument(doc) },
      { label: doc.pinned ? t('home.unpin') : t('home.pin'), icon: 'pin', onClick: () => togglePin(doc) },
      { separator: true },
      { label: t('menu.export'), header: true },
      ...exporters.map((exporter) => ({
        label: exporter.label,
        onClick: () => exportDocument(doc, exporter.id),
      })),
      { separator: true },
      { label: t('home.delete'), icon: 'trash', danger: true, onClick: () => deleteDocument(doc) },
    ], { align: 'right', width: 240 });
  }

  /* ---------- 动作 ---------- */
  async function createAndOpen(type, data, title) {
    const doc = await onCreate?.(type, data, title);
    if (doc) onOpen(doc);
    return doc;
  }

  async function renameDocument(doc) {
    const title = await promptDialog({ title: t('home.rename'), value: doc.title, label: t('common.name') });
    if (title === null || !title.trim()) return;
    await store.rename(doc.id, title.trim());
    toastSuccess(t('toast.renamed'));
    await refresh();
  }

  async function duplicateDocument(doc) {
    const copy = await store.duplicate(doc.id);
    toastSuccess(t('toast.duplicated'));
    await refresh();
    if (copy) return copy;
    return null;
  }

  async function togglePin(doc) {
    await store.setPinned(doc.id, !doc.pinned);
    toastSuccess(doc.pinned ? t('toast.unpinned') : t('toast.pinned'));
    await refresh();
  }

  async function deleteDocument(doc) {
    const ok = await confirmDialog(t('common.confirmDelete', { name: doc.title }), { danger: true });
    if (!ok) return;
    await store.remove(doc.id);
    toastSuccess(t('toast.deleted'));
    await refresh();
  }

  async function exportDocument(doc, formatId) {
    const exporter = findExporter(doc.type, formatId);
    if (!exporter) return;
    try {
      const result = await exporter.run(doc);
      download(result.content, result.filename, result.mime || exporter.mime);
      toastSuccess(t('toast.exported', { name: result.filename }));
    } catch (err) {
      toastError(t('toast.importFailed', { msg: err.message }));
    }
  }

  async function importDocuments() {
    const files = await pickFiles({ accept: '.trio,.json,.md,.markdown,.html,.htm,.txt,.csv,.tsv,.xlsx', multiple: true });
    if (!files.length) return;
    let ok = 0;
    const failures = [];
    for (const file of files) {
      try {
        if (/\.json$/i.test(file.name)) {
          const text = await file.text();
          let parsedBackup = null;
          try {
            parsedBackup = parseBackup(text);
          } catch {
            parsedBackup = null;
          }
          if (parsedBackup) {
            for (const entry of parsedBackup) await store.save(entry, { silent: true });
            ok += parsedBackup.length;
            continue;
          }
        }
        const { doc } = await importFile(file);
        await store.save(doc, { silent: true });
        ok += 1;
      } catch (err) {
        failures.push(`${file.name}：${err.message}`);
      }
    }
    await refresh();
    if (ok) {
      bus.emit(EVENTS.DOC_LIST_CHANGED, { reason: 'import' });
      toastSuccess(t('toast.imported', { name: `${ok} 个文件` }));
    }
    if (failures.length) toastError(t('toast.importFailed', { msg: failures.join('；') }));
  }

  async function backupAll() {
    const all = await store.list();
    if (!all.length) {
      toast(t('home.empty'), 'warn');
      return;
    }
    download(buildBackup(all), safeFileName(`trioffice-backup-${new Date().toISOString().slice(0, 10)}`, 'json'), 'application/json');
    toastSuccess(t('toast.exported', { name: 'trioffice-backup.json' }));
  }

  function setSort(mode) {
    sortMode = mode;
    savePreference('trioffice.home.sort', mode);
    renderRecent();
  }

  /* ---------- 数据刷新 ---------- */
  async function refresh() {
    docs = await store.list();
    renderRecent();
    updateStorage();
  }

  async function updateStorage() {
    try {
      const usage = await store.usage();
      if (usage.usage) {
        storageLabel.textContent = `${t('dialog.storage')}: ${formatBytes(usage.usage)}`;
      } else {
        storageLabel.textContent = `${docs.length} 个文件`;
      }
    } catch {
      storageLabel.textContent = `${docs.length} 个文件`;
    }
  }

  function render() {
    clear(root);
    root.appendChild(buildHero());
    root.appendChild(h('section.home__section', {}, [
      h('div.home__section-head', {}, [
        h('h2.home__section-title', { text: t('home.new') }),
        h('div.home__section-actions', {}, [
          button({ icon: 'upload', label: t('home.import'), variant: 'ghost', onClick: () => importDocuments() }),
          button({ icon: 'download', label: t('home.exportAll'), variant: 'ghost', onClick: () => backupAll() }),
        ]),
      ]),
      newCards,
    ]));
    root.appendChild(h('section.home__section', {}, [
      h('div.home__section-head', {}, [
        h('h2.home__section-title', { text: t('home.templates') }),
        h('span.home__hint', { text: '一键生成常用文档骨架' }),
      ]),
      templateRow,
    ]));
    root.appendChild(h('section.home__section', {}, [
      h('div.home__section-head', {}, [
        h('h2.home__section-title', { text: t('home.recent') }),
        h('div.home__section-actions', {}, [
          searchInput,
          segmented([{ value: 'grid', title: t('home.grid'), icon: 'grid' }, { value: 'list', title: t('home.list'), icon: 'align-left' }], view, (value) => {
            view = value;
            savePreference('trioffice.home.view', value);
            renderRecent();
          }),
          button({
            icon: 'sort-asc',
            title: t('home.sortBy'),
            variant: 'ghost',
            onClick: (event) => openMenu(event.currentTarget, [
              { label: t('home.sortUpdated'), checked: sortMode === 'updated', onClick: () => setSort('updated') },
              { label: t('home.sortCreated'), checked: sortMode === 'created', onClick: () => setSort('created') },
              { label: t('home.sortName'), checked: sortMode === 'name', onClick: () => setSort('name') },
            ], { align: 'right' }),
          }),
        ]),
      ]),
      recentGrid,
    ]));
    root.appendChild(h('footer.home__footer', {}, [
      h('span', { text: `${t('app.name')} 0.1.0 · MIT License · 数据保存在本地浏览器` }),
      h('span.home__footer-right', {}, [
        storageLabel,
        button({ icon: 'info', label: t('menu.shortcuts'), variant: 'ghost', onClick: () => showShortcuts() }),
        button({ icon: 'info', label: t('dialog.about'), variant: 'ghost', onClick: () => showAbout() }),
      ]),
    ]));
    renderNewCards();
    renderTemplates();
    renderRecent();
    updateStorage();
  }

  /* ---------- 初始化 ---------- */
  render();
  const off = bus.on(EVENTS.DOC_LIST_CHANGED, () => refresh());
  const offLang = bus.on(EVENTS.LANG_CHANGED, () => render());

  return {
    el: root,
    refresh,
    destroy() {
      off();
      offLang();
    },
  };
}

function loadPreference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* ignore */ }
}
