/**
 * idb.js —— 极简 IndexedDB 封装（Promise 化），带内存兜底。
 * 在 Node / 隐私模式下自动退化为 Map 存储，保证业务逻辑不崩。
 */

const DB_NAME = 'trioffice';
const DB_VERSION = 1;
const STORE = 'docs';

/** 内存兜底实现，接口与 IndexedDB 版本一致 */
class MemoryDriver {
  constructor() {
    this.map = new Map();
  }
  async all() {
    return [...this.map.values()];
  }
  async get(key) {
    return this.map.get(key) ?? null;
  }
  async put(record) {
    this.map.set(record.id, structuredCloneSafe(record));
    return record.id;
  }
  async delete(key) {
    this.map.delete(key);
  }
  async clear() {
    this.map.clear();
  }
  async usage() {
    return { usage: 0, quota: 0, driver: 'memory' };
  }
}

/** IndexedDB 驱动 */
class IdbDriver {
  constructor(db) {
    this.db = db;
  }

  static async open() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('type', 'type');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new IdbDriver(db);
  }

  tx(mode = 'readonly') {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async all() {
    return this.req(this.tx().getAll());
  }
  async get(key) {
    return (await this.req(this.tx().get(key))) ?? null;
  }
  async put(record) {
    await this.req(this.tx('readwrite').put(record));
    return record.id;
  }
  async delete(key) {
    await this.req(this.tx('readwrite').delete(key));
  }
  async clear() {
    await this.req(this.tx('readwrite').clear());
  }
  async usage() {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota, driver: 'indexeddb' };
    }
    return { usage: 0, quota: 0, driver: 'indexeddb' };
  }
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

let driverPromise = null;

/** 获取（并缓存）驱动实例 */
export function getDriver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      try {
        if (typeof indexedDB === 'undefined') return new MemoryDriver();
        return await IdbDriver.open();
      } catch (err) {
        console.warn('[idb] 无法使用 IndexedDB，已退化为内存存储：', err);
        return new MemoryDriver();
      }
    })();
  }
  return driverPromise;
}

/** 仅供测试：注入自定义驱动 */
export function setDriver(driver) {
  driverPromise = Promise.resolve(driver);
}

export { MemoryDriver };
