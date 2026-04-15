import type { AuditEvent, DraftCollaborator, HouseholdMember, Profile, User } from './types'

export function formatDateTime(value: unknown) {
  if (!value) return 'Unavailable'
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) return String(value)
  return new Date(parsed).toLocaleString()
}

export function formatDate(value: unknown) {
  if (!value) return 'Unavailable'
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) return String(value)
  return new Date(parsed).toLocaleDateString()
}

export function profileName(profile: Partial<Profile> | null | undefined) {
  if (!profile) return 'Unknown profile'
  const full = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim()
  return full || profile.id || 'Unknown profile'
}

export function userName(user: Partial<User> | null | undefined) {
  if (!user) return 'Unknown user'
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full || user.email || user.id || 'Unknown user'
}

export function householdRoleLabel(member: HouseholdMember) {
  return String(member.role || 'member').replace(/_/g, ' ')
}

export function collaboratorSummary(collaborators: DraftCollaborator[] = []) {
  if (!collaborators.length) return 'No collaborators'
  return collaborators.map((entry) => `${entry.userId} (${entry.permission})`).join(', ')
}

export function auditActor(event: AuditEvent) {
  return event.actor?.userId || 'system'
}

export function humanizeKey(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (token) => token.toUpperCase())
}
