/**
 * HORUS — tools/serve.mjs
 * Servidor de desarrollo estático, sin dependencias.
 *
 * La aplicación no necesita compilación: son módulos ES nativos. Pero los
 * módulos y el service worker NO funcionan abriendo el archivo con file://,
 * así que hace falta servirlos por HTTP.
 *
 * Uso:
 *   node tools/serve.mjs            → http://localhost:5173
 *   node tools/serve.mjs 8080       → otro puerto
 *
 * Cabeceras pensadas para el desarrollo:
 *   - `Cache-Control: no-store` en todo, para que al recargar se vea siempre el
 *     código nuevo y no una versión cacheada por el navegador.
 *   - `Service-Worker-Allowed: /` para que el service worker pueda controlar
 *     todo el ámbito.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Traduce una URL a una ruta de archivo, sin salirse de la raíz del proyecto. */
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const target = resolve(ROOT, clean || 'index.html');
  // Impide salir del directorio del proyecto con ../
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  let target = resolvePath(req.url || '/');
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 · Ruta no permitida');
    return;
  }

  try {
    let info = await stat(target);
    // Un directorio sirve su index.html
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target);
    }

    const body = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    log(req, 200, Date.now() - started);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>404</title>'
        + '<body style="font-family:system-ui;padding:2rem;background:#0b0d12;color:#edf0f7">'
        + `<h1>404 · No encontrado</h1><p><code>${escapeHtml(req.url || '')}</code></p>`
        + '<p><a style="color:#f2a33c" href="/">Volver a HORUS</a></p>',
      );
      log(req, 404, Date.now() - started);
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 · ${err.message}`);
    log(req, 500, Date.now() - started);
  }
});

function log(req, status, ms) {
  const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
  console.log(`${color}${status}\x1b[0m ${req.method} ${req.url} \x1b[2m${ms}ms\x1b[0m`);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  \x1b[1m\x1b[36mHORUS\x1b[0m · servidor de desarrollo');
  console.log(`  \x1b[1m→\x1b[0m http://${HOST}:${PORT}/`);
  console.log(`  sirviendo \x1b[2m${ROOT}\x1b[0m`);
  console.log('  \x1b[2mCtrl+C para parar\x1b[0m');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  \x1b[31mEl puerto ${PORT} está ocupado.\x1b[0m Prueba otro: node tools/serve.mjs ${PORT + 1}\n`);
  } else {
    console.error('\n  \x1b[31mNo se pudo arrancar el servidor:\x1b[0m', err.message, '\n');
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  Servidor detenido.\n');
    server.close(() => process.exit(0));
  });
}
