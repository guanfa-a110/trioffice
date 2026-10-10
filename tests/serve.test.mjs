/**
 * serve.test.mjs —— 校验本地静态服务器的请求处理（不真正监听端口，只跑 handler）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdir as mkdirPath } from 'node:fs/promises';
import { createHandler, contentTypeFor, MIME } from '../scripts/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 收集响应的假 res 对象 */
function fakeResponse() {
  const chunks = [];
  return {
    statusCode: null,
    headers: null,
    headersSent: false,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString('utf8');
    },
  };
}

async function request(url, root = ROOT) {
  const res = fakeResponse();
  await createHandler(root)({ url, method: 'GET' }, res);
  return res;
}

test('serve：返回存在的文件并带上正确的 MIME', async () => {
  const page = await request('/index.html');
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.ok(page.body.includes('TriOffice'));

  const script = await request('/src/main.js');
  assert.equal(script.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.ok(script.body.includes('boot'));

  const css = await request('/src/styles/base.css');
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.ok(css.body.includes('--accent'));

  const logo = await request('/assets/logo.svg');
  assert.equal(logo.headers['Content-Type'], 'image/svg+xml');
  assert.equal(logo.headers['X-Content-Type-Options'], 'nosniff');
});

test('serve：目录请求回落到 index.html', async () => {
  const res = await request('/');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<!doctype html>'));
});

test('serve：未知的无扩展名路径走 SPA 兜底', async () => {
  const res = await request('/some/spa/route');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<!doctype html>'));
});

test('serve：缺失的静态资源返回 404', async () => {
  const res = await request('/assets/not-here.png');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, '404 Not Found');
});

test('serve：任何请求都无法逃出静态根目录', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');

  // 造一个隔离的根目录与根目录外的“机密文件”
  const base = await mkdtemp(pjoin(tmpdir(), 'trio-serve-'));
  const root = pjoin(base, 'public');
  await mkdirPath(root, { recursive: true });
  await writeFile(pjoin(root, 'index.html'), '<!doctype html><title>root</title>');
  await writeFile(pjoin(base, 'secret.txt'), 'TOP SECRET');

  const encoded = await request('/%2e%2e%2fsecret.txt', root);
  assert.equal(encoded.statusCode, 403, '编码过的目录穿越必须被拒绝');

  // 未编码的 `../` 会被 URL 解析器规范化掉，最终仍落在根目录内（不会读到 secret.txt）
  const plain = await request('/../secret.txt', root);
  assert.ok([403, 404].includes(plain.statusCode), `实际 ${plain.statusCode}`);
  assert.ok(!plain.body.includes('TOP SECRET'));

  const deep = await request('/a/../../secret.txt', root);
  assert.ok([403, 404].includes(deep.statusCode));
  assert.ok(!deep.body.includes('TOP SECRET'));

  const naive = await request('/..%5c..%5csecret.txt', root);
  assert.ok([403, 404].includes(naive.statusCode), `实际 ${naive.statusCode}`);
});

test('serve：MIME 表覆盖项目用到的扩展名', () => {
  assert.equal(contentTypeFor('a.xlsx'), MIME['.xlsx']);
  assert.equal(contentTypeFor('a.trio'), MIME['.trio']);
  assert.equal(contentTypeFor('a.unknown'), 'application/octet-stream');
  assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
});

test('serve：examples 目录可被访问（示例下载）', async () => {
  const res = await request('/examples/budget.trio');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.ok(res.body.includes('trio/1'));
  void join;
});
