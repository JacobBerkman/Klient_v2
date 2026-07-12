import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

/**
 * App-wide toast notifications for mutation feedback.
 *
 * - useToast() exposes toast.success / toast.error / toast.info.
 * - Toasts auto-dismiss after ~5s; hovering or focusing a toast pauses the
 *   remaining time, and every toast has a manual dismiss button.
 * - The portal viewport is a named region so assistive tech (and e2e specs)
 *   can find notifications; success/info toasts announce politely via
 *   role="status" while errors interrupt via role="alert".
 * - Entry animation lives in styles.css and is neutralised by the global
 *   prefers-reduced-motion block there.
 * - InlineNotice remains the right tool for persistent validation messages;
 *   toasts are for transient success/failure feedback after a mutation.
 */

export type ToastTone = 'success' | 'error' | 'info'

interface ToastRecord {
  id: number
  tone: ToastTone
  message: string
}

type ToastAction = { type: 'add'; toast: ToastRecord } | { type: 'dismiss'; id: number }

function toastReducer(toasts: ToastRecord[], action: ToastAction): ToastRecord[] {
  switch (action.type) {
    case 'add':
      // Re-raising an identical message replaces the earlier toast instead of
      // stacking duplicates (also keeps text locators unambiguous in e2e).
      return [
        ...toasts.filter((toast) => toast.tone !== action.toast.tone || toast.message !== action.toast.message),
        action.toast
      ]
    case 'dismiss':
      return toasts.filter((toast) => toast.id !== action.id)
    default:
      return toasts
  }
}

export interface ToastApi {
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const AUTO_DISMISS_MS = 5000

let nextToastId = 1

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: number) => void }) {
  // Pause-on-hover/focus keeps the remaining time instead of restarting it.
  const remainingRef = useRef(AUTO_DISMISS_MS)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const pause = useCallback(() => {
    if (timerRef.current === null) return
    clearTimer()
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current))
  }, [clearTimer])

  const resume = useCallback(() => {
    if (timerRef.current !== null) return
    startedAtRef.current = Date.now()
    timerRef.current = setTimeout(() => onDismiss(toast.id), remainingRef.current)
  }, [onDismiss, toast.id])

  useEffect(() => {
    resume()
    return clearTimer
  }, [resume, clearTimer])

  return (
    <div
      className={`toast toast-${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <p className="toast-message">{toast.message}</p>
      <button
        type="button"
        className="ghost-button toast-dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        &times;
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, [])

  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), [])

  const push = useCallback((tone: ToastTone, message: string) => {
    dispatch({ type: 'add', toast: { id: nextToastId++, tone, message } })
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push('success', message),
      error: (message: string) => push('error', message),
      info: (message: string) => push('info', message)
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-viewport" role="region" aria-label="Notifications">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider.')
  }
  return context
}
