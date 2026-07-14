import { createDefaultFirmStageConfig, getStageKey } from '../stage-config.mjs'

export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8
export const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 30
export const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7
export const PERMISSIONS = {
  admin: ['*'],
  advisor: [
    'dashboard:read',
    'profiles:read',
    'profiles:write',
    'pipeline:read',
    'pipeline:write',
    'households:read',
    'households:write',
    'forms:read',
    'forms:write',
    'templates:read',
    'templates:write',
    'audit:read',
    'exports:write',
    'exports:read',
    'users:read',
    'users:manage',
    'analytics:read',
    'diagnostics:read',
    'sensitive:read',
    'portal:manage'
  ],
  readonly: [
    'dashboard:read',
    'profiles:read',
    'pipeline:read',
    'households:read',
    'forms:read',
    'templates:read',
    'audit:read',
    'analytics:read',
    'users:read'
  ],
  client: ['portal:read', 'client:write'],
  anonymous: []
}
export const STAGE_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export const DEFAULT_PIPELINE_STAGES = [
  { id: 'discovery', label: 'Discovery', order: 1, active: true },
  { id: 'gather_oi', label: 'Gather OI', order: 2, active: true },
  { id: 'analysis', label: 'Analysis', order: 3, active: true },
  { id: 'advisor_proposal_meeting', label: 'Advisor Proposal Meeting', order: 4, active: true },
  { id: 'intake', label: 'Intake', order: 5, active: true },
  { id: 'on_boarding', label: 'On Boarding', order: 6, active: true },
  { id: 'investment_strategy', label: 'Investment Strategy', order: 7, active: true },
  { id: 'completed', label: 'Completed', order: 8, active: true },
  { id: 'drop_dead_lead', label: 'Drop / Dead Lead', order: 9, active: true },
  { id: 'drop_nurture', label: 'Drop / Nurture', order: 10, active: true }
]
export const DEFAULT_STAGE_DEFINITIONS = createDefaultFirmStageConfig().stages.map((stage, index) => {
  const id = getStageKey(stage)
  return {
    id,
    label: stage.label || id,
    order: Number(stage.order) || index + 1,
    isTerminal: id === 'completed',
    isDrop: id.startsWith('drop_')
  }
})
export const LEGACY_STAGE_BUCKET = 'legacy_unassigned'
// Synthetic stage_change destinations that are NOT real pipeline stages: archive
// and convert write these terminal sentinel markers into stage history (see the
// archiveProfile / convertProfile comments). They must never be counted as
// advisor "stage moves" for productivity. The funnel/aging loops already skip
// them (toAnalyticsStage buckets unknown stages into LEGACY_STAGE_BUCKET and only
// prospect rows are iterated).
export const SYNTHETIC_STAGE_CHANGE_TARGETS = new Set(['archived', 'converted'])
// Allowed meeting types; anything else is normalized to 'other'.
export const MEETING_TYPES = new Set(['intro', 'proposal', 'review', 'other'])
export const DEFAULT_ANALYTICS_STAGE_DEFINITIONS = createDefaultFirmStageConfig().stages.map((stage) => {
  const id = getStageKey(stage)
  return {
    id,
    order: Number(stage.order) || 0,
    role: id === 'discovery' ? 'start' : id === 'completed' ? 'end' : id.startsWith('drop_') ? 'dropped' : 'active'
  }
})

export const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'boolean', 'date'])

export const TEMPLATE_STATES = new Set(['draft', 'review', 'published', 'deprecated'])

// Lightweight client/prospect tags. Normalization is deliberately conservative:
// trim + collapse internal whitespace, drop empties, cap each tag's length, cap
// the count, and dedupe case-insensitively while preserving the first-seen
// casing (friendlier for display than forcing lowercase). Returns a plain array
// that round-trips in the profile canonical object (profiles.payload).
export const MAX_PROFILE_TAG_LENGTH = 40
export const MAX_PROFILE_TAGS = 20

// The only profile fields a request body may set. Everything absent from this
// set is server-owned: id/firmId/createdAt are identity, `pii` is the encrypted
// envelope (writable only through the ssn/taxId/dateOfBirth inputs, which are
// encrypted on the way in), archivedAt belongs to archive/restore,
// pipelineVersion to the board transaction, and the source_* timestamps to the
// source normalizer.
export const PROFILE_UPDATABLE_FIELDS = new Set([
  'kind',
  'firstName',
  'lastName',
  'email',
  'phone',
  'dateOfBirth',
  'status',
  'stage',
  'stageOrderIndex',
  'orderIndex',
  'householdId',
  'spouseClientId',
  'advisorUserId',
  'source',
  'sourceDisplay',
  'tags',
  'extensions',
  'financialSummary'
])
