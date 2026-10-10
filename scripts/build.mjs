#!/usr/bin/env node
/**
 * build.mjs —— TriOffice 构建脚本：产出 dist/ 静态目录 + 单文件离线版 dist/triooffice.html
 *
 * 自带一个极简 ESM 打包器：递归解析相对 import，把每个模块包成注册表函数，
 * 因此无需 Rollup / Vite / esbuild，构建零依赖。
 * 为了保证正则改写可靠，源码需遵守以下约定：
 *   - 只用 `import { a, b } from './x.js'` 和 `import './x.js'` 两种导入写法
 *   - 导出只用 `export function/class/const/let/var` 或 `export default`
 *   - 不使用 `export * from`、`export { a as b }`、动态 import()
 * 这些约定由 tests/integrity.test.mjs 与 tests/build.test.mjs 自动校验。
 *
 * 作为模块使用时可以拿到打包中间产物（见 bundleEntry / buildStandalone）。
 */
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DIST = join(ROOT, 'dist');
export const ENTRY = 'src/main.js';
export const STYLE_ORDER = ['base', 'shell', 'writer', 'sheet', 'deck'];

const IMPORT_RE = /^[ \t]*import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|([\w$]+)|\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^[ \t]*export\s+(async\s+function|function|class|const|let|var)\s+([\w$]+)/gm;
const EXPORT_DEFAULT_RE = /^[ \t]*export\s+default\s+/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

function reset(regexes) {
  for (const regex of regexes) regex.lastIndex = 0;
}

const ALL_RES = [IMPORT_RE, BARE_IMPORT_RE, EXPORT_DECL_RE, EXPORT_LIST_RE, EXPORT_DEFAULT_RE];

/** posix 风格路径，保证跨平台一致 */
export function toPosix(path) {
  return path.split(sep).join('/');
}

/** 相对路径解析：from 是模块 id（相对项目根，posix），spec 是 import 说明符 */
export function resolveId(from, spec) {
  const baseDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = (baseDir ? baseDir.split('/') : []).concat(spec.split('/'));
  const out = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  let id = out.join('/');
  if (!id.endsWith('.js')) id += '.js';
  return id;
}

/** 收集模块的导出名 */
export function collectExports(source) {
  reset(ALL_RES);
  const names = new Set();
  for (const match of source.matchAll(EXPORT_DECL_RE)) names.add(match[2]);
  for (const match of source.matchAll(EXPORT_LIST_RE)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.trim());
    }
  }
  const hasDefault = EXPORT_DEFAULT_RE.test(source);
  reset(ALL_RES);
  return { names: [...names].sort(), hasDefault };
}

const shortId = (id) => id.replace(/[^\w$]/g, '_');

/** 把模块源码改写为注册表函数 */
export function transformModule(id, source) {
  reset(ALL_RES);
  let code = source;

  // 1. 具名导入 → __import__
  code = code.replace(IMPORT_RE, (full, defAndNamed, named, defOnly, nsOnly, spec) => {
    if (!spec.startsWith('.')) throw new Error(`模块 ${id} 引用了非相对依赖 "${spec}"（本项目禁止第三方依赖）`);
    const target = resolveId(id, spec);
    const alias = shortId(target);
    const lines = [`const __m_${alias} = __import__(${JSON.stringify(target)});`];
    if (named) {
      for (const raw of named.split(',')) {
        const [orig, bind] = raw.split(/\s+as\s+/);
        const name = (orig || '').trim();
        if (!name) continue;
        const local = (bind || name).trim();
        lines.push(`const ${local} = __m_${alias}[${JSON.stringify(name)}];`);
      }
    }
    if (defOnly) lines.push(`const ${defOnly.trim()} = __m_${alias}.default;`);
    if (defAndNamed) lines.push(`const ${defAndNamed.trim()} = __m_${alias}.default;`);
    if (nsOnly) lines.push(`const ${nsOnly.trim()} = __m_${alias};`);
    return lines.join('\n');
  });

  // 2. 副作用导入 → 仅求值
  code = code.replace(BARE_IMPORT_RE, (full, spec) => {
    if (!spec.startsWith('.')) throw new Error(`模块 ${id} 引用了非相对依赖 "${spec}"`);
    return `__import__(${JSON.stringify(resolveId(id, spec))});`;
  });

  // 3. 导出声明 → 普通声明
  code = code.replace(EXPORT_DECL_RE, (full, kind, name) => `${kind} ${name}`);
  code = code.replace(EXPORT_LIST_RE, '');

  const { names, hasDefault } = collectExports(source);

  // 4. export default → 赋值给 __exports__
  if (hasDefault) {
    code = code.replace(EXPORT_DEFAULT_RE, 'const __default__ = ');
    code += '\n__exports__.default = __default__;\n';
  }

  const tail = names.length
    ? `\n${names.map((name) => `__exports__[${JSON.stringify(name)}] = ${name};`).join('\n')}\n`
    : '';
  return `function (__exports__, __import__) {\n${code}${tail}\n}`;
}

/** 深度优先收集模块（后序：被依赖者先注册） */
export async function collectModules(entryId = ENTRY) {
  const seen = new Set();
  const order = [];

  const visit = async (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    let source;
    try {
      source = await readFile(join(ROOT, id), 'utf8');
    } catch {
      throw new Error(`找不到模块 ${id}`);
    }
    const specs = [];
    reset(ALL_RES);
    for (const regex of [IMPORT_RE, BARE_IMPORT_RE]) {
      regex.lastIndex = 0;
      for (const match of source.matchAll(regex)) {
        const spec = match[regex === IMPORT_RE ? 5 : 1];
        if (spec && spec.startsWith('.')) specs.push(resolveId(id, spec));
      }
    }
    for (const dep of specs) await visit(dep);
    order.push({ id, source });
  };

  await visit(entryId);
  return order;
}

/** 生成单文件脚本（模块注册表 IIFE） */
export async function bundleEntry(entryId = ENTRY) {
  const modules = await collectModules(entryId);
  const registry = modules
    .map(({ id, source }) => `  ${JSON.stringify(id)}: ${transformModule(id, source)},`)
    .join('\n');

  const script = `
(function () {
  'use strict';
  var __modules__ = {
${registry}
  };
  var __cache__ = {};
  function __import__(id) {
    if (__cache__[id]) return __cache__[id];
    var factory = __modules__[id];
    if (!factory) throw new Error('模块未打包: ' + id);
    var exports = (__cache__[id] = {});
    factory(exports, __import__);
    return exports;
  }
  __import__(${JSON.stringify(entryId)});
})();
`;
  return { script, modules, count: modules.length };
}

/** 读取合并后的 CSS */
export async function bundleStyles(order = STYLE_ORDER) {
  const files = order.map((name) => join(ROOT, `src/styles/${name}.css`));
  const parts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return parts.join('\n');
}

/** 生成单文件 HTML（CSS 与 JS 全部内联） */
export async function buildStandalone() {
  const [{ script }, css, html] = await Promise.all([
    bundleEntry(),
    bundleStyles(),
    readFile(join(ROOT, 'index.html'), 'utf8'),
  ]);
  return html
    .replace(/<link rel="stylesheet"[^>]*>/g, '')
    .replace('</head>', `<style>\n${css}\n</style>\n</head>`)
    .replace(/<script type="module"[^>]*><\/script>/g, '')
    .replace('</body>', `<script>\n${script}\n</script>\n</body>`);
}

/** 执行完整构建 */
export async function build() {
  console.log('▶ TriOffice build');

  // ---- 1. dist 静态目录 ----
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(join(ROOT, 'index.html'), join(DIST, 'index.html'));
  await cp(join(ROOT, 'src'), join(DIST, 'src'), { recursive: true });
  await cp(join(ROOT, 'assets'), join(DIST, 'assets'), { recursive: true });

  // ---- 2. 单文件离线版 ----
  const { script, count } = await bundleEntry();
  const standalone = await buildStandalone();
  await writeFile(join(DIST, 'trioffice.html'), standalone);
  await writeFile(join(DIST, 'trioffice.js'), script);

  // ---- 3. 语法校验 ----
  await run(process.execPath, ['--check', join(DIST, 'trioffice.js')]);

  const size = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
  console.log(`✔ 打包 ${count} 个模块，语法校验通过`);
  console.log(`✔ 单文件离线版 dist/triooffice.html（${size(standalone)}），可部署版 dist/index.html`);
  console.log(`✔ 入口脚本 dist/triooffice.js（${size(script)}）`);
  void toPosix;
  void relative;
  return { count, size: standalone.length };
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  build().catch((err) => {
    console.error('✖ 构建失败:', err.message);
    process.exit(1);
  });
}
