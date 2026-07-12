// Opaque keyset cursors: base64url of the JSON keyset position. Mirrors the
// exact encoding the activity feed uses (modules/activity/service.mjs) so the
// client always treats cursors as opaque tokens rather than depending on the
// keyset internals. Generic over the cursor object shape so each paged list
// (profiles, households, submissions, templates) can carry its own keys.
export function encodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'object') return null
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCursor(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
