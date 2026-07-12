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
  upsertCsrfToken,
  getFirmRow,
  getUserRow,
  getProfileRow
} from './storage.mjs'
import { createStore } from './store.mjs'
import { createModules } from './modules/index.mjs'
import { createMailer } from './mailer/index.mjs'
import { createKeyProvider } from './pii-crypto.mjs'
import { createRuntimeKmsAdapter } from './kms-adapter.mjs'
import {
  classifyWorkerHealth,
  logOperationalEvent,
  pickRecentExportFailures,
  readLastSuccessfulReleaseValidationTimestamp,
  summarizeExportQueue
} from './operability.mjs'
import { createRateLimiter } from './security/rate-limit.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const distDir = resolve(__dirname, '../../web/dist')
const bootedAt = new Date().toISOString()
const startupDiagnostics = validateRuntimeConfig()
const COOKIE_POLICY = Object.freeze({
  session: {
    secureName: '__Host-klient-session',
    localName: 'klient-session',
    path: '/',
    sameSite: 'Strict'
  },
  csrf: {
    secureName: '__Host-klient-csrf',
    localName: 'klient-csrf',
    path: '/',
    sameSite: 'Strict'
  },
  // Google OIDC browser-binding cookie. SameSite=Lax (NOT Strict) is required:
  // the callback is a top-level cross-site GET navigation from accounts.google.com,
  // and a Strict cookie would not be sent on it. Lax still withholds the cookie
  // from cross-site subresource/POST forgeries, which is the CSRF surface here.
  oidc: {
    secureName: '__Host-klient-oidc',
    localName: 'klient-oidc',
    path: '/',
    sameSite: 'Lax'
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
  },
  rateLimit: {
    limitedTotal: 0,
    limitedByKeyType: {}
  }
}

// Coarse per-caller request budget for /api/* routes (auth endpoints keep
// their own durable SQLite lockouts in local-provider.mjs). Health/readiness
// probes and the CSRF bootstrap are exempt; static assets never match /api/*.
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/health', '/ready', CSRF_BOOTSTRAP_PATH])
const rateLimiter = runtime.rateLimit.enabled
  ? createRateLimiter({
      maxRequests: runtime.rateLimit.maxRequests,
      windowSeconds: runtime.rateLimit.windowSeconds
    })
  : null

// Keyed by session-cookie hash when a session cookie is present (stable per
// signed-in caller, never stores the raw token), otherwise by client IP.
function rateLimitIdentity(req) {
  const sessionCookie = resolveSessionToken(req)
  if (sessionCookie) {
    return { keyType: 'session', key: `session:${createHash('sha256').update(sessionCookie).digest('hex')}` }
  }
  return { keyType: 'ip', key: `ip:${getClientIp(req)}` }
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

function forwardedProto(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return xfProto
}

function shouldUseSecureCookies(req) {
  if (runtime.isProduction) return true
  if (forwardedProto(req) === 'https') return true
  return req.socket?.encrypted === true
}

function cookieName(req, kind) {
  const policy = COOKIE_POLICY[kind]
  return shouldUseSecureCookies(req) ? policy.secureName : policy.localName
}

function cookieNamesForRead(kind) {
  const policy = COOKIE_POLICY[kind]
  return runtime.isProduction ? [policy.secureName] : [policy.localName, policy.secureName]
}

function cookieConfig(req, overrides = {}) {
  const secure = shouldUseSecureCookies(req)
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
    cookieName(req, 'session'),
    sessionToken,
    cookieConfig(req, {
      path: COOKIE_POLICY.session.path,
      sameSite: COOKIE_POLICY.session.sameSite,
      maxAge: SESSION_IDLE_TIMEOUT_SECONDS
    })
  )
}

function clearSessionCookie(req) {
  return cookieNamesForRead('session').map((name) =>
    serializeCookie(
      name,
      '',
      cookieConfig(req, {
        path: COOKIE_POLICY.session.path,
        sameSite: COOKIE_POLICY.session.sameSite,
        maxAge: 0
      })
    )
  )
}

const OIDC_BINDING_COOKIE_MAX_AGE_SECONDS = 60 * 10

function buildOidcBindingCookie(req, bindingToken) {
  return serializeCookie(
    cookieName(req, 'oidc'),
    bindingToken,
    cookieConfig(req, {
      path: COOKIE_POLICY.oidc.path,
      sameSite: COOKIE_POLICY.oidc.sameSite,
      maxAge: OIDC_BINDING_COOKIE_MAX_AGE_SECONDS
    })
  )
}

function clearOidcBindingCookie(req) {
  return cookieNamesForRead('oidc').map((name) =>
    serializeCookie(
      name,
      '',
      cookieConfig(req, {
        path: COOKIE_POLICY.oidc.path,
        sameSite: COOKIE_POLICY.oidc.sameSite,
        maxAge: 0
      })
    )
  )
}

function resolveOidcBindingToken(req) {
  const cookies = parseCookies(req)
  for (const name of cookieNamesForRead('oidc')) {
    const value = String(cookies[name] || '').trim()
    if (value) return value
  }
  return ''
}

function readOpsBearerToken(req) {
  return req.headers.authorization?.replace('Bearer ', '').trim()
}

function configuredOpsTokens() {
  const configured = Array.isArray(runtime.klientOpsTokens) ? runtime.klientOpsTokens : []
  if (configured.length > 0) return configured
  const legacy = String(runtime.klientOpsToken || process.env.KLIENT_OPS_TOKEN || '').trim()
  return legacy ? [{ token: legacy, slot: 'legacy' }] : []
}

function getOpsTokenMatch(candidate) {
  const candidates = configuredOpsTokens()
  const provided = Buffer.from(String(candidate || ''))
  for (const entry of candidates) {
    const expected = Buffer.from(entry.token)
    if (expected.length === 0 || expected.length !== provided.length) continue
    if (timingSafeEqual(expected, provided)) return entry
  }
  return null
}

function opsTokenFingerprint(token) {
  if (!token) return null
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

function resolveSessionToken(req) {
  const cookies = parseCookies(req)
  for (const name of cookieNamesForRead('session')) {
    const cookieToken = String(cookies[name] || '').trim()
    if (cookieToken) return cookieToken
  }
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
  const protocols = new Set([protocol])
  if (!runtime.isProduction && forwardedProto === 'https') {
    protocols.add('http')
  }
  const origins = new Set()
  for (const candidateProtocol of protocols) {
    if (host) origins.add(`${candidateProtocol}://${host}`)
    if (forwardedHost) origins.add(`${candidateProtocol}://${forwardedHost}`)
  }
  if (!runtime.isProduction) {
    ;['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://localhost:5173'].forEach(
      (origin) => origins.add(origin)
    )
  }
  return origins
}

function isCsrfExempt(pathname) {
  return (
    pathname === CSRF_BOOTSTRAP_PATH ||
    CSRF_EXEMPT_PATHS.has(pathname) ||
    pathname.startsWith('/api/portal/') ||
    // The raw binary upload endpoint (PUT /api/storage/uploads/:uploadId) is a
    // capability URL: the unguessable, single-use, server-minted upload intent id
    // in the path is itself the anti-CSRF/anti-forgery token, exactly as the
    // portal token and the OIDC `state` parameter are for their routes. It is
    // also reachable by portal-token callers that have no CSRF token or session,
    // so a header check would be impossible for them. Authorization is enforced
    // in store.storeUploadedBytes (live intent + exact reserved-key match).
    pathname.startsWith('/api/storage/uploads/')
  )
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
        cookieName(req, 'csrf'),
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
  return cookieNamesForRead('csrf').map((name) =>
    serializeCookie(
      name,
      '',
      cookieConfig(req, {
        path: COOKIE_POLICY.csrf.path,
        sameSite: COOKIE_POLICY.csrf.sameSite,
        maxAge: 0
      })
    )
  )
}

function validateCsrf(req, requestId, sessionToken, user) {
  const originError = validateOriginAndReferer(req, requestId)
  if (originError) return originError
  const cookies = parseCookies(req)
  const cookieTokenId =
    cookieNamesForRead('csrf')
      .map((name) => String(cookies[name] || '').trim())
      .find(Boolean) || ''
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

function resolveStaticFile(rootDir, pathname, fallbackFile = null) {
  const relativePath = pathname === '/' ? '' : pathname.replace(/^\/+/, '')
  const filePath = relativePath
    ? resolve(rootDir, relativePath)
    : fallbackFile
      ? resolve(rootDir, fallbackFile)
      : rootDir
  const rootPrefix = `${rootDir}${sep}`
  if (filePath !== rootDir && !filePath.startsWith(rootPrefix)) return null
  return filePath
}

function contentTypeFor(filePath) {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.map': 'application/json; charset=utf-8'
    }[extname(filePath)] || 'text/plain; charset=utf-8'
  )
}

async function serveFile(filePath, res, requestId) {
  const contents = await readFile(filePath)
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': contentTypeFor(filePath),
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store'
  })
  res.end(contents)
  return true
}

async function tryServeFrom(rootDir, pathname, res, requestId, fallbackFile = null) {
  const filePath = resolveStaticFile(rootDir, pathname, fallbackFile)
  if (!filePath) return false
  try {
    await serveFile(filePath, res, requestId)
    return true
  } catch {
    return false
  }
}

async function serveStatic(pathname, res, requestId) {
  // The built React app (apps/web/dist) is the only served shell. Root and every
  // routed deep link resolve to dist/index.html; the SPA router handles unknown
  // paths (including the retired /legacy URLs) client-side. Requests for a file
  // with an extension that is not present in dist return 404 (no legacy fallback).
  if (pathname === '/') {
    if (await tryServeFrom(distDir, '/', res, requestId, 'index.html')) return true
    return notFound(res, requestId)
  }

  if (await tryServeFrom(distDir, pathname, res, requestId)) return true
  if (extname(pathname)) return notFound(res, requestId)
  if (await tryServeFrom(distDir, '/', res, requestId, 'index.html')) return true
  return notFound(res, requestId)
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
  const fieldErrors =
    error?.details?.fieldErrors && typeof error.details.fieldErrors === 'object' ? error.details.fieldErrors : null
  const tightenedMessage =
    statusCode === 422 && fieldErrors && Object.keys(fieldErrors).length
      ? `${message} (${Object.entries(fieldErrors)
          .map(([key, value]) => `${key}: ${value}`)
          .join('; ')})`
      : message
  json(
    res,
    statusCode,
    {
      message: tightenedMessage,
      error: {
        message: tightenedMessage,
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

export function createHttpServer({ modules, mailer }) {
  // Email delivery is strictly additive fire-and-forget: when no mailer is
  // provided (existing callers/tests) or EMAIL_PROVIDER=disabled, every API
  // response stays byte-identical to the pre-mailer behavior.
  const transactionalMailer = mailer || { send: async () => ({ ok: true, skipped: true, provider: 'disabled' }) }
  const firmNameFor = (firmId) => {
    try {
      return getFirmRow(firmId)?.name || ''
    } catch {
      return ''
    }
  }
  const sendTransactionalEmail = (payload) => {
    // mailer.send() never rejects, but belt-and-braces: nothing thrown here may
    // ever reach a request handler or change a response.
    try {
      void transactionalMailer.send(payload)
    } catch {
      // Swallowed: email must never affect the API response.
    }
  }
  return createServer(async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID()
    const url = new URL(req.url || '/', `http://${req.headers.host || `${runtime.host}:${runtime.port}`}`)
    const { pathname } = url
    const finalizeLog = requestLogger(req, requestId)
    let sessionToken = null
    let authenticatedUser = null
    let rotateCsrfAfterResponse = false
    let opsAuditMetadata = null
    const rejectSession = (reason) => {
      securityDiagnostics.session.rejectedTotal += 1
      securityDiagnostics.session.rejectedByReason[reason] =
        (securityDiagnostics.session.rejectedByReason[reason] || 0) + 1
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
      const configuredTokens = configuredOpsTokens()
      if (configuredTokens.length > 0) {
        const opsToken = readOpsBearerToken(req)
        const tokenMatch = getOpsTokenMatch(opsToken)
        if (!tokenMatch) {
          opsAuditMetadata = {
            authMode: 'ops-token',
            result: 'denied',
            reason: 'invalid_or_missing_token',
            tokenPresent: Boolean(opsToken),
            configuredTokenCount: configuredTokens.length
          }
          const error = new Error('Ops token authentication required.')
          error.statusCode = 401
          throw error
        }
        const queueHealth = readExportWorkerStatus()
        opsAuditMetadata = {
          authMode: 'ops-token',
          result: 'granted',
          tokenSlot: tokenMatch.slot,
          tokenFingerprint: opsTokenFingerprint(tokenMatch.token),
          configuredTokenCount: configuredTokens.length
        }
        return {
          id: 'ops-token',
          role: 'admin',
          authMode: 'ops-token',
          firmId: queueHealth?.latestJob?.firmId || null,
          authAudit: opsAuditMetadata
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
        logOperationalEvent(log, 'warn', 'auth.session.rejected', {
          entity: 'session',
          id: token ? '[present]' : null,
          status: 'rejected',
          requestId,
          details: { reason: 'authentication_required' }
        })
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
      if (rateLimiter && pathname.startsWith('/api/') && !RATE_LIMIT_EXEMPT_PATHS.has(pathname)) {
        const { key, keyType } = rateLimitIdentity(req)
        const verdict = rateLimiter.check(key)
        if (!verdict.allowed) {
          securityDiagnostics.rateLimit.limitedTotal += 1
          securityDiagnostics.rateLimit.limitedByKeyType[keyType] =
            (securityDiagnostics.rateLimit.limitedByKeyType[keyType] || 0) + 1
          const message = 'Too many requests. Please retry later.'
          finalizeLog(429, { reason: 'rate_limited', rateLimitKeyType: keyType })
          return json(
            res,
            429,
            {
              message,
              error: {
                message,
                code: 'RATE_LIMITED',
                details: { retryAfterSeconds: verdict.retryAfterSeconds },
                statusCode: 429,
                requestId
              }
            },
            { 'X-Request-Id': requestId, 'Retry-After': String(verdict.retryAfterSeconds) }
          )
        }
      }
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const database = ensureDatabaseReady()
        const storageHealth = readStorageHealth()
        const queue = readExportWorkerStatus()
        const checks = {
          databaseReady: Boolean(database?.ok),
          exportWorkerReady: Boolean(queue && typeof queue === 'object') && Number(queue?.stalled || 0) === 0,
          storageReady: storageHealth?.ok === true
        }
        const healthy = Object.values(checks).every(Boolean)
        const statusCode = healthy ? 200 : 503
        finalizeLog(statusCode)
        return replyJson(
          statusCode,
          {
            status: healthy ? 'ok' : 'degraded',
            healthy,
            service: runtime.serviceName,
            uptimeSeconds: Math.round(process.uptime()),
            checks,
            dependencies: {
              database,
              exportWorker: {
                stalled: Number(queue?.stalled || 0),
                running: Number(queue?.running || 0),
                queued: Number(queue?.queued || 0)
              },
              storage: storageHealth
            }
          },
          { 'X-Request-Id': requestId }
        )
      }
      if (pathname === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
        const database = ensureDatabaseReady()
        const storageHealth = readStorageHealth()
        const queue = readExportWorkerStatus()
        const checks = {
          databaseReady: Boolean(database?.ok),
          dbReadiness: Boolean(database?.ok),
          storageReady: storageHealth?.ok === true,
          storageReadiness: storageHealth?.ok === true,
          exportQueueReachable: Boolean(queue && typeof queue === 'object'),
          exportQueueNotStalled: Number(queue?.stalled || 0) === 0,
          exportWorkerReady: Boolean(queue && typeof queue === 'object') && Number(queue?.stalled || 0) === 0,
          startupConfigValid: runtime.isProduction ? Boolean(startupDiagnostics?.ok) : true
        }
        const ready = Object.values(checks).every(Boolean)
        const includeDiagnostics =
          ['1', 'true', 'ops', 'full'].includes(String(url.searchParams.get('verbose') || '').toLowerCase()) ||
          ['1', 'true', 'ops', 'full'].includes(String(url.searchParams.get('details') || '').toLowerCase())
        let diagnosticsPayload = null
        if (includeDiagnostics) {
          authorizeOpsRequest()
          diagnosticsPayload = {
            querySummary: readQuerySummary(),
            database,
            storageHealth,
            exportWorker: queue,
            auditEvents: readAuditEventSummary(),
            startupDiagnostics
          }
        }
        const unhealthyDependencies = Object.entries(checks)
          .filter(([, passed]) => !passed)
          .map(([key]) => key)
        const statusCode = ready ? 200 : 503
        finalizeLog(statusCode)
        return replyJson(
          statusCode,
          {
            status: 'ready',
            ready,
            service: runtime.serviceName,
            instanceId: runtime.instanceId,
            pid: process.pid,
            bootedAt,
            uptimeSeconds: Math.round(process.uptime()),
            checks,
            unhealthyDependencies,
            diagnostics: includeDiagnostics
              ? {
                  mode: 'privileged',
                  ...diagnosticsPayload
                }
              : {
                  mode: 'minimal',
                  message: 'Use /api/ops/diagnostics with KLIENT_OPS_TOKEN for deep diagnostics.',
                  endpoint: '/api/ops/diagnostics'
                },
            links: {
              generatedAt: new Date().toISOString(),
              health: '/health',
              ready: '/ready',
              exportsQueue: '/api/ops/exports/queue',
              telemetry: '/api/ops/diagnostics',
              exportRuntime: '/api/ops/export-runtime'
            }
          },
          { 'X-Request-Id': requestId }
        )
      }
      if ((pathname === '/system/status' || pathname === '/admin/diagnostics') && req.method === 'GET') {
        const user = authorizeOpsRequest() || authorize('canReadDiagnostics')
        const queueHealth = modules.exports.getQueueHealth(user)
        const queue = queueHealth?.queue || readExportWorkerStatus()
        const exportJobs = modules.exports.list(user, { sort: 'updatedAt_desc' })
        const database = ensureDatabaseReady()
        const lastReleaseValidationAt = await readLastSuccessfulReleaseValidationTimestamp()
        const queueSummary = summarizeExportQueue(queue)
        finalizeLog(200, { opsAuth: user?.authAudit || opsAuditMetadata })
        return replyJson(
          200,
          {
            generatedAt: new Date().toISOString(),
            queue: queueSummary,
            worker: {
              health: classifyWorkerHealth(queue),
              stalledCount: Number(queue?.stalled || 0),
              activeLeases: Number(queue?.activeLeasesCount ?? queue?.activeLeases ?? 0)
            },
            recentExportFailures: pickRecentExportFailures(exportJobs, 5),
            dependencies: {
              database: {
                connected: Boolean(database?.ok),
                status: database?.ok ? 'ok' : 'unhealthy',
                details: database
              },
              storage: readStorageHealth()
            },
            releaseValidation: {
              lastSuccessfulAt: lastReleaseValidationAt
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
        finalizeLog(200, { opsAuth: user?.authAudit || opsAuditMetadata })
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
                },
                rateLimit: {
                  enabled: Boolean(rateLimiter),
                  maxRequests: runtime.rateLimit.maxRequests,
                  windowSeconds: runtime.rateLimit.windowSeconds,
                  limitedTotal: securityDiagnostics.rateLimit.limitedTotal,
                  limitedByKeyType: securityDiagnostics.rateLimit.limitedByKeyType,
                  trackedKeys: rateLimiter ? rateLimiter.keyCount : 0
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
        finalizeLog(200, { opsAuth: user?.authAudit || opsAuditMetadata })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/ops/export-runtime' && req.method === 'GET') {
        const user = authorizeOpsRequest() || requireUser()
        if (user?.authMode !== 'ops-token') modules.policy.requireGuard(user, 'canProcessExports')
        const queueHealth = modules.exports.getQueueHealth(user)
        const exports = modules.exports.list(user, { sort: 'updatedAt_desc' })
        const recentFailures = exports
          .filter((entry) => ['failed', 'dead-letter', 'retrying'].includes(String(entry.status || '').toLowerCase()))
          .slice(0, 10)
          .map((entry) => ({
            id: entry.id,
            status: entry.status,
            attempts: entry.attempts || 0,
            failureReason: entry.failureReason || entry.errorMessage || null,
            updatedAt: entry.updatedAt || null
          }))
        finalizeLog(200, { opsAuth: user?.authAudit || opsAuditMetadata })
        return replyJson(
          200,
          {
            generatedAt: new Date().toISOString(),
            queueStatus: queueHealth?.queue || readExportWorkerStatus(),
            workerStatus: {
              workerMode: queueHealth?.queue?.workerMode || 'companion',
              manualProcessEndpointDeprecated: queueHealth?.queue?.manualProcessEndpointDeprecated === true,
              lastWorkerHeartbeatAt: queueHealth?.queue?.lastWorkerHeartbeatAt || null,
              workerObservedRecently: queueHealth?.queue?.workerObservedRecently === true,
              pendingWithoutWorker: queueHealth?.queue?.pendingWithoutWorker === true,
              activeLeases: Number(queueHealth?.queue?.activeLeasesCount || 0),
              stalled: Number(queueHealth?.queue?.stalled || 0),
              retrying: Number(queueHealth?.queue?.retrying || 0),
              readyNow: Number(queueHealth?.queue?.readyNow || 0)
            },
            recentFailures
          },
          { 'X-Request-Id': requestId }
        )
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
        finalizeLog(200)
        return replyJson(
          200,
          { enableDemoMode: runtime.enableDemoMode, googleAuthEnabled: modules.googleOidc.isEnabled() },
          { 'X-Request-Id': requestId }
        )
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
        log('info', 'auth.register.succeeded', { requestId, userId: result?.user?.id, firmId: result?.user?.firmId })
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
        let result
        try {
          result = modules.auth.login(await parseBody(req))
        } catch (error) {
          logOperationalEvent(log, 'warn', 'auth.login.failed', {
            entity: 'auth',
            id: null,
            status: 'failed',
            requestId,
            details: { reason: error?.message || 'login_failed' }
          })
          throw error
        }
        if (result?.mfaRequired) {
          logOperationalEvent(log, 'info', 'auth.login.challenge_required', {
            entity: 'user',
            id: result?.user?.id || null,
            status: 'challenge_required',
            requestId
          })
          finalizeLog(200, { mfaRequired: true })
          return replyJson(200, { ...result, csrfToken: null, csrfExpiresAt: null }, { 'X-Request-Id': requestId })
        }
        const priorToken = resolveSessionToken(req)
        if (priorToken && priorToken !== result.token) {
          modules.auth.logout(priorToken)
          deleteCsrfTokensBySession(priorToken)
          securityDiagnostics.session.rotatedTotal += 1
        }
        logOperationalEvent(log, 'info', 'auth.login.succeeded', {
          entity: 'user',
          id: result?.user?.id || null,
          status: 'succeeded',
          requestId,
          firmId: result?.user?.firmId
        })
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
      // Google interactive sign-in (optional; config-gated by GOOGLE_CLIENT_ID +
      // GOOGLE_CLIENT_SECRET). Both routes are GET, so the CSRF middleware (which
      // only guards unsafe methods) does not apply — the single-use `state`
      // parameter is the CSRF/forgery defense for the callback. When Google is
      // not configured, the routes 404 and the login page shows no Google button.
      if (pathname === '/api/auth/google/start' && req.method === 'GET') {
        if (!modules.googleOidc.isEnabled()) {
          finalizeLog(404)
          return notFound(res, requestId)
        }
        const { authorizationUrl, bindingToken } = await modules.googleOidc.startLogin()
        res.writeHead(302, {
          ...baseHeaders(),
          'X-Request-Id': requestId,
          Location: authorizationUrl,
          'Cache-Control': 'no-store',
          // Bind this flow to the initiating browser; the callback must echo it.
          'Set-Cookie': buildOidcBindingCookie(req, bindingToken)
        })
        finalizeLog(302)
        return res.end()
      }
      if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
        if (!modules.googleOidc.isEnabled()) {
          finalizeLog(404)
          return notFound(res, requestId)
        }
        try {
          const result = await modules.googleOidc.completeLogin({
            state: url.searchParams.get('state'),
            code: url.searchParams.get('code'),
            error: url.searchParams.get('error'),
            bindingToken: resolveOidcBindingToken(req)
          })
          // Rotate any pre-existing session, mirroring local login.
          const priorToken = resolveSessionToken(req)
          if (priorToken && priorToken !== result.session.token) {
            modules.auth.logout(priorToken)
            deleteCsrfTokensBySession(priorToken)
            securityDiagnostics.session.rotatedTotal += 1
          }
          const csrf = issueCsrfForSession(req, result.session.token, result.session.user.id)
          logOperationalEvent(log, 'info', 'auth.login.succeeded', {
            entity: 'user',
            id: result.session.user.id,
            status: 'succeeded',
            requestId,
            firmId: result.session.user.firmId,
            details: { method: 'google_oidc' }
          })
          res.writeHead(302, {
            ...baseHeaders(),
            'X-Request-Id': requestId,
            Location: '/',
            'Cache-Control': 'no-store',
            // Clear the one-time binding cookie now that the flow is complete.
            'Set-Cookie': [
              buildSessionCookie(req, result.session.token),
              csrf.headers['Set-Cookie'],
              ...clearOidcBindingCookie(req)
            ]
          })
          finalizeLog(302)
          return res.end()
        } catch (error) {
          const reason = error?.code || 'oidc_failed'
          logOperationalEvent(log, 'warn', 'auth.login.failed', {
            entity: 'auth',
            id: null,
            status: 'failed',
            requestId,
            details: { reason, method: 'google_oidc' }
          })
          res.writeHead(302, {
            ...baseHeaders(),
            'X-Request-Id': requestId,
            Location: `/login?error=${encodeURIComponent(reason)}`,
            'Cache-Control': 'no-store',
            // Clear the binding cookie on failure too so a stale token cannot leak
            // into a later attempt.
            'Set-Cookie': clearOidcBindingCookie(req)
          })
          finalizeLog(302)
          return res.end()
        }
      }
      if (pathname === '/api/invites' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageUsers')
        const result = modules.firmsUsers.inviteUser(user, await parseBody(req))
        // Fire-and-forget invite email; the response keeps returning the token.
        sendTransactionalEmail({
          to: result?.email,
          template: 'userInvite',
          data: {
            token: result?.token,
            firmName: firmNameFor(user.firmId),
            role: result?.role,
            expiresAt: result?.expiresAt
          },
          firmId: user.firmId,
          actorUserId: user.id
        })
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
        const body = await parseBody(req)
        const result = modules.auth.requestReset(body)
        // Anti-enumeration preserved: an unknown email returns { ok: true }
        // with no token and sends NOTHING. Only a successful reset (token
        // minted for a real account) triggers the fire-and-forget email, and
        // the response body is unchanged either way.
        if (result?.token) {
          const requester = (() => {
            try {
              return getUserRow(result.userId)
            } catch {
              return null
            }
          })()
          sendTransactionalEmail({
            to: body?.email,
            template: 'passwordReset',
            data: {
              token: result.token,
              firmName: firmNameFor(requester?.firmId),
              expiresAt: result.expiresAt
            },
            firmId: requester?.firmId || null,
            actorUserId: result.userId || null
          })
        }
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
          {
            'X-Request-Id': requestId,
            ...csrf.headers,
            'Set-Cookie': [buildSessionCookie(req, rotatedSession.token), csrf.headers['Set-Cookie']]
          }
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
        const query = {
          mode: url.searchParams.get('mode') || '',
          search: url.searchParams.get('search') || '',
          limit: url.searchParams.get('limit') || '',
          includeSelf: url.searchParams.get('includeSelf') || ''
        }
        const result = modules.firmsUsers.listUsers(user, query)
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
        const sessionUser = token ? modules.auth.requireUser(token) : null
        const result = modules.auth.logout(token)
        deleteCsrfTokensBySession(token)
        log('info', 'auth.logout.succeeded', {
          requestId,
          userId: sessionUser?.id || null,
          firmId: sessionUser?.firmId || null
        })
        finalizeLog(200)
        return replyJson(200, result, {
          'X-Request-Id': requestId,
          'Set-Cookie': [...clearSessionCookie(req), ...clearCsrfCookie(req)]
        })
      }
      if (pathname === '/api/dashboard' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canViewDashboard')
        const result = modules.profiles.getDashboard(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/notifications' && req.method === 'GET') {
        const user = requireUser()
        const unreadOnly = ['1', 'true', 'yes'].includes(String(url.searchParams.get('unread') || '').toLowerCase())
        const result = modules.notifications.list(user, { unreadOnly })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/notifications/unread-count' && req.method === 'GET') {
        const user = requireUser()
        const result = modules.notifications.unreadCount(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/notifications/read-all' && req.method === 'POST') {
        const user = requireUser()
        const result = modules.notifications.markAllRead(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const notificationReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
      if (notificationReadMatch && req.method === 'POST') {
        const [, notificationId] = notificationReadMatch
        const user = requireUser()
        const result = modules.notifications.markRead(user, decodeURIComponent(notificationId))
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
        const includeArchived = url.searchParams.get('includeArchived')
        if (includeArchived === '1' || includeArchived === 'true') query.includeArchived = true
        const result = modules.profiles.listProfiles(user, query)
        finalizeLog(200, { firmId: user.firmId })
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/profiles' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = modules.profiles.createProfile(user, await parseBody(req))
        log('info', 'mutation.profile.created', {
          requestId,
          userId: user.id,
          firmId: user.firmId,
          profileId: result?.id
        })
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/profiles/custom-fields/schema' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const result = modules.profiles.getCustomFieldSchema(user)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/profiles/custom-fields/schema' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageUsers')
        const dryRun = ['1', 'true', 'yes'].includes(String(url.searchParams.get('dryRun') || '').toLowerCase())
        const result = dryRun
          ? modules.profiles.dryRunCustomFieldSchema(user, await parseBody(req))
          : modules.profiles.createCustomField(user, await parseBody(req))
        finalizeLog(dryRun ? 200 : 201)
        return replyJson(dryRun ? 200 : 201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/custom-fields/schema/') && req.method === 'PATCH') {
        const fieldKey = pathname.split('/')[5]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageUsers')
        const result = modules.profiles.updateCustomField(user, fieldKey, await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/custom-fields/schema/') && req.method === 'DELETE') {
        const fieldKey = pathname.split('/')[5]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageUsers')
        const result = modules.profiles.deleteCustomField(user, fieldKey)
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
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
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/meetings') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        const result = modules.meetings.listMeetings(user, id)
        finalizeLog(200)
        return replyJson(200, { meetings: result }, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/meetings') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const body = await parseBody(req)
        const user = requireUser()
        const result = modules.meetings.createMeeting(user, id, body)
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      {
        const meetingDeleteMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/meetings\/([^/]+)$/)
        if (meetingDeleteMatch && req.method === 'DELETE') {
          const [, id, meetingId] = meetingDeleteMatch
          const user = requireUser()
          const result = modules.meetings.deleteMeeting(user, decodeURIComponent(id), decodeURIComponent(meetingId))
          finalizeLog(200)
          return replyJson(200, result, { 'X-Request-Id': requestId })
        }
      }
      // Raw binary upload endpoint. Provider-agnostic (server-side putObject to
      // the reserved key) and capability-authorized by the upload intent id in the
      // path — see isCsrfExempt() and store.storeUploadedBytes() for the auth model.
      // Accepts the raw file bytes (parseRawBody hard-caps at 25 MB; the intent's
      // per-flow ceiling is enforced in the store). The exact reserved object key
      // is echoed back via ?key= so a mismatched key is rejected.
      const storageUploadMatch = pathname.match(/^\/api\/storage\/uploads\/([^/]+)$/)
      if (storageUploadMatch && req.method === 'PUT') {
        const [, rawUploadId] = storageUploadMatch
        const body = await parseRawBody(req)
        const result = await modules.forms.storeUploadedBytes({
          uploadId: decodeURIComponent(rawUploadId),
          objectKey: url.searchParams.get('key') || null,
          contentType:
            String(req.headers['content-type'] || '')
              .split(';')[0]
              .trim() || null,
          body
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const profileUploadPresignMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/uploads\/presign$/)
      if (profileUploadPresignMatch && req.method === 'POST') {
        const [, id] = profileUploadPresignMatch
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.forms.createProfileUploadPresign(user, decodeURIComponent(id), body)
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      const profileUploadDownloadMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/uploads\/([^/]+)\/download$/)
      if (profileUploadDownloadMatch && req.method === 'GET') {
        const [, id, uploadId] = profileUploadDownloadMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const artifact = await modules.forms.getProfileUploadDownload(
          user,
          decodeURIComponent(id),
          decodeURIComponent(uploadId)
        )
        log('info', 'document_upload.downloaded', {
          requestId,
          userId: user.id,
          firmId: user.firmId,
          profileId: decodeURIComponent(id),
          uploadId: decodeURIComponent(uploadId),
          delivery: artifact?.redirectUrl ? 'presigned-redirect' : 'stream'
        })
        if (artifact?.redirectUrl) {
          // Authorization above already gated this request; hand the browser a
          // short-lived presigned URL (Content-Disposition travels inside the
          // signed response-content-disposition query parameter).
          res.writeHead(302, {
            ...baseHeaders(),
            'X-Request-Id': requestId,
            Location: artifact.redirectUrl,
            'Cache-Control': 'private, no-store'
          })
          finalizeLog(302)
          return res.end()
        }
        const fileName = sanitizeDownloadFilename(artifact.fileName || `${uploadId}.bin`)
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
      const profileUploadArchiveMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/uploads\/([^/]+)\/archive$/)
      if (profileUploadArchiveMatch && req.method === 'POST') {
        const [, id, uploadId] = profileUploadArchiveMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = modules.forms.archiveProfileUpload(user, decodeURIComponent(id), decodeURIComponent(uploadId))
        logOperationalEvent(log, 'info', 'mutation.document_upload.archived', {
          entity: 'document_upload',
          id: decodeURIComponent(uploadId),
          status: 'updated',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const profileUploadsMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/uploads$/)
      if (profileUploadsMatch && req.method === 'GET') {
        const [, id] = profileUploadsMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadProfiles')
        const includeArchived = url.searchParams.get('includeArchived') === 'true'
        const result = modules.forms.listProfileUploads(user, decodeURIComponent(id), { includeArchived })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (profileUploadsMatch && req.method === 'POST') {
        const [, id] = profileUploadsMatch
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.forms.completeProfileUpload(user, decodeURIComponent(id), body)
        logOperationalEvent(log, 'info', 'mutation.document_upload.created', {
          entity: 'document_upload',
          id: result?.id || null,
          status: 'created',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      const profileTagsMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/tags$/)
      if (profileTagsMatch && req.method === 'POST') {
        const [, id] = profileTagsMatch
        const body = await parseBody(req)
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = modules.profiles.addTag(user, decodeURIComponent(id), body.tag || '')
        logOperationalEvent(log, 'info', 'mutation.profile.tag_added', {
          entity: 'profile',
          id: decodeURIComponent(id),
          status: 'updated',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const profileTagDeleteMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/tags\/([^/]+)$/)
      if (profileTagDeleteMatch && req.method === 'DELETE') {
        const [, id, tag] = profileTagDeleteMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = modules.profiles.removeTag(user, decodeURIComponent(id), decodeURIComponent(tag))
        logOperationalEvent(log, 'info', 'mutation.profile.tag_removed', {
          entity: 'profile',
          id: decodeURIComponent(id),
          status: 'updated',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
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
        logOperationalEvent(log, 'info', 'mutation.pipeline.stage_moved', {
          entity: 'profile',
          id,
          status: 'updated',
          requestId,
          userId: user.id,
          firmId: user.firmId,
          details: { stage: body.stage }
        })
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
      if (pathname === '/api/events' && req.method === 'GET') {
        const user = requireUser()
        const includeArchived = ['1', 'true', 'yes'].includes(
          String(url.searchParams.get('includeArchived') || '').toLowerCase()
        )
        const result = modules.events.listEvents(user, {
          includeArchived,
          limit: url.searchParams.get('limit') || ''
        })
        finalizeLog(200)
        return replyJson(200, { events: result }, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/events' && req.method === 'POST') {
        const user = requireUser()
        const result = modules.events.createEvent(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/events/') && pathname.endsWith('/archive') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        const result = modules.events.archiveEvent(user, decodeURIComponent(id))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/events/') && pathname.split('/').length === 4 && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        const result = modules.events.updateEvent(user, decodeURIComponent(id), await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/meetings/upcoming' && req.method === 'GET') {
        const user = requireUser()
        const windowDaysRaw = Number(url.searchParams.get('windowDays'))
        const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 ? Math.min(windowDaysRaw, 90) : 14
        const result = modules.meetings.listUpcoming(user, { windowDays })
        finalizeLog(200)
        return replyJson(200, { meetings: result }, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/convert') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.profiles.convertProfile(user, id, await parseBody(req))
        logOperationalEvent(log, 'info', 'mutation.profile.converted', {
          entity: 'profile',
          id,
          status: 'converted',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const profileArchiveMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/archive$/)
      if (profileArchiveMatch && req.method === 'POST') {
        const id = decodeURIComponent(profileArchiveMatch[1])
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.profiles.archiveProfile(user, id, await parseBody(req))
        logOperationalEvent(log, 'info', 'mutation.profile.archived', {
          entity: 'profile',
          id,
          status: 'archived',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const profileRestoreMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/restore$/)
      if (profileRestoreMatch && req.method === 'POST') {
        const id = decodeURIComponent(profileRestoreMatch[1])
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.profiles.restoreProfile(user, id, await parseBody(req))
        logOperationalEvent(log, 'info', 'mutation.profile.restored', {
          entity: 'profile',
          id,
          status: 'restored',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteProfiles')
        const result = await modules.profiles.updateProfile(user, id, await parseBody(req))
        logOperationalEvent(log, 'info', 'mutation.profile.updated', {
          entity: 'profile',
          id,
          status: 'updated',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
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
        log('info', 'mutation.household.created', {
          requestId,
          userId: user.id,
          firmId: user.firmId,
          householdId: result?.id
        })
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.addHouseholdMember(user, id, await parseBody(req))
        log('info', 'mutation.household.member_added', {
          requestId,
          userId: user.id,
          firmId: user.firmId,
          householdId: id
        })
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
      const householdArchiveMatch = pathname.match(/^\/api\/households\/([^/]+)\/archive$/)
      if (householdArchiveMatch && req.method === 'POST') {
        const id = decodeURIComponent(householdArchiveMatch[1])
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.archiveHousehold(user, id, await parseBody(req))
        log('info', 'mutation.household.archived', { requestId, userId: user.id, firmId: user.firmId, householdId: id })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const householdRestoreMatch = pathname.match(/^\/api\/households\/([^/]+)\/restore$/)
      if (householdRestoreMatch && req.method === 'POST') {
        const id = decodeURIComponent(householdRestoreMatch[1])
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteHouseholds')
        const result = modules.households.restoreHousehold(user, id)
        log('info', 'mutation.household.restored', { requestId, userId: user.id, firmId: user.firmId, householdId: id })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
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
      // Advisor-side draft-resume search. Read-only (GET, no CSRF token
      // required) but gated on canWriteForms because a matched draft is opened
      // for editing. `q` is matched over name/email and — only when it is
      // exactly four digits — SSN last-4 (decrypted in memory, firm-scoped).
      if (pathname === '/api/forms/drafts/search' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        const result = modules.forms.searchDrafts(user, url.searchParams.get('q') || '')
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const draftLockMatch = pathname.match(/^\/api\/forms\/drafts\/([^/]+)\/lock$/)
      if (draftLockMatch && req.method === 'POST') {
        const [, draftId] = draftLockMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        modules.policy.requireGuard(user, 'canWriteDraftCollaborator')
        const result = modules.forms.acquireDraftLock(user, decodeURIComponent(draftId), await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (draftLockMatch && req.method === 'DELETE') {
        const [, draftId] = draftLockMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        modules.policy.requireGuard(user, 'canWriteDraftCollaborator')
        const body = await parseBody(req)
        const result = modules.forms.releaseDraftLock(user, decodeURIComponent(draftId), body?.leaseId || '')
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const draftCollaboratorsMatch = pathname.match(/^\/api\/forms\/drafts\/([^/]+)\/collaborators$/)
      if (draftCollaboratorsMatch && req.method === 'GET') {
        const [, draftId] = draftCollaboratorsMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageDraftSharing')
        const result = modules.forms.listDraftCollaborators(user, decodeURIComponent(draftId))
        finalizeLog(200)
        return replyJson(200, { ok: true, ...result }, { 'X-Request-Id': requestId })
      }
      if (draftCollaboratorsMatch && req.method === 'POST') {
        const [, draftId] = draftCollaboratorsMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageDraftSharing')
        const result = modules.forms.addDraftCollaborator(user, decodeURIComponent(draftId), await parseBody(req))
        finalizeLog(201)
        return replyJson(201, { ok: true, ...result }, { 'X-Request-Id': requestId })
      }
      const draftCollaboratorDeleteMatch = pathname.match(/^\/api\/forms\/drafts\/([^/]+)\/collaborators\/([^/]+)$/)
      if (draftCollaboratorDeleteMatch && req.method === 'DELETE') {
        const [, draftId, collaboratorUserId] = draftCollaboratorDeleteMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canManageDraftSharing')
        const result = modules.forms.removeDraftCollaborator(
          user,
          decodeURIComponent(draftId),
          decodeURIComponent(collaboratorUserId)
        )
        finalizeLog(200)
        return replyJson(200, { ok: true, ...result }, { 'X-Request-Id': requestId })
      }
      const draftMatch = pathname.match(/^\/api\/forms\/drafts\/([^/]+)$/)
      if (draftMatch && req.method === 'PATCH') {
        const [, draftId] = draftMatch
        const user = requireUser()
        modules.policy.requireGuard(user, 'canWriteForms')
        modules.policy.requireGuard(user, 'canWriteDraftCollaborator')
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
      if (pathname === '/api/templates/auto-build/presign' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const result = await modules.templates.autoBuildPresign(user, await parseBody(req))
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/templates/auto-build' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const result = await modules.templates.autoBuild(user, await parseBody(req))
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
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/source-pdf') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadTemplate')
        const source = await modules.templates.getSourcePdf(user, id)
        const fileName = sanitizeDownloadFilename(source.fileName || `${id}.pdf`)
        res.writeHead(200, {
          ...baseHeaders(),
          'X-Request-Id': requestId,
          'Content-Type': source.contentType || 'application/pdf',
          'Content-Length': String(source.sizeBytes || source.body?.length || 0),
          'Content-Disposition': `inline; filename=\"${fileName}\"`,
          'Cache-Control': 'private, no-store'
        })
        finalizeLog(200)
        return res.end(source.body)
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/pdf-layout') && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const result = modules.templates.updatePdfLayout(user, id, await parseBody(req))
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/templates/') && pathname.endsWith('/test-fill-preview') && req.method === 'POST') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canEditTemplate')
        const preview = await modules.templates.previewTestFill(user, id, await parseBody(req))
        const fileName = sanitizeDownloadFilename(preview.fileName || `${id}-test-fill.pdf`)
        res.writeHead(200, {
          ...baseHeaders(),
          'X-Request-Id': requestId,
          'Content-Type': preview.contentType || 'application/pdf',
          'Content-Length': String(preview.sizeBytes || preview.body?.length || 0),
          'Content-Disposition': `inline; filename=\"${fileName}\"`,
          'Cache-Control': 'private, no-store',
          'X-Mapper-Diagnostics': String(preview.diagnostics?.length || 0)
        })
        finalizeLog(200)
        return res.end(preview.body)
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
          sort: url.searchParams.get('sort') || undefined,
          limit: url.searchParams.get('limit') || undefined
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
        logOperationalEvent(log, 'info', 'export.lifecycle.queued', {
          entity: 'export',
          id: result?.id || null,
          status: 'queued',
          requestId,
          userId: user.id,
          firmId: user.firmId,
          details: { templateId: body?.templateId || null, clientId: body?.clientId || null }
        })
        finalizeLog(201)
        return replyJson(201, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/exports/process' && req.method === 'POST') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canProcessExports')
        const result = await modules.exports.processQueuedExports(user)
        logOperationalEvent(log, 'info', 'export.lifecycle.processing_batch', {
          entity: 'export_batch',
          id: requestId,
          status: result?.failed > 0 ? 'completed_with_failures' : 'completed',
          requestId,
          userId: user.id,
          firmId: user.firmId,
          details: {
            processed: Number(result?.processed || 0),
            failed: Number(result?.failed || 0),
            leased: Number(result?.leased || 0),
            deadLettered: Number(result?.deadLettered || 0),
            retried: Number(result?.retried || 0)
          }
        })
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
        logOperationalEvent(log, 'info', 'export.lifecycle.retry_requested', {
          entity: 'export',
          id,
          status: 'retry_requested',
          requestId,
          userId: user.id,
          firmId: user.firmId
        })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname.startsWith('/api/exports/') && pathname.endsWith('/download') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadExports')
        const artifact = await modules.exports.getDownload(user, id)
        log('info', 'export.lifecycle.downloaded', {
          requestId,
          userId: user.id,
          firmId: user.firmId,
          exportId: id,
          contentType: artifact?.contentType || null,
          delivery: artifact?.redirectUrl ? 'presigned-redirect' : 'stream'
        })
        if (artifact?.redirectUrl) {
          // Authorization above already gated this request; hand the browser a
          // short-lived presigned URL (Content-Disposition travels inside the
          // signed response-content-disposition query parameter).
          res.writeHead(302, {
            ...baseHeaders(),
            'X-Request-Id': requestId,
            Location: artifact.redirectUrl,
            'Cache-Control': 'private, no-store'
          })
          finalizeLog(302)
          return res.end()
        }
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
        const result = modules.audit.list(user, { limit: url.searchParams.get('limit') || '' })
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (pathname === '/api/activity' && req.method === 'GET') {
        const user = requireUser()
        modules.policy.requireGuard(user, 'canReadAudit')
        const result = modules.activity.list(user, {
          category: url.searchParams.get('category') || '',
          actorId: url.searchParams.get('actorId') || '',
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
          cursor: url.searchParams.get('cursor') || '',
          limit: url.searchParams.get('limit') || ''
        })
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
        // Fire-and-forget portal-link email to the linked profile's email (if
        // it has one). Firm-scoped row read; failures never affect the response.
        const linkedProfile = (() => {
          try {
            return getProfileRow(result?.profileId, { firmId: user.firmId })
          } catch {
            return null
          }
        })()
        if (linkedProfile?.email) {
          sendTransactionalEmail({
            to: linkedProfile.email,
            template: 'portalLink',
            data: {
              token: result?.token,
              firmName: firmNameFor(user.firmId),
              expiresAt: result?.expiresAt
            },
            firmId: user.firmId,
            actorUserId: user.id
          })
        }
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
      const portalDraftSectionsMatch = pathname.match(/^\/api\/portal\/[^/]+\/drafts\/([^/]+)\/sections$/)
      if (portalDraftSectionsMatch && req.method === 'GET') {
        const { token } = requirePortalSession()
        const result = modules.forms.listPortalDraftSectionStates(
          token,
          decodeURIComponent(portalDraftSectionsMatch[1])
        )
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      const portalDraftSectionMatch = pathname.match(/^\/api\/portal\/[^/]+\/drafts\/([^/]+)\/sections\/([^/]+)$/)
      if (portalDraftSectionMatch && req.method === 'GET') {
        const { token } = requirePortalSession()
        const result = modules.forms.getPortalDraftSectionState(
          token,
          decodeURIComponent(portalDraftSectionMatch[1]),
          decodeURIComponent(portalDraftSectionMatch[2])
        )
        finalizeLog(200)
        return replyJson(200, result, { 'X-Request-Id': requestId })
      }
      if (portalDraftSectionMatch && req.method === 'PUT') {
        const { token } = requirePortalSession()
        const result = modules.forms.savePortalDraftSectionState(
          token,
          decodeURIComponent(portalDraftSectionMatch[1]),
          decodeURIComponent(portalDraftSectionMatch[2]),
          await parseBody(req)
        )
        finalizeLog(result.ok ? 200 : 409)
        return replyJson(result.ok ? 200 : 409, result, { 'X-Request-Id': requestId })
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
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        finalizeLog(404)
        return replyJson(404, { message: 'Not found.' }, { 'X-Request-Id': requestId })
      }
      finalizeLog(200, { static: true })
      return await serveStatic(pathname, res, requestId)
    } catch (error) {
      if (opsAuditMetadata) {
        error.details = {
          ...(error.details || {}),
          opsAuth: opsAuditMetadata
        }
      }
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
  const mailer = createMailer({
    runtime,
    log,
    // Audit through the existing store audit trail. The mailer only ever puts
    // the template name and a MASKED recipient in metadata — never the token
    // or a tokenized URL.
    onAudit: ({ firmId, actorUserId, action, metadata }) => {
      store.addAuditEvent(
        { firmId: firmId || null, id: actorUserId || null },
        { entityType: 'email', entityId: metadata?.template || 'email', action, metadata }
      )
    }
  })
  const server = createHttpServer({ modules, mailer })

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
