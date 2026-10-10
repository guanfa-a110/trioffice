/**
 * format.js —— 统一文件格式 `.trio` 与导入/导出插件注册表。
 *
 * `.trio` 是一个 UTF-8 JSON 文本文件：
 * {
 *   "format": "trio/1",
 *   "app": "TriOffice",
 *   "type": "doc" | "sheet" | "deck",
 *   "title": "季度报告",
 *   "createdAt": 1699999999999,
 *   "updatedAt": 1699999999999,
 *   "data": { ...应用私有模型... }
 * }
 *
 * 各应用通过 registerExporter / registerImporter 自我注册，
 * 工作台与菜单只面向注册表，不需要知道具体实现。
 */
import { normalizeDoc, makePreview, newId } from './store.js';
import { readText, readArrayBuffer } from './fileio.js';

export const TRIO_FORMAT = 'trio/1';

/** 导出格式注册表：type -> [{id, label, ext, mime, run}] */
const exporters = new Map();
/** 导入格式注册表：ext -> { handler, priority } */
const importers = new Map();

/**
 * 注册导出器。
 * @param {'doc'|'sheet'|'deck'} type
 * @param {{id: string, label: string, ext: string, mime: string, run: (doc:any)=>Promise<{filename:string,content:any,mime?:string}>|{filename:string,content:any,mime?:string}}} exporter
 */
export function registerExporter(type, exporter) {
  if (!exporters.has(type)) exporters.set(type, []);
  exporters.get(type).push(exporter);
}

/** 列出某类型可用的导出格式 */
export function listExporters(type) {
  return exporters.get(type) || [];
}

/** 找到某个导出器 */
export function findExporter(type, id) {
  return listExporters(type).find((item) => item.id === id) || null;
}

/**
 * 注册导入器。
 *
 * 同一个扩展名可以被多个应用注册（例如 .md 既能当文档也能当演示大纲），
 * 这时 priority 高的一方生效；默认 0，先到先得。
 *
 * @param {string[]} exts 例如 ['csv', 'tsv']
 * @param {(file: File, ctx: {text: string, buffer: ArrayBuffer}) => Promise<{type:string,title:string,data:any}>} handler
 * @param {{priority?: number}} [options]
 */
export function registerImporter(exts, handler, options = {}) {
  const priority = Number(options.priority) || 0;
  for (const ext of exts) {
    const key = ext.toLowerCase();
    const existing = importers.get(key);
    if (existing && existing.priority >= priority) continue;
    importers.set(key, { handler, priority });
  }
}

/** 查询某个扩展名的导入器（测试与调试用） */
export function findImporter(ext) {
  return importers.get(String(ext).toLowerCase())?.handler || null;
}

/** 所有可导入的扩展名（给 file input 的 accept 用） */
export function importableExtensions() {
  return [...importers.keys()];
}

/** 序列化为 .trio 文本 */
export function serializeDoc(doc) {
  const payload = {
    format: TRIO_FORMAT,
    app: 'TriOffice',
    version: '0.1.0',
    type: doc.type,
    title: doc.title,
    createdAt: doc.createdAt || Date.now(),
    updatedAt: doc.updatedAt || Date.now(),
    stats: doc.stats || undefined,
    preview: doc.preview || undefined,
    data: doc.data,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 解析 .trio 文本（也容忍纯 JSON 的 { type, data } 结构）。
 * @returns {{type:string,title:string,data:any,createdAt:number,updatedAt:number}}
 */
export function parseDoc(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error('文件不是有效的 JSON / .trio 内容');
  }
  if (!raw || typeof raw !== 'object') throw new Error('文件内容为空');
  const type = ['doc', 'sheet', 'deck'].includes(raw.type) ? raw.type : null;
  if (!type) throw new Error('无法识别的文档类型（缺少 type 字段）');
  return {
    type,
    title: String(raw.title || '').trim() || '未命名',
    data: raw.data ?? null,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    preview: raw.preview,
    stats: raw.stats,
  };
}

/**
 * 依据文件自动选择导入器。
 * @param {File} file
 * @returns {Promise<{doc: object, source: string}>}
 */
export async function importFile(file) {
  const name = file.name || 'untitled';
  const ext = (name.split('.').pop() || '').toLowerCase();

  // 原生格式优先：扩展名 + 魔数双保险
  const isNative = ext === 'trio' || ext === 'json';
  const looksNative = isNative || /^\s*\{/.test(await peek(file));

  if (looksNative && (ext === 'trio' || ext === 'json' || ext === '')) {
    const text = await readText(file);
    const parsed = parseDoc(text);
    return { doc: finalize(parsed, name), source: 'trio' };
  }

  const entry = importers.get(ext);
  const handler = entry?.handler;
  if (!handler) {
    if (looksNative) {
      const text = await readText(file);
      const parsed = parseDoc(text);
      return { doc: finalize(parsed, name), source: 'trio' };
    }
    throw new Error(`暂不支持 .${ext} 文件的导入`);
  }

  const ctx = {
    get text() {
      return readText(file);
    },
    get buffer() {
      return readArrayBuffer(file);
    },
  };
  const result = await handler(file, ctx);
  return { doc: finalize({ ...result, title: result.title || stripExt(name) }, name), source: ext };
}

/** 读取文件前 200 字节用于判断类型 */
async function peek(file) {
  try {
    const slice = file.slice(0, 200);
    return (await slice.text()).replace(/^\ufeff/, '');
  } catch {
    return '';
  }
}

function finalize(parsed, filename) {
  const doc = normalizeDoc({
    id: newId(parsed.type === 'doc' ? 'doc' : parsed.type),
    type: parsed.type,
    title: parsed.title || stripExt(filename),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    data: parsed.data,
    stats: parsed.stats,
    preview: parsed.preview || '',
  });
  return doc;
}

function stripExt(name) {
  return String(name).replace(/\.[^.]+$/, '');
}

/** 统计预览文本（把 HTML 粗粒度转成纯文本） */
export function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

/** 统一计算预览与统计信息 */
export function withPreview(doc, text, stats) {
  return { ...doc, preview: makePreview(text), stats: { ...doc.stats, ...stats } };
}

/** 备份所有文档为 JSON */
export function buildBackup(docs) {
  return JSON.stringify({
    format: TRIO_FORMAT,
    app: 'TriOffice',
    kind: 'backup',
    exportedAt: Date.now(),
    count: docs.length,
    docs: docs.map((doc) => ({
      type: doc.type,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      data: doc.data,
    })),
  }, null, 2);
}

/** 解析备份文件 */
export function parseBackup(text) {
  const raw = JSON.parse(text);
  if (!raw || !Array.isArray(raw.docs)) throw new Error('不是有效的 TriOffice 备份文件');
  return raw.docs.map((entry) => normalizeDoc({ ...entry, id: newId(entry.type) }));
}
