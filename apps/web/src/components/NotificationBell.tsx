import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, routes } from '../lib/client'
import type { AppNotification, NotificationsPayload } from '../lib/types'

const POLL_INTERVAL_MS = 30_000

function formatTimestamp(value?: string | null): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleString()
}

export function NotificationBell() {
  const navigate = useNavigate()
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const refreshCount = useCallback(async () => {
    try {
      const result = await api.get<{ count: number }>(routes.notificationsUnreadCount())
      setUnreadCount(result.count || 0)
    } catch {
      // Non-fatal: leave the last known count in place.
    }
  }, [])

  const refreshList = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.get<NotificationsPayload>(routes.notifications())
      setNotifications(result.notifications || [])
      setUnreadCount(result.unreadCount || 0)
    } catch {
      setNotifications([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshCount()
    const timer = window.setInterval(() => {
      void refreshCount()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refreshCount])

  // Close on outside click / Escape when the panel is open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggleOpen = useCallback(() => {
    setOpen((previous) => {
      const next = !previous
      if (next) void refreshList()
      return next
    })
  }, [refreshList])

  const handleMarkAllRead = useCallback(async () => {
    try {
      await api.post(routes.notificationsReadAll(), {})
      setNotifications((previous) => previous.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() })))
      setUnreadCount(0)
    } catch {
      // Non-fatal.
    }
  }, [])

  const handleActivate = useCallback(
    async (notification: AppNotification) => {
      if (!notification.readAt) {
        try {
          await api.post(routes.notificationRead(notification.id), {})
          setNotifications((previous) =>
            previous.map((item) =>
              item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item
            )
          )
          setUnreadCount((previous) => Math.max(0, previous - 1))
        } catch {
          // Non-fatal: still navigate.
        }
      }
      setOpen(false)
      if (notification.link) navigate(notification.link)
    },
    [navigate]
  )

  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount)

  return (
    <div className="notification-bell" ref={containerRef}>
      <button
        type="button"
        className="notification-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications, no unread'
        }
        onClick={toggleOpen}
      >
        <span aria-hidden="true" className="notification-icon">
          &#128276;
        </span>
        {unreadCount > 0 ? (
          <span className="notification-badge" aria-hidden="true">
            {badgeLabel}
          </span>
        ) : null}
      </button>
      <span className="visually-hidden" aria-live="polite" role="status">
        {unreadCount > 0 ? `${unreadCount} unread notifications` : 'No unread notifications'}
      </span>
      {open ? (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-header">
            <strong>Notifications</strong>
            <button
              type="button"
              className="text-link"
              onClick={() => void handleMarkAllRead()}
              disabled={unreadCount === 0}
            >
              Mark all read
            </button>
          </div>
          <ul className="notification-list">
            {loading ? (
              <li className="notification-empty">Loading...</li>
            ) : notifications.length === 0 ? (
              <li className="notification-empty">You have no notifications.</li>
            ) : (
              notifications.map((notification) => (
                <li
                  key={notification.id}
                  className={notification.readAt ? 'notification-item' : 'notification-item is-unread'}
                >
                  <button
                    type="button"
                    className="notification-item-button"
                    onClick={() => void handleActivate(notification)}
                  >
                    <span className="notification-item-title">{notification.title || notification.type}</span>
                    {notification.body ? (
                      <span className="notification-item-body">{notification.body}</span>
                    ) : null}
                    <span className="notification-item-time">{formatTimestamp(notification.createdAt)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
