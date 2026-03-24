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
  readAuditEventSummary
} from './storage.mjs';
import { createStore } from './store.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '../../web/public');
const store = createStore();
const reads = new SqliteReadRepository();
const bootedAt = new Date().toISOString();
const startupDiagnostics = validateRuntimeConfig();
const csrfSessions = new Map();
const CSRF_SESSION_COOKIE = 'klient-csrf-session';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res, requestId) {
  json(res, 404, { message: 'Not found' }, { 'X-Request-Id': requestId });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, ...rest] = entry.split('=');
        return [name, decodeURIComponent(rest.join('=') || '')];
      })
  );
}

function expectedOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return `${protocol}://${req.headers.host || `${runtime.host}:${runtime.port}`}`;
}

function getCsrfTokenRecord(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[CSRF_SESSION_COOKIE];
  if (!sessionId) return null;
  const token = csrfSessions.get(sessionId);
  if (!token) return null;
  return { sessionId, token };
}

function createCsrfSession() {
  const sessionId = randomUUID();
  const token = randomUUID();
  csrfSessions.set(sessionId, token);
  return { sessionId, token };
}

function requiresCsrfProtection(method = 'GET') {
  return !CSRF_SAFE_METHODS.has(method.toUpperCase());
}

function getCsrfErrorResponse(reason, requestId) {
  return {
    statusCode: 403,
    body: {
      error: {
        code: 'CSRF_VALIDATION_FAILED',
        message: 'CSRF validation failed.',
        details: { reason }
      }
    },
    headers: { 'X-Request-Id': requestId }
  };
}

function validateCsrf(req, requestId) {
  const suppliedOrigin = req.headers.origin;
  const suppliedReferer = req.headers.referer;
  const origin = expectedOrigin(req);

  if (suppliedOrigin && suppliedOrigin !== origin) {
    return getCsrfErrorResponse('Origin mismatch.', requestId);
  }
  if (suppliedReferer && !suppliedReferer.startsWith(`${origin}/`)) {
    return getCsrfErrorResponse('Referrer mismatch.', requestId);
  }

  const record = getCsrfTokenRecord(req);
  if (!record) {
    return getCsrfErrorResponse('Missing CSRF session.', requestId);
  }
  const headerToken = req.headers[CSRF_HEADER];
  if (!headerToken || headerToken !== record.token) {
    return getCsrfErrorResponse('Invalid or missing CSRF token.', requestId);
  }
  return null;
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
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

function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '');
}

function requireUser(req) {
  return store.requireUser(getToken(req));
}

function serveStatic(pathname, res, requestId) {
  const filePath = pathname === '/' ? resolve(publicDir, 'index.html') : resolve(publicDir, pathname.slice(1));
  const publicDirRoot = `${publicDir}${sep}`;
  if (filePath !== publicDir && !filePath.startsWith(publicDirRoot)) {
    return notFound(res, requestId);
  }
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

function baseHeaders() {
  return {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}

function sendError(res, error, requestId) {
  const message = error?.message || 'Request failed';
  const statusCode = /not found/i.test(message) ? 404 : /auth|permission/i.test(message) ? 401 : 400;
  json(res, statusCode, {
    message,
    error: {
      message,
      statusCode,
      requestId
    }
  }, { 'X-Request-Id': requestId });
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

const server = createServer(async (req, res) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  const url = new URL(req.url || '/', `http://${req.headers.host || `${runtime.host}:${runtime.port}`}`);
  const { pathname } = url;
  const finalizeLog = requestLogger(req, requestId);

  try {
    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      finalizeLog(200);
      return json(res, 200, { status: 'ok', service: runtime.serviceName, uptimeSeconds: Math.round(process.uptime()) }, { 'X-Request-Id': requestId });
    }
    if (pathname === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
      const database = ensureDatabaseReady();
      const storageHealth = readStorageHealth();
      finalizeLog(200);
      return json(res, 200, {
        status: 'ready',
        querySummary: readQuerySummary(),
        database,
        storageHealth,
        exportWorker: readExportWorkerStatus(),
        auditEvents: readAuditEventSummary(),
        startupDiagnostics
      }, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/ops/diagnostics' && req.method === 'GET') {
      const user = requireUser(req);
      const auditEvents = store.listAudit(user);
      const exports = store.listExports(user);
      const byStatus = exports.reduce((acc, job) => {
        acc[job.status] = (acc[job.status] || 0) + 1;
        return acc;
      }, {});
      finalizeLog(200);
      return json(res, 200, {
        generatedAt: new Date().toISOString(),
        startup: {
          bootedAt,
          uptimeSeconds: Math.round(process.uptime()),
          pid: process.pid,
          runtime: startupDiagnostics
        },
        data: {
          querySummary: readQuerySummary(),
          storageHealth: readStorageHealth(),
          exportWorker: { byStatus, total: exports.length, latest: exports.slice().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null },
          audit: { total: auditEvents.length, latest: auditEvents[0] || null }
        }
      }, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/csrf' && req.method === 'GET') {
      const session = createCsrfSession();
      finalizeLog(200);
      return json(
        res,
        200,
        { csrfToken: session.token },
        {
          'X-Request-Id': requestId,
          'Set-Cookie': `${CSRF_SESSION_COOKIE}=${session.sessionId}; HttpOnly; Path=/; SameSite=Strict`
        }
      );
    }
    if (pathname.startsWith('/api/') && requiresCsrfProtection(req.method)) {
      const csrfError = validateCsrf(req, requestId);
      if (csrfError) {
        finalizeLog(csrfError.statusCode, { reason: csrfError.body.error.details.reason });
        return json(res, csrfError.statusCode, csrfError.body, csrfError.headers);
      }
    }
    if (pathname === '/api/register' && req.method === 'POST') { const result = store.register(await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/login' && req.method === 'POST') { const result = store.login(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/invites' && req.method === 'POST') { const result = store.inviteUser(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/invites/accept' && req.method === 'POST') { const result = store.acceptInvite(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/password-resets' && req.method === 'POST') { const result = store.requestPasswordReset((await parseBody(req)).email || ''); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/password-resets/confirm' && req.method === 'POST') { const result = store.resetPassword(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/users' && req.method === 'GET') { const result = store.listUsers(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/session' && req.method === 'GET') { const result = { user: requireUser(req) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/logout' && req.method === 'POST') { const result = store.logout(getToken(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/dashboard' && req.method === 'GET') { const result = store.getDashboard(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/profiles' && req.method === 'GET') { const user = requireUser(req); store.assertPermission(user, 'profiles:read'); const result = reads.listProfiles(user.firmId, { kind: url.searchParams.get('kind'), search: url.searchParams.get('search') || '' }); finalizeLog(200, { firmId: user.firmId }); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/profiles' && req.method === 'POST') { const result = store.createProfile(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage-history') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.listStageHistory(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.listNotes(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.addNote(requireUser(req), id, body.body || ''); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.split('/').length === 4 && req.method === 'GET') { const id = pathname.split('/')[3]; const user = requireUser(req); const result = { ...store.getProfileDetail(user, id), profileRecord: reads.getProfileDetail(user.firmId, id) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && req.method === 'PATCH') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.moveProfileStage(requireUser(req), id, body.stage, body.beforeProfileId || null); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') { const id = pathname.split('/')[3]; const result = store.updateProfile(requireUser(req), id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/board' && req.method === 'GET') { const result = store.getBoard(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/households' && req.method === 'GET') { const result = store.listHouseholds(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/households' && req.method === 'POST') { const result = store.createHousehold(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.addHouseholdMember(requireUser(req), id, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'DELETE') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.removeHouseholdMember(requireUser(req), id, body.clientId); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/households/link-spouse' && req.method === 'POST') { const body = await parseBody(req); const result = store.linkSpouse(requireUser(req), body.primaryClientId, body.spouseClientId); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/households/create-spouse' && req.method === 'POST') { const body = await parseBody(req); const result = store.createSpouse(requireUser(req), body.primaryClientId, body.spouse); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/forms/templates' && req.method === 'GET') { const result = store.listFormTemplates(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/forms/templates' && req.method === 'POST') { const result = store.createFormTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/forms/submissions' && req.method === 'GET') { const result = store.listFormSubmissions(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/forms/drafts' && req.method === 'GET') { const result = store.listFormDrafts(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/forms/submissions' && req.method === 'POST') { const result = store.createFormSubmission(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/client/workspace' && req.method === 'GET') { const result = store.getClientWorkspace(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/client/forms/submissions' && req.method === 'POST') { const result = store.submitClientForm(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/client/uploads' && req.method === 'POST') { const result = store.submitClientUpload(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'PATCH') { const id = pathname.split('/')[4]; const result = store.updateSubmission(requireUser(req), id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'DELETE') { const id = pathname.split('/')[4]; const result = store.deleteSubmission(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/templates' && req.method === 'GET') { const result = store.listDocumentTemplates(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/templates' && req.method === 'POST') { const result = store.createDocumentTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/templates/auto-build' && req.method === 'POST') { const result = store.autoBuildTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.publishTemplate(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings') && req.method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.updateTemplateMappings(requireUser(req), id, body.mappings || []); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/exports' && req.method === 'GET') { const result = store.listExports(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/exports' && req.method === 'POST') { const result = store.createExport(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/exports/process' && req.method === 'POST') { const result = store.processQueuedExports(); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.retryExport(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/audit' && req.method === 'GET') { const result = store.listAudit(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/analytics' && req.method === 'GET') { const user = requireUser(req); const result = { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.getMaskedSensitiveData(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/portal-links' && req.method === 'POST') { const body = await parseBody(req); const result = store.createPortalLink(requireUser(req), body.profileId); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.split('/').length === 4 && req.method === 'GET') { const token = pathname.split('/')[3]; const result = store.getPortalData(token); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/submissions') && req.method === 'POST') { const token = pathname.split('/')[3]; const result = store.portalSubmit(token, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/uploads') && req.method === 'POST') { const token = pathname.split('/')[3]; const result = store.portalUpload(token, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/portal' && req.method === 'GET') { finalizeLog(200); return serveStatic('portal.html', res, requestId); }

    finalizeLog(200, { static: true });
    return serveStatic(pathname, res, requestId);
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
  const ready = ensureDatabaseReady();
  const diag = {
    bootedAt,
    config: startupDiagnostics,
    storageHealth: readStorageHealth(),
    querySummary: readQuerySummary(),
    exportWorker: readExportWorkerStatus(),
    auditEvents: readAuditEventSummary()
  };
  log('info', 'server.started', { host: runtime.host, port: runtime.port, dbPath: ready.dbPath, diagnostics: diag });
  if (!startupDiagnostics.ok) {
    log('error', 'runtime.config.invalid', { issues: startupDiagnostics.issues });
  }
  if (startupDiagnostics.warnings.length) {
    log('warn', 'runtime.config.warnings', { warnings: startupDiagnostics.warnings });
  }
});
