#!/usr/bin/env node
/**
 * set-repo.mjs —— 把仓库里的 OWNER 占位符换成你自己的 GitHub 账号，并加上 CI 徽章。
 *
 *   node scripts/set-repo.mjs <github-username> [repo-name]
 *
 * 改动文件：package.json（repository / bugs / homepage）、README.md、README.en.md
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './build.mjs';

const [owner, repoArg] = process.argv.slice(2);
const repo = repoArg || 'trioffice';

if (!owner || !/^[\w.-]+$/.test(owner)) {
  console.error('用法: node scripts/set-repo.mjs <github-username> [repo-name]');
  process.exit(1);
}

const badge = `[![CI](https://github.com/${owner}/${repo}/actions/workflows/ci.yml/badge.svg)](https://github.com/${owner}/${repo}/actions/workflows/ci.yml)`;

async function patchPackage() {
  const file = join(ROOT, 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.repository = { type: 'git', url: `git+https://github.com/${owner}/${repo}.git` };
  pkg.bugs = { url: `https://github.com/${owner}/${repo}/issues` };
  pkg.homepage = `https://github.com/${owner}/${repo}#readme`;
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return file;
}

async function patchReadme(name, anchor) {
  const file = join(ROOT, name);
  let text = await readFile(file, 'utf8');
  if (!text.includes('actions/workflows/ci.yml/badge.svg')) {
    text = text.replace(anchor, `${anchor}\n\n${badge}\n`);
  }
  text = text.replace(/git remote add origin git@github\.com:<[^>]+>\/trioffice\.git/g,
    `git remote add origin git@github.com:${owner}/${repo}.git`);
  text = text.replace(/node scripts\/set-repo\.mjs <[^>]+>/g, `node scripts/set-repo.mjs ${owner}`);
  await writeFile(file, text, 'utf8');
  return file;
}

const changed = [];
changed.push(await patchPackage());
changed.push(await patchReadme('README.md', '**零依赖、纯前端的开源办公三件套**'));
changed.push(await patchReadme('README.en.md', '**A dependency-free, browser-native open-source office suite**'));

console.log(`✔ 已指向 https://github.com/${owner}/${repo}`);
for (const file of changed) console.log(`  更新 ${file.replace(`${ROOT}/`, '')}`);
console.log('');
console.log('接下来：');
console.log(`  git add -A && git commit -m "chore: 指向 ${owner}/${repo}"`);
console.log(`  git remote add origin git@github.com:${owner}/${repo}.git   # 或 https://github.com/${owner}/${repo}.git`);
console.log('  git push -u origin main');
console.log('');
console.log('创建远程仓库（需已登录 gh CLI）：');
console.log(`  gh repo create ${repo} --public --source=. --remote=origin --push`);
