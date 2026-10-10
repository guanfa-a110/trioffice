#!/usr/bin/env node
/**
 * serve.mjs —— TriOffice 本地静态服务器：零依赖，只用 Node 内置模块。
 *
 *   npm start
 *   node scripts/serve.mjs --port 8080 --host 0.0.0.0
 *
 * 作为模块使用时可以拿到 requestHandler，便于单测（见 tests/serve.test.mjs）。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.trio': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const contentTypeFor = (path) => MIME[extname(path).toLowerCase()] || 'application/octet-stream';

/** 极简响应对象：让 handler 可以脱离 http.Server 被测试 */
function makeResponder(res) {
  return {
    status(code) {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      return this;
    },
    /** 返回文本 */
    text(body) {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
    },
    /** 返回文件内容 */
    file(body, path) {
      res.writeHead(200, {
        'Content-Type': contentTypeFor(path),
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    },
  };
}

/**
 * 生成请求处理器。
 * @param {string} [root] 静态根目录
 * @returns {(req: {url?: string, method?: string}, res: any) => Promise<void>}
 */
export function createHandler(root = ROOT) {
  return async function handle(req, res) {
    const reply = makeResponder(res);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      // 防目录穿越：解析后的路径必须落在 root 之内
      const target = normalize(join(root, pathname));
      if (target !== root && !target.startsWith(root + sep)) {
        reply.status(403).text('403 Forbidden');
        return;
      }

      let filePath = target;
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        // SPA 兜底：无扩展名的未知路径交回 index.html，由前端哈希路由处理
        if (!extname(pathname)) filePath = join(root, 'index.html');
      }

      const body = await readFile(filePath);
      reply.file(body, filePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        reply.status(404).text('404 Not Found');
        return;
      }
      if (err && err.code === 'EISDIR') {
        reply.status(404).text('404 Not Found');
        return;
      }
      reply.status(500).text(`500 ${err && err.message}`);
    }
  };
}

/** 打印启动信息 */
function announce(port, host) {
  const lines = ['  TriOffice 已启动 / running:'];
  lines.push(`    ➜  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  if (host === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) lines.push(`    ➜  http://${net.address}:${port}/`);
      }
    }
  }
  lines.push('  按 Ctrl+C 停止 / press Ctrl+C to stop');
  console.log(lines.join('\n'));
}

/** 启动服务器（CLI 入口用） */
export function startServer({ port = 5173, host = '127.0.0.1', root = ROOT } = {}) {
  const server = createServer(createHandler(root));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`✖ 端口 ${port} 已被占用，换一个：npm start -- --port ${port + 1}`);
    } else if (err.code === 'EPERM' || err.code === 'EACCES') {
      console.error(`✖ 没有权限监听 ${host}:${port}，试试换端口或改用 --host 127.0.0.1`);
    } else {
      console.error('✖ 服务器启动失败：', err.message);
    }
    process.exit(1);
  });
  server.listen(port, host, () => announce(port, host));
  return server;
}

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  startServer({
    port: Number(argOf('port', process.env.PORT || 5173)),
    host: argOf('host', process.env.HOST || '127.0.0.1'),
  });
}
