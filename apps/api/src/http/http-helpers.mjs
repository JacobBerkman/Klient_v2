import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body, null, 2));
}

export function notFound(res, requestId) {
  json(res, 404, { message: 'Not found' }, { 'X-Request-Id': requestId });
}


export function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '');
}
export function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

export function serveStatic(pathname, res, requestId, publicDir) {
  const filePath = pathname === '/' ? resolve(publicDir, 'index.html') : resolve(publicDir, pathname.slice(1));
  readFile(filePath)
    .then((contents) => {
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8'
      }[extname(filePath)] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType, 'X-Request-Id': requestId, 'Cache-Control': 'no-store' });
      res.end(contents);
    })
    .catch(() => notFound(res, requestId));
}

export function sendError(res, error, requestId) {
  const message = error?.message || 'Request failed';
  const statusCode = /not found/i.test(message) ? 404 : /auth|permission/i.test(message) ? 401 : 400;
  json(res, statusCode, { message }, { 'X-Request-Id': requestId });
}

export function createRequestLogger(log, req, requestId) {
  const startedAt = Date.now();
  return (statusCode, metadata = {}) => {
    log('info', 'request.completed', {
      requestId,
      method: req.method,
      path: req.url,
      statusCode,
      durationMs: Date.now() - startedAt,
      ...metadata
    });
  };
}
