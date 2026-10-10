/**
 * integrity.test.mjs —— 静态一致性检查。
 *
 * 纯前端项目没有构建期类型检查，这里用文本级校验兜住最容易出错的几类问题：
 *   1. import 的路径是否真实存在；
 *   2. import 的名字是否真的被目标模块导出（防止改名后漏改）；
 *   3. i18n 里 t('key') 用到的键是否在 zh / en 两份字典里都存在；
 *   4. icon('name') 用到的图标是否真的定义过；
 *   5. 每个模块能否被 Node 直接解析（catch 语法错误）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** 递归收集所有 .js 源文件（相对项目根，posix 风格） */
function collectFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = collectFiles();
const SOURCES = new Map(FILES.map((file) => [file, readFileSync(file, 'utf8')]));

/** 提取模块的导出名 */
function exportsOf(source) {
  const names = new Set();
  for (const match of source.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+([\w$]+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.trim());
    }
  }
  if (/^[ \t]*export\s+default/m.test(source)) names.add('default');
  return names;
}

/** 提取模块的导入（路径 + 名字） */
function importsOf(source) {
  const out = [];
  // import { a, b as c } from './x.js'
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = match[1].split(',').map((item) => item.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ names, spec: match[2] });
  }
  // import X from './x.js'
  for (const match of source.matchAll(/import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: ['default'], spec: match[2], raw: match[1] });
  }
  // import './x.js'
  for (const match of source.matchAll(/import\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: [], spec: match[1] });
  }
  return out;
}

const EXPORTS = new Map([...SOURCES].map(([file, source]) => [file, exportsOf(source)]));

test('所有相对 import 都指向存在的文件', () => {
  const problems = [];
  for (const [file, source] of SOURCES) {
    for (const item of importsOf(source)) {
      if (!item.spec.startsWith('.')) continue;
      const target = resolve(dirname(file), item.spec);
      if (!SOURCES.has(target)) problems.push(`${rel(file)} → ${item.spec}`);
    }
  }
  assert.deepEqual(problems, [], `以下 import 找不到目标文件：\n${problems.join('\n')}`);
});

test('import 的名字都被目标模块导出', () => {
  const problems = [];
  for (const [file, source] of SOURCES) {
    for (const item of importsOf(source)) {
      if (!item.spec.startsWith('.')) continue;
      const target = resolve(dirname(file), item.spec);
      const exp = EXPORTS.get(target);
      if (!exp) continue;
      for (const name of item.names) {
        if (!exp.has(name)) problems.push(`${rel(file)} 从 ${rel(target)} 导入了未导出的 "${name}"`);
      }
    }
  }
  assert.deepEqual(problems, [], `以下导入名不存在：\n${problems.join('\n')}`);
});

test('不存在导入了却不使用的名字（提示无效 import）', () => {
  // 只针对同名导入做粗粒度检查：名字在正文中出现次数为 1（仅 import 行本身）
  const problems = [];
  for (const [file, source] of SOURCES) {
    for (const item of importsOf(source)) {
      if (item.names.length === 0) continue;
      const body = source.replace(/import[\s\S]*?from\s*['"][^'"]+['"];?/g, '');
      for (const name of item.names) {
        const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
        if (!re.test(body)) problems.push(`${rel(file)}: 导入的 "${name}" 未被使用`);
      }
    }
  }
  assert.deepEqual(problems, [], `存在未使用的导入：\n${problems.join('\n')}`);
});

test('i18n：t() 用到的键在 zh / en 中都存在', () => {
  const i18nSource = SOURCES.get(join(SRC, 'core', 'i18n.js'));
  const zh = collectDictionary(i18nSource, 'zh');
  const en = collectDictionary(i18nSource, 'en');
  assert.ok(zh.size > 200, `中文词条过少：${zh.size}`);
  assert.equal(zh.size, en.size, 'zh 与 en 词条数量应一致');

  const used = new Set();
  for (const [file, source] of SOURCES) {
    if (file.endsWith('i18n.js')) continue;
    for (const match of source.matchAll(/\bt\(\s*'([\w.\-]+)'/g)) used.add(match[1]);
    // 通过 labelKey / i18n 字段间接引用的词条
    for (const match of source.matchAll(/\b(?:labelKey|i18n):\s*'([\w.\-]+)'/g)) used.add(match[1]);
  }
  const missingZh = [...used].filter((key) => !zh.has(key));
  const missingEn = [...used].filter((key) => !en.has(key));
  assert.deepEqual(missingZh, [], `中文词条缺失：${missingZh.join(', ')}`);
  assert.deepEqual(missingEn, [], `英文词条缺失：${missingEn.join(', ')}`);

  const unused = [...zh.keys()].filter((key) => !used.has(key));
  assert.ok(unused.length < 45, `未使用的词条过多（${unused.length}）：${unused.slice(0, 24).join(', ')}`);
});

test('icon() 使用的图标名都已定义', async () => {
  const { iconNames } = await import('../src/core/ui.js');
  const known = new Set(iconNames());
  const problems = [];
  const patterns = [
    /\bicon\(\s*'([\w-]+)'/g,
    /\bicon:\s*'([\w-]+)'/g,
  ];
  for (const [file, source] of SOURCES) {
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        if (!known.has(match[1])) problems.push(`${rel(file)}: 未定义的图标 "${match[1]}"`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [], `图标名不存在：\n${[...new Set(problems)].join('\n')}`);
});

test('每个模块都能被 Node 解析（语法 + 顶层副作用安全）', async () => {
  const failures = [];
  for (const file of FILES) {
    const source = SOURCES.get(file);
    // 跳过依赖浏览器全局的 UI 模块，它们由浏览器加载
    if (/document\.|window\.|localStorage\./.test(source) && !/typeof document/.test(source)) continue;
    try {
      await import(file);
    } catch (err) {
      failures.push(`${rel(file)}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, [], `模块导入失败：\n${failures.join('\n')}`);
});

test('JS 里声明的 class 都能在 CSS 中找到（防拼写错误）', () => {
  const styleDir = join(SRC, 'styles');
  const cssFiles = readdirSync(styleDir).map((name) => join(styleDir, name));
  const css = cssFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1]));

  // 仅用于 JS 查询、不需要样式的类名白名单
  const allow = new Set(['btn__label', 'menu-anchor', 'is-in', 'tsv']);

  const used = new Map();
  const add = (raw, file) => {
    for (const name of String(raw).split(/\s+/)) {
      if (!/^[A-Za-z][\w-]*$/.test(name)) continue;
      if (name.startsWith('is-') || name.includes('$')) continue;
      used.set(name, rel(file));
    }
  };

  for (const [file, raw] of SOURCES) {
    const source = stripComments(raw);
    for (const match of source.matchAll(/h\('([\w.#-]+)'/g)) {
      for (const cls of match[1].match(/\.([\w-]+)/g) || []) add(cls.slice(1), file);
    }
    for (const match of source.matchAll(/class(?:Name)?:\s*'([^']+)'/g)) add(match[1], file);
    for (const match of source.matchAll(/class:\s*\[([^\]]+)\]/g)) {
      // 含有三元表达式 / 模板字符串时无法静态判断，跳过以免误报
      if (/[?`]/.test(match[1])) continue;
      for (const literal of match[1].matchAll(/'([^']+)'/g)) add(literal[1], file);
    }
  }

  const problems = [...used]
    .filter(([name]) => !defined.has(name) && !allow.has(name))
    .map(([name, file]) => `${file}: 使用了未定义的 class "${name}"`);
  assert.deepEqual(problems, [], `类名与样式不匹配：\n${problems.join('\n')}`);
  assert.ok(used.size > 100, `扫描到的类名过少（${used.size}），检查扫描逻辑`);
});

test('CSS 自定义属性都被定义过', () => {
  const files = readdirSync(join(SRC, 'styles')).map((name) => join(SRC, 'styles', name));
  const all = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  const defined = new Set([...all.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  const problems = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
      if (!defined.has(match[1]) && !match[1].startsWith('--handle-scale')) {
        problems.push(`${rel(file)}: 使用了未定义的 ${match[1]}`);
      }
    }
  }
  assert.deepEqual(problems, [], `CSS 变量未定义：\n${problems.join('\n')}`);
});

test('index.html 引用的资源都存在', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((match) => match[1]);
  for (const ref of refs) {
    assert.ok(SOURCES.has(join(ROOT, ref)) || existsSyncSafe(join(ROOT, ref)), `index.html 引用了不存在的文件：${ref}`);
  }
});

function existsSyncSafe(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 去掉注释，避免文档示例里的 class 被误判 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function rel(file) {
  return file.replace(`${ROOT}/`, '');
}

/** 从 i18n 源码里按语言抽取键名 */
function collectDictionary(source, lang) {
  const start = source.indexOf(`${lang}: {`);
  assert.ok(start !== -1, `找不到 ${lang} 字典`);
  const end = source.indexOf('\n  },', start);
  const block = source.slice(start, end === -1 ? source.length : end);
  return new Set([...block.matchAll(/'([\w.\-]+)':/g)].map((match) => match[1]));
}
