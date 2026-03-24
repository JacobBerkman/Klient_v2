import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteReadRepository } from './repositories/sqlite-read-repository.mjs';
import { runtime, log } from './runtime.mjs';
import { ensureDatabaseReady, closeDatabase } from './storage.mjs';
import { createStore } from './store.mjs';
import { createRequestLogger, getToken, json, parseBody, sendError, serveStatic } from './http/http-helpers.mjs';
import { routeRequest } from './routes/runtime-router.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '../../web/public');
const store = createStore();
const reads = new SqliteReadRepository();

function requireUser(req) {
  return store.requireUser(getToken(req));
}

const server = createServer(async (req, res) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  const url = new URL(req.url || '/', `http://${req.headers.host || `${runtime.host}:${runtime.port}`}`);
  const { pathname } = url;
  const finalizeLog = createRequestLogger(log, req, requestId);

  try {
    const handled = await routeRequest({
      req,
      res,
      url,
      pathname,
      method: req.method,
      requestId,
      runtime,
      store,
      reads,
      requireUser,
      parseBody,
      getToken,
      json,
      serveStatic: (targetPath, response, currentRequestId) => serveStatic(targetPath, response, currentRequestId, publicDir),
      finalizeLog
    });

    if (handled) {
      return;
    }

    finalizeLog(200, { static: true });
    return serveStatic(pathname, res, requestId, publicDir);
  } catch (error) {
    log('error', 'request.failed', { requestId, method: req.method, path: req.url, error: error.message || String(error) });
    finalizeLog(/not found/i.test(error?.message || '') ? 404 : 400);
    return sendError(res, error, requestId);
  }
});

let isShuttingDown = false;
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('info', 'server.shutdown.started', { signal });
  server.close(() => {
    closeDatabase();
    log('info', 'server.shutdown.completed', { signal });
    process.exit(0);
  });
  setTimeout(() => {
    log('error', 'server.shutdown.timeout', { signal });
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  log('error', 'process.uncaughtException', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  log('error', 'process.unhandledRejection', { error: error?.message || String(error) });
});

server.listen(runtime.port, runtime.host, () => {
  log('info', 'server.started', { host: runtime.host, port: runtime.port, dbPath: ensureDatabaseReady().dbPath });
});
