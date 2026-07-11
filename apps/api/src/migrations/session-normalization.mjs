// Shared session-record normalization used by the sessions backfill (002) and
// the blob-retirement cleanup (003). This ports the defaulting the store used
// to perform on state.sessions at startup: sparse legacy records get a
// createdAt/lastActivityAt plus absolute and idle expiry timestamps, because
// the sessions table is the sole source of truth and NULL expiry columns are
// treated as already-expired by deleteExpiredSessions.
//
// The constants mirror SESSION_MAX_AGE_MS / SESSION_IDLE_TIMEOUT_MS in
// apps/api/src/store.mjs and must stay in sync with them.
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8
export const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 30

function toEpochMs(value, fallbackMs) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : fallbackMs
}

export function normalizeSessionRecord(session, nowMs = Date.now()) {
  const createdAt = session.createdAt || new Date(nowMs).toISOString()
  const lastActivityAt = session.lastActivityAt || createdAt
  return {
    token: session.token,
    userId: session.userId ?? null,
    firmId: session.firmId ?? null,
    createdAt,
    lastActivityAt,
    expiresAt: session.expiresAt || new Date(toEpochMs(createdAt, nowMs) + SESSION_MAX_AGE_MS).toISOString(),
    idleExpiresAt:
      session.idleExpiresAt || new Date(toEpochMs(lastActivityAt, nowMs) + SESSION_IDLE_TIMEOUT_MS).toISOString()
  }
}
