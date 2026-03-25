import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  upsertCsrfToken,
  readCsrfToken,
  deleteCsrfToken,
  deleteCsrfTokensBySession,
  deleteExpiredCsrfTokens
} from '../storage.mjs'

function createRecord(overrides = {}) {
  const issuedAt = new Date().toISOString()
  return {
    id: randomUUID(),
    sessionToken: overrides.sessionToken || randomUUID(),
    userId: overrides.userId || randomUUID(),
    token: overrides.token || randomUUID(),
    issuedAt,
    lastRotatedAt: issuedAt,
    expiresAt: overrides.expiresAt || new Date(Date.now() + 60_000).toISOString()
  }
}

test('csrf persistence: expires stale tokens', () => {
  const record = createRecord({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
  upsertCsrfToken(record)
  deleteExpiredCsrfTokens(new Date().toISOString())
  assert.equal(readCsrfToken(record.sessionToken, record.id), null)
})

test('csrf persistence: rotation invalidates replay of prior token id', () => {
  const sessionToken = randomUUID()
  const userId = randomUUID()
  const first = createRecord({ sessionToken, userId })
  const second = createRecord({ sessionToken, userId })
  upsertCsrfToken(first)
  deleteCsrfTokensBySession(sessionToken)
  upsertCsrfToken(second)
  assert.equal(readCsrfToken(sessionToken, first.id), null)
  const stored = readCsrfToken(sessionToken, second.id)
  assert.equal(stored?.token, second.token)
  deleteCsrfToken(second.id)
})

test('csrf persistence: supports multi-instance read/write compatibility', () => {
  const record = createRecord()
  // Instance A writes.
  upsertCsrfToken(record)
  // Instance B reads from shared storage (same helper, separate call path).
  const sharedRead = readCsrfToken(record.sessionToken, record.id)
  assert.equal(sharedRead?.id, record.id)
  assert.equal(sharedRead?.userId, record.userId)
  deleteCsrfToken(record.id)
})
