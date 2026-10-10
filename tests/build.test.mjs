/**
 * build.test.mjs —— 校验自研打包器：单文件离线版必须能脱离模块系统独立运行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleEntry, buildStandalone, collectModules, transformModule, collectExports, resolveId } from '../scripts/build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 去掉注释后检查，避免 JSDoc 里的 `import('./x').T` 类型注解造成误报 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

test('打包器：逐模块改写正确', () => {
  const output = transformModule('src/a.js', [
    "import { helper, other as renamed } from './lib/x.js';",
    "import './side-effect.js';",
    'export const VALUE = 1;',
    'export function run() { return helper() + renamed(); }',
    'export default class Foo {}',
  ].join('\n'));
  assert.ok(output.startsWith('function (__exports__, __import__) {'));
  assert.ok(output.includes('__import__("src/lib/x.js")'));
  assert.ok(output.includes('const helper = __m_src_lib_x_js["helper"];'));
  assert.ok(output.includes('const renamed = __m_src_lib_x_js["other"];'));
  assert.ok(output.includes('__import__("src/side-effect.js");'));
  assert.ok(!/^\s*export\s/m.test(output), '导出关键字应被移除');
  assert.ok(output.includes('__exports__["VALUE"] = VALUE;'));
  assert.ok(output.includes('__exports__["run"] = run;'));
  assert.ok(output.includes('__exports__.default = __default__;'));

  const names = collectExports('export const a = 1;\nexport default 2;\nexport { b, c as d };');
  assert.deepEqual(names.names, ['a', 'b', 'd']);
  assert.equal(names.hasDefault, true);

  assert.equal(resolveId('src/apps/sheet/index.js', '../../core/dom.js'), 'src/core/dom.js');
  assert.equal(resolveId('src/main.js', './core/dom.js'), 'src/core/dom.js');
  assert.throws(() => transformModule('src/a.js', "import lodash from 'lodash';"), /第三方依赖/);
});

test('打包器：完整依赖图与产物校验', async () => {
  const modules = await collectModules();
  assert.ok(modules.length >= 25, `模块数量应不少于 25，实际 ${modules.length}`);
  const ids = modules.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, '模块不应重复');
  assert.equal(ids[ids.length - 1], 'src/main.js', '入口模块最后注册');
  assert.ok(ids.indexOf('src/core/dom.js') < ids.indexOf('src/main.js'), '依赖先于入口');

  const { script, count } = await bundleEntry();
  assert.equal(count, modules.length);
  assert.ok(!/^\s*import\s/m.test(script), '打包结果不应残留 import 语句');
  assert.ok(!/^\s*export\s/m.test(script), '打包结果不应残留 export 语句');
  assert.ok(!/import\s*\(/.test(stripComments(script)), '不应残留动态 import()（单文件版脱离模块系统运行）');
  assert.ok(script.includes('__modules__'));
  assert.ok(script.includes('"src/main.js"'));
  assert.ok(script.includes('"src/apps/sheet/formula.js"'));
  assert.ok(script.includes('"src/apps/deck/render.js"'));
});

test('打包器：单文件 HTML 内联样式与脚本', async () => {
  const html = await buildStandalone();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>TriOffice'), '保留原有 head 内容');
  assert.ok(!/<link rel="stylesheet"/.test(html), 'CSS 应被内联');
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes(':root {'));
  assert.ok(!/<script type="module"/.test(html), '单文件版不应依赖 ESM');
  assert.ok(html.includes('__modules__'));
  assert.ok(html.indexOf('<style>') < html.indexOf('__modules__'), '样式应先于脚本');
});

test('构建脚本可作为 CLI 运行', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(output, /打包 \d+ 个模块/);
  assert.match(output, /dist\/triooffice\.html/);
  assert.match(output, /dist\/index\.html/);
});
