/* Local development server: the same API, on Node, against a local SQLite file.
   Usage: node dev.mjs [--port 8787] [--db file:./dev.db]
   Serves ../index.html at / with the API at /api, so one origin works with no CORS setup. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { handle } from './src/app.js';
import { migrate } from './scripts/migrate.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('--port', process.env.PORT || 8787));
const db = createClient({ url: arg('--db', process.env.DB_URL || 'file:./dev.db') });
await migrate(db);
const env = { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*', SETUP_TOKEN: process.env.SETUP_TOKEN || 'dev-setup-token',
  SESSION_IDLE_MINUTES: process.env.SESSION_IDLE_MINUTES || '60', SESSION_MAX_HOURS: '12', ALLOW_SELF_RELEASE: process.env.ALLOW_SELF_RELEASE || 'false' };
const indexUrl = new URL('../index.html', import.meta.url);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (!url.pathname.startsWith('/api')) {
      if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404).end('Not found'); return; }
      let html = await readFile(indexUrl, 'utf8');
      html = html.replace(/<meta name="qa-api" content="[^"]*">/, '<meta name="qa-api" content="/api">');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return;
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    url.pathname = url.pathname.slice(4) || '/';
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, db);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500).end('dev server error'); }
}).listen(port, () => console.log(`QA Lab Suite dev server: http://localhost:${port}  (API at /api, setup token "${env.SETUP_TOKEN}")`));
