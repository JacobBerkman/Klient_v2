import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './client'

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'

export interface UseAutosaveOptions<T> {
  value: T
  enabled: boolean
  // Perform the save. Throw to signal failure; throw an ApiError with status
  // 409 to signal an optimistic-concurrency conflict (surfaced as 'conflict').
  save: (value: T) => Promise<void>
  serialize?: (value: T) => string
  delay?: number
}

export interface AutosaveController {
  status: AutosaveStatus
  // Save immediately (e.g. on blur), bypassing the debounce.
  flush: () => void
  // Re-baseline after the record reloads (new revision) so the freshly loaded
  // value is treated as already-saved and does not trigger an autosave.
  reset: (savedValue?: unknown) => void
}

// Debounced, coalesced autosave with an explicit status for a visible
// indicator. It never fires for the initial/unchanged value, never overlaps
// saves (in-flight saves coalesce a single trailing save), and reports
// conflicts distinctly so callers can surface them without clobbering.
export function useAutosave<T>({
  value,
  enabled,
  save,
  serialize = JSON.stringify,
  delay = 1500
}: UseAutosaveOptions<T>): AutosaveController {
  const [status, setStatus] = useState<AutosaveStatus>('idle')

  const valueRef = useRef(value)
  const saveRef = useRef(save)
  const serializeRef = useRef(serialize)
  const enabledRef = useRef(enabled)
  const lastSavedRef = useRef<string | null>(null)
  const lastAttemptRef = useRef<string | null>(null)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  valueRef.current = value
  saveRef.current = save
  serializeRef.current = serialize
  enabledRef.current = enabled

  const runSave = useCallback(async () => {
    if (!enabledRef.current) return
    if (savingRef.current) {
      pendingRef.current = true
      return
    }
    const snapshot = serializeRef.current(valueRef.current)
    if (snapshot === lastSavedRef.current) return
    savingRef.current = true
    lastAttemptRef.current = snapshot
    setStatus('saving')
    try {
      await saveRef.current(valueRef.current)
      lastSavedRef.current = snapshot
      setStatus('saved')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error')
    } finally {
      savingRef.current = false
      if (pendingRef.current) {
        pendingRef.current = false
        const latest = serializeRef.current(valueRef.current)
        // Retry only if new edits arrived while saving — never re-fire the exact
        // payload that just failed (avoids a conflict/error storm).
        if (enabledRef.current && latest !== lastSavedRef.current && latest !== lastAttemptRef.current) {
          void runSave()
        }
      }
    }
  }, [])

  const flush = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void runSave()
  }, [runSave])

  const reset = useCallback((savedValue?: unknown) => {
    lastSavedRef.current = savedValue === undefined ? null : serializeRef.current(savedValue as T)
    lastAttemptRef.current = null
    pendingRef.current = false
    setStatus('idle')
  }, [])

  useEffect(() => {
    if (!enabled) return
    const snapshot = serialize(value)
    // First observation while enabled establishes the saved baseline without a
    // network call, so a freshly loaded record is not autosaved on mount.
    if (lastSavedRef.current === null) {
      lastSavedRef.current = snapshot
      return
    }
    if (snapshot === lastSavedRef.current) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void runSave()
    }, delay)
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [value, enabled, delay, serialize, runSave])

  return { status, flush, reset }
}

export function autosaveStatusLabel(status: AutosaveStatus): string {
  switch (status) {
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'All changes saved'
    case 'conflict':
      return 'Save conflict – reload to reconcile'
    case 'error':
      return 'Save failed – retry'
    default:
      return ''
  }
}
