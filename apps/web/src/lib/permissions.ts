import type { Role, User } from './types'

export const guardMatrix = {
  canManageUsers: ['admin'],
  canReadUsers: ['admin'],
  canViewDashboard: ['admin', 'advisor', 'readonly'],
  canReadProfiles: ['admin', 'advisor', 'readonly'],
  canWriteProfiles: ['admin', 'advisor'],
  canReadSensitiveProfileData: ['admin', 'advisor'],
  canReadPipeline: ['admin', 'advisor', 'readonly'],
  canMovePipeline: ['admin', 'advisor'],
  canReadHouseholds: ['admin', 'advisor', 'readonly'],
  canWriteHouseholds: ['admin', 'advisor'],
  canReadForms: ['admin', 'advisor', 'readonly'],
  canWriteForms: ['admin', 'advisor'],
  canManageDraftSharing: ['admin', 'advisor'],
  canWriteDraftCollaborator: ['admin', 'advisor'],
  canReadTemplate: ['admin', 'advisor', 'readonly'],
  canEditTemplate: ['admin', 'advisor'],
  canPublishTemplate: ['admin', 'advisor'],
  canReadExports: ['admin', 'advisor'],
  canWriteExports: ['admin', 'advisor'],
  canProcessExports: ['admin'],
  canReadAudit: ['admin', 'advisor', 'readonly'],
  canReadAnalytics: ['admin', 'advisor', 'readonly'],
  canReadDiagnostics: ['admin'],
  canReadClientWorkspace: ['client'],
  canWriteClientWorkspace: ['client'],
  canCreatePortalLink: ['admin', 'advisor']
} as const

export type GuardName = keyof typeof guardMatrix

export function hasGuard(user: User | null | undefined, guard: GuardName) {
  if (!user) return false
  return guardMatrix[guard].includes(user.role)
}

export function hasRole(user: User | null | undefined, roles: Role[]) {
  return Boolean(user && roles.includes(user.role))
}

export function homePathForUser(user: User | null | undefined) {
  if (!user) return '/login'
  return user.role === 'client' ? '/portal' : '/dashboard'
}
