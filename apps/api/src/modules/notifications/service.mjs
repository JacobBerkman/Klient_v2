import {
  countUnreadNotifications,
  insertNotification,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead
} from '../../storage.mjs'

// In-app notifications service. Every operation is scoped to the requesting
// user (firm_id + user_id): a member reads/acts on their own notifications plus
// firm-wide ones. Notifications are inherently identity-scoped, so requireUser
// at the route + this firm/user scoping is the authorization boundary;
// canReadSession (every authenticated role) is asserted for defense in depth.
export function createNotificationsService({ policy }) {
  function scope(user) {
    return { firmId: user.firmId, userId: user.id }
  }

  return {
    list(user, { unreadOnly = false, limit = 50 } = {}) {
      policy.requireGuard(user, 'canReadSession')
      const notifications = listNotificationsForUser({ ...scope(user), unreadOnly, limit })
      return { ok: true, notifications, unreadCount: countUnreadNotifications(scope(user)) }
    },
    unreadCount(user) {
      policy.requireGuard(user, 'canReadSession')
      return { ok: true, count: countUnreadNotifications(scope(user)) }
    },
    markRead(user, notificationId) {
      policy.requireGuard(user, 'canReadSession')
      const marked = markNotificationRead(notificationId, scope(user))
      if (!marked) {
        const error = new Error('Notification not found.')
        error.statusCode = 404
        error.code = 'NOTIFICATION_NOT_FOUND'
        throw error
      }
      return { ok: true, unreadCount: countUnreadNotifications(scope(user)) }
    },
    markAllRead(user) {
      policy.requireGuard(user, 'canReadSession')
      const updated = markAllNotificationsRead(scope(user))
      return { ok: true, updated, unreadCount: countUnreadNotifications(scope(user)) }
    },
    // Firm/user-scoped creation helper (used by tests and any in-process
    // producer that has a user context; the export worker inserts directly via
    // storage so it also fires from the standalone worker process).
    create(user, input = {}) {
      policy.requireGuard(user, 'canReadSession')
      return insertNotification({ firmId: user.firmId, userId: user.id, ...input })
    }
  }
}
