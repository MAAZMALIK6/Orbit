import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const rel = url.pathname === '/' ? 'fixtures/browser-lab.html' : url.pathname.replace(/^\//, '');
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !(rel.startsWith('extension/') || rel.startsWith('fixtures/'))) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const data = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Browser practice page: http://127.0.0.1:${port}/`);
  console.log(`UI preview: http://127.0.0.1:${port}/extension/panel/panel.html (browser actions require the installed extension)`);
});
