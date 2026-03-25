import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const serverEntrypoint = resolve(repoRoot, 'apps/api/src/server.mjs')

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
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

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export async function createTestContext(name) {
  const port = deterministicPort(name)
  const resetBehavior = process.env.TEST_RESET_BEHAVIOR || 'isolated'
  const testCwd =
    resetBehavior === 'isolated' ? await mkdtemp(join(tmpdir(), `klient-${name}-`)) : resolve(process.cwd())

  const server = spawn(process.execPath, [serverEntrypoint], {
    cwd: testCwd,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'test',
      PORT: String(port),
      HOST: '127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let bootError = ''
  server.stderr.on('data', (chunk) => {
    bootError += chunk.toString()
  })

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`)
      if (response.ok) {
        return {
          port,
          testCwd,
          csrfToken: '',
          csrfCookie: '',
          authToken: '',
          async ensureCsrf() {
            if (!this.authToken) {
              throw new Error('Cannot bootstrap CSRF token without auth token.')
            }
            if (this.csrfToken && this.csrfCookie) {
              return { csrfToken: this.csrfToken, csrfCookie: this.csrfCookie }
            }
            const csrfResponse = await fetch(`http://127.0.0.1:${port}/api/csrf`, {
              headers: {
                Authorization: `Bearer ${this.authToken}`
              }
            })
            const csrfData = await csrfResponse.json()
            if (!csrfResponse.ok || !csrfData.csrfToken) {
              throw new Error(
                `CSRF bootstrap failed: ${csrfData?.message || csrfData?.error?.message || 'unknown error'}`
              )
            }
            this.csrfToken = csrfData.csrfToken
            this.csrfCookie = (csrfResponse.headers.get('set-cookie') || '').split(';')[0]
            return { csrfToken: this.csrfToken, csrfCookie: this.csrfCookie }
          },
          async request(path, options = {}) {
            const method = (options.method || 'GET').toUpperCase()
            const headers = { ...(options.headers || {}) }
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !isCsrfExemptPath(path)) {
              const { csrfToken, csrfCookie } = await this.ensureCsrf()
              headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken
              headers.Cookie = headers.Cookie || csrfCookie
              headers.Origin = headers.Origin || `http://127.0.0.1:${port}`
              headers.Referer = headers.Referer || `http://127.0.0.1:${port}/`
              if (!headers.Authorization && this.authToken) {
                headers.Authorization = `Bearer ${this.authToken}`
              }
            }
            const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers })
            const data = await response.json()
            const nextCsrfToken = response.headers.get('x-csrf-token')
            const nextCookie = (response.headers.get('set-cookie') || '').split(';')[0]
            if (nextCsrfToken) this.csrfToken = nextCsrfToken
            if (nextCookie.startsWith('__Host-klient-csrf=')) this.csrfCookie = nextCookie
            if (!response.ok) {
              throw new Error(`${path}: ${data.message || 'Request failed'}`)
            }
            if (data && typeof data === 'object' && !('message' in data) && data.error?.message) {
              return { ...data, message: data.error.message }
            }
            return data
          },
          async requestExpectError(path, options = {}, expectedStatus = 400) {
            const method = (options.method || 'GET').toUpperCase()
            const headers = { ...(options.headers || {}) }
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !isCsrfExemptPath(path)) {
              const { csrfToken, csrfCookie } = await this.ensureCsrf()
              headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken
              headers.Cookie = headers.Cookie || csrfCookie
              headers.Origin = headers.Origin || `http://127.0.0.1:${port}`
              headers.Referer = headers.Referer || `http://127.0.0.1:${port}/`
              if (!headers.Authorization && this.authToken) {
                headers.Authorization = `Bearer ${this.authToken}`
              }
            }
            const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers })
            const data = await response.json()
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
          authHeaders(token) {
            return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
          },
          async login(email = 'admin@demo.test', password = 'ChangeMe123!') {
            const data = await this.request('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password })
            })
            this.authToken = data.token
            this.csrfToken = ''
            this.csrfCookie = ''
            return data
          },
          async shutdown() {
            server.kill('SIGTERM')
            await wait(120)
            if (resetBehavior === 'isolated') {
              await rm(testCwd, { recursive: true, force: true })
            }
          }
        }
      }
    } catch {
      // Wait for server startup.
    }
    await wait(100)
  }

  server.kill('SIGTERM')
  if (resetBehavior === 'isolated') {
    await rm(testCwd, { recursive: true, force: true })
  }
  throw new Error(`Server failed to start for ${name}. ${bootError}`.trim())
}
