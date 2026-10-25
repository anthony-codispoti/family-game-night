// Local stand-in for Vercel: serves the built site from dist/ and runs the
// functions in api/ the same way Vercel does. Uses plain Postgres (LOCAL_PG=1).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.LOCAL_PG ??= '1';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fns = { '/api/rpc': require(path.join(root, 'api/rpc.js')), '/api/wait': require(path.join(root, 'api/wait.js')) };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const PORT = Number(process.env.PORT || 4173);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const fn = fns[url.pathname];
  if (fn) {
    let raw = '';
    for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : undefined;
    req.query = Object.fromEntries(url.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    return fn(req, res);
  }
  let file = path.join(root, 'dist', url.pathname);
  if (!file.startsWith(path.join(root, 'dist')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'dist', 'index.html');
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('local server on http://localhost:' + PORT));
