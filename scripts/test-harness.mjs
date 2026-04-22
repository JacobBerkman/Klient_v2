import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeProcessFailure,
  releaseChildStdio,
  startManagedProcess,
  terminateManagedProcess
} from './process-lifecycle.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const serverEntrypoint = resolve(repoRoot, 'apps/api/src/server.mjs')

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function isRetryableNetworkError(error) {
  const code = error?.cause?.code || error?.code
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return true
  if (error?.name === 'TimeoutError') return true
  if (error?.cause?.name === 'TimeoutError') return true
  return false
}

async function fetchWithLifecycleRetry(
  url,
  options = {},
  {
    retries = 8,
    retryDelayMs = 125,
    requestTimeoutMs = Number.parseInt(process.env.TEST_REQUEST_TIMEOUT_MS || '30000', 10)
  } = {}
) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const hasSignal = Boolean(options?.signal)
      const timeoutSignal =
        !hasSignal && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
          ? AbortSignal.timeout(requestTimeoutMs)
          : undefined
      return await fetch(url, { ...options, ...(timeoutSignal ? { signal: timeoutSignal } : {}) })
    } catch (error) {
      if (!isRetryableNetworkError(error) || attempt === retries) {
        throw error
      }
      lastError = error
      await wait(retryDelayMs)
    }
  }
  throw lastError
}

function isCsrfExemptPath(path) {
  return [
    '/api/login',
    '/api/register',
    '/api/invites/accept',
    '/api/password-resets',
    '/api/password-resets/confirm'
  ].includes(path)
}

function deterministicPort(name) {
  const base = Number.parseInt(process.env.TEST_PORT_BASE || '3300', 10)
  const modulo = Number.parseInt(process.env.TEST_PORT_RANGE || '300', 10)
  const seed = `${process.env.TEST_SEED || 'klient-seed'}:${name}`
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1_000_000
  }
  return base + (hash % modulo)
}

async function waitForServerUnavailable(baseUrl, { attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(250) })
      if (response.ok) {
        await wait(delayMs)
        continue
      }
    } catch {
      return true
    }
    await wait(delayMs)
  }
  return false
}

function shouldDropAuthHeader(value) {
  if (!value) return true
  const normalized = String(value).trim()
  return /^Bearer\s*(undefined|null)?$/i.test(normalized)
}

function parseCookieFromHeader(rawHeader, cookieName) {
  return String(rawHeader || '')
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${cookieName}=`))
    ?.split(';')[0]
}

function parseAnyCookieFromHeader(rawHeader, cookieNames) {
  for (const cookieName of cookieNames) {
    const cookie = parseCookieFromHeader(rawHeader, cookieName)
    if (cookie) return cookie
  }
  return ''
}

const SESSION_COOKIE_NAMES = ['klient-session', '__Host-klient-session']
const CSRF_COOKIE_NAMES = ['klient-csrf', '__Host-klient-csrf']

function createSessionClient(port) {
  return {
    csrfToken: '',
    csrfCookie: '',
    sessionCookie: '',
    async ensureCsrf() {
      if (!this.sessionCookie) {
        throw new Error('Cannot bootstrap CSRF token without session cookie.')
      }
      const csrfResponse = await fetchWithLifecycleRetry(`http://127.0.0.1:${port}/api/csrf`, {
        headers: { Cookie: this.sessionCookie }
      })
      const csrfData = await csrfResponse.json()
      if (!csrfResponse.ok || !csrfData.csrfToken) {
        throw new Error(`CSRF bootstrap failed: ${csrfData?.message || csrfData?.error?.message || 'unknown error'}`)
      }
      this.csrfToken = csrfData.csrfToken
      this.csrfCookie = parseAnyCookieFromHeader(csrfResponse.headers.get('set-cookie'), CSRF_COOKIE_NAMES) || ''
      return { csrfToken: this.csrfToken, csrfCookie: this.csrfCookie }
    },
    updateStateFromResponse(response) {
      const setCookie = response.headers.get('set-cookie') || ''
      const nextCsrfToken = response.headers.get('x-csrf-token')
      const nextSessionCookie = parseAnyCookieFromHeader(setCookie, SESSION_COOKIE_NAMES)
      const nextCsrfCookie = parseAnyCookieFromHeader(setCookie, CSRF_COOKIE_NAMES)

      if (nextSessionCookie) this.sessionCookie = nextSessionCookie
      if (nextCsrfToken) this.csrfToken = nextCsrfToken
      if (nextCsrfCookie) this.csrfCookie = nextCsrfCookie
    },
    async request(path, options = {}) {
      const method = (options.method || 'GET').toUpperCase()
      const headers = { ...(options.headers || {}) }

      if (shouldDropAuthHeader(headers.Authorization)) delete headers.Authorization
      if (path.startsWith('/api/') && this.sessionCookie && !headers.Cookie && !headers.Authorization) {
        headers.Cookie = this.sessionCookie
      }

      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !isCsrfExemptPath(path)) {
        if (!headers.Authorization) {
          const { csrfToken, csrfCookie } = await this.ensureCsrf()
          headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken
          if (!headers.Cookie) {
            headers.Cookie = [this.sessionCookie, csrfCookie].filter(Boolean).join('; ')
          } else if (csrfCookie && !CSRF_COOKIE_NAMES.some((name) => headers.Cookie.includes(`${name}=`))) {
            headers.Cookie = `${headers.Cookie}; ${csrfCookie}`
          }
          headers.Origin = headers.Origin || `http://127.0.0.1:${port}`
          headers.Referer = headers.Referer || `http://127.0.0.1:${port}/`
        }
      }

      const response = await fetchWithLifecycleRetry(`http://127.0.0.1:${port}${path}`, { ...options, headers })
      let data
      try {
        data = await response.json()
      } catch {
        data = null
      }
      this.updateStateFromResponse(response)
      if (!response.ok) {
        throw new Error(`${path}: ${data?.message || data?.error?.message || 'Request failed'}`)
      }
      if (data && typeof data === 'object' && !('message' in data) && data.error?.message) {
        return { ...data, message: data.error.message }
      }
      return data
    },
    async requestExpectError(path, options = {}, expectedStatus = 400) {
      const method = (options.method || 'GET').toUpperCase()
      const headers = { ...(options.headers || {}) }
      if (shouldDropAuthHeader(headers.Authorization)) delete headers.Authorization
      if (path.startsWith('/api/') && this.sessionCookie && !headers.Cookie && !headers.Authorization) {
        headers.Cookie = this.sessionCookie
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !isCsrfExemptPath(path)) {
        if (!headers.Authorization) {
          const { csrfToken, csrfCookie } = await this.ensureCsrf()
          headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken
          if (!headers.Cookie) {
            headers.Cookie = [this.sessionCookie, csrfCookie].filter(Boolean).join('; ')
          } else if (csrfCookie && !CSRF_COOKIE_NAMES.some((name) => headers.Cookie.includes(`${name}=`))) {
            headers.Cookie = `${headers.Cookie}; ${csrfCookie}`
          }
          headers.Origin = headers.Origin || `http://127.0.0.1:${port}`
          headers.Referer = headers.Referer || `http://127.0.0.1:${port}/`
        }
      }
      const response = await fetchWithLifecycleRetry(`http://127.0.0.1:${port}${path}`, { ...options, headers })
      const data = await response.json()
      this.updateStateFromResponse(response)
      const acceptedStatuses = Array.isArray(expectedStatus)
        ? expectedStatus
        : expectedStatus === 401
          ? [401, 403]
          : [expectedStatus]
      if (!acceptedStatuses.includes(response.status)) {
        throw new Error(
          `${path}: expected ${acceptedStatuses.join(' or ')} but received ${response.status} (${data.message || 'Request failed'})`
        )
      }
      return data
    },
    authHeaders() {
      return { 'Content-Type': 'application/json' }
    },
    async login(email = 'admin@demo.test', password = 'ChangeMe123!') {
      const response = await fetchWithLifecycleRetry(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await response.json()
      const sessionCookie = parseAnyCookieFromHeader(response.headers.get('set-cookie'), SESSION_COOKIE_NAMES)
      if (!response.ok || !sessionCookie) {
        throw new Error(`Login failed: ${data?.message || data?.error?.message || 'missing session cookie'}`)
      }
      this.sessionCookie = sessionCookie
      this.csrfToken = ''
      this.csrfCookie = ''
      return data
    }
  }
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export async function createTestContext(name) {
  const port = deterministicPort(name)
  const baseUrl = `http://127.0.0.1:${port}`
  const resetBehavior = process.env.TEST_RESET_BEHAVIOR || 'isolated'
  const testCwd =
    resetBehavior === 'isolated' ? await mkdtemp(join(tmpdir(), `klient-${name}-`)) : resolve(process.cwd())

  const opsToken = process.env.KLIENT_OPS_TOKEN || 'ops-token-abcdefghijklmnopqrstuvwxyz'
  let bootError = ''
  let bootOutput = ''
  const appendBootLog = (chunk) => {
    const text = chunk.toString()
    bootOutput += text
    if (bootOutput.length > 16_000) {
      bootOutput = bootOutput.slice(-16_000)
    }
  }
  let server
  try {
    server = startManagedProcess({
      command: process.execPath,
      args: [serverEntrypoint],
      label: `api-test-server:${name}`,
      cwd: testCwd,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        KLIENT_BASE_URL: baseUrl,
        E2E_BASE_URL: baseUrl,
        KLIENT_OPS_TOKEN: opsToken
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      onStdout: appendBootLog,
      onStderr: (chunk) => {
        bootError += chunk.toString()
        appendBootLog(chunk)
      }
    })
  } catch (error) {
    if (resetBehavior === 'isolated') {
      await rm(testCwd, { recursive: true, force: true })
    }
    throw error
  }

  let spawnError = null
  server.child.once('error', (error) => {
    spawnError = error
  })

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (spawnError) break
    try {
      const response = await fetchWithLifecycleRetry(
        `http://127.0.0.1:${port}/ready`,
        {},
        { retries: 1, retryDelayMs: 50 }
      )
      if (response.ok) {
        const sessions = new Map()
        const getSession = (name = 'default') => {
          if (!sessions.has(name)) sessions.set(name, createSessionClient(port))
          return sessions.get(name)
        }

        const context = {
          port,
          baseUrl,
          testCwd,
          opsToken,
          session(name = 'default') {
            return getSession(name)
          },
          request(path, options = {}) {
            return getSession('default').request(path, options)
          },
          requestExpectError(path, options = {}, expectedStatus = 400) {
            return getSession('default').requestExpectError(path, options, expectedStatus)
          },
          requestAs(sessionName, path, options = {}) {
            return getSession(sessionName).request(path, options)
          },
          requestExpectErrorAs(sessionName, path, options = {}, expectedStatus = 400) {
            return getSession(sessionName).requestExpectError(path, options, expectedStatus)
          },
          async rawRequest(path, options = {}, retryOptions) {
            try {
              return await fetchWithLifecycleRetry(`${baseUrl}${path}`, options, retryOptions)
            } catch (error) {
              throw new Error(`${path}: ${error?.message || 'Request failed'}`)
            }
          },
          authHeaders(sessionName = 'default') {
            return getSession(sessionName).authHeaders()
          },
          opsHeaders(extraHeaders = {}) {
            return { Authorization: `Bearer ${opsToken}`, ...extraHeaders }
          },
          async login(email = 'admin@demo.test', password = 'ChangeMe123!', sessionName = 'default') {
            return getSession(sessionName).login(email, password)
          },
          async shutdown() {
            try {
              await terminateManagedProcess(server, { label: `api-test-server:${name}` })
              const closed = await waitForServerUnavailable(baseUrl)
              if (!closed) {
                throw new Error(`Server port ${port} still responds after shutdown for ${name}.`)
              }
            } finally {
              releaseChildStdio(server)
              if (resetBehavior === 'isolated') {
                await rm(testCwd, { recursive: true, force: true })
              }
            }
          }
        }
        Object.defineProperties(context, {
          sessionCookie: {
            get() {
              return getSession('default').sessionCookie
            }
          },
          csrfToken: {
            get() {
              return getSession('default').csrfToken
            }
          },
          csrfCookie: {
            get() {
              return getSession('default').csrfCookie
            }
          }
        })

        return context
      }
    } catch {
      // Wait for server startup.
    }
    await wait(100)
  }

  await terminateManagedProcess(server, { label: `api-test-server:${name}` }).catch(() => {})
  releaseChildStdio(server)
  if (resetBehavior === 'isolated') {
    await rm(testCwd, { recursive: true, force: true })
  }
  const startupDetails = spawnError
    ? describeProcessFailure(server, `Server failed to start for ${name}: ${spawnError.message}`)
    : `Server failed to start for ${name}. ${bootError || bootOutput}`.trim()
  throw new Error(startupDetails)
}
