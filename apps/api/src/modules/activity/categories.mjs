// Single source of truth for the firm-wide activity feed's action taxonomy.
// The per-profile timeline and raw /api/audit stream render actions verbatim;
// the activity feed is the only surface that groups actions into user-facing
// categories and renders a human summary, so that mapping lives here and
// nowhere else. Both the category filter (server-side prefix matching) and the
// summary formatter are derived from this module.
//
// Categories map to action *prefixes*. First matching category wins, so more
// specific prefixes (e.g. client.form_submission.) are ordered ahead of the
// generic ones they would otherwise collide with only where necessary.

export const ACTIVITY_CATEGORIES = Object.freeze([
  {
    id: 'profiles',
    label: 'Profiles',
    prefixes: ['profile.', 'household.', 'sensitive.']
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    prefixes: ['pipeline.']
  },
  {
    id: 'forms',
    label: 'Forms & templates',
    prefixes: [
      'form_submission.',
      'client.form_submission.',
      'template_aggregate.',
      'document_template.',
      'template.'
    ]
  },
  {
    id: 'documents',
    label: 'Documents',
    prefixes: ['document_upload.', 'client.document_upload.', 'advisor.document_upload.']
  },
  {
    // Authentication and access-control events. Visibility is restricted: only
    // admins see other users' events in this category (see the activity service).
    id: 'auth',
    label: 'Auth & access',
    prefixes: ['auth.', 'user.', 'invite.', 'firm.']
  },
  {
    id: 'system',
    label: 'System',
    prefixes: ['export.', 'export_job.', 'server.', 'runtime.', 'backup.', 'seed.', 'operational.', 'request.']
  }
])

export const AUTH_CATEGORY_ID = 'auth'

// Category id used for actions that match no known prefix. Not offered as a
// filter option; it exists so every event still renders with a stable label.
export const FALLBACK_CATEGORY = Object.freeze({ id: 'other', label: 'Other' })

const CATEGORY_LABELS = Object.freeze(
  ACTIVITY_CATEGORIES.reduce(
    (acc, category) => {
      acc[category.id] = category.label
      return acc
    },
    { [FALLBACK_CATEGORY.id]: FALLBACK_CATEGORY.label }
  )
)

export function categoryForAction(action) {
  const value = String(action || '')
  for (const category of ACTIVITY_CATEGORIES) {
    if (category.prefixes.some((prefix) => value.startsWith(prefix))) return category.id
  }
  return FALLBACK_CATEGORY.id
}

export function categoryLabel(categoryId) {
  return CATEGORY_LABELS[categoryId] || FALLBACK_CATEGORY.label
}

// Returns the LIKE-prefix list for a category id, or null when the id is not a
// known filterable category (an unknown or empty filter means "all").
export function prefixesForCategory(categoryId) {
  const category = ACTIVITY_CATEGORIES.find((entry) => entry.id === categoryId)
  return category ? category.prefixes.slice() : null
}

export function authCategoryPrefixes() {
  return prefixesForCategory(AUTH_CATEGORY_ID) || []
}

function humanizeAction(action) {
  const cleaned = String(action || 'activity')
    .replace(/[._]+/g, ' ')
    .trim()
  if (!cleaned) return 'Recorded activity'
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function fieldList(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return ''
  return ` (${fields.join(', ')})`
}

// Exact-action summary builders. `after` carries the audit change-set metadata
// (see addAudit in store.mjs). Anything not listed falls back to a humanized
// action string so new actions still read sensibly without a code change.
const SUMMARY_BUILDERS = {
  'profile.created': (after) => `Created a ${after.kind || 'profile'}`,
  'profile.updated': (after) => `Updated profile${fieldList(after.fields)}`,
  'profile.converted': () => 'Converted a prospect to a client',
  'profile.tag_added': (after) => (after.tag ? `Added tag "${after.tag}"` : 'Added a tag'),
  'profile.tag_removed': (after) => (after.tag ? `Removed tag "${after.tag}"` : 'Removed a tag'),
  'profile.note_added': () => 'Added a note',
  'pipeline.stage_changed': (after) =>
    after.toStage ? `Moved a profile to ${after.toStage}` : 'Moved a profile to a new stage',
  'pipeline.stage_config_created': (after) => `Created pipeline stage ${after.label || after.key || ''}`.trim(),
  'pipeline.stage_config_updated': () => 'Updated a pipeline stage',
  'pipeline.stage_config_deactivated': () => 'Deactivated a pipeline stage',
  'pipeline.stage_config_reordered': () => 'Reordered pipeline stages',
  'pipeline.indices_normalized': () => 'Normalized pipeline ordering',
  'household.created': (after) => (after.name ? `Created household ${after.name}` : 'Created a household'),
  'household.member_added': () => 'Added a household member',
  'household.split': () => 'Split a household',
  'household.merge': () => 'Merged households',
  'sensitive.read': () => 'Viewed sensitive profile data',
  'sensitive.read_denied': () => 'Was denied sensitive profile data',
  'sensitive.write_reencrypted': () => 'Re-encrypted sensitive data',
  'form_submission.created': () => 'Created a form submission',
  'client.form_submission.created': () => 'Submitted a client form',
  'form_submission.draft_revised': () => 'Revised a form draft',
  'form_submission.lock_acquired': () => 'Locked a form draft',
  'form_submission.lock_released': () => 'Released a form draft lock',
  'form_submission.collaborator_added': () => 'Added a draft collaborator',
  'form_submission.collaborator_removed': () => 'Removed a draft collaborator',
  'form_submission.deleted': () => 'Deleted a form submission',
  'template_aggregate.created': () => 'Created a template',
  'document_template.created': () => 'Created a document template',
  'document_template.mappings_updated': () => 'Updated template mappings',
  'document_template.pdf_layout_updated': () => 'Updated template PDF layout',
  'document_template.published': () => 'Published a document template',
  'client.document_upload.created': () => 'Uploaded a document (client portal)',
  'advisor.document_upload.created': () => 'Uploaded a document',
  'advisor.document_upload.archived': () => 'Archived a document',
  'document_upload.downloaded': () => 'Downloaded a document',
  'auth.login.succeeded': () => 'Signed in',
  'auth.login.failed': () => 'Failed a sign-in attempt',
  'auth.logout': () => 'Signed out',
  'auth.logout.succeeded': () => 'Signed out',
  'auth.mfa.enabled': () => 'Enabled multi-factor authentication',
  'auth.mfa.challenge_issued': () => 'Was issued an MFA challenge',
  'auth.mfa.challenge_verified': () => 'Passed an MFA challenge',
  'auth.mfa.challenge_failed': () => 'Failed an MFA challenge',
  'auth.password_reset.requested': () => 'Requested a password reset',
  'auth.password_reset.completed': () => 'Completed a password reset',
  'auth.federated.sync': () => 'Synced a federated identity',
  'firm.created': () => 'Created the firm',
  'invite.created': (after) => (after.email ? `Invited ${after.email}` : 'Created an invite'),
  'invite.accepted': () => 'Accepted an invite',
  'user.role_assigned': (after) => (after.role ? `Assigned role ${after.role}` : 'Assigned a role')
}

export function summarizeEvent(event = {}) {
  const action = String(event.action || '')
  const after = event.after && typeof event.after === 'object' ? event.after : {}
  const builder = SUMMARY_BUILDERS[action]
  if (builder) {
    try {
      const summary = builder(after, event)
      if (summary) return summary
    } catch {
      // Fall through to the humanized default on any malformed payload.
    }
  }
  return humanizeAction(action)
}
