import { createFirmContext } from '../shared/tenancy.mjs'

const SEARCHABLE_TYPES = ['profile', 'household', 'template', 'submission']
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

// Global search service. Guarded by canUseGlobalSearch (client role excluded
// — the portal never exposes firm-wide search). The store queries the
// runtime-managed search index, which holds ONLY promoted plaintext columns;
// submissions are resolved at query time from matched profile/template ids so
// client-entered submission payloads are never indexed.
export function createSearchService({ store, policy }) {
  return {
    search(user, filters = {}) {
      policy.requireGuard(user, 'canUseGlobalSearch')

      const q = String(filters.q || '').trim()
      const requestedTypes = String(filters.types || '')
        .split(',')
        .map((type) => type.trim().toLowerCase())
        .filter((type) => SEARCHABLE_TYPES.includes(type))
      const requestedLimit = Number.parseInt(filters.limit, 10)
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT

      return store.searchGlobal(createFirmContext(user), {
        q,
        types: requestedTypes.length ? requestedTypes : null,
        limit
      })
    }
  }
}
