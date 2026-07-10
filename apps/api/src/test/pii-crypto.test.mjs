import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

function encryptLegacy(value, keySeed) {
  const key = createHash('sha256').update(keySeed).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function withStoreEnv(fn, env = {}) {
  const previousCwd = process.cwd()
  const previousEnv = { ...process.env }
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-pii-test-'))
  process.chdir(tempDir)
  Object.assign(process.env, {
    APP_SECRET: 'test-secret-for-pii',
    AUTH_PROVIDER: 'local',
    PII_KEY_PROVIDER: 'env',
    PII_ACTIVE_KEY_ID: 'key-v1',
    PII_KEYRING: JSON.stringify({
      'legacy-app-secret-v1': 'test-secret-for-pii',
      'key-v1': 'key-material-v1',
      'key-v2': 'key-material-v2'
    }),
    ...env
  })
  const moduleUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  return import(moduleUrl)
    .then((mod) => fn(mod.createStore()))
    .finally(() => {
      process.chdir(previousCwd)
      process.env = previousEnv
    })
}

test('envelope crypto preserves backward compatibility for legacy ciphertext', async () => {
  await withStoreEnv((store) => {
    const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    const user = store.requireUser(session.token)
    const profile = store.state.profiles.find((entry) => entry.firmId === user.firmId && entry.kind === 'client')
    profile.pii = {
      maskingPolicy: 'role_based',
      ssnCiphertext: encryptLegacy('123-45-6789', 'test-secret-for-pii'),
      taxIdCiphertext: encryptLegacy('12-3456789', 'test-secret-for-pii')
    }

    const sensitive = store.getMaskedSensitiveData(user, profile.id, {
      purpose: 'profile_view',
      reasonCode: 'customer_request'
    })
    assert.equal(sensitive.ssnMasked, '***-**-6789')
    assert.equal(sensitive.taxIdMasked, '**-6789')
  })
})

test('key rotation re-encrypts pii fields to active key id', async () => {
  await withStoreEnv((store) => {
    const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    const user = store.requireUser(session.token)
    const created = store.createProfile(user, {
      kind: 'client',
      firstName: 'Rot',
      lastName: 'Test',
      ssn: '111-22-3333',
      taxId: '98-7654321'
    })
    assert.equal(created.pii.ssnEncrypted.keyId, 'key-v1')

    process.env.PII_ACTIVE_KEY_ID = 'key-v2'
    const rotatedStore = store
    rotatedStore._internal.piiCrypto.keyProvider.activeKeyId = 'key-v2'
    const result = rotatedStore.reencryptSensitiveData({ firmId: user.firmId, actorUserId: user.id })
    assert.ok(result.rotatedProfiles >= 1)
    const updated = rotatedStore.state.profiles.find((entry) => entry.id === created.id)
    assert.equal(updated.pii.ssnEncrypted.keyId, 'key-v2')
    assert.equal(updated.pii.taxIdEncrypted.keyId, 'key-v2')
  })
})

test('unauthorized unmask reads are denied and audited', async () => {
  await withStoreEnv((store) => {
    const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    const user = store.requireUser(session.token)
    const profile = store.state.profiles.find((entry) => entry.firmId === user.firmId && entry.kind === 'client')

    assert.throws(
      () =>
        store.getMaskedSensitiveData({ ...user, role: 'readonly' }, profile.id, {
          purpose: 'compliance_review',
          unmask: true,
          reasonCode: 'regulatory_review',
          justification: 'Investigating regulator inquiry.',
          privilegedPolicy: 'privileged_sensitive_read_v1'
        }),
      /denied/
    )
    const denyEvent = store.state.auditEvents.find((entry) => entry.action === 'sensitive.read_denied')
    assert.ok(denyEvent)
    const denyMeta = denyEvent.metadata || denyEvent.after || {}
    assert.equal(denyMeta.requestedUnmask, true)
    assert.equal(denyMeta.grantedUnmask, false)
    assert.equal(denyMeta.outcome, 'denied')
    assert.deepEqual(denyMeta.fieldScope, ['ssn', 'taxId'])
    assert.equal(denyMeta.purpose, 'compliance_review')
    assert.equal(denyMeta.reason?.code, 'regulatory_review')
    assert.equal(denyMeta.reason?.privilegedPolicy, 'privileged_sensitive_read_v1')
    assert.match(denyMeta.denialReason, /least-privilege|denied/i)
    assert.equal(denyMeta.actor?.userId, user.id)
    assert.equal(denyMeta.actor?.role, 'readonly')
    assert.equal(denyEvent.after.requestedUnmask, true)
    assert.equal(denyEvent.after.reason.code, 'regulatory_review')
    assert.equal(denyEvent.after.actor.userId, user.id)
  })
})

test('authorized unmask reads return clear values and emit audit events', async () => {
  await withStoreEnv((store) => {
    const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    const user = store.requireUser(session.token)
    const created = store.createProfile(user, {
      kind: 'client',
      firstName: 'Audit',
      lastName: 'Trail',
      ssn: '999-88-7777',
      taxId: '11-2223333'
    })

    const response = store.getMaskedSensitiveData(user, created.id, {
      purpose: 'compliance_review',
      unmask: true,
      reasonCode: 'compliance_review',
      justification: 'Periodic compliance verification for KYC controls.',
      privilegedPolicy: 'privileged_sensitive_read_v1'
    })
    assert.equal(response.ssn, '999-88-7777')
    assert.equal(response.taxId, '11-2223333')

    const auditEvent = store.state.auditEvents.find(
      (entry) => entry.action === 'sensitive.read' && entry.entityId === created.id
    )
    assert.ok(auditEvent)
    const auditMeta = auditEvent.metadata || auditEvent.after || {}
    assert.equal(auditMeta.grantedUnmask, true)
    assert.equal(auditMeta.requestedUnmask, true)
    assert.equal(auditMeta.outcome, 'granted')
    assert.deepEqual(auditMeta.fieldScope, ['ssn', 'taxId'])
    assert.equal(auditMeta.purpose, 'compliance_review')
    assert.equal(auditMeta.reason?.code, 'compliance_review')
    assert.equal(
      auditMeta.reason?.justification,
      'Periodic compliance verification for KYC controls.'
    )
    assert.equal(auditMeta.reason?.privilegedPolicy, 'privileged_sensitive_read_v1')
    assert.equal(auditMeta.actor?.userId, user.id)
    assert.equal(auditMeta.actor?.role, 'admin')
    assert.equal(auditEvent.after.grantedUnmask, true)
    assert.deepEqual(auditEvent.after.fieldScope, ['ssn', 'taxId'])
    assert.equal(auditEvent.after.reason.code, 'compliance_review')
  })
})

test('unmask reads require approved reason code, justification, and explicit privileged policy', async () => {
  await withStoreEnv((store) => {
    const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    const user = store.requireUser(session.token)
    const profile = store.state.profiles.find((entry) => entry.firmId === user.firmId && entry.kind === 'client')

    assert.throws(
      () =>
        store.getMaskedSensitiveData(user, profile.id, {
          purpose: 'compliance_review',
          unmask: true,
          reasonCode: 'invalid_reason',
          justification: 'Need this'
        }),
      /approved code/
    )

    assert.throws(
      () =>
        store.getMaskedSensitiveData(user, profile.id, {
          purpose: 'compliance_review',
          unmask: true,
          reasonCode: 'compliance_review',
          justification: 'Too short',
          privilegedPolicy: 'privileged_sensitive_read_v1'
        }),
      /at least 12 characters/
    )

    assert.throws(
      () =>
        store.getMaskedSensitiveData(user, profile.id, {
          purpose: 'compliance_review',
          unmask: true,
          reasonCode: 'compliance_review',
          privilegedPolicy: 'privileged_sensitive_read_v1'
        }),
      /require non-empty justification/
    )

    assert.throws(
      () =>
        store.getMaskedSensitiveData(user, profile.id, {
          purpose: 'compliance_review',
          unmask: true,
          reasonCode: 'compliance_review',
          justification: 'Incident ticket KLIENT-123'
        }),
      /explicit privileged policy acknowledgement/
    )

    const deniedEvents = store.state.auditEvents.filter(
      (entry) => entry.action === 'sensitive.read_denied' && entry.entityId === profile.id
    )
    assert.ok(deniedEvents.length >= 4)
    deniedEvents.forEach((entry) => {
      const denialMeta = entry.metadata || entry.after || {}
      assert.equal(denialMeta.requestedUnmask, true)
      assert.equal(denialMeta.grantedUnmask, false)
      assert.equal(denialMeta.outcome, 'denied')
      assert.equal(typeof denialMeta.denialReason, 'string')
    })
  })
})
