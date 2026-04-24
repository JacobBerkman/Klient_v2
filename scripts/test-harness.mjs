import { randomUUID } from 'node:crypto'
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
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  if (error?.cause?.name === 'TimeoutError' || error?.cause?.name === 'AbortError') return true
  const combinedMessage = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase()
  return (
    combinedMessage.includes('other side closed') ||
    combinedMessage.includes('socket') ||
    combinedMessage.includes('connection closed') ||
    combinedMessage.includes('fetch failed')
  )
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

export function deterministicPort(name) {
  const base = Number.parseInt(process.env.TEST_PORT_BASE || '3300', 10)
  const modulo = Number.parseInt(process.env.TEST_PORT_RANGE || '300', 10)
  const seed = `${process.env.TEST_SEED || 'klient-seed'}:${name}`
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1_000_000
  }
  return base + (hash % modulo)
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

function parseReadyPayloadIdentity(payload) {
  const pid = Number.parseInt(String(payload?.pid || ''), 10)
  return {
    instanceId: String(payload?.instanceId || ''),
    pid: Number.isFinite(pid) ? pid : null,
    bootedAt: payload?.bootedAt || null
  }
}

function describeReadyIdentity(identity) {
  if (!identity) return 'instanceId=<unknown> pid=<unknown>'
  return `instanceId=${identity.instanceId || '<unknown>'} pid=${identity.pid ?? '<unknown>'}`
}

function readyIdentityMatches(expected, actual) {
  if (!expected?.instanceId || !actual?.instanceId) return false
  if (expected.instanceId !== actual.instanceId) return false
  if (expected.pid != null && actual.pid != null && expected.pid !== actual.pid) return false
  return true
}

async function readReadyIdentity(baseUrl, fetchImpl) {
  try {
    const response = await fetchImpl(
      `${baseUrl}/ready`,
      {},
      {
        retries: 0,
        retryDelayMs: 0,
        requestTimeoutMs: 500
      }
    )
    const payload = await response.json().catch(() => null)
    return {
      ok: response.ok,
      statusCode: response.status,
      identity: parseReadyPayloadIdentity(payload),
      payload
    }
  } catch {
    return null
  }
}

async function waitForServerUnavailable(baseUrl, fetchImpl, { attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const readyState = await readReadyIdentity(baseUrl, fetchImpl)
    if (!readyState?.ok) return true
    await wait(delayMs)
  }
  return false
}

function formatServerExit(exitInfo) {
  if (!exitInfo) return 'exit=<unknown>'
  if (exitInfo.error) {
    return `exitEvent=${exitInfo.event} error=${exitInfo.error.message}`
  }
  return `exitEvent=${exitInfo.event} code=${exitInfo.code ?? '<unknown>'} signal=${exitInfo.signal ?? '<none>'}`
}

function buildLifecycleErrorMessage({
  name,
  port,
  testCwd,
  server,
  serverExitInfo,
  message,
  responderIdentity = null,
  path = null
}) {
  const scope = [`suite=${name}`, `port=${port}`, `cwd=${testCwd}`]
  if (path) scope.push(`path=${path}`)
  const responder = responderIdentity ? `\nreadyResponder: ${describeReadyIdentity(responderIdentity)}` : ''
  const exit = serverExitInfo ? `\nserverExit: ${formatServerExit(serverExitInfo)}` : ''
  return `${describeProcessFailure(server, `${message} (${scope.join(', ')})`)}${exit}${responder}`
}

const SESSION_COOKIE_NAMES = ['klient-session', '__Host-klient-session']
const CSRF_COOKIE_NAMES = ['klient-csrf', '__Host-klient-csrf']

function createSessionClient({
  port,
  baseUrl,
  suiteName,
  testCwd,
  server,
  expectedIdentity,
  getServerExitInfo,
  fetchImpl
}) {
  async function decorateTransportError(path, error) {
    const serverExitInfo = getServerExitInfo()
    const responder = await readReadyIdentity(baseUrl, fetchImpl)
    const responderIdentity = responder?.identity || null
    const reason = serverExitInfo
      ? `Request transport failed after suite server exited: ${error?.message || 'Request failed'}`
      : responder && responder.ok && !readyIdentityMatches(expectedIdentity, responderIdentity)
        ? `Request transport failed against a foreign responder: ${error?.message || 'Request failed'}`
        : `Request transport failed: ${error?.message || 'Request failed'}`
    return new Error(
      buildLifecycleErrorMessage({
        name: suiteName,
        port,
        testCwd,
        server,
        serverExitInfo,
        responderIdentity,
        message: reason,
        path
      })
    )
  }

  return {
    csrfToken: '',
    csrfCookie: '',
    sessionCookie: '',
    async ensureCsrf() {
      if (!this.sessionCookie) {
        throw new Error('Cannot bootstrap CSRF token without session cookie.')
      }
      let csrfResponse
      try {
        csrfResponse = await fetchImpl(`${baseUrl}/api/csrf`, {
          headers: { Cookie: this.sessionCookie }
        })
      } catch (error) {
        throw await decorateTransportError('/api/csrf', error)
      }
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

      let response
      try {
        response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers })
      } catch (error) {
        throw await decorateTransportError(path, error)
      }
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
      let response
      try {
        response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers })
      } catch (error) {
        throw await decorateTransportError(path, error)
      }
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
      let response
      try {
        response = await fetchImpl(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        })
      } catch (error) {
        throw await decorateTransportError('/api/login', error)
      }
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

export async function createTestContext(name, deps = {}) {
  const {
    startProcess = startManagedProcess,
    terminateProcess = terminateManagedProcess,
    fetchImpl = fetchWithLifecycleRetry,
    mkdtempImpl = mkdtemp,
    rmImpl = rm,
    releaseStdio = releaseChildStdio,
    waitImpl = wait,
    waitForUnavailable = waitForServerUnavailable,
    testContextId: providedTestContextId
  } = deps

  const port = deterministicPort(name)
  const baseUrl = `http://127.0.0.1:${port}`
  const resetBehavior = process.env.TEST_RESET_BEHAVIOR || 'isolated'
  const testCwd =
    resetBehavior === 'isolated' ? await mkdtempImpl(join(tmpdir(), `klient-${name}-`)) : resolve(process.cwd())

  const opsToken = process.env.KLIENT_OPS_TOKEN || 'ops-token-abcdefghijklmnopqrstuvwxyz'
  const testContextId =
    providedTestContextId || `test-context-${name}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  let bootError = ''
  let bootOutput = ''
  let shutdownInvoked = false
  let serverExitInfo = null

  const appendBootLog = (chunk) => {
    const text = chunk.toString()
    bootOutput += text
    if (bootOutput.length > 16_000) {
      bootOutput = bootOutput.slice(-16_000)
    }
  }

  let server
  try {
    server = startProcess({
      command: process.execPath,
      args: [serverEntrypoint],
      label: `api-test-server:${name}`,
      cwd: testCwd,
      detached: false,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        KLIENT_BASE_URL: baseUrl,
        E2E_BASE_URL: baseUrl,
        KLIENT_OPS_TOKEN: opsToken,
        TEST_CONTEXT_ID: testContextId,
        INSTANCE_ID: testContextId
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
      await rmImpl(testCwd, { recursive: true, force: true })
    }
    throw error
  }

  const expectedIdentity = {
    instanceId: testContextId,
    pid: server?.child?.pid ?? null
  }

  const rememberExit = (event, code, signal, error) => {
    serverExitInfo = {
      event,
      code: code ?? null,
      signal: signal ?? null,
      error: error || null,
      observedAt: new Date().toISOString()
    }
  }

  server.child.once('error', (error) => {
    rememberExit('error', 1, null, error)
  })
  server.child.once('exit', (code, signal) => {
    rememberExit('exit', code, signal, null)
  })
  server.child.once('close', (code, signal) => {
    if (!serverExitInfo) rememberExit('close', code, signal, null)
  })

  const cleanupServerOnExit = () => {
    if (shutdownInvoked) return
    try {
      server?.child?.kill?.('SIGTERM')
    } catch {
      // Best-effort shutdown for abrupt suite termination.
    }
  }
  process.once('exit', cleanupServerOnExit)

  const finalizeStartupFailure = async (message, responderIdentity = null) => {
    shutdownInvoked = true
    await terminateProcess(server, { label: `api-test-server:${name}` }).catch(() => {})
    releaseStdio(server)
    process.removeListener('exit', cleanupServerOnExit)
    if (resetBehavior === 'isolated') {
      await rmImpl(testCwd, { recursive: true, force: true })
    }
    throw new Error(
      buildLifecycleErrorMessage({
        name,
        port,
        testCwd,
        server,
        serverExitInfo,
        responderIdentity,
        message
      })
    )
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (serverExitInfo) {
      await finalizeStartupFailure(`Server exited before startup completed for ${name}.`)
    }
    const readyState = await readReadyIdentity(baseUrl, fetchImpl)
    if (readyState?.ok) {
      if (!readyIdentityMatches(expectedIdentity, readyState.identity)) {
        await finalizeStartupFailure(
          `Foreign responder detected on deterministic test port before suite server ownership was verified for ${name}.`,
          readyState.identity
        )
      }

      const sessions = new Map()
      const getSession = (sessionName = 'default') => {
        if (!sessions.has(sessionName)) {
          sessions.set(
            sessionName,
            createSessionClient({
              port,
              baseUrl,
              suiteName: name,
              testCwd,
              server,
              expectedIdentity,
              getServerExitInfo: () => serverExitInfo,
              fetchImpl
            })
          )
        }
        return sessions.get(sessionName)
      }

      const context = {
        port,
        baseUrl,
        testCwd,
        opsToken,
        serverIdentity: expectedIdentity,
        session(sessionName = 'default') {
          return getSession(sessionName)
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
            return await fetchImpl(`${baseUrl}${path}`, options, retryOptions)
          } catch (error) {
            const responder = await readReadyIdentity(baseUrl, fetchImpl)
            throw new Error(
              buildLifecycleErrorMessage({
                name,
                port,
                testCwd,
                server,
                serverExitInfo,
                responderIdentity: responder?.identity || null,
                message: `Raw request transport failed: ${error?.message || 'Request failed'}`,
                path
              })
            )
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
        serverStatus() {
          return {
            name,
            port,
            testCwd,
            expectedIdentity,
            serverExitInfo,
            bootOutput: server.stdoutTail || bootOutput,
            bootError: server.stderrTail || bootError
          }
        },
        async portOwnershipSnapshot() {
          const responder = await readReadyIdentity(baseUrl, fetchImpl)
          return {
            name,
            port,
            baseUrl,
            expectedIdentity,
            responder: responder?.identity || null,
            responderStatusCode: responder?.statusCode ?? null,
            ready: responder?.ok === true,
            matchesExpected:
              responder?.ok === true && readyIdentityMatches(expectedIdentity, responder?.identity || null)
          }
        },
        async shutdown() {
          if (shutdownInvoked) return
          shutdownInvoked = true
          process.removeListener('exit', cleanupServerOnExit)
          try {
            await terminateProcess(server, { label: `api-test-server:${name}` })
            const closed = await waitForUnavailable(baseUrl, fetchImpl)
            if (!closed) {
              throw new Error(`Server port ${port} still responds after shutdown for ${name}.`)
            }
          } finally {
            releaseStdio(server)
            if (resetBehavior === 'isolated') {
              await rmImpl(testCwd, { recursive: true, force: true })
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
    await waitImpl(100)
  }

  await finalizeStartupFailure(`Server failed to start for ${name}.`)
}
