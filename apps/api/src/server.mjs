import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteReadRepository } from './repositories/sqlite-read-repository.mjs';
import { runtime, log, validateRuntimeConfig } from './runtime.mjs';
import {
  ensureDatabaseReady,
  closeDatabase,
  readQuerySummary,
  readExportWorkerStatus,
  readStorageHealth,
  readAuditEventSummary,
  readAnalyticsMaterializedSummary
} from './storage.mjs';
import { createModules } from './modules/index.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '../../web/public');
const bootedAt = new Date().toISOString();
const startupDiagnostics = validateRuntimeConfig();

function baseHeaders() {
  return {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res, requestId) {
  json(res, 404, { message: 'Not found' }, { 'X-Request-Id': requestId });
}

function sendError(res, error, requestId) {
  const message = error?.message || 'Request failed';
  const statusCode = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : (/not found/i.test(message) ? 404 : /auth|permission/i.test(message) ? 401 : 400);
  json(res, statusCode, { message }, { 'X-Request-Id': requestId });
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
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

function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '');
}

function serveStatic(pathname, res, requestId) {
  const filePath = pathname === '/' ? resolve(publicDir, 'index.html') : resolve(publicDir, pathname.slice(1));
  const publicDirRoot = `${publicDir}${sep}`;
  if (filePath !== publicDir && !filePath.startsWith(publicDirRoot)) return notFound(res, requestId);
  readFile(filePath)
    .then((contents) => {
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8'
      }[extname(filePath)] || 'text/plain; charset=utf-8';
      res.writeHead(200, { ...baseHeaders(), 'Content-Type': contentType, 'X-Request-Id': requestId, 'Cache-Control': 'no-store' });
      res.end(contents);
    })
    .catch(() => notFound(res, requestId));
}

function requestLogger(req, requestId) {
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

export function createHttpServer({ modules }) {
  return createServer(async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    const url = new URL(req.url || '/', `http://${req.headers.host || `${runtime.host}:${runtime.port}`}`);
    const { pathname } = url;
    const finalizeLog = requestLogger(req, requestId);
    const requireUser = () => modules.auth.requireUser(getToken(req));

    try {
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        finalizeLog(200);
        return json(res, 200, { status: 'ok', service: runtime.serviceName, uptimeSeconds: Math.round(process.uptime()) }, { 'X-Request-Id': requestId });
      }
      if (pathname === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
        finalizeLog(200);
        return json(res, 200, {
          status: 'ready',
          querySummary: readQuerySummary(),
          database: ensureDatabaseReady(),
          storageHealth: readStorageHealth(),
          exportWorker: readExportWorkerStatus(),
          auditEvents: readAuditEventSummary(),
          startupDiagnostics
        }, { 'X-Request-Id': requestId });
      }

      if (pathname === '/api/dashboard' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.profiles.getDashboard(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/profiles' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.profiles.listProfiles(user, { kind: url.searchParams.get('kind'), search: url.searchParams.get('search') || '' }); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/profiles' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'profiles:write'); const result = modules.profiles.createProfile(user, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage-history') && req.method === 'GET') { const id = pathname.split('/')[3]; const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.profiles.listStageHistory(user, id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'GET') { const id = pathname.split('/')[3]; const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.profiles.listNotes(user, id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const user = requireUser(); modules.policy.requirePermission(user, 'profiles:write'); const result = modules.profiles.addNote(user, id, body.body || ''); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/profiles/') && pathname.split('/').length === 4 && req.method === 'GET') { const id = pathname.split('/')[3]; const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.profiles.getProfileDetail(user, id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && req.method === 'PATCH') { const id = pathname.split('/')[3]; const body = await parseBody(req); const user = requireUser(); modules.policy.requirePermission(user, 'pipeline:write'); const result = modules.pipeline.moveProfileStage(user, id, body.stage, body.beforeProfileId || null, { expectedVersion: body.expectedVersion ?? null, expectedUpdatedAt: body.expectedUpdatedAt ?? null, expectedBoardVersion: body.expectedBoardVersion ?? null }); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/board/reorder' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'pipeline:write'); const result = modules.pipeline.reorderBoard(user, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/board/normalize' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'pipeline:write'); const result = modules.pipeline.normalizeBoardOrdering(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') { const id = pathname.split('/')[3]; const user = requireUser(); modules.policy.requirePermission(user, 'profiles:write'); const result = modules.profiles.updateProfile(user, id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/board' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.pipeline.getBoard(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }

      if (pathname === '/api/households' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'households:read'); const result = modules.households.listHouseholds(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/households' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'households:write'); const result = modules.households.createHousehold(user, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'POST') { const id = pathname.split('/')[3]; const user = requireUser(); modules.policy.requirePermission(user, 'households:write'); const result = modules.households.addHouseholdMember(user, id, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }

      if (pathname === '/api/forms/templates' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'forms:read'); const result = modules.forms.listFormTemplates(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/forms/templates' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'forms:write'); const result = modules.forms.createFormTemplate(user, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/forms/submissions' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'forms:read'); const result = modules.forms.listFormSubmissions(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/forms/submissions' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'forms:write'); const result = modules.forms.createFormSubmission(user, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }

      if (pathname === '/api/templates' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'templates:read'); const result = modules.templates.list(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/templates' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'templates:write'); const result = modules.templates.create(user, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }

      if (pathname === '/api/exports' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'exports:read'); const result = modules.exports.list(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/exports' && req.method === 'POST') { const user = requireUser(); modules.policy.requirePermission(user, 'exports:write'); const result = modules.exports.create(user, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
      if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && req.method === 'POST') { const id = pathname.split('/')[3]; const user = requireUser(); modules.policy.requirePermission(user, 'exports:write'); const result = modules.exports.retry(user, id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }

      if (pathname === '/api/audit' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'profiles:read'); const result = modules.audit.list(user); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
      if (pathname === '/api/analytics' && req.method === 'GET') { const user = requireUser(); modules.policy.requirePermission(user, 'analytics:read'); const result = { ...modules.analytics.get(user), materialized: readAnalyticsMaterializedSummary(user.firmId) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }

      if (pathname === '/portal' && req.method === 'GET') { finalizeLog(200); return serveStatic('portal.html', res, requestId); }
      finalizeLog(200, { static: true });
      return serveStatic(pathname, res, requestId);
    } catch (error) {
      finalizeLog(/not found/i.test(error?.message || '') ? 404 : 400);
      return sendError(res, error, requestId);
    }
  });
}

export async function startServer() {
  const { createStore } = await import('./store.mjs');
  const store = createStore();
  const reads = new SqliteReadRepository();
  const modules = createModules({ store, reads });
  const server = createHttpServer({ modules });

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
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(runtime.port, runtime.host, () => {
    const ready = ensureDatabaseReady();
    log('info', 'server.started', {
      host: runtime.host,
      port: runtime.port,
      dbPath: ready.dbPath,
      bootedAt,
      config: startupDiagnostics,
      storageHealth: readStorageHealth(),
      querySummary: readQuerySummary(),
      exportWorker: readExportWorkerStatus(),
      auditEvents: readAuditEventSummary()
    });
  });

  return server;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  startServer();
}
