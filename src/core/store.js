/**
 * store.js —— 文档仓库：统一的元数据模型 + 持久化 + 变更广播。
 *
 * 一个“文档”无论属于哪个应用，都长这样：
 * {
 *   id: 'doc_x1y2', type: 'doc'|'sheet'|'deck',
 *   title: '未命名文档', pinned: false,
 *   createdAt: 1699999999999, updatedAt: 1699999999999,
 *   data: {...应用各自的文档模型...},
 *   preview: '前 120 字纯文本预览',
 *   stats: { words: 0, cells: 0, slides: 0 }
 * }
 */
import { getDriver } from './idb.js';
import { bus, EVENTS } from './bus.js';

export const DOC_TYPES = {
  doc: { icon: 'doc', ext: 'trio', i18n: 'home.doc' },
  sheet: { icon: 'sheet', ext: 'trio', i18n: 'home.sheet' },
  deck: { icon: 'deck', ext: 'trio', i18n: 'home.deck' },
};

/** 生成短 id */
export function newId(prefix = 'doc') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 从纯文本生成预览 */
export function makePreview(text, limit = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 规范化一条记录，保证字段完整（兼容旧数据 / 手工导入的文件） */
export function normalizeDoc(raw) {
  const now = Date.now();
  const type = DOC_TYPES[raw?.type] ? raw.type : 'doc';
  return {
    id: raw?.id || newId(type === 'doc' ? 'txt' : type),
    type,
    title: String(raw?.title || '').trim() || '未命名',
    pinned: Boolean(raw?.pinned),
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
    preview: String(raw?.preview || ''),
    stats: { words: 0, cells: 0, slides: 0, ...(raw?.stats || {}) },
    data: raw?.data ?? null,
    schema: raw?.schema || 'trio/1',
  };
}

/** 文档仓库 */
export const store = {
  /** 拉取全部文档，按置顶 + 更新时间排序 */
  async list() {
    const driver = await getDriver();
    const all = (await driver.all()).map(normalizeDoc);
    return all.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  },

  async get(id) {
    const driver = await getDriver();
    const record = await driver.get(id);
    return record ? normalizeDoc(record) : null;
  },

  /** 新建空文档骨架 */
  async create(type, patch = {}) {
    const doc = normalizeDoc({
      id: newId(type === 'doc' ? 'doc' : type === 'sheet' ? 'sheet' : 'deck'),
      type,
      title: patch.title || defaultTitle(type),
      data: patch.data ?? null,
      ...patch,
    });
    await this.save(doc, { silent: true });
    bus.emit(EVENTS.DOC_LIST_CHANGED, { reason: 'create', id: doc.id });
    return doc;
  },

  /** 保存（全量写入） */
  async save(doc, options = {}) {
    const driver = await getDriver();
    const record = normalizeDoc({ ...doc, updatedAt: Date.now() });
    await driver.put(record);
    if (!options.silent) {
      bus.emit(EVENTS.DOC_SAVED, { id: record.id, doc: record });
      bus.emit(EVENTS.DOC_LIST_CHANGED, { reason: 'save', id: record.id });
    }
    return record;
  },

  async remove(id) {
    const driver = await getDriver();
    await driver.delete(id);
    bus.emit(EVENTS.DOC_DELETED, { id });
    bus.emit(EVENTS.DOC_LIST_CHANGED, { reason: 'delete', id });
  },

  /** 创建副本（含深拷贝，避免两个文档共享同一 data 引用） */
  async duplicate(id) {
    const source = await this.get(id);
    if (!source) return null;
    const copy = normalizeDoc({
      ...source,
      id: newId(source.type),
      title: `${source.title} ${copySuffix()}`,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      data: deepClone(source.data),
    });
    await this.save(copy);
    return copy;
  },

  async setPinned(id, pinned) {
    const doc = await this.get(id);
    if (!doc) return null;
    doc.pinned = pinned;
    await this.save(doc);
    return doc;
  },

  async rename(id, title) {
    const doc = await this.get(id);
    if (!doc) return null;
    doc.title = String(title || '').trim() || doc.title;
    await this.save(doc);
    return doc;
  },

  async clear() {
    const driver = await getDriver();
    await driver.clear();
    bus.emit(EVENTS.DOC_LIST_CHANGED, { reason: 'clear' });
  },

  async usage() {
    const driver = await getDriver();
    return driver.usage();
  },
};

function defaultTitle(type) {
  if (type === 'sheet') return '未命名表格';
  if (type === 'deck') return '未命名演示';
  return '未命名文档';
}

function copySuffix() {
  return typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh')
    ? '副本'
    : 'copy';
}

/** 结构化深拷贝（优先原生 API） */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}
