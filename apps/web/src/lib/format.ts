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

export function formatCount(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0'
  return parsed.toLocaleString()
}

export function formatPercent(value: unknown, digits = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0%'
  return `${(parsed * 100).toFixed(digits)}%`
}

export function formatDays(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0 days'
  const rounded = Number(parsed.toFixed(1))
  return `${rounded.toLocaleString()} ${rounded === 1 ? 'day' : 'days'}`
}

export function formatHours(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0 hours'
  const rounded = Number(parsed.toFixed(1))
  return `${rounded.toLocaleString()} ${rounded === 1 ? 'hour' : 'hours'}`
}

export function formatBytes(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = parsed
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const rounded = unitIndex === 0 ? Math.round(size) : Number(size.toFixed(1))
  return `${rounded.toLocaleString()} ${units[unitIndex]}`
}

export function humanizeKey(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (token) => token.toUpperCase())
}
