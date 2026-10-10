/**
 * bus.js —— 极简事件总线，用于跨模块解耦。
 */
export class Bus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * 订阅事件，返回取消订阅函数。
   * @param {string} type
   * @param {(payload:any, type:string)=>void} handler
   */
  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  /** 只触发一次 */
  once(type, handler) {
    const off = this.on(type, (payload, t) => {
      off();
      handler(payload, t);
    });
    return off;
  }

  off(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  /** 广播事件；监听器异常不会影响其他监听器 */
  emit(type, payload) {
    const direct = this.listeners.get(type);
    if (direct) for (const handler of [...direct]) safely(handler, payload, type);
    const all = this.listeners.get('*');
    if (all) for (const handler of [...all]) safely(handler, payload, type);
    return payload;
  }
}

function safely(handler, payload, type) {
  try {
    handler(payload, type);
  } catch (err) {
    console.error(`[bus] 监听器处理 "${type}" 时出错:`, err);
  }
}

/** 全局事件名常量，避免拼写错误 */
export const EVENTS = {
  DOC_OPENED: 'doc:opened',
  DOC_SAVED: 'doc:saved',
  DOC_CHANGED: 'doc:changed',
  DOC_DELETED: 'doc:deleted',
  DOC_LIST_CHANGED: 'doc:list-changed',
  THEME_CHANGED: 'ui:theme',
  LANG_CHANGED: 'ui:lang',
  STATUS: 'ui:status',
  ERROR: 'ui:error',
};

/** 应用级单例总线 */
export const bus = new Bus();
