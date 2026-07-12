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

// The raw binary upload endpoint is capability-authorized (the unguessable
// upload intent id in the path is the anti-CSRF token) and must be reachable by
// portal-token callers that have neither a session cookie nor a CSRF token.
// These tests assert that CSRF exemption + routing behave accordingly.
test('PUT /api/storage/uploads/:id streams raw bytes to forms.storeUploadedBytes without a session or CSRF token', async () => {
  process.env.APP_SECRET ||= 'test-secret-raw-upload-endpoint'
  const { createHttpServer } = await import(`../server.mjs?raw-upload=${Date.now()}-${Math.random()}`)
  const received = []
  const modules = {
    // No auth.requireUser needed: the route is CSRF-exempt and session-agnostic.
    auth: {
      requireUser: () => {
        throw new Error('session auth must not be invoked for the capability upload route')
      }
    },
    forms: {
      storeUploadedBytes: (input) => {
        received.push({
          uploadId: input.uploadId,
          objectKey: input.objectKey,
          contentType: input.contentType,
          body: Buffer.isBuffer(input.body) ? input.body.toString() : String(input.body)
        })
        return {
          uploadId: input.uploadId,
          object: { key: input.objectKey },
          sizeBytes: input.body.length,
          checksum: 'abc'
        }
      }
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  try {
    const address = await listen(server)
    const base = `http://${address.address}:${address.port}`
    const response = await fetch(
      `${base}/api/storage/uploads/intent-123?key=${encodeURIComponent('firm/docs/reserved.pdf')}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from('%PDF raw bytes')
      }
    )
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.sizeBytes, Buffer.from('%PDF raw bytes').length)
    assert.deepEqual(received, [
      {
        uploadId: 'intent-123',
        objectKey: 'firm/docs/reserved.pdf',
        contentType: 'application/pdf',
        body: '%PDF raw bytes'
      }
    ])
  } finally {
    await close(server)
  }
})

test('raw upload endpoint surfaces the store statusCode for a rejected intent', async () => {
  process.env.APP_SECRET ||= 'test-secret-raw-upload-endpoint'
  const { createHttpServer } = await import(`../server.mjs?raw-upload-err=${Date.now()}-${Math.random()}`)
  const modules = {
    auth: { requireUser: () => ({ id: 'ignored' }) },
    forms: {
      storeUploadedBytes: () => {
        const error = new Error('Upload key does not match the reserved intent key.')
        error.statusCode = 403
        throw error
      }
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  try {
    const address = await listen(server)
    const base = `http://${address.address}:${address.port}`
    const response = await fetch(`${base}/api/storage/uploads/intent-9?key=wrong`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('bytes')
    })
    assert.equal(response.status, 403)
  } finally {
    await close(server)
  }
})
