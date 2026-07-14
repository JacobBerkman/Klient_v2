import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Email delivery must be strictly additive: with the capture provider each
// invite / password-reset / portal-link flow produces exactly one message with
// the right recipient and a working token link, while the API responses stay
// BYTE-IDENTICAL to a server with EMAIL_PROVIDER=disabled and to a server with
// no mailer wired at all. Audit events carry a masked recipient and never the
// token or URL. The unknown-email password reset keeps its anti-enumeration
// contract: nothing is sent and the response is unchanged.
const repoRoot = process.cwd()
const previousEnv = {
  NODE_ENV: process.env.NODE_ENV,
  ENABLE_TEST_CSRF_BYPASS: process.env.ENABLE_TEST_CSRF_BYPASS,
  APP_SECRET: process.env.APP_SECRET
}
const tempDir = mkdtempSync(join(tmpdir(), 'klient-email-delivery-'))
process.chdir(tempDir)
process.env.NODE_ENV = 'test'
// The invite and portal-link routes are session+CSRF protected; the harness
// CSRF bypass (honored only under NODE_ENV=test) lets the fake module auth
// stand in for a real session, exactly like other route-wiring tests.
process.env.ENABLE_TEST_CSRF_BYPASS = 'true'
process.env.APP_SECRET = 'test-secret-email-delivery-suite'

const bust = `${Date.now()}-${Math.random()}`
const [{ createHttpServer }, { createMailer }, storage] = await Promise.all([
  import(`${pathToFileURL(resolve(repoRoot, 'apps/api/src/server.mjs')).href}?email=${bust}`),
  import(`${pathToFileURL(resolve(repoRoot, 'apps/api/src/mailer/index.mjs')).href}?email=${bust}`),
  // Plain (non-cache-busted) storage import: same module instance the server
  // routes read through, so the seeded rows below are visible to them.
  import(pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href)
])

const FIRM_NAME = 'Acme Wealth Partners'
const BASE_URL = 'https://app.acme.test'
const INVITE_TOKEN = 'invite-token-456'
const RESET_TOKEN = 'reset-token-123'
const PORTAL_TOKEN = 'portal-token-789'

storage.upsertFirmRow({ id: 'firm-1', name: FIRM_NAME, slug: 'acme-wealth' })
storage.upsertUserRow({ id: 'user-reset-1', firmId: 'firm-1', email: 'known@example.test', role: 'advisor' })
storage.upsertProfileRow({
  id: 'profile-1',
  firmId: 'firm-1',
  kind: 'client',
  firstName: 'Pat',
  lastName: 'Client',
  email: 'pat.client@example.test'
})
storage.upsertProfileRow({
  id: 'profile-no-email',
  firmId: 'firm-1',
  kind: 'client',
  firstName: 'No',
  lastName: 'Email',
  email: ''
})

// Deterministic fake modules (raw-upload-endpoint precedent) so responses are
// byte-comparable across servers. Shapes mirror the real store returns.
function createFakeModules() {
  const actor = { id: 'user-admin-1', firmId: 'firm-1', role: 'admin', email: 'admin@example.test' }
  return new Proxy(
    {
      auth: {
        requireUser: () => actor,
        requestReset: (input) => {
          const email = String(input?.email || '').toLowerCase()
          if (email === 'known@example.test') {
            return {
              id: 'reset-1',
              userId: 'user-reset-1',
              token: RESET_TOKEN,
              createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: '2026-01-01T01:00:00.000Z'
            }
          }
          // Anti-enumeration contract of the real store: unknown emails get
          // an empty acknowledgement, never a token.
          return { ok: true }
        }
      },
      policy: { requireGuard: () => true },
      firmsUsers: {
        inviteUser: (user, input) => ({
          id: 'invite-1',
          firmId: user.firmId,
          email: String(input?.email || '').toLowerCase(),
          role: input?.role || 'advisor',
          invitedByUserId: user.id,
          token: INVITE_TOKEN,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-08T00:00:00.000Z'
        })
      },
      forms: {
        createPortalLink: (user, profileId) => ({
          id: 'link-1',
          firmId: user.firmId,
          profileId,
          token: PORTAL_TOKEN,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          maxUses: 1,
          usedCount: 0,
          revokedAt: null,
          lastUsedAt: null,
          scope: { formIds: [] }
        })
      }
    },
    { get: (target, prop) => target[prop] || {} }
  )
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`))
  })
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())))
}

async function waitForSettled() {
  // mailer.send() is fire-and-forget; give its microtasks a beat to finish.
  await new Promise((resolveWait) => setTimeout(resolveWait, 25))
}

const captureAudits = []
const captureMailer = createMailer({
  runtime: { nodeEnv: 'test', emailProvider: 'capture', appBaseUrl: BASE_URL },
  log: () => {},
  onAudit: (event) => captureAudits.push(event)
})
const disabledAudits = []
const disabledMailer = createMailer({
  runtime: { nodeEnv: 'test', emailProvider: 'disabled', appBaseUrl: BASE_URL },
  log: () => {},
  onAudit: (event) => disabledAudits.push(event)
})

const captureServer = createHttpServer({ modules: createFakeModules(), mailer: captureMailer })
const disabledServer = createHttpServer({ modules: createFakeModules(), mailer: disabledMailer })
const bareServer = createHttpServer({ modules: createFakeModules() })

const captureBase = await listen(captureServer)
const disabledBase = await listen(disabledServer)
const bareBase = await listen(bareServer)

after(async () => {
  await close(captureServer)
  await close(disabledServer)
  await close(bareServer)
  process.chdir(repoRoot)
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
  }
})

async function postJson(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, text: await response.text() }
}

// Sends the same request to the capture, disabled, and mailer-less servers and
// asserts the responses are byte-identical before returning the capture one.
async function postEverywhere(path, body) {
  const [captured, disabled, bare] = await Promise.all([
    postJson(captureBase, path, body),
    postJson(disabledBase, path, body),
    postJson(bareBase, path, body)
  ])
  assert.equal(captured.status, disabled.status, `${path}: status differs with provider=disabled`)
  assert.equal(captured.text, disabled.text, `${path}: body differs with provider=disabled`)
  assert.equal(captured.status, bare.status, `${path}: status differs with no mailer wired`)
  assert.equal(captured.text, bare.text, `${path}: body differs with no mailer wired`)
  await waitForSettled()
  return captured
}

function takeMessages() {
  return captureMailer.messages.splice(0, captureMailer.messages.length)
}

function takeAudits() {
  return captureAudits.splice(0, captureAudits.length)
}

function assertAuditIsSafe(audit, { template, maskedRecipient, tokens }) {
  assert.equal(audit.action, 'email.sent')
  assert.equal(audit.metadata.template, template)
  assert.equal(audit.metadata.recipient, maskedRecipient)
  const serialized = JSON.stringify(audit)
  for (const token of tokens) {
    assert.ok(!serialized.includes(token), `audit payload must not contain the token (${template})`)
  }
  assert.ok(!serialized.includes(BASE_URL), `audit payload must not contain the link URL (${template})`)
  assert.ok(!serialized.includes('http'), `audit payload must not contain any URL (${template})`)
}

test('invite: one message to the invited address with a working token link; response byte-identical', async () => {
  const response = await postEverywhere('/api/invites', { email: 'New.Advisor@Example.test', role: 'advisor' })
  assert.equal(response.status, 201)
  const body = JSON.parse(response.text)
  assert.equal(body.token, INVITE_TOKEN, 'response keeps returning the invite token')

  const messages = takeMessages()
  assert.equal(messages.length, 1, 'exactly one invite message')
  assert.equal(messages[0].to, 'new.advisor@example.test')
  assert.equal(messages[0].template, 'userInvite')
  assert.ok(messages[0].subject.includes(FIRM_NAME), 'subject names the firm')
  assert.ok(messages[0].text.includes(FIRM_NAME), 'body names the firm')
  assert.ok(
    messages[0].text.includes(`${BASE_URL}/accept-invite?token=${INVITE_TOKEN}`),
    'body contains the invite link with the token'
  )

  const audits = takeAudits()
  assert.equal(audits.length, 1)
  assertAuditIsSafe(audits[0], {
    template: 'userInvite',
    maskedRecipient: 'n***@example.test',
    tokens: [INVITE_TOKEN]
  })
  assert.equal(audits[0].firmId, 'firm-1')
  assert.equal(audits[0].actorUserId, 'user-admin-1')
})

test('password reset (known email): token is emailed, never returned in the response', async () => {
  const response = await postEverywhere('/api/password-resets', { email: 'known@example.test' })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  // The reset token is a credential. Returning it to an unauthenticated caller
  // would let anyone who knows an email address take over that account.
  assert.deepEqual(body, { ok: true }, 'response is a bare acknowledgement')
  assert.ok(!response.text.includes(RESET_TOKEN), 'reset token never appears in the response body')

  const messages = takeMessages()
  assert.equal(messages.length, 1, 'exactly one reset message')
  assert.equal(messages[0].to, 'known@example.test')
  assert.equal(messages[0].template, 'passwordReset')
  assert.ok(messages[0].text.includes(FIRM_NAME), 'body names the firm (resolved via the seeded user row)')
  assert.ok(
    messages[0].text.includes(`${BASE_URL}/reset-password?token=${RESET_TOKEN}`),
    'body contains the reset link with the token'
  )

  const audits = takeAudits()
  assert.equal(audits.length, 1)
  assertAuditIsSafe(audits[0], {
    template: 'passwordReset',
    maskedRecipient: 'k***@example.test',
    tokens: [RESET_TOKEN]
  })
})

test('password reset (unknown email): sends nothing, audits nothing, response unchanged', async () => {
  const response = await postEverywhere('/api/password-resets', { email: 'nobody@example.test' })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.text), { ok: true }, 'anti-enumeration acknowledgement is unchanged')
  assert.equal(takeMessages().length, 0, 'no message for an unknown email')
  assert.equal(takeAudits().length, 0, 'no audit event for an unknown email')
})

test('password reset: known and unknown emails are indistinguishable to the caller', async () => {
  // Anti-enumeration only holds if the caller cannot tell the two apart. A
  // response that carried the token for real accounts (and not for fake ones)
  // was itself the enumeration oracle.
  const known = await postEverywhere('/api/password-resets', { email: 'known@example.test' })
  takeMessages()
  takeAudits()
  const unknown = await postEverywhere('/api/password-resets', { email: 'nobody@example.test' })
  takeMessages()
  takeAudits()

  assert.equal(known.status, unknown.status, 'same status code')
  assert.equal(known.text, unknown.text, 'same response body for a real and a fake account')
})

test('portal link: one message to the profile email with the portal deep link; response byte-identical', async () => {
  const response = await postEverywhere('/api/portal-links', { profileId: 'profile-1', expiresInHours: 24 })
  assert.equal(response.status, 201)
  const body = JSON.parse(response.text)
  assert.equal(body.token, PORTAL_TOKEN, 'response keeps returning the portal token')

  const messages = takeMessages()
  assert.equal(messages.length, 1, 'exactly one portal-link message')
  assert.equal(messages[0].to, 'pat.client@example.test')
  assert.equal(messages[0].template, 'portalLink')
  assert.ok(messages[0].subject.includes(FIRM_NAME), 'subject names the firm')
  assert.ok(
    messages[0].text.includes(`${BASE_URL}/portal?token=${PORTAL_TOKEN}`),
    'body contains the /portal?token= deep link the frontend PortalPage consumes'
  )

  const audits = takeAudits()
  assert.equal(audits.length, 1)
  assertAuditIsSafe(audits[0], {
    template: 'portalLink',
    maskedRecipient: 'p***@example.test',
    tokens: [PORTAL_TOKEN]
  })
})

test('portal link for a profile without an email sends nothing and the response is unchanged', async () => {
  const response = await postEverywhere('/api/portal-links', { profileId: 'profile-no-email', expiresInHours: 24 })
  assert.equal(response.status, 201)
  assert.equal(JSON.parse(response.text).token, PORTAL_TOKEN)
  assert.equal(takeMessages().length, 0, 'no recipient, no message')
  assert.equal(takeAudits().length, 0, 'no recipient, no audit event')
})

test('provider "disabled" captures nothing and never audits', async () => {
  assert.equal(disabledMailer.provider, 'disabled')
  assert.equal(disabledMailer.messages.length, 0, 'disabled provider stores no messages')
  assert.equal(disabledAudits.length, 0, 'disabled provider records no audit events')
  const direct = await disabledMailer.send({
    to: 'someone@example.test',
    template: 'userInvite',
    data: { token: 'x' }
  })
  assert.deepEqual(direct, { ok: true, skipped: true, provider: 'disabled' })
  assert.equal(disabledMailer.messages.length, 0)
  assert.equal(disabledAudits.length, 0)
})

test('send failures are swallowed and audited as email.send_failed with a masked recipient', async () => {
  const audits = []
  const failing = createMailer({
    runtime: { nodeEnv: 'test', emailProvider: 'capture', appBaseUrl: BASE_URL },
    log: () => {},
    onAudit: (event) => audits.push(event)
  })
  const result = await failing.send({
    to: 'victim@example.test',
    template: 'not-a-real-template',
    data: { token: 'secret-token' },
    firmId: 'firm-1'
  })
  assert.equal(result.ok, false, 'send resolves (never throws) even when rendering fails')
  assert.equal(failing.messages.length, 0)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'email.send_failed')
  assert.equal(audits[0].metadata.recipient, 'v***@example.test')
  assert.ok(!JSON.stringify(audits[0]).includes('secret-token'), 'failure audit must not leak the token')
})
