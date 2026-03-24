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
import { createStore } from './store.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '../../web/public');
const store = createStore();
const reads = new SqliteReadRepository();
const bootedAt = new Date().toISOString();
const startupDiagnostics = validateRuntimeConfig();
const CSRF_SESSION_COOKIE = '__Host-klient-csrf';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_BOOTSTRAP_PATH = '/api/csrf';
const CSRF_EXEMPT_PATHS = new Set([
  '/api/login',
  '/api/register',
  '/api/invites/accept',
  '/api/password-resets',
  '/api/password-resets/confirm'
]);

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

function cookieConfig(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secure = runtime.isProduction || xfProto === 'https';
  return {
    secure,
    sameSite: secure ? 'Strict' : 'Lax',
    httpOnly: true,
    path: '/api',
    maxAge: 60 * 15
  };
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCsrfCookie(req) {
  const options = cookieConfig(req);
  return serializeCookie(CSRF_SESSION_COOKIE, '', { ...options, maxAge: 0 });
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

function getExpectedOrigins(req) {
  const host = String(req.headers.host || `${runtime.host}:${runtime.port}`).split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto || (runtime.isProduction ? 'https' : 'http');
  const origins = new Set();
  if (host) origins.add(`${protocol}://${host}`);
  if (forwardedHost) origins.add(`${protocol}://${forwardedHost}`);
  return origins;
}

function isCsrfExempt(pathname) {
  return pathname === CSRF_BOOTSTRAP_PATH || CSRF_EXEMPT_PATHS.has(pathname);
}

function validateOriginAndReferer(req, requestId) {
  const suppliedOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const suppliedReferer = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : '';
  const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'].toLowerCase() : '';
  const expectedOrigins = getExpectedOrigins(req);
  const matchesOrigin = suppliedOrigin && expectedOrigins.has(suppliedOrigin);
  const matchesReferer = suppliedReferer && [...expectedOrigins].some((origin) => suppliedReferer.startsWith(`${origin}/`) || suppliedReferer === origin);

  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
    return getCsrfErrorResponse('Cross-site browser context rejected.', requestId);
  }
  if (!suppliedOrigin && !suppliedReferer) {
    return getCsrfErrorResponse('Missing Origin or Referer.', requestId);
  }
  if (suppliedOrigin && !matchesOrigin) {
    return getCsrfErrorResponse('Origin mismatch.', requestId);
  }
  if (suppliedReferer && !matchesReferer) {
    return getCsrfErrorResponse('Referrer mismatch.', requestId);
  }
  return null;
}

function validateCsrf(req, requestId) {
  const originError = validateOriginAndReferer(req, requestId);
  if (originError) return originError;
  const sessionToken = getToken(req);
  if (!sessionToken) {
    return getCsrfErrorResponse('Missing or expired authenticated session.', requestId);
  }
  const cookies = parseCookies(req);
  const cookieTokenId = cookies[CSRF_SESSION_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  const result = store.validateCsrfToken(sessionToken, cookieTokenId, headerToken);
  if (!result.ok) return getCsrfErrorResponse(result.reason, requestId);
  return { nextToken: result.nextToken };
}

function csrfRefreshHeaders(req, nextToken) {
  const options = cookieConfig(req);
  return {
    'Set-Cookie': serializeCookie(CSRF_SESSION_COOKIE, nextToken.id, options),
    'X-CSRF-Token': nextToken.token
  };
}

function applyResponseHeaders(res, headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    res.setHeader(name, value);
  }
}

function withCommonHeaders(res, requestId, headers = {}) {
  applyResponseHeaders(res, { ...baseHeaders(), 'X-Request-Id': requestId, ...headers });
}

function jsonWithHeaders(res, status, body, requestId, headers = {}) {
  withCommonHeaders(res, requestId, { 'Content-Type': 'application/json', ...headers });
  res.statusCode = status;
  res.end(JSON.stringify(body, null, 2));
}

function sendCsrfBootstrap(res, req, requestId, sessionToken) {
  const session = store.getSession(sessionToken);
  if (!session) {
    return jsonWithHeaders(res, 401, { message: 'Authentication required.' }, requestId, { 'Set-Cookie': clearCsrfCookie(req) });
  }
  const tokenRecord = store.issueCsrfToken(session.token);
  const headers = csrfRefreshHeaders(req, tokenRecord);
  return jsonWithHeaders(res, 200, { csrfToken: tokenRecord.token, expiresAt: tokenRecord.expiresAt }, requestId, headers);
}

function serveJson(res, statusCode, payload, requestId, extraHeaders = {}) {
  return jsonWithHeaders(res, statusCode, payload, requestId, extraHeaders);
}

function csrfHeadersForRequest(req, pathname, method, requestId) {
  if (!pathname.startsWith('/api/') || !requiresCsrfProtection(method) || isCsrfExempt(pathname)) {
    return { error: null, headers: {} };
  }
  const validation = validateCsrf(req, requestId);
  if (validation?.statusCode) {
    return { error: validation, headers: {} };
  }
  return { error: null, headers: csrfRefreshHeaders(req, validation.nextToken) };
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

function parseRawBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 25_000_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
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
  const statusCode = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : (/not found/i.test(message) ? 404 : /auth|permission/i.test(message) ? 401 : 400);
  const statusCode = error?.statusCode || (/not found/i.test(message) ? 404 : /auth|permission/i.test(message) ? 401 : 400);
  json(res, statusCode, {
    message,
    error: {
      message,
      code: error?.code || null,
      details: error?.details || null,
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
      const storageHealth = { ...readStorageHealth(), objectStorage: store.objectStorage.describeHealth?.() || null };
      const queue = readExportWorkerStatus();
      finalizeLog(200);
      return json(res, 200, {
        status: 'ready',
        querySummary: readQuerySummary(),
        database,
        storageHealth,
        exportWorker: queue,
        auditEvents: readAuditEventSummary(),
        startupDiagnostics
      }, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/ops/diagnostics' && req.method === 'GET') {
      const user = requireUser(req);
      const auditEvents = store.listAudit(user);
      const exports = store.listExports(user);
      const queue = readExportWorkerStatus();
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
          runtime: startupDiagnostics,
          auth: { provider: runtime.authProvider }
        },
        data: {
          querySummary: readQuerySummary(),
          storageHealth: { ...readStorageHealth(), objectStorage: store.objectStorage.describeHealth?.() || null },
          queue,
          exportWorker: { byStatus, total: exports.length, latest: exports.slice().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null },
          audit: { total: auditEvents.length, latest: auditEvents[0] || null }
        }
      }, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/csrf' && req.method === 'GET') {
      const token = getToken(req);
      const session = token ? store.getSession(token) : null;
      const response = sendCsrfBootstrap(res, req, requestId, token);
      finalizeLog(session ? 200 : 401);
      return response;
    }
    const csrfValidation = csrfHeadersForRequest(req, pathname, req.method, requestId);
    if (csrfValidation.error) {
      finalizeLog(csrfValidation.error.statusCode, { reason: csrfValidation.error.body.error.details.reason });
      return serveJson(res, csrfValidation.error.statusCode, csrfValidation.error.body, requestId, csrfValidation.error.headers);
    }
    if (Object.keys(csrfValidation.headers).length) {
      applyResponseHeaders(res, csrfValidation.headers);
    }

    if (pathname.startsWith('/api/storage/presigned/') && req.method === 'PUT') {
      const token = url.searchParams.get('token');
      const operation = pathname.endsWith('/upload') ? 'upload' : null;
      if (!token || !operation || typeof store.objectStorage.provider.consumePresignedToken !== 'function') {
        finalizeLog(404);
        return notFound(res, requestId);
      }
      const object = store.objectStorage.provider.consumePresignedToken(token, operation);
      if (!object) {
        finalizeLog(403);
        return json(res, 403, { message: 'Invalid or expired presigned token.' }, { 'X-Request-Id': requestId });
      }
      const payload = await parseRawBody(req);
      await store.objectStorage.putObject({ ...object, body: payload, contentType: req.headers['content-type'] || object.contentType || 'application/octet-stream' });
      finalizeLog(200);
      return json(res, 200, { ok: true }, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/storage/presigned/') && req.method === 'GET') {
      const token = url.searchParams.get('token');
      const operation = pathname.endsWith('/download') ? 'download' : null;
      if (!token || !operation || typeof store.objectStorage.provider.consumePresignedToken !== 'function') {
        finalizeLog(404);
        return notFound(res, requestId);
      }
      const object = store.objectStorage.provider.consumePresignedToken(token, operation);
      if (!object) {
        finalizeLog(403);
        return json(res, 403, { message: 'Invalid or expired presigned token.' }, { 'X-Request-Id': requestId });
      }
      const fetched = await store.objectStorage.getObject(object);
      res.writeHead(200, { ...baseHeaders(), 'X-Request-Id': requestId, 'Content-Type': object.contentType || fetched.contentType || 'application/octet-stream' });
      res.end(fetched.body);
      finalizeLog(200);
      return;
    }
    if (pathname === '/api/register' && req.method === 'POST') { const result = store.auth.register(await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/login' && req.method === 'POST') { const result = store.auth.login(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/invites' && req.method === 'POST') { const result = store.inviteUser(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/invites/accept' && req.method === 'POST') { const result = store.acceptInvite(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/password-resets' && req.method === 'POST') { const result = store.auth.requestReset(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/password-resets/confirm' && req.method === 'POST') { const result = store.auth.resetPassword(await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
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
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && req.method === 'PATCH') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const result = store.reorderBoard(requireUser(req), {
        profileId: id,
        toStage: body.stage,
        beforeProfileId: body.beforeProfileId || null,
        expectedVersion: body.expectedVersion ?? null,
        expectedUpdatedAt: body.expectedUpdatedAt ?? null,
        expectedBoardVersion: body.expectedBoardVersion ?? null
      });
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/board/reorder' && req.method === 'POST') {
      const result = store.reorderBoard(requireUser(req), await parseBody(req));
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/board/normalize' && req.method === 'POST') {
      const result = store.normalizeBoardOrdering(requireUser(req));
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
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
    if (pathname.startsWith('/api/forms/drafts/') && pathname.endsWith('/lock') && req.method === 'POST') {
      const id = pathname.split('/')[4];
      const result = store.acquireDraftLock(requireUser(req), id, await parseBody(req));
      finalizeLog(result.conflict ? 409 : 200);
      return json(res, result.conflict ? 409 : 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/forms/drafts/') && pathname.endsWith('/lock') && req.method === 'DELETE') {
      const id = pathname.split('/')[4];
      const body = await parseBody(req);
      const result = store.releaseDraftLock(requireUser(req), id, body.leaseId || '');
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/forms/drafts/') && req.method === 'PATCH') {
      const id = pathname.split('/')[4];
      const result = store.reviseDraftSubmission(requireUser(req), id, await parseBody(req));
      finalizeLog(result.conflict ? 409 : 200);
      return json(res, result.conflict ? 409 : 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname === '/api/client/workspace' && req.method === 'GET') { const result = store.getClientWorkspace(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/client/forms/submissions' && req.method === 'POST') { const result = store.submitClientForm(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/client/uploads/presign' && req.method === 'POST') { const result = await store.createClientUploadPresign(requireUser(req), await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/client/uploads' && req.method === 'POST') { const result = store.submitClientUpload(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/forms/submissions/') && pathname.split('/').length === 5 && req.method === 'PATCH') { const id = pathname.split('/')[4]; const result = store.updateSubmission(requireUser(req), id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/forms/submissions/') && pathname.includes('/sections/') && pathname.endsWith('/items') && req.method === 'POST') {
      const parts = pathname.split('/');
      const submissionId = parts[4];
      const sectionKey = parts[6];
      const result = store.createSubmissionSectionItem(requireUser(req), submissionId, sectionKey, await parseBody(req));
      finalizeLog(201);
      return json(res, 201, result, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/forms/submissions/') && pathname.includes('/sections/') && pathname.includes('/items/') && req.method === 'PATCH') {
      const parts = pathname.split('/');
      const submissionId = parts[4];
      const sectionKey = parts[6];
      const itemKey = parts[8];
      const result = store.updateSubmissionSectionItem(requireUser(req), submissionId, sectionKey, itemKey, await parseBody(req));
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/forms/submissions/') && pathname.includes('/sections/') && pathname.includes('/items/') && req.method === 'DELETE') {
      const parts = pathname.split('/');
      const submissionId = parts[4];
      const sectionKey = parts[6];
      const itemKey = parts[8];
      const result = store.deleteSubmissionSectionItem(requireUser(req), submissionId, sectionKey, itemKey);
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/client/uploads/') && pathname.endsWith('/download-url') && req.method === 'POST') { const id = pathname.split('/')[4]; const result = await store.createClientUploadDownloadUrl(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'PATCH') { const id = pathname.split('/')[4]; const result = store.updateSubmission(requireUser(req), id, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'DELETE') { const id = pathname.split('/')[4]; const result = store.deleteSubmission(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/templates' && req.method === 'GET') { const result = store.listDocumentTemplates(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/templates' && req.method === 'POST') { const result = store.createDocumentTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/templates/auto-build' && req.method === 'POST') { const result = store.autoBuildTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/versions') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.listTemplateVersions(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish-transitions') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.listPublishTransitions(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.publishTemplate(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings') && req.method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.updateTemplateMappings(requireUser(req), id, body.mappings || []); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/exports' && req.method === 'GET') { const result = store.listExports(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/exports' && req.method === 'POST') { const result = store.createExport(requireUser(req), await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/exports/process' && req.method === 'POST') {
      const user = requireUser(req);
      store.assertPermission(user, 'exports:process');
      const result = store.processQueuedExports();
      store.assertPermission(user, 'exports:write');
      const result = await store.processQueuedExports();
      finalizeLog(200);
      return json(res, 200, { ...result, deprecated: true, message: 'Manual processing endpoint is deprecated; prefer running scripts/export-worker.mjs.' }, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = store.retryExport(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/exports/') && pathname.endsWith('/download-url') && req.method === 'POST') { const id = pathname.split('/')[3]; const result = await store.createExportDownloadUrl(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/ops/lifecycle/run' && req.method === 'POST') { const result = await store.runLifecyclePolicies(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/audit' && req.method === 'GET') { const result = store.listAudit(requireUser(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/analytics' && req.method === 'GET') { const user = requireUser(req); const result = { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) }; finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.getMaskedSensitiveData(requireUser(req), id, { purpose: url.searchParams.get('purpose') || 'profile_view', unmask: url.searchParams.get('unmask') === 'true' }); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/analytics' && req.method === 'GET') {
      const user = requireUser(req);
      const result = {
        stageCounts: reads.getAnalytics(user.firmId),
        summary: store.getAnalytics(user),
        materialized: readAnalyticsMaterializedSummary(user.firmId)
      };
      finalizeLog(200);
      return json(res, 200, result, { 'X-Request-Id': requestId });
    }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && req.method === 'GET') { const id = pathname.split('/')[3]; const result = store.getMaskedSensitiveData(requireUser(req), id); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/api/portal-links' && req.method === 'POST') { const body = await parseBody(req); const result = store.createPortalLink(requireUser(req), body.profileId); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.split('/').length === 4 && req.method === 'GET') { const token = pathname.split('/')[3]; const result = store.getPortalData(token); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/submissions') && req.method === 'POST') { const token = pathname.split('/')[3]; const result = store.portalSubmit(token, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/uploads/presign') && req.method === 'POST') { const token = pathname.split('/')[3]; const result = await store.createPortalUploadPresign(token, await parseBody(req)); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/uploads') && req.method === 'POST') { const token = pathname.split('/')[3]; const result = store.portalUpload(token, await parseBody(req)); finalizeLog(201); return json(res, 201, result, { 'X-Request-Id': requestId }); }
    if (pathname.startsWith('/api/portal/') && pathname.includes('/uploads/') && pathname.endsWith('/download-url') && req.method === 'POST') { const [, , , token, , uploadId] = pathname.split('/'); const result = await store.createPortalUploadDownloadUrl(token, uploadId); finalizeLog(200); return json(res, 200, result, { 'X-Request-Id': requestId }); }
    if (pathname === '/portal' && req.method === 'GET') { finalizeLog(200); return serveStatic('portal.html', res, requestId); }

    finalizeLog(200, { static: true });
    return serveStatic(pathname, res, requestId);
  } catch (error) {
    log('error', 'request.failed', { requestId, method: req.method, path: req.url, error: error.message || String(error) });
    const statusCode = error?.statusCode || (/not found/i.test(error?.message || '') ? 404 : 400);
    finalizeLog(statusCode);
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
