import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] || 'public');
const port = Number(process.env.PORT || 4173);
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const joined = path.resolve(root, rel.endsWith('/') ? `${rel}index.html` : rel);
  if (!joined.startsWith(root + path.sep) && joined !== root) throw new Error('unsafe path');
  return joined;
}

const server = http.createServer(async (req, res) => {
  try {
    let filename = safePath(req.url || '/');
    let stat;
    try { stat = await fs.stat(filename); }
    catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    if (stat.isDirectory()) filename = path.join(filename, 'index.html');
    const body = await fs.readFile(filename);
    res.writeHead(200, {
      'content-type': mime.get(path.extname(filename).toLowerCase()) || 'application/octet-stream',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'cross-origin-isolated=(self)',
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error?.stack || error));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BLACK_MONDAY_WEB CI server listening on http://127.0.0.1:${port}`);
  console.log(`root=${root}`);
});
