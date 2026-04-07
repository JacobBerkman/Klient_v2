import test from 'node:test'
import assert from 'node:assert/strict'

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

test('POST /api/templates/auto-build routes request payload to templates.autoBuild', async () => {
  process.env.APP_SECRET ||= 'test-secret-template-auto-build-route'
  const { createHttpServer } = await import(`../server.mjs?route-auto-build=${Date.now()}-${Math.random()}`)
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'advisor' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    templates: {
      autoBuild: (user, payload) => {
        calls.push({ userId: user.id, payload })
        return { id: 'template-1', name: payload.name }
      }
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  try {
    const address = await listen(server)
    const base = `http://${address.address}:${address.port}`
    const cookie = '__Host-klient-session=token'

    const csrfResponse = await fetch(`${base}/api/csrf`, { headers: { cookie } })
    const { csrfToken } = await csrfResponse.json()
    const response = await fetch(`${base}/api/templates/auto-build`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        origin: base,
        referer: `${base}/`
      },
      body: JSON.stringify({
        name: 'Auto-build route test',
        fileName: 'template.pdf',
        fileBytes: [1, 2, 3, 4]
      })
    })
    const body = await response.json()

    assert.equal(response.status, 201)
    assert.equal(body.id, 'template-1')
    assert.deepEqual(calls, [
      'policy:u1:canEditTemplate',
      {
        userId: 'u1',
        payload: {
          name: 'Auto-build route test',
          fileName: 'template.pdf',
          fileBytes: [1, 2, 3, 4]
        }
      }
    ])
  } finally {
    await close(server)
  }
})
