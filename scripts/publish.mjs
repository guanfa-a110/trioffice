#!/usr/bin/env node
/**
 * publish.mjs —— 把本地仓库发布到 GitHub 并保留完整提交历史。
 *
 * 两条路径，自动选择：
 *   1. 有 gh CLI（且已 `gh auth login`）→ 直接 `gh repo create --push`
 *   2. 有 GITHUB_TOKEN / GH_TOKEN → 走 REST API（api.github.com）逐个提交上传
 *      这条路径在网络受限、只放行 api.github.com 的环境里也能用
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs --owner <账号或组织> [--repo trioffice] [--private]
 *   node scripts/publish.mjs --owner <账号> --dry-run        # 只打印将要上传的内容，不联网
 *
 * 令牌只从环境变量读取，不会写入任何文件，也不会回显。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './build.mjs';

const run = promisify(execFile);
const API = 'https://api.github.com';

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = { repo: 'trioffice', owner: '', private: false, dryRun: false, description: '', homepage: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--owner') args.owner = argv[++i] || '';
    else if (token === '--repo') args.repo = argv[++i] || 'trioffice';
    else if (token === '--description') args.description = argv[++i] || '';
    else if (token === '--private') args.private = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const DEFAULT_DESCRIPTION = '零依赖、纯前端的开源办公三件套：文档 Writer / 表格 Sheet / 演示 Deck。TriOffice is a dependency-free, browser-native office suite.';
const TOPICS = ['office', 'spreadsheet', 'document-editor', 'presentation', 'vanilla-javascript',
  'zero-dependency', 'no-build', 'offline-first', 'xlsx', 'markdown', 'productivity-tools'];

/* ------------------------------------------------------------------ *
 * 本地 git 数据
 * ------------------------------------------------------------------ */
async function git(...args) {
  const { stdout } = await run('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** 读取完整提交历史（从旧到新） */
async function readHistory() {
  const raw = await git('log', '--reverse', '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1e');
  const commits = [];
  for (const chunk of raw.split('\x1e')) {
    const text = chunk.replace(/^\n/, '');
    if (!text.trim()) continue;
    const [sha, an, ae, ad, cn, ce, cd, subject, ...bodyParts] = text.split('\x1f');
    commits.push({
      sha,
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
      message: [subject, bodyParts.join('\x1f').trim()].filter(Boolean).join('\n\n'),
    });
  }
  return commits;
}

/** 列出某个提交里的文件（mode/blob/path） */
async function listTree(sha) {
  const raw = await git('ls-tree', '-r', '-z', sha);
  return raw.split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, object] = meta.split(' ');
    return { mode, type, object, path };
  });
}

/** 读取某个提交里某个文件的原始内容（Buffer） */
async function readBlob(sha, path) {
  const { stdout } = await run('git', ['cat-file', 'blob', `${sha}:${path}`], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  });
  return stdout;
}

/* ------------------------------------------------------------------ *
 * GitHub REST API
 * ------------------------------------------------------------------ */
function createClient(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'trioffice-publish-script',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const request = async (method, path, body, options = {}) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok && !options.allowFailure) {
      const detail = data && data.message ? data.message : String(text).slice(0, 200);
      const error = new Error(`${method} ${path} → ${response.status} ${detail}`);
      error.status = response.status;
      throw error;
    }
    return { status: response.status, data };
  };

  return { request };
}

/* ------------------------------------------------------------------ *
 * 发布流程
 * ------------------------------------------------------------------ */
async function publishViaGh(args, history) {
  const repoSlug = `${args.owner}/${args.repo}`;
  console.log(`▶ 使用 gh CLI 发布到 ${repoSlug}（${history.length} 个提交）`);
  try {
    await run('gh', ['repo', 'view', repoSlug], { cwd: ROOT });
    console.log(`  仓库已存在，直接推送`);
    await run('git', ['remote', 'remove', 'origin'], { cwd: ROOT }).catch(() => {});
    await run('git', ['remote', 'add', 'origin', `https://github.com/${repoSlug}.git`], { cwd: ROOT });
    const { stdout } = await run('git', ['push', '-u', 'origin', 'main'], { cwd: ROOT });
    console.log(stdout.trim());
  } catch {
    const { stdout } = await run('gh', [
      'repo', 'create', repoSlug,
      '--public',
      `--description=${args.description || DEFAULT_DESCRIPTION}`,
      '--source=.',
      '--remote=origin',
      '--push',
    ], { cwd: ROOT });
    console.log(stdout.trim());
  }
  return `https://github.com/${repoSlug}`;
}

async function publishViaApi(args, history, token) {
  const client = createClient(token);
  const repoSlug = `${args.owner}/${args.repo}`;

  const me = await client.request('GET', '/user');
  const login = me.data.login;
  console.log(`▶ 以 ${login} 的身份发布到 ${repoSlug}（${history.length} 个提交）`);

  // 1. 创建仓库（已存在则继续）
  const isOrg = login.toLowerCase() !== args.owner.toLowerCase();
  const created = await client.request(
    'POST',
    isOrg ? `/orgs/${args.owner}/repos` : '/user/repos',
    {
      name: args.repo,
      description: args.description || DEFAULT_DESCRIPTION,
      homepage: `https://github.com/${repoSlug}`,
      private: args.private,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    },
    { allowFailure: true },
  );
  if (created.status === 201) console.log(`  ✔ 已创建仓库 ${repoSlug}`);
  else if (created.status === 422) {
    console.log('  · 仓库已存在，继续推送提交');
    // 仓库是手工建的（描述/主页可能没填）→ 统一覆盖成我们想要的
    const patched = await client.request('PATCH', `/repos/${repoSlug}`, {
      description: args.description || DEFAULT_DESCRIPTION,
      homepage: `https://github.com/${repoSlug}`,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    }, { allowFailure: true });
    if (patched.status < 400) console.log('  ✔ 已更新仓库描述与主页');
    else console.log(`  · 描述/主页未能自动更新（需要 Administration 权限）：挂个 ${patched.status}，可稍后在仓库设置里手动填`);
  } else if (created.status === 404 && isOrg) {
    throw new Error(`组织 ${args.owner} 不存在，或令牌没有创建仓库的权限`);
  } else if (created.status === 403) {
    throw new Error(
      '当前令牌无法创建仓库。\n'
      + '   原因：GitHub 的细粒度令牌（github_pat_…）在个人账号下不提供 repository_creation 权限。\n'
      + '   解决：二选一 ——\n'
      + '     A. 先在网页上建一个空的同名仓库（不勾 README），再重跑本脚本；\n'
      + '     B. 换一个经典令牌（classic token，勾选 repo 权限）后重跑。',
    );
  } else if (created.status >= 400) {
    throw new Error(`创建仓库失败：${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  }
  else console.log(`  · 创建仓库返回 ${created.status}`);

  // 2. 逐个提交重建（保留完整历史与提交信息）
  let parent = null;
  const blobCache = new Map();

  for (const commit of history) {
    const entries = await listTree(commit.sha);
    const treeItems = [];
    for (const entry of entries) {
      const cacheKey = entry.object;
      let sha = blobCache.get(cacheKey);
      if (!sha) {
        const content = await readBlob(commit.sha, entry.path);
        const blob = await client.request('POST', `/repos/${repoSlug}/git/blobs`, {
          content: content.toString('base64'),
          encoding: 'base64',
        });
        sha = blob.data.sha;
        blobCache.set(cacheKey, sha);
      }
      treeItems.push({ path: entry.path, mode: entry.mode === '120000' ? '120000' : '100644', type: 'blob', sha });
    }

    const tree = await client.request('POST', `/repos/${repoSlug}/git/trees`, { tree: treeItems });
    const created2 = await client.request('POST', `/repos/${repoSlug}/git/commits`, {
      message: commit.message,
      tree: tree.data.sha,
      parents: parent ? [parent] : [],
      author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
      committer: { name: commit.committer.name, email: commit.committer.email, date: commit.committer.date },
    });
    parent = created2.data.sha;
    console.log(`  ✔ ${commit.sha.slice(0, 7)} → ${parent.slice(0, 7)}  ${commit.message.split('\n')[0]}`);
  }

  // 3. 建立分支引用（已存在则强制更新）
  const ref = await client.request('GET', `/repos/${repoSlug}/git/ref/heads/main`, null, { allowFailure: true });
  if (ref.status === 200) {
    await client.request('PATCH', `/repos/${repoSlug}/git/refs/heads/main`, { sha: parent, force: true });
    console.log('  ✔ 已更新 main 分支');
  } else {
    await client.request('POST', `/repos/${repoSlug}/git/refs`, { ref: 'refs/heads/main', sha: parent });
    console.log('  ✔ 已创建 main 分支');
  }

  // 4. 主题标签（失败不影响发布）
  await client.request('PUT', `/repos/${repoSlug}/topics`, { names: TOPICS }, { allowFailure: true });

  return `https://github.com/${repoSlug}`;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
用法: GITHUB_TOKEN=xxx node scripts/publish.mjs --owner <账号或组织> [选项]

选项:
  --owner <name>         GitHub 用户名或组织名（必填）
  --repo <name>          仓库名，默认 trioffice
  --description <text>   仓库描述
  --private              创建私有仓库（默认公开）
  --dry-run              只打印将要上传的内容，不联网
`);
    return;
  }
  // 没给 --owner 时，用令牌对应的账号（最常见的情况）
  if (!args.owner) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token) {
      console.error('✖ 缺少 --owner <你的 GitHub 用户名>');
      console.error('  例如: GITHUB_TOKEN=xxx node scripts/publish.mjs --owner yourname');
      process.exit(1);
    }
    const me = await createClient(token).request('GET', '/user');
    args.owner = me.data.login;
    console.log(`▶ 未指定 --owner，使用令牌对应的账号：${args.owner}`);
  }

  const history = await readHistory();
  const files = await listTree(history[history.length - 1].sha);
  console.log(`▶ 本地仓库：${history.length} 个提交，${files.length} 个文件`);
  console.log(`  最新提交：${history[history.length - 1].message.split('\n')[0]}`);
  const head = history[history.length - 1].sha;
  const sizes = await Promise.all(files.map((file) => readBlob(head, file.path).then((buffer) => buffer.length)));
  console.log(`  文件总大小：${Math.round(sizes.reduce((sum, size) => sum + size, 0) / 1024)} KB`);

  if (args.dryRun) {
    console.log('▶ --dry-run：将上传以下文件');
    for (const file of files) console.log(`    ${file.path}`);
    console.log(`▶ 目标：https://github.com/${args.owner}/${args.repo}`);
    return;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  let hasGh = true;
  try {
    await run('gh', ['--version']);
  } catch {
    hasGh = false;
  }

  let url;
  if (hasGh && !token) url = await publishViaGh(args, history);
  else if (token) url = await publishViaApi(args, history, token);
  else {
    console.error('✖ 没有可用的 GitHub 凭据。请二选一：');
    console.error('   A. 安装并登录 gh CLI：brew install gh && gh auth login');
    console.error('   B. 生成一个 Personal Access Token（勾选 repo 权限），然后：');
    console.error(`      GITHUB_TOKEN=<你的token> node scripts/publish.mjs --owner ${args.owner}`);
    process.exit(1);
  }

  console.log('');
  console.log(`✔ 发布完成：${url}`);
  console.log('  下一步：到仓库 Settings → Pages 或 Actions 检查 CI 是否通过；');
  console.log(`  徽章已在 README 里引用，等 CI 跑完即可显示。`);
}

main().catch((err) => {
  console.error('✖ 发布失败：', err.message);
  process.exit(1);
});
