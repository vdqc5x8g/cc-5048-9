#!/usr/bin/env node
// 零依赖静态服务（辅助）：ES 模块需要通过 http(s) 提供，file:// 下无法加载。
// 用法：node cli/serve.js [--port 8080] [--root ..]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const rootIdx = args.indexOf('--root');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8080;
const root = resolve(here, rootIdx >= 0 ? args[rootIdx + 1] : '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(root, rel);
    if (!filePath.startsWith(root + sep) && filePath !== root) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const st = await stat(filePath).catch(() => null);
    if (st && st.isDirectory()) filePath = join(filePath, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(port, () => {
  console.log(`转头重投影演示服务已启动: http://localhost:${port}/`);
  console.log(`根目录: ${root}`);
  console.log('图形入口: /index.html （Ctrl+C 停止）');
});
