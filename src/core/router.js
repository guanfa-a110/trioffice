/**
 * router.js —— 极简哈希路由：#/home、#/doc/:id、#/sheet/:id、#/deck/:id
 */
import { bus } from './bus.js';

export class Router {
  /** @param {(route: {name: string, params: string[], hash: string}) => void} handler */
  constructor(handler) {
    this.handler = handler;
    this.current = null;
    this.onHashChange = () => this.resolve();
  }

  start() {
    window.addEventListener('hashchange', this.onHashChange);
    this.resolve();
    return this;
  }

  stop() {
    window.removeEventListener('hashchange', this.onHashChange);
  }

  /** 解析当前 hash */
  parse() {
    const raw = (window.location.hash || '#/home').replace(/^#/, '');
    const clean = raw.split('?')[0];
    const parts = clean.split('/').filter(Boolean);
    return { name: parts[0] || 'home', params: parts.slice(1), hash: clean };
  }

  resolve() {
    const route = this.parse();
    this.current = route;
    this.handler(route);
    bus.emit('route:changed', route);
    return route;
  }

  /** 跳转（不触发重复渲染） */
  go(name, ...params) {
    const hash = `#/${[name, ...params].filter(Boolean).join('/')}`;
    if (window.location.hash === hash) {
      this.resolve();
    } else {
      window.location.hash = hash;
    }
  }
}
