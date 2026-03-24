import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteReadRepository } from './repositories/sqlite-read-repository.mjs';
import { runtime, log } from './runtime.mjs';
import { ensureDatabaseReady, closeDatabase, readQuerySummary } from './storage.mjs';
import { createStore } from './store.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '../../web/public');
const store = createStore();
const reads = new SqliteReadRepository();

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res, requestId) {
  json(res, 404, { message: 'Not found' }, { 'X-Request-Id': requestId });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    let completed = false;

    const fail = (error) => {
      if (completed) return;
      completed = true;
      req.destroy();
      reject(error);
    };

    req.on('data', (chunk) => {
      if (completed) return;
      data += chunk;
      if (data.length > runtime.maxBodyBytes) {
        fail(new Error(`Payload too large. Limit is ${runtime.maxBodyBytes} bytes.`));
      }
    });
    req.on('end', () => {
      if (completed) return;
      completed = true;
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', fail);
  });
}

function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '');
}

function requireUser(req) {
  return store.requireUser(getToken(req));
}

function resolveStaticFile(pathname) {
  const normalizedPath = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = resolve(publicDir, normalizedPath);
  const relativePath = relative(publicDir, filePath);
  if (relativePath.startsWith('..') || resolve(publicDir, relativePath) !== filePath) {
    return null;
  }
  return filePath;
}

function serveStatic(pathname, res, requestId) {
  const filePath = resolveStaticFile(pathname);
  if (!filePath) {
    notFound(res, requestId);
    return;
  }

  readFile(filePath)
    .then((contents) => {
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8'
      }[extname(filePath)] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType, 'X-Request-Id': requestId, 'Cache-Control': 'no-store', ...securityHeaders() });
      res.end(contents);
    })
    .catch(() => notFound(res, requestId));
}

function statusCodeForError(error) {
  const message = error?.message || 'Request failed';
  if (/payload too large/i.test(message)) return 413;
  if (/auth|permission/i.test(message)) return 401;
  if (/forbidden|missing permission/i.test(message)) return 403;
  if (/not found/i.test(message)) return 404;
  return 400;
}

function sendError(res, error, requestId) {
  const message = error?.message || 'Request failed';
  json(res, statusCodeForError(error), { message }, { 'X-Request-Id': requestId, ...securityHeaders() });
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
    if (pathname === '/health') {
      finalizeLog(200);
      return json(res, 200, { status: 'ok', service: runtime.serviceName, uptimeSeconds: Math.round(process.uptime()) }, { 'X-Request-Id': requestId, ...securityHeaders() });
    }
    if (pathname === '/ready') {
      const database = ensureDatabaseReady();
      finalizeLog(200);
      return json(res, 200, { status: 'ready', querySummary: readQuerySummary(), database }, { 'X-Request-Id': requestId, ...securityHeaders() });
    }
    if (pathname === '/api/register' && req.method === 'POST') { const result = store.register(await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/login' && req.method === 'POST') { const result = store.login(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/invites' && req.method === 'POST') { const result = store.inviteUser(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/invites/accept' && req.method === 'POST') { const result = store.acceptInvite(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/password-resets' && req.method === 'POST') { const result = store.requestPasswordReset((await parseBody(req)).email || ''); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/password-resets/confirm' && req.method === 'POST') { const result = store.resetPassword(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/users' && req.method === 'GET') { const result = store.listUsers(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/session' && req.method === 'GET') { const result = { user: requireUser(req) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/logout' && req.method === 'POST') { const result = store.logout(getToken(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/dashboard' && req.method === 'GET') { const result = store.getDashboard(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/profiles' && req.method === 'GET') { const user = requireUser(req); const result = reads.listProfiles(user.firmId, { kind: url.searchParams.get('kind'), search: url.searchParams.get('search') || '' }); finalizeLog(200, { firmId: user.firmId }); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/profiles' && req.method === 'POST') { const result = store.createProfile(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage-history') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.listStageHistory(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.listNotes(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.addNote(requireUser(req), id, body.body || ''); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && pathname.split('/').length === 4 && req.method === 'GET') { const id = pathname.split('/')[3]; const user = requireUser(req); const result = { ...store.getProfileDetail(user, id), profileRecord: reads.getProfileDetail(user.firmId, id) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && req.method === 'PATCH') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.moveProfileStage(requireUser(req), id, body.stage, body.beforeProfileId || null); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') { const id = pathname.split('/')[3]; const result = store.updateProfile(requireUser(req), id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/board' && req.method === 'GET') { const result = store.getBoard(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/households' && req.method === 'GET') { const result = store.listHouseholds(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/households' && req.method === 'POST') { const result = store.createHousehold(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.addHouseholdMember(requireUser(req), id, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'DELETE') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.removeHouseholdMember(requireUser(req), id, body.clientId); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/households/link-spouse' && req.method === 'POST') { const body = await parseBody(req); const result = store.linkSpouse(requireUser(req), body.primaryClientId, body.spouseClientId); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/households/create-spouse' && req.method === 'POST') { const body = await parseBody(req); const result = store.createSpouse(requireUser(req), body.primaryClientId, body.spouse); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/forms/templates' && req.method === 'GET') { const result = store.listFormTemplates(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/forms/templates' && req.method === 'POST') { const result = store.createFormTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/forms/submissions' && req.method === 'GET') { const result = store.listFormSubmissions(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/forms/drafts' && req.method === 'GET') { const result = store.listFormDrafts(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/forms/submissions' && req.method === 'POST') { const result = store.createFormSubmission(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'PATCH') { const id = pathname.split('/')[4]; const result = store.updateSubmission(requireUser(req), id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'DELETE') { const id = pathname.split('/')[4]; const result = store.deleteSubmission(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/templates' && req.method === 'GET') { const result = store.listDocumentTemplates(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/templates' && req.method === 'POST') { const result = store.createDocumentTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/templates/auto-build' && req.method === 'POST') { const result = store.autoBuildTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.publishTemplate(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings') && req.method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.updateTemplateMappings(requireUser(req), id, body.mappings || []); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/exports' && req.method === 'GET') { const result = store.listExports(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/exports' && req.method === 'POST') { const result = store.createExport(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/exports/process' && req.method === 'POST') { const result = store.processQueuedExports(); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.retryExport(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/audit' && req.method === 'GET') { const result = store.listAudit(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/analytics' && req.method === 'GET') { const user = requireUser(req); const result = { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.getMaskedSensitiveData(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/api/portal-links' && req.method === 'POST') { const body = await parseBody(req); const result = store.createPortalLink(requireUser(req), body.profileId); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/portal/') && pathname.split('/').length === 4 && req.method === 'GET') { const token = pathname.split('/')[3]; const result = store.getPortalData(token); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/submissions') && req.method === 'POST') { const token = pathname.split('/')[3]; const result = store.portalSubmit(token, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId, ...securityHeaders() }); }
    if (pathname === '/portal' && req.method === 'GET') { finalizeLog(200); return serveStatic('/portal.html', res, requestId); }

    finalizeLog(200, { static: true });
    return serveStatic(pathname, res, requestId);
  } catch (error) {
    log('error', 'request.failed', { requestId, method: req.method, path: req.url, error: error.message || String(error) });
    finalizeLog(statusCodeForError(error));
    return sendError(res, error, requestId);
  }
});

server.headersTimeout = runtime.headersTimeoutMs;
server.requestTimeout = runtime.requestTimeoutMs;
server.keepAliveTimeout = runtime.keepAliveTimeoutMs;

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
