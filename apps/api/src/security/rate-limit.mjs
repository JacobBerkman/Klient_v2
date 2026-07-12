// In-memory sliding-window API rate limiter.
//
// Deliberately in-memory (a Map of key -> request timestamps): this sits on the
// hot path of every /api/* request and the deployment is single-instance, so no
// shared/durable counter store is needed. Memory is bounded two ways:
// - a background prune interval (unref()'d so it never holds the process open)
//   drops expired timestamps and empty keys, and
// - a max-tracked-keys cap evicts the least-recently-seen key when a new key
//   would exceed the cap.
//
// Auth endpoints keep their own durable SQLite lockouts (local-provider.mjs);
// this limiter is a coarse per-caller request budget layered in front.

export const DEFAULT_MAX_REQUESTS = 600
export const DEFAULT_WINDOW_SECONDS = 60
export const DEFAULT_MAX_TRACKED_KEYS = 10_000
export const DEFAULT_PRUNE_INTERVAL_MS = 30_000

export function createRateLimiter({
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  maxTrackedKeys = DEFAULT_MAX_TRACKED_KEYS,
  pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
  now = () => Date.now()
} = {}) {
  if (!Number.isFinite(maxRequests) || maxRequests < 1) throw new Error('maxRequests must be a positive number.')
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) throw new Error('windowSeconds must be a positive number.')
  if (!Number.isFinite(maxTrackedKeys) || maxTrackedKeys < 1) {
    throw new Error('maxTrackedKeys must be a positive number.')
  }

  const windowMs = windowSeconds * 1000
  // key -> ascending array of request timestamps (ms) inside the window.
  // Map insertion order doubles as recency order: every touched key is
  // re-inserted at the tail, so the head is always the least-recently-seen key.
  const buckets = new Map()

  function dropExpired(timestamps, cutoff) {
    let firstLive = 0
    while (firstLive < timestamps.length && timestamps[firstLive] <= cutoff) firstLive += 1
    if (firstLive > 0) timestamps.splice(0, firstLive)
    return timestamps
  }

  function prune(currentMs = now()) {
    const cutoff = currentMs - windowMs
    for (const [key, timestamps] of buckets) {
      dropExpired(timestamps, cutoff)
      if (timestamps.length === 0) buckets.delete(key)
    }
    return buckets.size
  }

  function check(key) {
    const currentMs = now()
    const cutoff = currentMs - windowMs
    const timestamps = dropExpired(buckets.get(key) || [], cutoff)

    if (timestamps.length >= maxRequests) {
      // Oldest surviving timestamp decides when a slot frees up.
      const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + windowMs - currentMs) / 1000))
      buckets.delete(key)
      buckets.set(key, timestamps)
      return { allowed: false, remaining: 0, retryAfterSeconds }
    }

    timestamps.push(currentMs)
    const isNewKey = !buckets.has(key)
    if (isNewKey && buckets.size >= maxTrackedKeys) {
      // Evict the least-recently-seen key so tracked state stays bounded even
      // under key churn (e.g. spoofed IPs). Evicted callers simply restart
      // with an empty window — bounded memory wins over perfect accounting.
      const oldestKey = buckets.keys().next().value
      buckets.delete(oldestKey)
    }
    buckets.delete(key)
    buckets.set(key, timestamps)
    return { allowed: true, remaining: maxRequests - timestamps.length, retryAfterSeconds: 0 }
  }

  const pruneTimer = setInterval(() => prune(), pruneIntervalMs)
  pruneTimer.unref?.()

  return {
    check,
    prune,
    stop() {
      clearInterval(pruneTimer)
    },
    get keyCount() {
      return buckets.size
    },
    config: Object.freeze({ maxRequests, windowSeconds, maxTrackedKeys, pruneIntervalMs })
  }
}
