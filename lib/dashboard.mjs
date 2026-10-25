import http from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export async function startDashboard({ store, port = 4317 }) {
  const clients = new Set();
  let url;
  const server = http.createServer(async (req, res) => {
    const host = new URL(url).host;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== url) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end('Forbidden'); return;
    }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const pathname = new URL(req.url, url).pathname;
    if (pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(store.snapshot()));
    } else if (pathname === '/events') {
      if (clients.size >= 16) { res.writeHead(503).end('Too many viewers'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      clients.add(res);
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
      req.on('close', () => clients.delete(res));
    } else if (assets.has(pathname)) {
      try {
        const [file, type] = assets.get(pathname);
        res.writeHead(200, { 'Content-Type': type });
        res.end(await readFile(new URL('../dashboard/' + file, import.meta.url)));
      } catch { res.end('Dashboard asset unavailable'); }
    } else { res.writeHead(404).end('Not found'); }
  });
  await new Promise((resolve, reject) => {
    const onError = error => {
      if (error.code === 'EADDRINUSE' && port !== 0) {
        port = 0;
        server.listen(port, '127.0.0.1');
      } else { server.off('error', onError); reject(error); }
    };
    server.on('error', onError);
    server.once('listening', () => { server.off('error', onError); resolve(); });
    server.listen(port, '127.0.0.1');
  });
  url = `http://127.0.0.1:${server.address().port}`;
  const broadcast = () => {
    const message = `data: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 512 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(message);
    }
  };
  store.on('change', broadcast);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, 15000).unref();
  return { url, async close() {
    store.off('change', broadcast);
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  } };
}
