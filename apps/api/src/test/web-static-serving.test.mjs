import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test'
const { createHttpServer } = await import('../server.mjs')

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const distIndex = resolve(repoRoot, 'apps/web/dist/index.html')

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()))
  })
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())))
}

async function requestText(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`)
  const text = await response.text()
  return { response, text }
}

function assertReactShell(text, label) {
  assert.match(text, /<div id="root"><\/div>/, `${label} should serve the React root`)
  assert.doesNotMatch(text, /id="login-form"/, `${label} should not serve the retired legacy one-page shell`)
  assert.doesNotMatch(text, /id="portal-upload-form"/, `${label} should not serve the retired legacy portal shell`)
}

test('built React app is the canonical static shell for routed deep links', async () => {
  assert.equal(existsSync(distIndex), true, 'apps/web/dist/index.html must exist; run npm run web:build first.')

  const server = createHttpServer({ modules: new Proxy({}, { get: () => ({}) }) })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    for (const path of [
      '/dashboard',
      '/profiles/profile-123',
      '/forms/submissions/submission-123',
      '/templates/template-123/mapper',
      '/portal'
    ]) {
      const { response, text } = await requestText(baseUrl, path)
      assert.equal(response.status, 200, `${path} should be served as an SPA route`)
      assert.match(response.headers.get('content-type') || '', /text\/html/)
      assertReactShell(text, path)
    }
  } finally {
    await close(server)
  }
})

test('retired legacy routes fall through to the React shell instead of a legacy one', async () => {
  const server = createHttpServer({ modules: new Proxy({}, { get: () => ({}) }) })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    // The legacy vanilla-JS shell has been retired. The old /legacy URLs are no
    // longer special-cased: they resolve like any other extensionless deep link,
    // i.e. the SPA fallback serves the React shell (200) and the client-side
    // router renders its not-found view. The React shell is served everywhere.
    for (const path of ['/legacy', '/legacy/portal', '/portal']) {
      const { response, text } = await requestText(baseUrl, path)
      assert.equal(response.status, 200, `${path} should be served the React SPA shell`)
      assert.match(response.headers.get('content-type') || '', /text\/html/)
      assertReactShell(text, path)
    }
  } finally {
    await close(server)
  }
})

test('static asset requests for files absent from dist return 404 without any legacy fallback', async () => {
  const server = createHttpServer({ modules: new Proxy({}, { get: () => ({}) }) })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    for (const path of ['/app.js', '/styles.css', '/portal.html', '/api-contract.js']) {
      const { response } = await requestText(baseUrl, path)
      assert.equal(response.status, 404, `${path} (retired legacy asset) should no longer be served`)
    }
  } finally {
    await close(server)
  }
})
