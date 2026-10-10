/**
 * history.js —— 通用撤销/重做栈（快照式）。
 *
 * 用法：
 *   const history = new History({ limit: 100, onChange: (h) => render(h) });
 *   history.reset(currentState);
 *   history.commit('输入文字', nextState);   // 一次性提交
 *   history.undo(); history.redo();
 *
 * 快照用结构化克隆保存，避免调用方后续修改污染历史。
 */
export class History {
  /**
   * @param {{limit?: number, onChange?: (info: {canUndo: boolean, canRedo: boolean, label: string}) => void}} [options]
   */
  constructor(options = {}) {
    this.limit = options.limit ?? 120;
    this.onChange = options.onChange || (() => {});
    /** @type {{label: string, state: any}[]} */
    this.past = [];
    /** @type {{label: string, state: any}[]} */
    this.future = [];
    this.present = null;
    this.label = '';
    this.mergeWindow = options.mergeWindow ?? 900;
    this.lastCommitAt = 0;
  }

  /** 重置历史（切换文档时调用） */
  reset(state) {
    this.past = [];
    this.future = [];
    this.present = clone(state);
    this.label = '';
    this.lastCommitAt = 0;
    this.emit();
    return this;
  }

  /**
   * 提交一个新状态。
   * @param {string} label 操作名（用于 UI 提示）
   * @param {any} state 提交后的完整状态
   * @param {{merge?: boolean}} [opts] merge=true 时，若与上次提交同 label 且在时间窗内则合并
   */
  commit(label, state, opts = {}) {
    if (this.present === null) {
      this.reset(state);
      return this;
    }
    const now = Date.now();
    const canMerge = opts.merge !== false
      && label === this.label
      && now - this.lastCommitAt < this.mergeWindow
      && this.past.length > 0;
    if (!canMerge) this.past.push({ label: this.label || label, state: this.present });
    if (this.past.length > this.limit) this.past.shift();
    this.present = clone(state);
    this.label = label;
    this.lastCommitAt = now;
    this.future = [];
    this.emit();
    return this;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get undoLabel() {
    return this.past.length ? this.past[this.past.length - 1].label : '';
  }
  get redoLabel() {
    return this.future.length ? this.future[this.future.length - 1].label : '';
  }

  /** 撤销：返回上一个状态，若无则返回 null */
  undo() {
    if (!this.past.length) return null;
    const entry = this.past.pop();
    this.future.push({ label: this.label || entry.label, state: this.present });
    this.present = entry.state;
    this.label = entry.label;
    this.lastCommitAt = 0;
    this.emit();
    return clone(this.present);
  }

  /** 重做 */
  redo() {
    if (!this.future.length) return null;
    const entry = this.future.pop();
    this.past.push({ label: this.label || entry.label, state: this.present });
    this.present = entry.state;
    this.label = entry.label;
    this.lastCommitAt = 0;
    this.emit();
    return clone(this.present);
  }

  /** 只更新状态但不入栈（例如初始化、外部同步） */
  replace(state) {
    this.present = clone(state);
    this.lastCommitAt = 0;
    return this;
  }

  emit() {
    this.onChange({ canUndo: this.canUndo, canRedo: this.canRedo, label: this.label });
  }
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}
