// The static file server the renderer and scroll benches and the screenshot tools load their builds from:
// the files under `root` on 127.0.0.1:<port>. Close it with `server.close()`.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.json': 'application/json' };

export async function serveDir(root, port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
