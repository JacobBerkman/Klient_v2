import {
  ACTIVITY_CATEGORIES,
  AUTH_CATEGORY_ID,
  authCategoryPrefixes,
  categoryForAction,
  prefixesForCategory,
  summarizeEvent
} from './categories.mjs'

// Opaque cursor: base64url of the { occurredAt, rowid } keyset position. Kept
// opaque so the client treats it as a token rather than depending on the
// (occurred_at, rowid) internals.
function encodeCursor(cursor) {
  if (!cursor || !cursor.occurredAt) return null
  return Buffer.from(JSON.stringify({ o: cursor.occurredAt, r: cursor.rowid }), 'utf8').toString('base64url')
}

function decodeCursor(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    if (!parsed || !parsed.o) return null
    return { occurredAt: String(parsed.o), rowid: Number(parsed.r) || 0 }
  } catch {
    return null
  }
}

function actorLabel(entry) {
  if (!entry) return null
  const full = [entry.firstName, entry.lastName].filter(Boolean).join(' ').trim()
  return full || entry.email || entry.id || null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function createActivityService({ store, policy }) {
  return {
    // Static metadata for the web filter bar: the filterable categories.
    categories() {
      return ACTIVITY_CATEGORIES.map((category) => ({ id: category.id, label: category.label }))
    },

    list(user, filters = {}) {
      policy.requireGuard(user, 'canReadAudit')

      const category = String(filters.category || '').trim()
      const actorId = String(filters.actorId || '').trim() || null
      const from = String(filters.from || '').trim() || null
      const to = String(filters.to || '').trim() || null
      const requestedLimit = Number.parseInt(filters.limit, 10)
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
        : DEFAULT_LIMIT

      // An unknown/empty category means "all". A known category narrows to its
      // action prefixes.
      const actionPrefixes = category ? prefixesForCategory(category) : null

      // Advisors and read-only users never see other users' auth-category
      // events; admins see everything. This is enforced in SQL so pages are not
      // silently short.
      const restrictAuthToSelf = user.role !== 'admin'

      const { events, nextCursor } = store.queryAuditEventsPage({
        firmId: user.firmId,
        actionPrefixes,
        actorId,
        from,
        to,
        restrictAuthToSelf,
        authPrefixes: authCategoryPrefixes(),
        selfUserId: user.id,
        cursor: decodeCursor(filters.cursor),
        limit
      })

      const directory = new Map(store.listFirmUserDirectory(user.firmId).map((entry) => [entry.id, entry]))

      const shaped = events.map((event) => {
        const actorUserId = event.actor?.userId || null
        return {
          id: event.id,
          timestamp: event.timestamp,
          action: event.action,
          category: categoryForAction(event.action),
          actorUserId,
          actorName: actorUserId ? actorLabel(directory.get(actorUserId)) || actorUserId : 'System',
          entityType: event.entityType || null,
          entityId: event.entityId || null,
          summary: summarizeEvent(event)
        }
      })

      return { events: shaped, nextCursor: encodeCursor(nextCursor) }
    }
  }
}

export { AUTH_CATEGORY_ID }
