import { createServer } from 'node:http'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SqliteReadRepository } from './repositories/sqlite-read-repository.mjs'
import { runtime, log, validateRuntimeConfig } from './runtime.mjs'
import {
  ensureDatabaseReady,
  closeDatabase,
  readQuerySummary,
  readExportWorkerStatus,
  readStorageHealth,
  readAuditEventSummary,
  readAnalyticsMaterializedSummary,
  consumeCsrfToken,
  deleteCsrfTokensBySession,
  deleteExpiredCsrfTokens,
  readCsrfToken,
  upsertCsrfToken
} from './storage.mjs'
import { createStore } from './store.mjs'
import { createModules } from './modules/index.mjs'
import { createKeyProvider } from './pii-crypto.mjs'
import { createRuntimeKmsAdapter } from './kms-adapter.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const publicDir = resolve(__dirname, '../../web/public')
const bootedAt = new Date().toISOString()
const startupDiagnostics = validateRuntimeConfig()
const COOKIE_POLICY = Object.freeze({
  session: {
    name: '__Host-klient-session',
    path: '/',
    sameSite: 'Strict'
  },
  csrf: {
    name: '__Host-klient-csrf',
    path: '/',
    sameSite: 'Strict'
  }
})
const CSRF_HEADER = 'x-csrf-token'
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CSRF_BOOTSTRAP_PATH = '/api/csrf'
const CSRF_TTL_SECONDS = 60 * 15
const SESSION_IDLE_TIMEOUT_SECONDS = 60 * 30
const REQUEST_LOG_INCLUDE_QUERY = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOG_REQUEST_QUERY || '').toLowerCase()
)
const LOG_SENSITIVE_QUERY_KEYS = new Set(['token', 'code', 'session', 'secret'])
const LOG_QUERY_SAFE_KEYS = new Set(['id', 'page', 'limit', 'kind', 'search', 'sort', 'filter'])
const CSRF_EXEMPT_PATHS = new Set([
  '/api/login',
  '/api/register',
  '/api/invites/accept',
  '/api/password-resets',
  '/api/password-resets/confirm'
])
const securityDiagnostics = {
  csrf: {
    rejectedTotal: 0,
    rejectedByReason: {}
  },
  session: {
    rejectedTotal: 0,
    rejectedByReason: {},
    rotatedTotal: 0,
    invalidatedTotal: 0
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body, null, 2))
}

function notFound(res, requestId) {
  json(res, 404, { message: 'Not found' }, { 'X-Request-Id': requestId })
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  if (!header) return {}
  return Object.fromEntries(
    header
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, ...rest] = entry.split('=')
        return [name, decodeURIComponent(rest.join('=') || '')]
      })
  )
}

function cookieConfig(req, overrides = {}) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  const secure = runtime.isProduction ? true : xfProto === 'https'
  return {
    secure,
    sameSite: overrides.sameSite || 'Strict',
    httpOnly: true,
    path: overrides.path || '/',
    maxAge: overrides.maxAge
  }
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

function buildSessionCookie(req, sessionToken) {
  return serializeCookie(
    COOKIE_POLICY.session.name,
    sessionToken,
    cookieConfig(req, {
      path: COOKIE_POLICY.session.path,
      sameSite: COOKIE_POLICY.session.sameSite,
      maxAge: SESSION_IDLE_TIMEOUT_SECONDS
    })
  )
}

function clearSessionCookie(req) {
  return serializeCookie(
    COOKIE_POLICY.session.name,
    '',
    cookieConfig(req, {
      path: COOKIE_POLICY.session.path,
      sameSite: COOKIE_POLICY.session.sameSite,
      maxAge: 0
    })
  )
}

function readOpsBearerToken(req) {
  return req.headers.authorization?.replace('Bearer ', '').trim()
}

function currentOpsToken() {
  return String(runtime.klientOpsToken || process.env.KLIENT_OPS_TOKEN || '').trim()
}

function isValidOpsToken(candidate) {
  const configured = currentOpsToken()
  if (!configured) return false
  const expected = Buffer.from(configured)
  const provided = Buffer.from(String(candidate || ''))
  if (expected.length === 0 || expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

function resolveSessionToken(req) {
  const cookies = parseCookies(req)
  const cookieToken = String(cookies[COOKIE_POLICY.session.name] || '').trim()
  if (cookieToken) return cookieToken
  return ''
}

function requiresCsrfProtection(method = 'GET') {
  if (runtime.nodeEnv === 'test' && runtime.enableTestCsrfBypass) return false
  return !CSRF_SAFE_METHODS.has(method.toUpperCase())
}

function getCsrfErrorResponse(reason, requestId) {
  securityDiagnostics.csrf.rejectedTotal += 1
  securityDiagnostics.csrf.rejectedByReason[reason] = (securityDiagnostics.csrf.rejectedByReason[reason] || 0) + 1
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
  }
}

function getExpectedOrigins(req) {
  const host = String(req.headers.host || `${runtime.host}:${runtime.port}`)
    .split(',')[0]
    .trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim()
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  const protocol = forwardedProto || (runtime.isProduction ? 'https' : 'http')
  const origins = new Set()
  if (host) origins.add(`${protocol}://${host}`)
  if (forwardedHost) origins.add(`${protocol}://${forwardedHost}`)
  return origins
}

function isCsrfExempt(pathname) {
  return pathname === CSRF_BOOTSTRAP_PATH || CSRF_EXEMPT_PATHS.has(pathname) || pathname.startsWith('/api/portal/')
}

function validateOriginAndReferer(req, requestId) {
  const suppliedOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
  const suppliedReferer = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : ''
  const secFetchSite =
    typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'].toLowerCase() : ''
  const expectedOrigins = getExpectedOrigins(req)
  const matchesOrigin = suppliedOrigin && expectedOrigins.has(suppliedOrigin)
  const matchesReferer =
    suppliedReferer &&
    [...expectedOrigins].some((origin) => suppliedReferer.startsWith(`${origin}/`) || suppliedReferer === origin)

  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
    return getCsrfErrorResponse('Cross-site browser context rejected.', requestId)
  }
  if (runtime.isProduction && !suppliedOrigin && !suppliedReferer) {
    return getCsrfErrorResponse('Missing Origin and Referer in production.', requestId)
  }
  if (!suppliedOrigin && !suppliedReferer) {
    if (!secFetchSite) return null
    return getCsrfErrorResponse('Missing Origin or Referer.', requestId)
  }
  if (suppliedOrigin && !matchesOrigin) {
    return getCsrfErrorResponse('Origin mismatch.', requestId)
  }
  if (suppliedReferer && !matchesReferer) {
    return getCsrfErrorResponse('Referrer mismatch.', requestId)
  }
  return null
}

function signCsrfPayload(sessionToken, tokenId, nonce) {
  return createHmac('sha256', runtime.appSecret).update(`${sessionToken}:${tokenId}:${nonce}`).digest('base64url')
}

function hashCsrfToken(token) {
  return createHash('sha256').update(token).digest('base64url')
}

function sanitizeDownloadFilename(value = 'export') {
  const cleaned = String(value || 'export')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'export'
}

function verifyHashEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual))
  const expectedBuffer = Buffer.from(String(expected))
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function createSignedCsrfToken(sessionToken) {
  const tokenId = randomUUID()
  const nonce = randomBytes(24).toString('base64url')
  const signature = signCsrfPayload(sessionToken, tokenId, nonce)
  return {
    tokenId,
    rawToken: `${tokenId}.${nonce}.${signature}`,
    tokenHash: hashCsrfToken(`${tokenId}.${nonce}.${signature}`)
  }
}

function issueCsrfForSession(req, sessionToken, userId) {
  deleteExpiredCsrfTokens(new Date().toISOString())
  const issuedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + CSRF_TTL_SECONDS * 1000).toISOString()
  const token = createSignedCsrfToken(sessionToken)
  upsertCsrfToken({
    id: token.tokenId,
    sessionToken,
    userId,
    token: token.tokenHash,
    issuedAt,
    lastRotatedAt: issuedAt,
    expiresAt,
    consumedAt: null
  })
  return {
    csrfToken: token.rawToken,
    expiresAt,
    headers: {
      [CSRF_HEADER]: token.rawToken,
      'Set-Cookie': serializeCookie(
        COOKIE_POLICY.csrf.name,
        token.tokenId,
        cookieConfig(req, {
          path: COOKIE_POLICY.csrf.path,
          sameSite: COOKIE_POLICY.csrf.sameSite,
          maxAge: Math.min(CSRF_TTL_SECONDS, SESSION_IDLE_TIMEOUT_SECONDS)
        })
      )
    }
  }
}

function clearCsrfCookie(req) {
  return serializeCookie(
    COOKIE_POLICY.csrf.name,
    '',
    cookieConfig(req, {
      path: COOKIE_POLICY.csrf.path,
      sameSite: COOKIE_POLICY.csrf.sameSite,
      maxAge: 0
    })
  )
}

function validateCsrf(req, requestId, sessionToken, user) {
  const originError = validateOriginAndReferer(req, requestId)
  if (originError) return originError
  const cookies = parseCookies(req)
  const cookieTokenId = String(cookies[COOKIE_POLICY.csrf.name] || '').trim()
  const headerToken = String(req.headers[CSRF_HEADER] || '').trim()
  if (!headerToken) return getCsrfErrorResponse('Missing CSRF token.', requestId)
  const [headerTokenId, nonce, signature] = headerToken.split('.')
  if (!headerTokenId || !nonce || !signature) {
    return getCsrfErrorResponse('Malformed CSRF token.', requestId)
  }
  if (cookieTokenId && headerTokenId !== cookieTokenId) {
    return getCsrfErrorResponse('Malformed CSRF token.', requestId)
  }
  const expectedSignature = signCsrfPayload(sessionToken, headerTokenId, nonce)
  if (!verifyHashEquals(signature, expectedSignature)) {
    return getCsrfErrorResponse('Invalid CSRF signature.', requestId)
  }
  const persisted = readCsrfToken(sessionToken, headerTokenId)
  if (!persisted || persisted.userId !== user.id) {
    return getCsrfErrorResponse('Unknown CSRF token.', requestId)
  }
  if (persisted.consumedAt) {
    return getCsrfErrorResponse('Replayed CSRF token.', requestId)
  }
  if (new Date(persisted.expiresAt).getTime() <= Date.now()) {
    return getCsrfErrorResponse('Expired CSRF token.', requestId)
  }
  if (!verifyHashEquals(hashCsrfToken(headerToken), persisted.token)) {
    return getCsrfErrorResponse('CSRF token mismatch.', requestId)
  }
  if (!consumeCsrfToken(sessionToken, headerTokenId, new Date().toISOString())) {
    return getCsrfErrorResponse('Replayed CSRF token.', requestId)
  }
  return null
}

function applyResponseHeaders(res, headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    res.setHeader(name, value)
  }
}

function withCommonHeaders(res, requestId, headers = {}) {
  applyResponseHeaders(res, { ...baseHeaders(), 'X-Request-Id': requestId, ...headers })
}

function jsonWithHeaders(res, status, body, requestId, headers = {}) {
  withCommonHeaders(res, requestId, { 'Content-Type': 'application/json', ...headers })
  res.statusCode = status
  res.end(JSON.stringify(body, null, 2))
}

function serveJson(res, statusCode, payload, requestId, extraHeaders = {}) {
  return jsonWithHeaders(res, statusCode, payload, requestId, extraHeaders)
}

function analyticsFiltersFrom(url) {
  return {
    startDate: url.searchParams.get('startDate') || null,
    endDate: url.searchParams.get('endDate') || null,
    cohortBy: url.searchParams.get('cohortBy') || 'all',
    cohortValue: url.searchParams.get('cohortValue') || null
  }
}

function csrfHeadersForRequest(req, pathname, method, requestId) {
  return { error: null, headers: {} }
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        req.destroy()
        reject(new Error('Payload too large'))
      }
    })
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('Invalid JSON payload'))
      }
    })
    req.on('error', reject)
  })
}

function parseRawBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25_000_000) {
        req.destroy()
        reject(new Error('Payload too large'))
      }
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return forwarded || req.socket?.remoteAddress || 'unknown'
}

function serveStatic(pathname, res, requestId) {
  const filePath = pathname === '/' ? resolve(publicDir, 'index.html') : resolve(publicDir, pathname.slice(1))
  const publicDirRoot = `${publicDir}${sep}`
  if (filePath !== publicDir && !filePath.startsWith(publicDirRoot)) {
    return notFound(res, requestId)
  }
  readFile(filePath)
    .then((contents) => {
      const contentType =
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8'
        }[extname(filePath)] || 'text/plain; charset=utf-8'
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': contentType,
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store'
      })
      res.end(contents)
    })
    .catch(() => notFound(res, requestId))
}

function baseHeaders() {
  return {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin'
  }
}

function sendError(res, error, requestId) {
  const message = error?.message || 'Request failed'
  const normalizedMessage = String(message).toLowerCase()
  const statusCode = Number.isInteger(error?.statusCode)
    ? error.statusCode
      : /not found/i.test(normalizedMessage)
        ? 404
        : /authentication required|invalid credentials|csrf/i.test(normalizedMessage)
          ? 401
          : /permission|policy denied|access denied|missing permission/i.test(normalizedMessage)
            ? 403
          : 400
  json(
    res,
    statusCode,
    {
      message,
      error: {
        message,
        code: error?.code || null,
        details: error?.details || null,
        statusCode,
        requestId
      }
    },
    { 'X-Request-Id': requestId }
  )
}

function requestLogger(req, requestId) {
  const startedAt = Date.now()
  const sanitizedPath = sanitizeRequestLogPath(req.url, { includeQuery: REQUEST_LOG_INCLUDE_QUERY })
  return (statusCode, metadata = {}) => {
    log('info', 'request.completed', {
      requestId,
      method: req.method,
      path: sanitizedPath,
      statusCode,
      durationMs: Date.now() - startedAt,
      ...metadata
    })
  }
}

function sanitizeRequestLogPath(rawUrl, { includeQuery = false } = {}) {
  const fallback = '/'
  const input = String(rawUrl || fallback)
  let url
  try {
    url = new URL(input, 'http://localhost')
  } catch {
    return fallback
  }
  const pathname = url.pathname || fallback
  if (!includeQuery || !url.searchParams || [...url.searchParams.keys()].length === 0) {
    return pathname
  }
  const query = sanitizeRequestLogQuery(url.searchParams)
  return query ? `${pathname}?${query}` : pathname
}

function sanitizeRequestLogQuery(searchParams) {
  const sanitized = new URLSearchParams()
  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = String(key || '').toLowerCase()
    if (LOG_SENSITIVE_QUERY_KEYS.has(normalizedKey)) {
      sanitized.set(key, '[REDACTED]')
      continue
    }
    if (!LOG_QUERY_SAFE_KEYS.has(normalizedKey)) {
      sanitized.set(key, '[OMITTED]')
      continue
    }
    sanitized.set(key, value)
  }
  return sanitized.toString()
}


export function bootstrapPiiKeyProvider() {
  const kmsAdapter = runtime.piiKeyProvider === 'kms' ? createRuntimeKmsAdapter(runtime) : null
  return createKeyProvider(runtime, { kmsAdapter })
}

export function createHttpServer({ modules }) {
  return createServer(async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID()
    const url = new URL(req.url || '/', `http://${req.headers.host || `${runtime.host}:${runtime.port}`}`)
    const { pathname } = url
    const finalizeLog = requestLogger(req, requestId)
    let sessionToken = null
    let authenticatedUser = null
    let rotateCsrfAfterResponse = false
    const rejectSession = (reason) => {
      securityDiagnostics.session.rejectedTotal += 1
      securityDiagnostics.session.rejectedByReason[reason] = (securityDiagnostics.session.rejectedByReason[reason] || 0) + 1
    }
    const requireUser = () => {
      const token = resolveSessionToken(req)
      try {
        return modules.auth.requireUser(token)
      } catch (error) {
        if (token) {
          deleteCsrfTokensBySession(token)
        }
        rejectSession('authentication_required')
        throw error
      }
    }
    const authorizeOpsRequest = () => {
      if (currentOpsToken()) {
        const opsToken = readOpsBearerToken(req)
        if (!isValidOpsToken(opsToken)) {
          const error = new Error('Ops token authentication required.')
          error.statusCode = 401
          throw error
        }
        const queueHealth = readExportWorkerStatus()
        return {
          id: 'ops-token',
          role: 'admin',
          authMode: 'ops-token',
          firmId: queueHealth?.latestJob?.firmId || null
        }
      }
      return null
    }
    const authorize = (guard, { allowAnonymous = false } = {}) => {
      const token = resolveSessionToken(req)
      if (allowAnonymous) {
        try {
          modules.policy.requireGuard({ role: 'anonymous' }, guard)
          return null
        } catch {
          // Continue to authenticated policy checks.
        }
      }
      let user
      try {
        user = modules.auth.requireUser(token)
      } catch (error) {
        if (token) {
          deleteCsrfTokensBySession(token)
        }
        rejectSession('authentication_required')
        throw error
      }
      modules.policy.requireGuard(user, guard)
      return user
    }
    const requirePortalSession = () => {
      if (!pathname.startsWith('/api/portal/')) throw new Error('Portal path required.')
      const token = pathname.split('/')[3]
      if (!token) throw new Error('Portal token required.')
      modules.forms.getPortalSession(token)
      return { token }
    }
    const replyJson = (statusCode, body, headers = {}) => {
      if (!rotateCsrfAfterResponse || !sessionToken || !authenticatedUser?.id) {
        return json(res, statusCode, body, headers)
      }
      const csrf = issueCsrfForSession(req, sessionToken, authenticatedUser.id)
      rotateCsrfAfterResponse = false
      return json(res, statusCode, body, { ...headers, ...csrf.headers })
    }

    try {
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        finalizeLog(200)
        return replyJson(
          200,
          { status: 'ok', service: runtime.serviceName, uptimeSeconds: Math.round(process.uptime()) },
          { 'X-Request-Id': requestId }
        )
      }
      if (pathname === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
        const database = ensureDatabaseReady()
        const storageHealth = readStorageHealth()
        const queue = readExportWorkerStatus()
        const querySummary = readQuerySummary()
        const auditEvents = readAuditEventSummary()
        finalizeLog(200)
        return replyJson(
          200,
          {
            status: 'ready',
            querySummary,
            database,
            storageHealth,
            exportWorker: queue,
            auditEvents,
            startupDiagnostics,
            checks: {
              databaseReady: Boolean(database?.ok),
              storageReady: Boolean(storageHealth?.ok),
              exportQueueReachable: Boolean(queue && typeof queue === 'object'),
              startupConfigValid: Boolean(startupDiagnostics?.ok)
            },
            diagnostics: {
              generatedAt: new Date().toISOString(),
              endpoints: {
                health: '/health',
                ready: '/ready',
                exportsQueue: '/api/ops/exports/queue',
                telemetry: '/api/ops/diagnostics'
              }
            }
          },
          { 'X-Request-Id': requestId }
        )
      }
      if (pathname === '/api/ops/diagnostics' && req.method === 'GET') {
        const user = authorizeOpsRequest() || authorize('canReadDiagnostics')
        const { auditEvents, exports } = modules.analytics.getDiagnosticsContext(user)
        const queueHealth = modules.exports.getQueueHealth(user)
        const queue = queueHealth?.queue || readExportWorkerStatus()
        const byStatus = exports.reduce((acc, job) => {
          acc[job.status] = (acc[job.status] || 0) + 1
          return acc
        }, {})
        finalizeLog(200)
        return replyJson(
          200,
          {
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
              storageHealth: readStorageHealth(),
              queue,
              exportWorker: {
                byStatus,
                total: exports.length,
                latest:
                  exports
                    .slice()
                    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null
              },
              audit: { total: auditEvents.length, latest: auditEvents[0] || null },
              security: {
                csrf: {
                  rejectedTotal: securityDiagnostics.csrf.rejectedTotal,
                  rejectedByReason: securityDiagnostics.csrf.rejectedByReason
                },
                sessions: {
                  rejectedTotal: securityDiagnostics.session.rejectedTotal,
                  rejectedByReason: securityDiagnostics.session.rejectedByReason,
                  rotatedTotal: securityDiagnostics.session.rotatedTotal,
                  invalidatedTotal: securityDiagnostics.session.invalidatedTotal
                }
              }
            }
          },
          { 'X-Request-Id': requestId }
        )
      }
      if (pathname === '/api/ops/exports/queue' && req.method === 'GET') {
        const user = authorizeOpsRequest() || requireUser()
        if (user?.authMode !== 'ops-token') modules.policy.requireGuard(user, 'canProcessExports')
        const result = modules.exports.getQueueHealth(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/ops/exports/retry-failed' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canProcessExports')
        const body = await parseBody(req)
        const result = modules.exports.retryFailed(user, body || {})
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/csrf' && req.method === 'GET') {
        sessionToken = resolveSessionToken(req)
        if (!sessionToken) {
          finalizeLog(401)
          return replyJson(401, { message: 'Authentication required.' }, { 'X-Request-Id': requestId })
        }
        authenticatedUser = modules.auth.requireUser(sessionToken)
        deleteCsrfTokensBySession(sessionToken)
        const csrf = issueCsrfForSession(req, sessionToken, authenticatedUser.id)
        finalizeLog(200)
        return replyJson(
          200,
          { csrfToken: csrf.csrfToken, expiresAt: csrf.expiresAt },
          {
            'X-Request-Id': requestId,
            ...csrf.headers
          }
        )
      }
      if (pathname === '/api/runtime' && req.method === 'GET') {
        authorize('canAccessRuntime', { allowAnonymous: true })
        finalizeLog(200);
        return replyJson(200, { enableDemoMode: runtime.enableDemoMode }, { 'X-Request-Id': requestId });
      }
      if (pathname.startsWith('/api/') && requiresCsrfProtection(req.method) && !isCsrfExempt(pathname)) {
        sessionToken = resolveSessionToken(req)
        authenticatedUser = modules.auth.requireUser(sessionToken)
        const csrfError = validateCsrf(req, requestId, sessionToken, authenticatedUser)
        if (csrfError) {
          finalizeLog(csrfError.statusCode, { reason: csrfError.body.error.details.reason })
          return replyJson(csrfError.statusCode, csrfError.body, csrfError.headers)
        }
        rotateCsrfAfterResponse = true
      }
      if (pathname === '/api/register' && req.method === 'POST') {
        authorize('canRegister', { allowAnonymous: true })
        const result = modules.auth.register(await parseBody(req))
        const csrf = issueCsrfForSession(req, result.token, result.user.id)
        finalizeLog(201)
        return replyJson(
          201,
          { user: result.user, csrfToken: csrf.csrfToken, csrfExpiresAt: csrf.expiresAt },
          {
            'X-Request-Id': requestId,
            'Set-Cookie': [buildSessionCookie(req, result.token), csrf.headers['Set-Cookie']],
            [CSRF_HEADER]: csrf.headers[CSRF_HEADER]
          }
        )
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        authorize('canLogin', { allowAnonymous: true })
        const result = modules.auth.login(await parseBody(req))
        if (result?.mfaRequired) {
          finalizeLog(200, { mfaRequired: true })
          return replyJson(200, { ...result, csrfToken: null, csrfExpiresAt: null }, { 'X-Request-Id': requestId })
        }
        const priorToken = resolveSessionToken(req)
        if (priorToken && priorToken !== result.token) {
          modules.auth.logout(priorToken)
          deleteCsrfTokensBySession(priorToken)
          securityDiagnostics.session.rotatedTotal += 1
        }
        const csrf = issueCsrfForSession(req, result.token, result.user.id)
        finalizeLog(200)
        return replyJson(
          200,
          { user: result.user, csrfToken: csrf.csrfToken, csrfExpiresAt: csrf.expiresAt },
          {
            'X-Request-Id': requestId,
            'Set-Cookie': [buildSessionCookie(req, result.token), csrf.headers['Set-Cookie']],
            [CSRF_HEADER]: csrf.headers[CSRF_HEADER]
          }
        )
      }
      if (pathname === '/api/invites' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageUsers')
        const result = modules.firmsUsers.inviteUser(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/invites/accept' && req.method === 'POST') {
        authorize('canAcceptInvite', { allowAnonymous: true })
        const result = modules.firmsUsers.acceptInvite(await parseBody(req))
        const csrf = issueCsrfForSession(req, result.token, result.user.id)
        finalizeLog(200)
        return replyJson(
          200,
          { user: result.user, csrfToken: csrf.csrfToken, csrfExpiresAt: csrf.expiresAt },
          {
            'X-Request-Id': requestId,
            'Set-Cookie': [buildSessionCookie(req, result.token), csrf.headers['Set-Cookie']],
            [CSRF_HEADER]: csrf.headers[CSRF_HEADER]
          }
        )
      }
      if (pathname === '/api/password-resets' && req.method === 'POST') {
        authorize('canRequestPasswordReset', { allowAnonymous: true })
        const result = modules.auth.requestReset(await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/password-resets/confirm' && req.method === 'POST') {
        authorize('canConfirmPasswordReset', { allowAnonymous: true })
        const result = modules.auth.resetPassword(await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }

      if (pathname === '/api/auth/mfa/enroll' && req.method === 'POST') {
        const user = authorize('canReadSession')
        const result = modules.auth.enrollMfa(user)
        finalizeLog(200)
        return replyJson(200, { ok: true, mfa: result }, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/auth/mfa/enroll/confirm' && req.method === 'POST') {
        const user = authorize('canReadSession')
        const result = modules.auth.confirmMfaEnrollment(user, await parseBody(req))
        finalizeLog(200)
        return replyJson(200, { ok: true, mfa: result }, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/auth/mfa/challenge' && req.method === 'POST') {
        const user = authorize('canReadSession')
        const result = modules.auth.challengeMfa(user)
        finalizeLog(200)
        return replyJson(200, { ok: true, mfa: result }, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/auth/mfa/verify' && req.method === 'POST') {
        const user = authorize('canReadSession')
        const result = modules.auth.verifyMfaChallenge(user, await parseBody(req))
        const priorToken = resolveSessionToken(req)
        const rotatedSession = modules.auth.rotateSession(priorToken, 'mfa_verified')
        deleteCsrfTokensBySession(priorToken)
        securityDiagnostics.session.rotatedTotal += 1
        const csrf = issueCsrfForSession(req, rotatedSession.token, rotatedSession.user.id)
        finalizeLog(200)
        return replyJson(
          200,
          { ok: true, mfa: result, token: rotatedSession.token, user: rotatedSession.user, sessionRotated: true },
          { 'X-Request-Id': requestId, ...csrf.headers }
        )
      }
      if (pathname === '/api/auth/mfa/backup-codes/rotate' && req.method === 'POST') {
        const user = authorize('canReadSession')
        const result = modules.auth.rotateMfaBackupCodes(user)
        finalizeLog(200)
        return replyJson(200, { ok: true, mfa: result }, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/users' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadUsers')
        const result = modules.firmsUsers.listUsers(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/session' && req.method === 'GET') {
        const result = { user: authorize('canReadSession') }
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        const token = resolveSessionToken(req)
        const result = modules.auth.logout(token)
        deleteCsrfTokensBySession(token)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId, 'Set-Cookie': clearCsrfCookie(req) })
      }
      if (pathname === '/api/dashboard' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canViewDashboard')
        const result = modules.profiles.getDashboard(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/profiles' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const query = {
          kind: url.searchParams.get('kind'),
          search: url.searchParams.get('search') || ''
        }
        const status = url.searchParams.get('status')
        if (status) query.status = status
        const result = modules.profiles.listProfiles(user, query)
        finalizeLog(200, { firmId: user.firmId })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/profiles' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = modules.profiles.createProfile(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage-history') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const result = modules.profiles.listStageHistory(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const result = modules.profiles.listNotes(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = modules.profiles.addNote(user, id, body.body || '')
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.split('/').length === 4 && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const result = modules.profiles.getProfileDetail(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canMovePipeline')
        const result = modules.pipeline.moveProfileStage(user, id, body.stage, body.beforeProfileId || null)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/pipeline/stages' && req.method === 'GET') {
        const user = requireUser()
        const result = modules.pipelineStages.listStages(user)
        finalizeLog(200, { firmId: user.firmId })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/pipeline/stages' && req.method === 'POST') {
        const user = requireUser()
        const result = modules.pipelineStages.createStage(user, await parseBody(req))
        finalizeLog(201, { firmId: user.firmId })
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/pipeline/stages/reorder' && req.method === 'PATCH') {
        const user = requireUser()
        const result = modules.pipelineStages.reorderStages(user, await parseBody(req))
        finalizeLog(200, { firmId: user.firmId })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/pipeline/stages/') && req.method === 'PATCH') {
        const stageId = pathname.split('/')[4]
        const user = requireUser()
        const result = modules.pipelineStages.updateStageMetadata(user, stageId, await parseBody(req))
        finalizeLog(200, { firmId: user.firmId })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/pipeline/stages/') && pathname.endsWith('/deactivate') && req.method === 'POST') {
        const stageId = pathname.split('/')[4]
        const user = requireUser()
        const result = modules.pipelineStages.deactivateStage(user, stageId)
        finalizeLog(200, { firmId: user.firmId })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/pipeline/reorder' && req.method === 'PATCH') {
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canMovePipeline')
        const result = modules.pipeline.reorderBoard(user, body)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.profiles.updateProfile(user, id, await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/board' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const result = modules.pipeline.getBoard(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/households' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadHouseholds')
        const result = modules.households.listHouseholds(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/households' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.createHousehold(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.addHouseholdMember(user, id, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.removeHouseholdMember(user, id, body.clientId)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/households/link-spouse' && req.method === 'POST') {
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.linkSpouse(user, body.primaryClientId, body.spouseClientId)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/households/create-spouse' && req.method === 'POST') {
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.createSpouse(user, body.primaryClientId, body.spouse)
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/forms/templates' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadForms')
        const result = modules.forms.listFormTemplates(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/forms/templates' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.createFormTemplate(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/forms/submissions' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadForms')
        const result = modules.forms.listFormSubmissions(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/forms/drafts' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadForms')
        const result = modules.forms.listFormDrafts(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const draftLockMatch = pathname.match(/^\/api\/forms\/drafts\/([^/]+)\/lock$/)
      if (draftLockMatch && req.method === 'POST') {
        const [, draftId] = draftLockMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.acquireDraftLock(user, decodeURIComponent(draftId), await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (draftLockMatch && req.method === 'DELETE') {
        const [, draftId] = draftLockMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const body = await parseBody(req)
        const result = modules.forms.releaseDraftLock(user, decodeURIComponent(draftId), body?.leaseId || '')
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const draftMatch = pathname.match(/^\/api\/forms\/drafts\/([^/]+)$/)
      if (draftMatch && req.method === 'PATCH') {
        const [, draftId] = draftMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.reviseDraftSubmission(user, decodeURIComponent(draftId), await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/forms/submissions' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.createFormSubmission(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/client/workspace' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadClientWorkspace')
        const result = modules.forms.getClientWorkspace(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/client/forms/submissions' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteClientWorkspace')
        const result = modules.forms.submitClientForm(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/client/uploads' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteClientWorkspace')
        const result = modules.forms.submitClientUpload(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/client/uploads/presign' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteClientWorkspace')
        const result = await modules.forms.createClientUploadPresign(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      const submissionSectionItemMatch = pathname.match(
        /^\/api\/forms\/submissions\/([^/]+)\/sections\/([^/]+)\/items\/([^/]+)$/
      )
      if (submissionSectionItemMatch && req.method === 'PATCH') {
        const [, submissionId, sectionKey, itemKey] = submissionSectionItemMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.updateSubmissionSectionItem(
          user,
          decodeURIComponent(submissionId),
          decodeURIComponent(sectionKey),
          decodeURIComponent(itemKey),
          await parseBody(req)
        )
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (submissionSectionItemMatch && req.method === 'DELETE') {
        const [, submissionId, sectionKey, itemKey] = submissionSectionItemMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const expectedUpdatedAt = url.searchParams.get('expectedUpdatedAt') || ''
        const result = modules.forms.deleteSubmissionSectionItem(
          user,
          decodeURIComponent(submissionId),
          decodeURIComponent(sectionKey),
          decodeURIComponent(itemKey),
          { expectedUpdatedAt }
        )
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (/^\/api\/forms\/submissions\/[^/]+$/.test(pathname) && req.method === 'PATCH') {
        const id = pathname.split('/')[4]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.updateSubmission(user, id, await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (/^\/api\/forms\/submissions\/[^/]+$/.test(pathname) && req.method === 'DELETE') {
        const id = pathname.split('/')[4]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.deleteSubmission(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/templates' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadTemplate')
        const result = modules.templates.list(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/templates' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const result = modules.templates.create(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/templates/auto-build' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const result = modules.templates.autoBuild(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canPublishTemplate')
        const result = modules.templates.publish(user, id, await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const result = modules.templates.updateMappings(user, id, body.mappings || [], {
          expectedVersionHash: body.expectedVersionHash || null
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings/preview') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadTemplate')
        const result = modules.templates.previewMappings(user, id, {
          clientId: body.clientId,
          submissionId: body.submissionId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/versions') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadTemplate')
        const result = modules.templates.listVersions(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish-transitions') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadTemplate')
        const result = modules.templates.listPublishTransitions(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/compare') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadTemplate')
        const baseVersion = Number(url.searchParams.get('baseVersion'))
        const targetVersion = Number(url.searchParams.get('targetVersion'))
        const result = modules.templates.compareVersions(user, id, baseVersion, targetVersion)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/revert') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const body = await parseBody(req)
        const result = modules.templates.revertVersion(user, id, Number(body.targetVersion), body)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/exports' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadExports')
        const result = modules.exports.list(user, {
          status: url.searchParams.get('status') || undefined,
          profileId: url.searchParams.get('profileId') || undefined,
          clientId: url.searchParams.get('clientId') || undefined,
          fromDate: url.searchParams.get('fromDate') || undefined,
          toDate: url.searchParams.get('toDate') || undefined,
          sort: url.searchParams.get('sort') || undefined
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/exports' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteExports')
        const body = await parseBody(req)
        const idempotencyKey = req.headers['idempotency-key']
        const result = modules.exports.create(user, {
          ...body,
          idempotencyKey: body.idempotencyKey || (typeof idempotencyKey === 'string' ? idempotencyKey : null)
        })
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/exports/process' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canProcessExports')
        const result = modules.exports.processQueuedExports(user)
        finalizeLog(200)
        return replyJson(
          200,
          {
            ...result,
            deprecated: true,
            message: 'Manual processing endpoint is deprecated; prefer running scripts/export-worker.mjs.'
          },
          { 'X-Request-Id': requestId }
        )
      }
      if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteExports')
        const result = modules.exports.retry(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/exports/') && pathname.endsWith('/download') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadExports')
        const artifact = modules.exports.getDownload(user, id)
        const fileName = sanitizeDownloadFilename(artifact.fileName || `${id}.bin`)
        res.writeHead(200, {
          ...baseHeaders(),
          'X-Request-Id': requestId,
          'Content-Type': artifact.contentType || 'application/octet-stream',
          'Content-Length': String(artifact.sizeBytes || artifact.body?.length || 0),
          'Content-Disposition': `attachment; filename=\"${fileName}\"`,
          'Cache-Control': 'private, no-store'
        })
        finalizeLog(200)
        return res.end(artifact.body)
      }
      if (pathname === '/api/audit' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadAudit')
        const result = modules.audit.list(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/analytics' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadAnalytics')
        const result = modules.analytics.get(user, analyticsFiltersFrom(url))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/analytics/dashboard' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadAnalytics')
        const result = modules.analytics.getDashboard(user, analyticsFiltersFrom(url))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/analytics/export' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadAnalytics')
        const csv = modules.analytics.exportCsv(user, analyticsFiltersFrom(url))
        withCommonHeaders(res, requestId, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename=\"analytics-report-${new Date().toISOString().slice(0, 10)}.csv\"`
        })
        res.statusCode = 200
        res.end(csv)
        finalizeLog(200)
        return
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadSensitiveProfileData')
        const result = modules.profiles.getMaskedSensitiveData(user, id)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/portal-links' && req.method === 'POST') {
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canCreatePortalLink')
        const result = modules.forms.createPortalLink(user, body.profileId, body)
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/portal-links/') && pathname.endsWith('/revoke') && req.method === 'POST') {
        const linkId = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canCreatePortalLink')
        const result = modules.forms.revokePortalLink(user, linkId)
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/portal/') && pathname.split('/').length === 4 && req.method === 'GET') {
        const { token } = requirePortalSession()
        const result = modules.forms.getPortalData(token)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/portal/') && pathname.endsWith('/submissions') && req.method === 'POST') {
        const { token } = requirePortalSession()
        const result = modules.forms.portalSubmit(token, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/portal/') && pathname.endsWith('/uploads/presign') && req.method === 'POST') {
        const { token } = requirePortalSession()
        const result = await modules.forms.createPortalUploadPresign(token, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/portal/') && pathname.endsWith('/uploads') && req.method === 'POST') {
        const { token } = requirePortalSession()
        const result = modules.forms.portalUpload(token, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/portal' && req.method === 'GET') {
        finalizeLog(200)
        return serveStatic('portal.html', res, requestId)
      }

      finalizeLog(200, { static: true })
      return serveStatic(pathname, res, requestId)
    } catch (error) {
      log('error', 'request.failed', {
        requestId,
        method: req.method,
        path: sanitizeRequestLogPath(req.url, { includeQuery: REQUEST_LOG_INCLUDE_QUERY }),
        error: error.message || String(error)
      })
      finalizeLog(/not found/i.test(error?.message || '') ? 404 : 400)
      return sendError(res, error, requestId)
    }
  })
}

function startServer() {
  const piiKeyProvider = bootstrapPiiKeyProvider()
  const store = createStore({
    piiKeyProvider,
    onSessionInvalidated: ({ token }) => {
      if (!token) return
      deleteCsrfTokensBySession(token)
      securityDiagnostics.session.invalidatedTotal += 1
    }
  })
  const reads = new SqliteReadRepository()
  const modules = createModules({ store, reads })
  const server = createHttpServer({ modules })

  let isShuttingDown = false
  function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true
    const exitCode = signal === 'uncaughtException' ? 1 : 0
    log('info', 'server.shutdown.started', { signal })
    server.close(() => {
      try {
        closeDatabase()
      } catch (error) {
        log('warn', 'server.shutdown.closeDatabase.failed', { signal, error: error?.message || String(error) })
      }
      log('info', 'server.shutdown.completed', { signal })
      process.exit(exitCode)
    })
    setTimeout(() => {
      log('error', 'server.shutdown.timeout', { signal })
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => {
    log('error', 'process.uncaughtException', { error: error.message, stack: error.stack })
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (error) => {
    log('error', 'process.unhandledRejection', { error: error?.message || String(error) })
  })

  if (runtime.isProduction && !startupDiagnostics.ok) {
    log('error', 'server.startup.blocked', {
      reason: 'Runtime configuration validation failed in production.',
      issues: startupDiagnostics.issues
    })
    closeDatabase()
    throw new Error('Startup blocked: runtime configuration is invalid in production.')
  }

  server.listen(runtime.port, runtime.host, () => {
    const ready = ensureDatabaseReady()
    const diag = {
      bootedAt,
      config: startupDiagnostics,
      storageHealth: readStorageHealth(),
      querySummary: readQuerySummary(),
      exportWorker: readExportWorkerStatus(),
      auditEvents: readAuditEventSummary()
    }
    log('info', 'server.started', { host: runtime.host, port: runtime.port, dbPath: ready.dbPath, diagnostics: diag })
    if (!startupDiagnostics.ok) {
      log('error', 'runtime.config.invalid', { issues: startupDiagnostics.issues })
    }
    if (startupDiagnostics.warnings.length) {
      log('warn', 'runtime.config.warnings', { warnings: startupDiagnostics.warnings })
    }
  })

  return server
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  startServer()
}
