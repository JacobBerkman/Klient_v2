import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { createTemplateWorkflowPdf } from '../../../../scripts/pdf-fixtures.mjs'

const repoRoot = process.cwd()

async function loadStore() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-preview-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'template-preview-secret-abcdefghijklmnopqrstuvwxyz'
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const { createStore } = await import(moduleUrl)
  const store = createStore()
  process.chdir(previousCwd)
  return store
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Preview Advisory',
    firstName: 'Morgan',
    lastName: 'Mapper',
    email: `mapper-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'MapperPass123!'
  })
  return store.requireUser(session.token)
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()))
  })
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())))
}

test('template mapper test-fill preview renders source PDF without creating export jobs', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createTemplateWorkflowPdf()
  const template = await store.autoBuildTemplate(user, {
    name: 'Mapper Preview Intake',
    fileName: 'mapper-preview.pdf',
    fileBytesBase64: pdf.toString('base64')
  })
  const beforeExports = store.listExports(user)

  const preview = await store.previewTemplateTestFill(user, template.id, {
    values: { client_name: 'Preview Client', salary: '$123,000', retired: true }
  })

  assert.equal(preview.contentType, 'application/pdf')
  assert.ok(preview.body.length > 100)
  assert.equal(store.listExports(user).length, beforeExports.length)
  const rendered = await PDFDocument.load(preview.body, { ignoreEncryption: true })
  const form = rendered.getForm()
  assert.equal(form.getTextField('client_name').getText(), 'Preview Client')
  assert.equal(form.getTextField('salary').getText(), '$123,000')
})

test('POST /api/templates/:id/test-fill-preview returns inline PDF without JSON wrapping', async () => {
  process.env.APP_SECRET ||= 'template-preview-route-secret-abcdefghijklmnopqrstuvwxyz'
  const { createHttpServer } = await import(`../server.mjs?mapper-preview-route=${Date.now()}-${Math.random()}`)
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'advisor' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    templates: {
      previewTestFill: (user, templateId, payload) => {
        calls.push({ userId: user.id, templateId, payload })
        return {
          body: Buffer.from('%PDF-route-preview'),
          fileName: 'route-preview.pdf',
          contentType: 'application/pdf',
          sizeBytes: Buffer.byteLength('%PDF-route-preview'),
          diagnostics: []
        }
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
    const response = await fetch(`${base}/api/templates/template-1/test-fill-preview`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        origin: base,
        referer: `${base}/`
      },
      body: JSON.stringify({ values: { client_name: 'Route Preview' } })
    })
    const body = Buffer.from(await response.arrayBuffer()).toString('utf8')

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.match(response.headers.get('content-disposition') || '', /inline/)
    assert.equal(body, '%PDF-route-preview')
    assert.deepEqual(calls, [
      'policy:u1:canEditTemplate',
      {
        userId: 'u1',
        templateId: 'template-1',
        payload: { values: { client_name: 'Route Preview' } }
      }
    ])
  } finally {
    await close(server)
  }
})
