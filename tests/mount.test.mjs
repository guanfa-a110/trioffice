/**
 * mount.test.mjs —— 在 DOM 影子环境里真正挂载三个应用与工作台。
 *
 * 这层测试专治「静态检查看不见、一打开浏览器就白屏」的问题：
 *   - TDZ（`let x` 声明晚于回调触发）
 *   - 拼错的标识符 / 不存在的全局
 *   - 挂载过程中抛出的任何异常
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomShim } from './dom-shim.mjs';
import { closeMenu } from '../src/core/ui.js';

/** 挂载过程中捕获到的真实错误（ReferenceError 一定是 bug） */
function captureFatal(run) {
  const failures = [];
  const onError = (event) => failures.push(event.error || new Error(String(event.message)));
  const originalError = console.error;
  console.error = (...args) => {
    const first = args[0];
    if (first instanceof Error && /before initialization|is not defined/.test(first.message)) failures.push(first);
  };
  try {
    run();
  } catch (err) {
    failures.push(err);
  } finally {
    console.error = originalError;
  }
  return failures;
}

test('工作台可以挂载并渲染出新建卡片', async () => {
  const dom = installDomShim();
  try {
    const { mountHome } = await import('../src/shell/home.js');
    const { MemoryDriver, setDriver } = await import('../src/core/idb.js');
    setDriver(new MemoryDriver());

    let view = null;
    const failures = captureFatal(() => {
      view = mountHome({ onOpen: () => {}, onCreate: async () => null });
      dom.appRoot.appendChild(view.el);
    });
    assert.deepEqual(failures.map((err) => err.message), [], '挂载过程不应抛错');
    assert.ok(view, '应返回视图对象');
    assert.equal(view.el.querySelectorAll('.home__new-card').length, 3, '应有三个新建入口');
    assert.ok(view.el.querySelectorAll('.home__template').length >= 3);
    view.destroy();
  } finally {
    dom.restore();
  }
});

test('Writer 应用可以挂载并渲染出编辑器', async () => {
  const dom = installDomShim();
  try {
    const { mountWriterApp } = await import('../src/apps/writer/index.js');
    const doc = { id: 'doc_test', type: 'doc', title: '测试文档', data: { html: '<h1>标题</h1><p>正文</p>' } };
    let app = null;
    const failures = captureFatal(() => {
      app = mountWriterApp({ doc, onSave: async () => {}, onClose: () => {} });
      dom.appRoot.appendChild(app.el);
    });
    assert.deepEqual(failures.map((err) => err.message), []);
    assert.ok(app.el.querySelector('.writer'), '应渲染出 .writer');
    assert.ok(app.el.querySelector('.writer__paper'), '应渲染出纸张');
    assert.ok(app.el.querySelector('.writer__outline'), '应渲染出大纲面板');
    const saved = await app.save();
    assert.equal(saved.type, 'doc');
    assert.equal(doc.title, '测试文档');
    app.destroy();
  } finally {
    dom.restore();
  }
});

test('Sheet 应用可以挂载、编辑、计算并保存', async () => {
  const dom = installDomShim();
  try {
    const { mountSheetApp } = await import('../src/apps/sheet/index.js');
    const doc = { id: 'sheet_test', type: 'sheet', title: '测试表格', data: null };
    let app = null;
    const failures = captureFatal(() => {
      app = mountSheetApp({ doc, onSave: async () => {}, onClose: () => {} });
      dom.appRoot.appendChild(app.el);
    });
    assert.deepEqual(failures.map((err) => err.message), []);
    assert.ok(app.el.querySelector('.sheet'), '应渲染出 .sheet');
    assert.ok(app.el.querySelector('.grid'), '应渲染出网格');
    assert.ok(app.el.querySelector('.sheet__formula-input'), '应渲染出公式栏');
    assert.ok(app.el.querySelectorAll('.sheet__tab').length >= 1, '应有工作表标签');
  } finally {
    dom.restore();
  }
});

test('Deck 应用可以挂载并渲染幻灯片与缩略图', async () => {
  const dom = installDomShim();
  try {
    const { mountDeckApp } = await import('../src/apps/deck/index.js');
    const doc = { id: 'deck_test', type: 'deck', title: '测试演示', data: null };
    let app = null;
    const failures = captureFatal(() => {
      app = mountDeckApp({ doc, onSave: async () => {}, onClose: () => {} });
      dom.appRoot.appendChild(app.el);
    });
    assert.deepEqual(failures.map((err) => err.message), []);
    assert.ok(app.el.querySelector('.deck'), '应渲染出 .deck');
    assert.ok(app.el.querySelector('.slide--canvas'), '应渲染出主画布');
    assert.ok(app.el.querySelectorAll('.deck__thumb').length >= 2, '应有缩略图列表');
    const saved = await app.save();
    assert.equal(saved.type, 'deck');
    assert.ok(saved.data.slides.length >= 2);
    app.destroy();
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * 交互冒烟：把工具栏按钮全点一遍 / 常用动作全跑一遍
 * ------------------------------------------------------------------ */

/** 等待挂起的 async 回调（导出、下载、提示条等）跑完，避免它们在影子环境卸载后才执行 */
async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 依次点击，收集异常（任何异常都要修，不允许忽略） */
function clickAll(container, selector, label) {
  const buttons = container.querySelectorAll(selector).filter((node) => {
    // 浏览器不会对 disabled 按钮派发 click 事件，这里保持一致
    if (node.disabled) return false;
    return true;
  });
  const failures = [];
  buttons.forEach((node, index) => {
    try {
      node.dispatchEvent({ type: 'click', target: node, currentTarget: node });
    } catch (err) {
      failures.push(`${label} 第 ${index + 1} 个按钮（${node.getAttribute('title') || node.textContent || '?'}）: ${err.message}`);
    }
  });
  return failures;
}

test('Sheet：点一遍全部工具栏按钮不报错', async () => {
  const dom = installDomShim();
  try {
    const { mountSheetApp } = await import('../src/apps/sheet/index.js');
    const doc = { id: 'sheet_click', type: 'sheet', title: '点测表格', data: null };
    const app = mountSheetApp({ doc, onSave: async () => {}, onClose: () => {} });
    dom.appRoot.appendChild(app.el);

    // 先往表里塞点数据，让按钮有东西可操作
    const sheet = app.__workbook;
    void sheet;
    const failures = clickAll(app.el, '.app__toolbar .btn', '表格工具栏');
    assert.deepEqual(failures, []);
    await settle();

    // 菜单项也要能打开
    app.el.querySelectorAll('.app__menu').forEach((node) => {
      node.dispatchEvent({ type: 'click', target: node, currentTarget: node });
    });
    await settle();
    closeMenu();

    const saved = await app.save();
    assert.equal(saved.type, 'sheet');
    app.destroy();
  } finally {
    dom.restore();
  }
});

test('Writer：点一遍全部工具栏按钮不报错', async () => {
  const dom = installDomShim();
  try {
    const { mountWriterApp } = await import('../src/apps/writer/index.js');
    const doc = { id: 'doc_click', type: 'doc', title: '点测文档', data: { html: '<h1>标题</h1><p>正文</p>' } };
    const app = mountWriterApp({ doc, onSave: async () => {}, onClose: () => {} });
    dom.appRoot.appendChild(app.el);
    const failures = clickAll(app.el, '.app__toolbar .btn', '文档工具栏');
    assert.deepEqual(failures, []);
    await settle();
    app.el.querySelectorAll('.app__menu').forEach((node) => {
      node.dispatchEvent({ type: 'click', target: node, currentTarget: node });
    });
    await settle();
    closeMenu();
    const saved = await app.save();
    assert.equal(saved.type, 'doc');
    app.destroy();
  } finally {
    dom.restore();
  }
});

test('Deck：点一遍全部工具栏按钮不报错', async () => {
  const dom = installDomShim();
  try {
    const { mountDeckApp } = await import('../src/apps/deck/index.js');
    const doc = { id: 'deck_click', type: 'deck', title: '点测演示', data: null };
    const app = mountDeckApp({ doc, onSave: async () => {}, onClose: () => {} });
    dom.appRoot.appendChild(app.el);
    const failures = clickAll(app.el, '.app__toolbar .btn', '演示工具栏');
    assert.deepEqual(failures, []);
    await settle();
    app.el.querySelectorAll('.app__menu').forEach((node) => {
      node.dispatchEvent({ type: 'click', target: node, currentTarget: node });
    });
    await settle();
    closeMenu();
    // 幻灯片缩略图切换
    app.el.querySelectorAll('.deck__thumb').forEach((node) => {
      node.dispatchEvent({ type: 'click', target: node, currentTarget: node });
    });
    const saved = await app.save();
    assert.equal(saved.type, 'deck');
    app.destroy();
  } finally {
    dom.restore();
  }
});

test('工作台：点一遍新建卡片与文件操作不报错', async () => {
  const dom = installDomShim();
  try {
    const { mountHome } = await import('../src/shell/home.js');
    const { MemoryDriver, setDriver } = await import('../src/core/idb.js');
    const { store } = await import('../src/core/store.js');
    setDriver(new MemoryDriver());
    await store.create('doc', { title: '已有文档', preview: '预览' });

    let opened = null;
    const view = mountHome({ onOpen: (doc) => { opened = doc; }, onCreate: async () => null });
    dom.appRoot.appendChild(view.el);
    await view.refresh();

    assert.ok(view.el.querySelectorAll('.home__card').length >= 1, '应渲染出文件卡片');
    view.el.querySelector('.home__card').dispatchEvent({ type: 'click', target: view.el, currentTarget: view.el });
    assert.ok(opened, '点击卡片应触发打开');
    assert.equal(opened.title, '已有文档');

    const failures = clickAll(view.el, '.home__new-card', '新建卡片');
    assert.deepEqual(failures, []);
    await settle();
    view.destroy();
  } finally {
    dom.restore();
  }
});
