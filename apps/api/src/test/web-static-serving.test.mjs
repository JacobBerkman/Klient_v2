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
  assert.doesNotMatch(text, /id="login-form"/, `${label} should not serve the legacy one-page shell`)
  assert.doesNotMatch(text, /id="portal-upload-form"/, `${label} should not serve the legacy portal shell`)
}

function assertLegacyShell(text, label) {
  assert.match(text, /id="login-form"/, `${label} should serve the legacy advisor shell explicitly`)
  assert.doesNotMatch(text, /<div id="root"><\/div>/, `${label} should not serve the React shell`)
}

test('built React app is the canonical static shell for routed deep links', async () => {
  assert.equal(existsSync(distIndex), true, 'apps/web/dist/index.html must exist; run npm run web:build first.')

  const server = createHttpServer({ modules: new Proxy({}, { get: () => ({}) }) })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    for (const path of ['/dashboard', '/profiles/profile-123', '/forms/submissions/submission-123', '/portal']) {
      const { response, text } = await requestText(baseUrl, path)
      assert.equal(response.status, 200, `${path} should be served as an SPA route`)
      assert.match(response.headers.get('content-type') || '', /text\/html/)
      assertReactShell(text, path)
    }
  } finally {
    await close(server)
  }
})

test('legacy shells remain reachable only through explicit legacy routes', async () => {
  const server = createHttpServer({ modules: new Proxy({}, { get: () => ({}) }) })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    const legacy = await requestText(baseUrl, '/legacy')
    assert.equal(legacy.response.status, 200)
    assertLegacyShell(legacy.text, '/legacy')

    const legacyPortal = await requestText(baseUrl, '/legacy/portal')
    assert.equal(legacyPortal.response.status, 200)
    assert.match(
      legacyPortal.text,
      /id="portal-upload-form"/,
      '/legacy/portal should serve the legacy portal shell explicitly'
    )
    assert.doesNotMatch(legacyPortal.text, /<div id="root"><\/div>/, '/legacy/portal should not serve the React shell')

    const canonicalPortal = await requestText(baseUrl, '/portal')
    assert.equal(canonicalPortal.response.status, 200)
    assertReactShell(canonicalPortal.text, '/portal')
  } finally {
    await close(server)
  }
})
