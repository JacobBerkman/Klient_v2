import { randomUUID } from 'node:crypto'

function nowIso() {
  return new Date().toISOString()
}

export const CANONICAL_AUDIT_FIELDS = [
  'actor',
  'firmId',
  'entityType',
  'entityId',
  'action',
  'before',
  'after',
  'requestId',
  'ip',
  'timestamp'
]

export function createCanonicalAuditEvent(input = {}) {
  const actor = input.actor || { userId: input.actorUserId || null }
  return {
    id: input.id || randomUUID(),
    actor,
    firmId: input.firmId || null,
    entityType: input.entityType || 'unknown',
    entityId: input.entityId || null,
    action: input.action || 'unknown',
    before: input.before ?? null,
    after: input.after ?? null,
    requestId: input.requestId || null,
    ip: input.ip || null,
    timestamp: input.timestamp || nowIso()
  }
}
