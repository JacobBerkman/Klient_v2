import { appRoutes, routes } from './api-contract.js'

const state = {
  user: null,
  view: 'dashboard',
  flash: null,
  alert: null,
  board: null,
  clientBoard: null,
  pendingActions: {},
  exportsFilters: {
    status: '',
    profileId: '',
    fromDate: '',
    toDate: '',
    sort: 'createdAt_desc',
    selectedIds: [],
    bulkBusy: false
  },
  mfa: {
    login: null,
    enrollment: null
  },
  inlineProfileUi: {},
  profileDetailById: {},
  selectedClientId: '',
  selectedSubmissionId: '',
  templatePreviewByTemplateId: {},
  templatePublishPreflightByTemplateId: {},
  templatePreviewSelectionByTemplateId: {},
  workflowStatusMessage: '',
  operations: {
    busy: false,
    lastUpdatedAt: '',
    snapshot: null
  }
}

const viewEl = document.querySelector('#view')
const authStatusEl = document.querySelector('#auth-status')
const mfaHintEl = document.querySelector('#mfa-hint')
const mfaLoginFormEl = document.querySelector('#mfa-login-form')
const mfaEnrollStartEl = document.querySelector('#mfa-enroll-start')
const mfaEnrollDetailsEl = document.querySelector('#mfa-enroll-details')
const mfaSecretEl = document.querySelector('#mfa-secret')
const mfaOtpAuthEl = document.querySelector('#mfa-otpauth')
const mfaEnrollConfirmFormEl = document.querySelector('#mfa-enroll-confirm-form')
const profileStageEl = document.querySelector('#profile-stage-select')
const householdPrimaryEl = document.querySelector('select[name="primaryClientId"]')
const portalProfileEl = document.querySelector('select[name="profileId"]')
const profileCreateFormEl = document.querySelector('#profile-form')
const householdFormEl = document.querySelector('#household-form')
const formTemplateFormEl = document.querySelector('#form-template-form')
const docTemplateFormEl = document.querySelector('#doc-template-form')
const inviteFormEl = document.querySelector('#invite-form')
const portalFormEl = document.querySelector('#portal-form')
const registerFormEl = document.querySelector('#register-form')
const loginFormEl = document.querySelector('#login-form')

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
let csrfToken = ''
const stageConfigState = {
  fetched: false,
  stages: []
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function setFlash(type, message) {
  state.flash = { type, message }
}

function setAlert(type, message) {
  state.alert = { type, message }
}

function clearAlert() {
  state.alert = null
}

function setWorkflowStatus(message = '') {
  state.workflowStatusMessage = message
}

function focusLiveRegion(element) {
  if (!element) return
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1')
  element.focus()
}

function setAuthStatus(message, { assertive = false } = {}) {
  if (!authStatusEl) return
  authStatusEl.setAttribute('role', assertive ? 'alert' : 'status')
  authStatusEl.setAttribute('aria-live', assertive ? 'assertive' : 'polite')
  authStatusEl.textContent = message
  if (assertive) focusLiveRegion(authStatusEl)
}

function normalizeConflictMessage(error, fallbackMessage = 'Conflict detected. Reload and try again.') {
  const conflictType = error?.details?.type || error?.details?.mergePrompt?.type || ''
  const promptSuggestion = String(error?.details?.mergePrompt?.suggestion || '').trim()
  if (conflictType === 'lease_conflict') {
    return 'Your lock lease expired or moved. Reload the draft, reacquire lock, then save again.'
  }
  if (conflictType === 'revision_conflict') {
    return 'Another advisor saved first. Reload latest draft revision, merge your edits, then retry save.'
  }
  if (conflictType === 'submission_stale') {
    return 'This submission changed on the server. Reload the section, review latest values, and retry.'
  }
  if (promptSuggestion) return promptSuggestion
  const rawMessage = String(error?.message || '').toLowerCase()
  if (rawMessage.includes('conflict') || rawMessage.includes('stale') || rawMessage.includes('version')) {
    return 'Conflict detected: reload latest server data, review differences, then retry your update.'
  }
  return fallbackMessage
}

function isConflictError(error) {
  if (error?.details?.mergePrompt?.suggestion) return true
  const rawMessage = String(error?.message || '').toLowerCase()
  return rawMessage.includes('conflict') || rawMessage.includes('stale') || rawMessage.includes('version')
}

function isPermissionError(error) {
  return Number(error?.status) === 403 || Number(error?.status) === 401
}

function isNotFoundError(error) {
  return Number(error?.status) === 404
}

function normalizeApiError(error, action = 'complete this action') {
  if (isConflictError(error)) return normalizeConflictMessage(error)
  if (isPermissionError(error)) return `Permission denied: you do not have access to ${action}.`
  if (isNotFoundError(error)) return `The requested record no longer exists. Reload before trying to ${action}.`
  if (Number(error?.status) === 422 || Number(error?.status) === 400) {
    return `Validation failed while trying to ${action}. Review the input and retry.`
  }
  const raw = String(error?.message || '').trim()
  return raw || `Unable to ${action} right now.`
}

function setActionPending(actionKey, status) {
  state.pendingActions[actionKey] = status
}

function clearActionPending(actionKey) {
  delete state.pendingActions[actionKey]
}

function pendingLabel(actionKey, defaultLabel, pendingLabel = 'Saving…') {
  return state.pendingActions[actionKey] ? pendingLabel : defaultLabel
}

function setFormFeedback(form, message = '', type = 'error') {
  const feedbackEl = form?.querySelector('[data-form-feedback]')
  if (!feedbackEl) return
  feedbackEl.setAttribute('role', type === 'error' ? 'alert' : 'status')
  feedbackEl.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite')
  feedbackEl.setAttribute('aria-atomic', 'true')
  feedbackEl.textContent = message
  feedbackEl.classList.remove('error-banner', 'success-banner')
  if (message) feedbackEl.classList.add(type === 'success' ? 'success-banner' : 'error-banner')
  if (type === 'error' && message) focusLiveRegion(feedbackEl)
}

function clearFormFeedback(form) {
  setFormFeedback(form, '')
}

function setRepeaterRowBusy(control, busy) {
  const row = control?.closest('tr')
  if (!row) return
  row.querySelectorAll('input, button').forEach((element) => {
    element.disabled = busy
  })
}

function setRepeaterRowFeedback(control, message = '', type = 'error') {
  const row = control?.closest('tr')
  if (!row) return
  const feedbackEl = row.querySelector('[data-repeater-feedback]')
  if (!feedbackEl) return
  feedbackEl.setAttribute('role', type === 'error' ? 'alert' : 'status')
  feedbackEl.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite')
  feedbackEl.textContent = message
  feedbackEl.classList.remove('error-banner', 'success-banner')
  if (message) feedbackEl.classList.add(type === 'success' ? 'success-banner' : 'error-banner')
}

function repeaterActionErrorMessage(error, { actionLabel = 'update', itemKey = '', sectionKey = '' } = {}) {
  if (isConflictError(error)) {
    return normalizeConflictMessage(error, `Could not ${actionLabel} item ${itemKey}. Reload and retry.`)
  }
  const lowered = String(error?.message || '').toLowerCase()
  if (lowered.includes('not found')) {
    return `Item ${itemKey} is stale or missing in section ${sectionKey}. Reload to sync latest data.`
  }
  return `Could not ${actionLabel} item ${itemKey}: ${error?.message || 'Request failed'}`
}

function withTrimmedFormData(form) {
  return Object.fromEntries(
    Array.from(new FormData(form).entries()).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
  )
}

function validateRequiredFields(form, requiredKeys = []) {
  const payload = withTrimmedFormData(form)
  requiredKeys.forEach((key) => {
    const field = form?.elements?.namedItem?.(key)
    if (field?.setAttribute) field.setAttribute('aria-invalid', 'false')
  })
  const missingLabel = requiredKeys.find((key) => !payload[key])
  if (missingLabel) {
    const missingField = form?.elements?.namedItem?.(missingLabel)
    if (missingField?.setAttribute) missingField.setAttribute('aria-invalid', 'true')
    if (missingField?.focus) missingField.focus()
    throw new Error(`${missingLabel} is required.`)
  }
  return payload
}

function reportActionSuccess(action, message) {
  clearAlert()
  setFlash('success', `${action}: ${message}`)
}

function reportActionError(action, error) {
  const reason = error?.message || 'Request failed'
  const details = error?.details?.issues
  const detailText =
    Array.isArray(details) && details.length
      ? ` (${details.map((issue) => `${issue.path}: ${issue.message}`).join(' | ')})`
      : ''
  setFlash('error', `${action}: ${reason}${detailText}`)
}

function prettifyStageId(stageId) {
  return String(stageId || '')
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function normalizeStageDefinition(stage, index = 0) {
  if (!stage || typeof stage !== 'object') return null
  const id = stage.id || stage.stage || stage.key || stage.slug || null
  if (!id) return null
  const order = Number(stage.order ?? stage.position ?? stage.sortOrder ?? index + 1)
  return {
    id,
    label: stage.label || stage.name || prettifyStageId(id),
    order: Number.isFinite(order) ? order : index + 1,
    active: stage.active !== false && stage.enabled !== false
  }
}

function normalizeStageDefinitions(stages = []) {
  return stages
    .map((stage, index) => normalizeStageDefinition(stage, index))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
}

function stageDefinitionsFromBoard(board) {
  const metadataStages = board?.stageDefinitions || board?.metadata?.stageDefinitions || []
  const normalizedMetadata = normalizeStageDefinitions(metadataStages)
  if (normalizedMetadata.length) return normalizedMetadata
  return (board?.columns || [])
    .map((column, index) => normalizeStageDefinition({ id: column.stage, order: index + 1 }))
    .filter(Boolean)
}

function getStageDefinitions({ includeInactive = true } = {}) {
  const stages = stageConfigState.stages || []
  return includeInactive ? stages : stages.filter((stage) => stage.active)
}

function ensureStageDefinition(stageId) {
  const definitions = getStageDefinitions({ includeInactive: true })
  return (
    definitions.find((stage) => stage.id === stageId) || { id: stageId, label: prettifyStageId(stageId), active: true }
  )
}

function stageLabel(stageId) {
  if (!stageId) return 'Unassigned'
  return ensureStageDefinition(stageId).label
}

function hydrateStageConfig(stages = [], { overwrite = false } = {}) {
  const normalized = normalizeStageDefinitions(stages)
  if (!normalized.length) return false
  if (!overwrite && stageConfigState.stages.length) return false
  stageConfigState.stages = normalized
  stageConfigState.fetched = true
  return true
}

function stageSelectOptionsMarkup(selectedStage = '', { includeInactiveSelected = true } = {}) {
  const activeStages = getStageDefinitions({ includeInactive: false })
  const selected = selectedStage || 'discovery'
  const options = [...activeStages]
  if (includeInactiveSelected && selected && !options.some((stage) => stage.id === selected)) {
    const derived = ensureStageDefinition(selected)
    options.push({ ...derived, active: false })
  }
  return options
    .sort((a, b) => a.order - b.order)
    .map((stage) => {
      const inactiveSuffix = stage.active ? '' : ' (Inactive)'
      return `<option value="${stage.id}" ${stage.id === selected ? 'selected' : ''}>${escapeHtml(stage.label + inactiveSuffix)}</option>`
    })
    .join('')
}

function renderProfileStageSelect(defaultStage = '') {
  if (!profileStageEl) return
  const options = stageSelectOptionsMarkup(defaultStage || 'discovery', { includeInactiveSelected: false })
  profileStageEl.innerHTML = options || '<option value="">No active stages available</option>'
  if (!profileStageEl.value && profileStageEl.options.length) profileStageEl.value = profileStageEl.options[0].value
}

async function fetchStageDefinitions() {
  const candidates = [routes.stageConfig(), routes.pipelineStages()]
  for (const path of candidates) {
    try {
      const payload = await request(path)
      const definitions = normalizeStageDefinitions(
        payload?.stages || payload?.stageDefinitions || payload?.data?.stages || payload?.data?.stageDefinitions || []
      )
      if (definitions.length) return definitions
    } catch {
      // try next endpoint
    }
  }
  return []
}

async function ensureStageConfig(force = false) {
  if (!force && stageConfigState.fetched && stageConfigState.stages.length) return stageConfigState.stages
  const endpointDefinitions = await fetchStageDefinitions()
  if (hydrateStageConfig(endpointDefinitions, { overwrite: true })) {
    renderProfileStageSelect()
    return stageConfigState.stages
  }
  stageConfigState.fetched = true
  return stageConfigState.stages
}

function findBoardColumn(board, stage) {
  return board?.columns?.find((column) => column.stage === stage) || null
}

function editableProfileFieldsFromCard(card = {}) {
  return {
    firstName: card.firstName || '',
    lastName: card.lastName || '',
    email: card.email || '',
    phone: card.phone || ''
  }
}

function boardKeyForKind(kind) {
  return kind === 'prospect' ? 'board' : 'clientBoard'
}

function ensureInlineProfileState(kind, profileId, card = null) {
  if (!state.inlineProfileUi[kind]) state.inlineProfileUi[kind] = {}
  if (!state.inlineProfileUi[kind][profileId]) {
    const fields = editableProfileFieldsFromCard(card || {})
    state.inlineProfileUi[kind][profileId] = {
      draft: { ...fields },
      latest: { ...fields },
      expectedUpdatedAt: card?.updatedAt || '',
      dirty: false,
      saving: false,
      conflictMessage: '',
      isEditing: false
    }
  }
  const entry = state.inlineProfileUi[kind][profileId]
  if (card) {
    const latest = editableProfileFieldsFromCard(card)
    entry.latest = { ...latest }
    entry.expectedUpdatedAt = card.updatedAt || ''
    if (!entry.dirty && !entry.saving) {
      entry.draft = { ...latest }
    }
  }
  return entry
}

function updateInlineDirtyState(kind, profileId) {
  const entry = ensureInlineProfileState(kind, profileId)
  entry.dirty = Object.keys(entry.latest).some((key) => (entry.draft[key] || '') !== (entry.latest[key] || ''))
  return entry
}

function setInlineDraftField(kind, profileId, field, value) {
  const entry = ensureInlineProfileState(kind, profileId)
  entry.draft[field] = typeof value === 'string' ? value : ''
  entry.conflictMessage = ''
  updateInlineDirtyState(kind, profileId)
}

function beginInlineSave(kind, profileId) {
  const entry = ensureInlineProfileState(kind, profileId)
  entry.saving = true
  entry.conflictMessage = ''
}

function completeInlineSave(kind, profileId, card = null) {
  const entry = ensureInlineProfileState(kind, profileId, card)
  if (card) {
    const fields = editableProfileFieldsFromCard(card)
    entry.latest = { ...fields }
    entry.draft = { ...fields }
    entry.expectedUpdatedAt = card.updatedAt || ''
  }
  entry.dirty = false
  entry.saving = false
  entry.conflictMessage = ''
  entry.isEditing = false
}

function failInlineSave(kind, profileId, conflictMessage = '') {
  const entry = ensureInlineProfileState(kind, profileId)
  entry.saving = false
  entry.conflictMessage = conflictMessage || 'Unable to save right now. Retry after reloading latest profile data.'
}

function cancelInlineDraft(kind, profileId, card = null) {
  const entry = ensureInlineProfileState(kind, profileId, card)
  entry.draft = { ...entry.latest }
  entry.dirty = false
  entry.saving = false
  entry.conflictMessage = ''
  entry.isEditing = false
}

function inlineStatusMarkup(entry) {
  const badges = []
  if (entry.conflictMessage) {
    badges.push('<span class="badge subtle inline-status-badge inline-status-conflict">Conflict</span>')
  } else if (entry.saving) {
    badges.push('<span class="badge subtle inline-status-badge inline-status-saving">Saving…</span>')
  } else if (entry.dirty) {
    badges.push('<span class="badge subtle inline-status-badge inline-status-dirty">Unsaved</span>')
  }
  const message = entry.conflictMessage
    ? escapeHtml(entry.conflictMessage)
    : entry.saving
      ? 'Saving profile changes…'
      : entry.dirty
        ? 'Unsaved changes.'
        : 'Synced'
  return `
    <div class="inline-status-row" aria-live="polite">
      ${badges.join('')}
      <span class="muted inline-status-text" role="${entry.conflictMessage ? 'alert' : 'status'}" aria-live="${
        entry.conflictMessage ? 'assertive' : 'polite'
      }">${message}</span>
    </div>
  `
}

function buildBoardFromProfiles(profiles = []) {
  const stageDefinitions = getStageDefinitions({ includeInactive: false })
  const stageIds = stageDefinitions.map((stage) => stage.id)
  const fallbackStage = stageIds[0] || 'discovery'
  return {
    boardVersion: null,
    stageDefinitions,
    columns: stageIds.map((stage) => ({
      stage,
      cards: profiles
        .filter((profile) => (profile.stage || fallbackStage) === stage)
        .sort((a, b) => (a.stageOrderIndex || a.orderIndex || 999) - (b.stageOrderIndex || b.orderIndex || 999))
    }))
  }
}

function updateCardInBoard(board, profileId, patch) {
  if (!board?.columns) return board
  const nextBoard = structuredClone(board)
  for (const column of nextBoard.columns) {
    const card = column.cards.find((entry) => entry.id === profileId)
    if (card) {
      Object.assign(card, patch)
      break
    }
  }
  return nextBoard
}

function applyOptimisticReorder(board, move) {
  if (!board?.columns?.length) return board
  const nextBoard = structuredClone(board)
  const fromColumn = nextBoard.columns.find((column) => column.cards.some((card) => card.id === move.profileId))
  const toColumn = findBoardColumn(nextBoard, move.toStage)
  if (!fromColumn || !toColumn) return board
  const sourceIndex = fromColumn.cards.findIndex((card) => card.id === move.profileId)
  if (sourceIndex < 0) return board

  const [card] = fromColumn.cards.splice(sourceIndex, 1)
  card.stage = move.toStage
  let targetIndex = toColumn.cards.length
  if (move.beforeProfileId) {
    const beforeIndex = toColumn.cards.findIndex((entry) => entry.id === move.beforeProfileId)
    targetIndex = beforeIndex >= 0 ? beforeIndex : toColumn.cards.length
  }
  toColumn.cards.splice(targetIndex, 0, card)

  for (const column of nextBoard.columns) {
    column.cards.forEach((entry, index) => {
      entry.orderIndex = index + 1
      entry.stageOrderIndex = index + 1
    })
  }
  return nextBoard
}

async function reorderPipelineOptimistically(move) {
  const previousBoard = state.board ? structuredClone(state.board) : null
  if (previousBoard) {
    state.board = applyOptimisticReorder(previousBoard, move)
  }
  try {
    const payload = {
      ...move,
      expectedBoardVersion: previousBoard?.boardVersion ?? null
    }
    const result = await request(routes.pipelineReorder(), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    state.board = result.board
    return result
  } catch (error) {
    const conflictBoard = error?.details?.serverBoard || null
    state.board = conflictBoard || previousBoard
    throw error
  }
}

function flashMarkup() {
  if (!state.flash) return ''
  const cls = state.flash.type === 'error' ? 'error-banner' : 'success-banner'
  return `<div class="item compact ${cls}">${escapeHtml(state.flash.message)}</div>`
}

function alertMarkup() {
  if (!state.alert) return ''
  const cls = state.alert.type === 'error' ? 'error-banner' : 'success-banner'
  return `<div class="item compact ${cls}">${escapeHtml(state.alert.message)}</div>`
}

function emptyStateMarkup(message = 'Nothing to show yet. Adjust filters or create a new record to get started.') {
  return `<p class="muted empty-state" role="status">${escapeHtml(message)}</p>`
}

function viewErrorBanner(viewName, error) {
  const detail = error?.message ? ` ${error.message}` : ''
  return `<div class="item compact error-banner" role="alert">We couldn’t load ${escapeHtml(viewName)}.${escapeHtml(detail)}</div>`
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  if (MUTATING_METHODS.has(method) && path.startsWith('/api/') && !csrfToken) {
    const boot = await fetch(routes.csrf(), { credentials: 'same-origin' })
    const data = await boot.json()
    if (!boot.ok) throw new Error(data.message || 'CSRF bootstrap failed')
    csrfToken = data.csrfToken
  }

  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(MUTATING_METHODS.has(method) && path.startsWith('/api/') ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    }
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || 'Request failed')
    error.details = data?.error?.details || null
    error.status = response.status
    error.code = data?.error?.code || data?.code || ''
    throw error
  }
  return data
}

async function requestText(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.headers || {})
    }
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || 'Request failed')
  return text
}

async function hydrateRuntime() {
  try {
    const runtimeConfig = await request(routes.runtime())
    state.enableDemoMode = Boolean(runtimeConfig.enableDemoMode)
  } catch {
    state.enableDemoMode = false
  }
  document.querySelector('#demo-login').hidden = !state.enableDemoMode
  document.querySelector('#demo-credentials').hidden = !state.enableDemoMode
}

function updateMfaUi() {
  const hasLoginChallenge = Boolean(state.mfa.login)
  const hasEnrollment = Boolean(state.mfa.enrollment)
  mfaLoginFormEl.hidden = !hasLoginChallenge
  mfaEnrollStartEl.hidden = !state.user || hasLoginChallenge || hasEnrollment
  mfaEnrollDetailsEl.hidden = !hasEnrollment

  if (hasLoginChallenge) {
    mfaHintEl.textContent = 'Enter an authenticator code or backup code to complete sign-in.'
  } else if (hasEnrollment) {
    mfaHintEl.textContent = 'Confirm enrollment with a fresh authenticator code.'
    mfaSecretEl.textContent = state.mfa.enrollment.secret
    mfaOtpAuthEl.textContent = state.mfa.enrollment.otpauthUrl
  } else if (state.user) {
    mfaHintEl.textContent = 'You are signed in. You can enroll MFA for this account.'
    mfaSecretEl.textContent = ''
    mfaOtpAuthEl.textContent = ''
  } else {
    mfaHintEl.textContent = 'Sign in to enroll MFA, or complete an MFA challenge during login.'
    mfaSecretEl.textContent = ''
    mfaOtpAuthEl.textContent = ''
  }
}

function setPendingMfaLogin(result, credentials) {
  state.mfa.login = {
    email: credentials.email,
    password: credentials.password,
    challengeToken: result.challengeToken
  }
  setFlash('success', 'MFA required. Complete the challenge below to finish signing in.')
  updateMfaUi()
}

function clearMfaState() {
  state.mfa.login = null
  state.mfa.enrollment = null
  updateMfaUi()
}

function roleAllowed(buttonRoleCsv = '') {
  if (!buttonRoleCsv) return true
  if (!state.user?.role) return false
  return buttonRoleCsv.split(',').includes(state.user.role)
}

function canMutateProfiles() {
  return roleAllowed('admin,advisor')
}

function canMutateSection(sectionEl) {
  return roleAllowed(sectionEl?.dataset.requiresRole || '')
}

function updateRoleVisibility() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.hidden = !roleAllowed(button.dataset.roles || '')
  })
  document.querySelectorAll('[data-requires-role]').forEach((section) => {
    const roles = section.dataset.requiresRole || ''
    const allowed = roleAllowed(roles)
    section.hidden = !allowed
    section.querySelectorAll('button, input, select, textarea').forEach((field) => {
      field.disabled = !allowed
    })
  })
}

function updateViewNavState() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const selected = button.dataset.view === state.view
    button.setAttribute('aria-current', selected ? 'page' : 'false')
  })
}

async function refreshSelects() {
  if (!state.user || state.user.role === 'client') return
  await ensureStageConfig()
  const clients = await request(routes.profiles({ kind: 'client' }))
  const profiles = await request(routes.profiles())
  householdPrimaryEl.innerHTML = clients
    .map(
      (profile) =>
        `<option value="${profile.id}">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`
    )
    .join('')
  portalProfileEl.innerHTML = profiles
    .map(
      (profile) =>
        `<option value="${profile.id}">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`
    )
    .join('')
  renderProfileStageSelect()
}

function metricCard(label, value) {
  return `<div class="stat"><strong>${escapeHtml(value)}</strong><div class="muted">${escapeHtml(label)}</div></div>`
}

function normalizeOpsSignal(payload, preferredKeys = []) {
  if (payload == null) return null
  if (typeof payload === 'boolean') return payload
  if (typeof payload === 'string') {
    const lowered = payload.trim().toLowerCase()
    if (!lowered) return null
    if (['ok', 'pass', 'ready', 'healthy', 'up', 'true'].includes(lowered)) return true
    if (['fail', 'failed', 'error', 'down', 'false', 'unhealthy'].includes(lowered)) return false
    return null
  }
  if (typeof payload !== 'object') return null

  for (const key of preferredKeys) {
    if (key in payload) return normalizeOpsSignal(payload[key], preferredKeys)
  }
  const fallbackKeys = ['ok', 'ready', 'healthy', 'status', 'state']
  for (const key of fallbackKeys) {
    if (key in payload) return normalizeOpsSignal(payload[key], preferredKeys)
  }
  return null
}

function flattenHealthChecks(payload) {
  if (!payload || typeof payload !== 'object') return []
  const checks = payload.checks || payload.results || payload.components || null
  if (!checks || typeof checks !== 'object') return []
  return Object.entries(checks).map(([name, value]) => ({ name, signal: normalizeOpsSignal(value) }))
}

function deriveOpsCardStatus(key, endpoint) {
  if (!endpoint || endpoint.ok === false) return { level: 'FAIL', note: 'Endpoint request failed.' }
  const payload = endpoint.payload
  const explicitSignal = normalizeOpsSignal(
    payload,
    key === 'health' ? ['healthy', 'ok', 'status'] : key === 'ready' ? ['ready', 'ok', 'status'] : []
  )

  if (key === 'health' || key === 'ready') {
    const checks = flattenHealthChecks(payload)
    const hasChecks = checks.length > 0
    const failedChecks = checks.filter((entry) => entry.signal === false)
    const unknownChecks = checks.filter((entry) => entry.signal == null)
    if (explicitSignal === false || failedChecks.length > 0) {
      return { level: 'FAIL', note: `${failedChecks.length || 1} failing check(s).` }
    }
    if (!hasChecks || unknownChecks.length > 0 || explicitSignal == null) {
      return { level: 'WARN', note: hasChecks ? 'Some checks are missing/ambiguous.' : 'Checks unavailable in payload.' }
    }
    return { level: 'PASS', note: 'All checks healthy/ready.' }
  }

  const degraded = Boolean(payload && typeof payload === 'object' && (payload.degraded || payload.warn))
  if (explicitSignal === false) return { level: 'FAIL', note: 'Diagnostic signal reports failure.' }
  if (degraded || explicitSignal == null) return { level: 'WARN', note: degraded ? 'Degraded mode signaled.' : 'No explicit pass signal.' }
  return { level: 'PASS', note: 'Endpoint returned healthy response.' }
}

async function fetchOpsEndpoint(path) {
  const response = await fetch(path, { credentials: 'same-origin' })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text || null
  }
  if (!response.ok) {
    const error = new Error((payload && payload.message) || response.statusText || 'Request failed')
    error.status = response.status
    throw error
  }
  return payload
}

async function loadOperationsSnapshot() {
  state.operations.busy = true
  try {
    const results = await Promise.allSettled([
      fetchOpsEndpoint('/health'),
      fetchOpsEndpoint('/ready'),
      fetchOpsEndpoint(routes.exportsQueueHealth()),
      fetchOpsEndpoint('/api/ops/diagnostics')
    ])
    state.operations.snapshot = {
      health:
        results[0].status === 'fulfilled'
          ? { ok: true, payload: results[0].value }
          : { ok: false, error: results[0].reason?.message || 'Failed to load /health.' },
      ready:
        results[1].status === 'fulfilled'
          ? { ok: true, payload: results[1].value }
          : { ok: false, error: results[1].reason?.message || 'Failed to load /ready.' },
      queue:
        results[2].status === 'fulfilled'
          ? { ok: true, payload: results[2].value }
          : { ok: false, error: results[2].reason?.message || 'Failed to load exports queue diagnostics.' },
      diagnostics:
        results[3].status === 'fulfilled'
          ? { ok: true, payload: results[3].value }
          : { ok: false, error: results[3].reason?.message || 'Failed to load diagnostics.' }
    }
    state.operations.lastUpdatedAt = new Date().toISOString()
  } finally {
    state.operations.busy = false
  }
}

function setWorkflowContext({ clientId = '', submissionId = '' } = {}) {
  if (clientId) state.selectedClientId = clientId
  if (submissionId) state.selectedSubmissionId = submissionId
}

function byLatestTimestampDesc(a = {}, b = {}) {
  const aTime = Date.parse(a.updatedAt || a.createdAt || 0) || 0
  const bTime = Date.parse(b.updatedAt || b.createdAt || 0) || 0
  return bTime - aTime
}

function buildClientWorkflowMap(drafts = [], submissions = []) {
  const workflowByClientId = new Map()
  const ensureEntry = (clientId) => {
    if (!workflowByClientId.has(clientId)) {
      workflowByClientId.set(clientId, {
        latestSubmissionId: '',
        latestDraftId: '',
        submissionCount: 0,
        draftCount: 0
      })
    }
    return workflowByClientId.get(clientId)
  }

  const draftsByClient = new Map()
  drafts.forEach((draft) => {
    if (!draft?.clientId) return
    const rows = draftsByClient.get(draft.clientId) || []
    rows.push(draft)
    draftsByClient.set(draft.clientId, rows)
  })
  draftsByClient.forEach((rows, clientId) => {
    const sorted = rows.slice().sort(byLatestTimestampDesc)
    const entry = ensureEntry(clientId)
    entry.latestDraftId = sorted[0]?.id || ''
    entry.draftCount = rows.length
  })

  const submissionsByClient = new Map()
  submissions.forEach((submission) => {
    if (!submission?.clientId) return
    const rows = submissionsByClient.get(submission.clientId) || []
    rows.push(submission)
    submissionsByClient.set(submission.clientId, rows)
  })
  submissionsByClient.forEach((rows, clientId) => {
    const sorted = rows.slice().sort(byLatestTimestampDesc)
    const entry = ensureEntry(clientId)
    entry.latestSubmissionId = sorted[0]?.id || ''
    entry.submissionCount = rows.length
  })
  return workflowByClientId
}

async function renderDashboard() {
  try {
    const data = await request(routes.dashboard())
    const stats = Object.entries(data?.stats || {})
    viewEl.innerHTML = `
      ${flashMarkup()}
      <div class="section-header"><h2>Dashboard</h2></div>
      <div class="stat-grid">
        ${stats.map(([key, value]) => metricCard(key, value)).join('') || emptyStateMarkup('No dashboard metrics are available yet.')}
      </div>
      <div class="item compact muted">Recent activity and profile management remain available in their dedicated tabs.</div>
    `
  } catch (error) {
    viewEl.innerHTML = `${flashMarkup()}${viewErrorBanner('dashboard', error)}${emptyStateMarkup()}`
  }
}

function analyticsPanel(title, body) {
  return `<section class="item"><h3>${escapeHtml(title)}</h3>${body}</section>`
}

async function renderAnalytics() {
  const filters = new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-12-31', cohortBy: 'all' })
  const analyticsQuery = Object.fromEntries(filters.entries())
  const analytics = await request(routes.analytics(analyticsQuery))
  const dashboard = await request(routes.analyticsDashboard(analyticsQuery))
  const summary = analytics.summary || {}
  const stageMetadata = summary.stageMetadata || dashboard.stageMetadata || []
  const stageLabelById = new Map(stageMetadata.map((entry) => [entry.id, entry.label]))
  const funnelRows = (summary.funnel || [])
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.stageLabel || stageLabelById.get(entry.stageId || entry.stage) || entry.stageId || entry.stage)}</td><td>${escapeHtml(entry.stageId || entry.stage)}</td><td>${entry.count}</td><td>${Math.round((entry.conversionRate || 0) * 100)}%</td></tr>`
    )
    .join('')
  const agingRows = (summary.stageAgingOrdered || dashboard.stageAgingOrdered || [])
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.stageLabel || stageLabelById.get(entry.stageId || entry.stage) || entry.stageId || entry.stage)}</td><td>${escapeHtml(entry.stageId || entry.stage)}</td><td>${entry.count || 0}</td><td>${entry.avgDays || 0}</td></tr>`
    )
    .join('')
  const completionRows = (summary.formCompletionRates || [])
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.templateId)}</td><td>${item.drafts}</td><td>${item.submitted}</td><td>${Math.round((item.completionRate || 0) * 100)}%</td></tr>`
    )
    .join('')
  const productivityRows = (summary.advisorProductivity || [])
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.advisorName)}</td><td>${item.profilesManaged}</td><td>${item.notesAuthored}</td><td>${item.stageMoves}</td><td>${item.productivityScore}</td></tr>`
    )
    .join('')
  const mat = analytics.materialized
  const bottleneckRows = (dashboard.bottlenecks || [])
    .map((entry) => `<tr><td>${escapeHtml(entry.stageLabel || stageLabelById.get(entry.stageId || entry.stage) || entry.stageId || entry.stage)}</td><td>${escapeHtml(entry.stageId || entry.stage)}</td><td>${entry.count}</td><td>${entry.avgDays}</td></tr>`)
    .join('')
  const latencyRows = (dashboard.formCompletionLatency || [])
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.templateId)}</td><td>${entry.submissions}</td><td>${entry.avgHours}</td></tr>`
    )
    .join('')
  const exportRows = (dashboard.exportUsage?.byAdvisor || [])
    .map((entry) => `<tr><td>${escapeHtml(entry.advisorName)}</td><td>${entry.total}</td></tr>`)
    .join('')

  viewEl.innerHTML = `
    ${flashMarkup()}
    <div class="section-header"><div><h2>Analytics</h2><p class="muted">Advisor-facing panels powered by live and materialized summaries.</p></div></div>
    <div class="stat-grid compact-stats">
      ${metricCard('profiles', summary.profileCount || 0)}
      ${metricCard('households', summary.householdCount || 0)}
      ${metricCard('overall conversion', `${Math.round((summary.overallConversionRate || 0) * 100)}%`)}
      ${metricCard('avg stage age (days)', summary.avgProspectStageAgeDays || 0)}
    </div>
    ${analyticsPanel('Funnel Conversion', `<table><thead><tr><th>Stage</th><th>Stage ID</th><th>Count</th><th>Conversion</th></tr></thead><tbody>${funnelRows || '<tr><td colspan="4">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Stage Aging', `<table><thead><tr><th>Stage</th><th>Stage ID</th><th>Prospects</th><th>Avg days</th></tr></thead><tbody>${agingRows || '<tr><td colspan="4">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Form Completion Rates', `<table><thead><tr><th>Template</th><th>Drafts</th><th>Submitted</th><th>Completion</th></tr></thead><tbody>${completionRows || '<tr><td colspan="4">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Form Completion Latency', `<table><thead><tr><th>Template</th><th>Submissions</th><th>Avg hours</th></tr></thead><tbody>${latencyRows || '<tr><td colspan="3">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Advisor Productivity', `<table><thead><tr><th>Advisor</th><th>Managed</th><th>Notes</th><th>Stage moves</th><th>Score</th></tr></thead><tbody>${productivityRows || '<tr><td colspan="5">No advisor events yet</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Stage Bottlenecks', `<table><thead><tr><th>Stage</th><th>Stage ID</th><th>Prospects</th><th>Avg days</th></tr></thead><tbody>${bottleneckRows || '<tr><td colspan="4">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Export Usage', `<table><thead><tr><th>Advisor</th><th>Exports</th></tr></thead><tbody>${exportRows || '<tr><td colspan="2">No exports yet</td></tr>'}</tbody></table><button id="download-analytics-csv">Download CSV</button>`)}
    ${analyticsPanel('Materialized Summary Health', `<div class="muted">${mat ? `Refreshed ${new Date(mat.updatedAt).toLocaleString()} for firm ${escapeHtml(mat.firmId)}` : 'Materialized summary unavailable.'}</div>`)}
  `
  document.querySelector('#download-analytics-csv')?.addEventListener('click', async () => {
    try {
      const csvText = await requestText(routes.analyticsExport(analyticsQuery))
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'analytics-report.csv'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setFlash('error', `Failed to export analytics CSV: ${error.message}`)
      await renderAnalytics()
    }
  })
}

async function renderForms() {
  let templates = []
  let drafts = []
  try {
    ;[templates, drafts] = await Promise.all([request(routes.formTemplates()), request(routes.formDrafts())])
  } catch (error) {
    viewEl.innerHTML = `${flashMarkup()}${alertMarkup()}${viewErrorBanner('forms', error)}${emptyStateMarkup()}`
    return
  }
  let selectedProfile = null
  let selectedSubmission = null
  let selectedSubmissionError = ''
  if (state.selectedClientId && state.selectedSubmissionId) {
    try {
      const detail = await request(routes.profileDetail(state.selectedClientId))
      selectedProfile = detail?.profile || null
      selectedSubmission = (detail?.submissions || []).find((entry) => entry.id === state.selectedSubmissionId) || null
      if (!selectedSubmission) selectedSubmissionError = 'Submission not found in selected profile.'
    } catch (error) {
      selectedSubmissionError = error.message || 'Failed to load profile submission context.'
    }
  }

  const repeaterSections = Object.entries(selectedSubmission?.data || {}).filter(([, value]) => Array.isArray(value))
  const rows = drafts
    .map(
      (draft) => `
    <tr>
      <td>${escapeHtml(draft.id)}</td>
      <td>${escapeHtml(draft.templateId)}</td>
      <td>${draft.revisionId || 1}</td>
      <td>${draft.lock ? `Locked (${escapeHtml(draft.lock.holderUserId)})` : 'Unlocked'}</td>
      <td>
        <a href="#${appRoutes.clientFormSubmission(draft.clientId, draft.id)}">Edit from profile</a>
        <button data-lock="${draft.id}">${pendingLabel(`lock-${draft.id}`, 'Acquire lock', 'Acquiring…')}</button>
        <button data-save="${draft.id}">${pendingLabel(`draft-save-${draft.id}`, 'Save revision', 'Saving…')}</button>
      </td>
    </tr>
  `
    )
    .join('')

  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    <p class="muted compact" role="status" aria-live="polite">${escapeHtml(state.workflowStatusMessage || '')}</p>
    <h2>Forms + Collaboration</h2>
    <p class="muted">Draft editing now uses revision IDs, short leases, and conflict-aware save prompts.</p>
    <div class="muted compact workflow-context">Context: client <code>${escapeHtml(state.selectedClientId || 'n/a')}</code> · submission <code>${escapeHtml(state.selectedSubmissionId || 'n/a')}</code></div>
    <div class="stat-grid compact-stats">
      ${metricCard('templates', templates.length)}
      ${metricCard('drafts', drafts.length)}
    </div>
    <table><thead><tr><th>Draft ID</th><th>Template</th><th>Revision</th><th>Lock</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No drafts yet. Create or import a form draft to begin collaboration.</td></tr>'}</tbody></table>
    ${
      state.selectedSubmissionId
        ? `
      <section class="item">
        <h3>Profile-driven Submission Editor</h3>
        <p class="muted">
          Profile: <strong>${escapeHtml(selectedProfile?.firstName || '')} ${escapeHtml(selectedProfile?.lastName || '')}</strong>
          · Submission: <code>${escapeHtml(state.selectedSubmissionId)}</code>
        </p>
        ${
          selectedSubmissionError
            ? `<p class="error-banner">${escapeHtml(selectedSubmissionError)}</p>`
            : !selectedSubmission
              ? '<p class="muted">No submission selected.</p>'
              : repeaterSections.length
                ? repeaterSections
                    .map(([sectionKey, items]) => {
                      const sectionActionKey = `repeater-${selectedSubmission.id}-${sectionKey}`
                      return `
                  <div class="item compact">
                    <h4>${escapeHtml(sectionKey)} <span class="badge subtle">${items.length} item(s)</span></h4>
                    ${
                      items.length
                        ? `<table>
                          <thead><tr><th>Item</th><th>Fields</th><th>Actions</th></tr></thead>
                          <tbody>
                            ${items
                              .map((item, index) => {
                                const identity = String(item?.id || item?.key || index)
                                const editableEntries = Object.entries(item || {}).filter(([key]) => key !== 'id' && key !== 'key')
                                return `<tr>
                                  <td><code>${escapeHtml(identity)}</code></td>
                                  <td>
                                    <form data-repeater-update="${sectionActionKey}" data-submission-id="${escapeHtml(selectedSubmission.id)}" data-section-key="${escapeHtml(sectionKey)}" data-item-key="${escapeHtml(identity)}">
                                      <div class="grid two">
                                        ${editableEntries
                                          .map(([key, value]) => {
                                            const isNumber = typeof value === 'number'
                                            return `<label>${escapeHtml(key)}
                                              <input name="field:${escapeHtml(key)}" value="${escapeHtml(value ?? '')}" data-item-field data-value-type="${isNumber ? 'number' : 'text'}" ${isNumber ? 'type="number"' : ''} />
                                            </label>`
                                          })
                                          .join('')}
                                      </div>
                                      <button type="submit" class="tiny">${pendingLabel(`${sectionActionKey}-update-${identity}`, 'Update item', 'Updating…')}</button>
                                    </form>
                                  </td>
                                  <td>
                                    <button class="tiny secondary" data-repeater-delete="${sectionActionKey}" data-submission-id="${escapeHtml(selectedSubmission.id)}" data-section-key="${escapeHtml(sectionKey)}" data-item-key="${escapeHtml(identity)}">${pendingLabel(`${sectionActionKey}-delete-${identity}`, 'Delete item', 'Deleting…')}</button>
                                    <p class="compact muted" data-repeater-feedback></p>
                                  </td>
                                </tr>`
                              })
                              .join('')}
                          </tbody>
                        </table>`
                        : '<p class="muted">No items in this section.</p>'
                    }
                  </div>
                `
                    })
                    .join('')
                : '<p class="muted">Selected submission has no repeatable sections.</p>'
        }
      </section>
    `
        : ''
    }
  `

  document.querySelectorAll('[data-lock]').forEach((button) => {
    button.addEventListener('click', async () => {
      const actionKey = `lock-${button.dataset.lock}`
      setActionPending(actionKey, 'pending')
      await renderForms()
      try {
        const result = await request(routes.formDraftLock(button.dataset.lock), {
          method: 'POST',
          body: JSON.stringify({ leaseMs: 30000 })
        })
        setWorkflowStatus(`Lock acquired for draft ${button.dataset.lock}.`)
        reportActionSuccess('Forms', `Lock acquired. Lease ${result.lock.leaseId.slice(0, 8)}…`)
      } catch (error) {
        setWorkflowStatus(normalizeApiError(error, 'acquire a draft lock'))
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      await renderForms()
    })
  })

  document.querySelectorAll('[data-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const draftId = button.dataset.save
      const draft = drafts.find((item) => item.id === draftId)
      const actionKey = `draft-save-${draftId}`
      setActionPending(actionKey, 'pending')
      setAlert('success', `Saving draft ${draftId} optimistically…`)
      await renderForms()
      try {
        const response = await request(routes.formDraft(draftId), {
          method: 'PATCH',
          body: JSON.stringify({
            leaseId: draft?.lock?.leaseId,
            expectedRevisionId: draft?.revisionId || 1,
            data: { ...(draft?.data || {}), uiSavedAt: new Date().toISOString() }
          })
        })
        clearAlert()
        setWorkflowStatus(`Draft ${draftId} saved at revision ${response.submission.revisionId}.`)
        reportActionSuccess('Forms', `Draft saved at revision ${response.submission.revisionId}.`)
      } catch (error) {
        const normalizedMessage = normalizeApiError(error, 'save this draft')
        setAlert('error', normalizedMessage)
        setWorkflowStatus(normalizedMessage)
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      await renderForms()
    })
  })

  document.querySelectorAll('form[data-repeater-update]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const submissionId = form.dataset.submissionId
      const sectionKey = form.dataset.sectionKey
      const itemKey = form.dataset.itemKey
      const expectedUpdatedAt = selectedSubmission?.updatedAt || ''
      const patch = {}
      form.querySelectorAll('[data-item-field]').forEach((input) => {
        const fieldName = String(input.name || '').replace(/^field:/, '')
        if (!fieldName) return
        const valueType = input.dataset.valueType || 'text'
        const rawValue = input.value
        patch[fieldName] = valueType === 'number' && rawValue !== '' ? Number(rawValue) : rawValue
      })
      const actionKey = `${form.dataset.repeaterUpdate}-update-${itemKey}`
      setActionPending(actionKey, 'pending')
      setRepeaterRowBusy(form, true)
      setRepeaterRowFeedback(form, '')
      try {
        await request(routes.submissionSectionItem(submissionId, sectionKey, itemKey), {
          method: 'PATCH',
          body: JSON.stringify({ ...patch, expectedUpdatedAt })
        })
        setRepeaterRowFeedback(form, `Item ${itemKey} updated.`, 'success')
        reportActionSuccess('Forms', `Updated repeater item ${itemKey}.`)
        await renderForms()
      } catch (error) {
        const message = repeaterActionErrorMessage(error, { actionLabel: 'update', itemKey, sectionKey })
        setRepeaterRowFeedback(form, message)
        setWorkflowStatus(message)
        reportActionError('Forms', error)
        setAlert('error', message)
      } finally {
        setRepeaterRowBusy(form, false)
        clearActionPending(actionKey)
      }
    })
  })

  document.querySelectorAll('[data-repeater-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const submissionId = button.dataset.submissionId
      const sectionKey = button.dataset.sectionKey
      const itemKey = button.dataset.itemKey
      const expectedUpdatedAt = selectedSubmission?.updatedAt || ''
      const actionKey = `${button.dataset.repeaterDelete}-delete-${itemKey}`
      setActionPending(actionKey, 'pending')
      setRepeaterRowBusy(button, true)
      setRepeaterRowFeedback(button, '')
      try {
        const deletePath = `${routes.submissionSectionItem(submissionId, sectionKey, itemKey)}?${new URLSearchParams({
          expectedUpdatedAt
        }).toString()}`
        await request(deletePath, { method: 'DELETE' })
        setRepeaterRowFeedback(button, `Item ${itemKey} deleted.`, 'success')
        reportActionSuccess('Forms', `Deleted repeater item ${itemKey}.`)
        await renderForms()
      } catch (error) {
        const message = repeaterActionErrorMessage(error, { actionLabel: 'delete', itemKey, sectionKey })
        setRepeaterRowFeedback(button, message)
        setWorkflowStatus(message)
        reportActionError('Forms', error)
        setAlert('error', message)
      } finally {
        setRepeaterRowBusy(button, false)
        clearActionPending(actionKey)
      }
    })
  })
}

function knownProfileSourcePaths() {
  return new Map([
    ['profile.firstName', 'text'],
    ['profile.lastName', 'text'],
    ['profile.email', 'text'],
    ['profile.phone', 'text'],
    ['profile.kind', 'text'],
    ['profile.stage', 'text'],
    ['profile.source.sourceCity', 'text'],
    ['profile.source.sourceVenue', 'text'],
    ['profile.source.sourceDate', 'date']
  ])
}

function collectTemplateSchemaPaths(fields = [], parentPath = '', output = new Map()) {
  fields.forEach((field) => {
    const segment = String(field?.path || field?.key || '').trim()
    if (!segment) return
    const fullPath = parentPath ? `${parentPath}.${segment}` : segment
    output.set(fullPath, String(field?.type || 'text'))
    if (String(field?.type || '') === 'repeater') {
      collectTemplateSchemaPaths(field.fields || [], fullPath, output)
    }
  })
  return output
}

function mappingLocalIssues(mapping, knownPaths) {
  const issues = []
  const pdfField = String(mapping.pdfField || '').trim()
  const sourcePath = String(mapping.sourcePath || '').trim()
  const targetType = String(mapping.targetType || '').trim()
  const transformType = String(mapping.transformType || '').trim()
  const transformExpression = String(mapping.transformExpression || '').trim()
  if (!pdfField) issues.push('Missing PDF field')
  if (!sourcePath) issues.push('Missing source path')
  if (sourcePath && !knownPaths.has(sourcePath)) issues.push('Unknown source path')
  const sourceType = sourcePath ? knownPaths.get(sourcePath) : ''
  if (sourceType && targetType && sourceType !== targetType) issues.push(`Type mismatch (${sourceType} → ${targetType})`)
  if (transformType === 'expression' && !transformExpression) issues.push('Missing transform expression')
  return issues
}

function formatSchemaIssue(issue = {}) {
  const path = String(issue.field || issue.path || 'mapping')
  const message = String(issue.message || issue.code || 'Validation issue')
  const rowIndex = Number(issue.rowIndex)
  const rowPrefix = Number.isFinite(rowIndex) ? `Row ${rowIndex + 1}: ` : ''
  return `${rowPrefix}${path} — ${message}`
}

function mappingSaveStateLabel(saveState = {}) {
  if (saveState.status === 'saving') return 'Saving…'
  if (saveState.status === 'error') return `Error (${saveState.message || 'retry'})`
  if (saveState.status === 'recovered') return 'Recovered'
  return 'Saved'
}

function previewWarningMarkup(warnings = []) {
  if (!Array.isArray(warnings) || !warnings.length) return '<span class="muted">None</span>'
  return warnings
    .map((warning) => {
      const title = escapeHtml(warning.message || warning.code || 'Warning')
      return `<span class="badge" title="${title}">${escapeHtml(warning.code || 'warning')}</span>`
    })
    .join(' ')
}

async function renderTemplates() {
  let templates = []
  let clients = []
  let submissions = []
  try {
    ;[templates, clients, submissions] = await Promise.all([
      request(routes.documentTemplates()),
      request(routes.profiles({ kind: 'client' })),
      request(routes.formSubmissions())
    ])
  } catch (error) {
    viewEl.innerHTML = `${flashMarkup()}${alertMarkup()}${viewErrorBanner('templates', error)}${emptyStateMarkup()}`
    return
  }
  if (!state.selectedTemplateId && templates[0]?.id) state.selectedTemplateId = templates[0].id
  const template = templates.find((entry) => entry.id === state.selectedTemplateId) || templates[0] || null
  const [versions, transitions] = template
    ? await Promise.all([
        request(routes.documentTemplateVersions(template.id)),
        request(routes.documentTemplatePublishTransitions(template.id))
      ])
    : [[], []]

  if (!state.templateMappingDrafts) state.templateMappingDrafts = {}
  if (!state.templateInspector) state.templateInspector = {}
  if (!state.templateSaveStateByTemplateId) state.templateSaveStateByTemplateId = {}
  if (!state.templateAutosaveTimers) state.templateAutosaveTimers = {}

  const mappingDraftFromServer = (mapping = {}) => ({
    pdfField: String(mapping.pdfField || ''),
    fieldLabel: String(mapping.fieldLabel || mapping.label || ''),
    sourcePath: String(mapping.sourcePath || ''),
    defaultValue: mapping.defaultValue == null ? '' : String(mapping.defaultValue),
    targetType: String(mapping.targetType || 'text'),
    required: mapping.required === true,
    enabled: mapping.enabled !== false,
    transformType: String(mapping?.transform?.type || ''),
    transformExpression: String(mapping?.transform?.expression || ''),
    transformCurrency: String(mapping?.transform?.currency || '')
  })
  const normalizeMappingDraft = (draft = {}) => {
    const sourcePath = String(draft.sourcePath || '').trim()
    const transformType = String(draft.transformType || '').trim()
    const transform = transformType
      ? {
          type: transformType,
          ...(String(draft.transformExpression || '').trim() ? { expression: String(draft.transformExpression).trim() } : {}),
          ...(String(draft.transformCurrency || '').trim() ? { currency: String(draft.transformCurrency).trim() } : {})
        }
      : null
    const mapping = {
      pdfField: String(draft.pdfField || '').trim(),
      fieldLabel: String(draft.fieldLabel || '').trim(),
      sourcePath,
      targetType: String(draft.targetType || '').trim() || 'text',
      required: draft.required === true,
      enabled: draft.enabled !== false,
      defaultValue: String(draft.defaultValue || '')
    }
    if (transform) mapping.transform = transform
    return mapping
  }

  const serverMappings = (template?.mappings || []).map((mapping) => mappingDraftFromServer(mapping))
  const existingDraft = state.templateMappingDrafts[template?.id] || []
  const draftMappings =
    existingDraft.length === serverMappings.length && existingDraft.length > 0
      ? existingDraft
      : serverMappings
  if (template) state.templateMappingDrafts[template.id] = draftMappings

  const versionOptions = (versions || [])
    .map((entry) => `<option value="${entry.version}">${entry.version} · ${escapeHtml(entry.changeType || 'update')}</option>`)
    .join('')
  const latestVersion = versions?.[0]?.version || ''

  const knownPaths = knownProfileSourcePaths()
  ;(template?.formSchema?.sections || []).forEach((section) => collectTemplateSchemaPaths(section.fields || [], '', knownPaths))

  const mappingIssuesByIndex = new Map(draftMappings.map((mapping, index) => [index, mappingLocalIssues(mapping, knownPaths)]))
  const preview = template ? state.templatePreviewByTemplateId[template.id] : null
  const preflight = template ? state.templatePublishPreflightByTemplateId[template.id] : null
  const preflightIssues = Array.isArray(preflight?.issues) ? preflight.issues : []
  const preflightIssueRows = new Set(preflightIssues.map((issue) => Number(issue.rowIndex)).filter((value) => Number.isFinite(value)))
  const previewWarningRows = new Set(
    (preview?.rows || [])
      .filter((row) => Array.isArray(row.warnings) && row.warnings.length)
      .map((row) => Number(row.rowIndex))
      .filter((value) => Number.isFinite(value))
  )
  const previewIssueRows = new Set((preview?.issues || []).map((issue) => Number(issue.rowIndex)).filter((value) => Number.isFinite(value)))
  const hasLocalMappingErrors = [...mappingIssuesByIndex.values()].some((issues) => issues.length > 0)
  const hasBlockingPreviewWarnings =
    Number(preview?.blockingWarningsCount || 0) > 0 || (preview?.issues || []).some((issue) => issue.blocking)
  const publishDisabled = hasLocalMappingErrors || hasBlockingPreviewWarnings || preflightIssues.length > 0

  const selectedRowIndex = Number.isInteger(state.templateInspector?.[template?.id]?.rowIndex)
    ? state.templateInspector[template.id].rowIndex
    : 0
  const safeSelectedRowIndex = Math.min(Math.max(selectedRowIndex, 0), Math.max(0, draftMappings.length - 1))
  if (template) state.templateInspector[template.id] = { rowIndex: safeSelectedRowIndex }
  const selectedMapping = draftMappings[safeSelectedRowIndex] || mappingDraftFromServer({})

  const mappedFieldSet = new Set(draftMappings.map((entry) => String(entry.pdfField || '').trim()).filter(Boolean))
  const extractedFields = template?.extractedFields || []
  const mappedExtractedCount = extractedFields.filter((field) => mappedFieldSet.has(field)).length
  const saveState = state.templateSaveStateByTemplateId[template?.id] || { status: 'idle', message: '' }

  const sampleProfile = clients[0] || {}
  const sampleSubmission = submissions[0] || {}
  const resolveSampleValue = (path) => {
    const value = String(path || '').trim()
    if (!value) return ''
    const pick = (obj, raw) =>
      raw
        .split('.')
        .filter(Boolean)
        .reduce((current, segment) => (current == null ? undefined : current[segment]), obj)
    if (value.startsWith('profile.')) return pick(sampleProfile, value.replace(/^profile\./, ''))
    if (value.startsWith('submission.') || value.startsWith('form.')) {
      return pick(sampleSubmission?.data || {}, value.replace(/^(submission|form)\./, ''))
    }
    return pick(sampleSubmission?.data || {}, value) ?? pick(sampleProfile || {}, value)
  }

  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    <div class="section-header"><h2>Template Builder</h2></div>
    <label>Template
      <select id="template-select">${templates
        .map((entry) => `<option value="${entry.id}" ${entry.id === template?.id ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`)
        .join('')}</select>
    </label>
    ${
      template
        ? `
      <section class="item">
        <h3>Mapping Health</h3>
        <div class="row wrap gap-sm">
          <span class="badge">Mapped ${draftMappings.filter((entry) => entry.enabled !== false && String(entry.pdfField || '').trim()).length}</span>
          <span class="badge subtle">Unmapped ${Math.max(0, extractedFields.length - mappedExtractedCount)}</span>
          <span class="badge ${hasLocalMappingErrors ? 'error-badge' : 'warning-badge'}">Validation ${hasLocalMappingErrors ? 'Needs fixes' : 'Ready'}</span>
          <span class="badge subtle">Save state: ${escapeHtml(mappingSaveStateLabel(saveState))}</span>
        </div>
      </section>
      <section class="item">
        <h3>Extracted AcroForm Fields</h3>
        <ul>${extractedFields
          .map((field, index) => {
            const mapped = mappedFieldSet.has(field)
            return `<li>${escapeHtml(field)} <span class="badge ${mapped ? 'subtle' : ''}">${mapped ? 'Mapped' : 'Unmapped'}</span><button data-remove-extracted="${index}" class="secondary tiny">Remove</button></li>`
          })
          .join('') || '<li class="muted">No extracted fields yet.</li>'}</ul>
        <div class="row gap-sm">
          <input id="new-extracted-field" placeholder="pdf_field_name" />
          <button id="add-extracted-field" class="tiny">Add</button>
        </div>
      </section>
      <section class="item">
        <h3>Source Path Discovery</h3>
        <div class="muted">Known paths from profile + form schema: ${[...knownPaths.keys()]
          .map((path) => `<code>${escapeHtml(path)}</code>`)
          .join(', ')}</div>
      </section>
      <section class="item">
        <h3>Mappings</h3>
        <div class="row gap-sm wrap"><button id="add-mapping-row" class="tiny">Add Mapping</button><button id="save-mappings" class="tiny">Save Now</button></div>
        <table><thead><tr><th>#</th><th>PDF Field</th><th>Source Path</th><th>Label</th><th>Local validation</th><th>Server preflight</th><th>Preview</th><th>Sample</th></tr></thead><tbody>
          ${draftMappings
            .map((mapping, index) => {
              const issues = mappingIssuesByIndex.get(index) || []
              const hasPreviewWarnings = previewWarningRows.has(index) || previewIssueRows.has(index)
              const serverPreflightIssues = preflightIssues.filter((issue) => Number(issue.rowIndex) === index)
              const sampleValue = resolveSampleValue(mapping.sourcePath)
              return `<tr id="mapping-row-${index}" data-select-row="${index}" style="cursor:pointer;${index === safeSelectedRowIndex ? 'outline:1px solid #60a5fa;' : ''}">
                <td>${index + 1}</td>
                <td>${escapeHtml(mapping.pdfField || '')}</td>
                <td>${escapeHtml(mapping.sourcePath || '')}</td>
                <td>${escapeHtml(mapping.fieldLabel || '')}</td>
                <td>${issues.length ? `<span class="error-badge">${escapeHtml(issues.join('; '))}</span>` : '<span class="muted">OK</span>'}</td>
                <td>${serverPreflightIssues.length ? `<span class="error-badge">${escapeHtml(serverPreflightIssues.map((issue) => issue.code || issue.message || 'issue').join(', '))}</span>` : '<span class="muted">None</span>'}</td>
                <td>${hasPreviewWarnings ? '<span class="warning-badge">Preview warning</span>' : '<span class="muted">OK</span>'}</td>
                <td>${escapeHtml(sampleValue == null ? '' : String(sampleValue))}</td>
              </tr>`
            })
            .join('') || '<tr><td colspan="8" class="muted">No mappings configured.</td></tr>'}
        </tbody></table>
      </section>
      <section class="item">
        <h3>Field Inspector</h3>
        <div class="muted">Selected row ${safeSelectedRowIndex + 1} of ${Math.max(1, draftMappings.length)}${selectedMapping.enabled === false ? ' (disabled)' : ''}</div>
        <datalist id="source-path-options">${[...knownPaths.keys()].map((path) => `<option value="${escapeHtml(path)}"></option>`).join('')}</datalist>
        <div class="grid two">
          <label>PDF Field<input id="inspector-pdfField" value="${escapeHtml(selectedMapping.pdfField || '')}" /></label>
          <label>Field Label/Name<input id="inspector-fieldLabel" value="${escapeHtml(selectedMapping.fieldLabel || '')}" /></label>
          <label>Source Path<input id="inspector-sourcePath" list="source-path-options" value="${escapeHtml(selectedMapping.sourcePath || '')}" /></label>
          <label>Default Value<input id="inspector-defaultValue" value="${escapeHtml(selectedMapping.defaultValue || '')}" /></label>
          <label>Target Type<select id="inspector-targetType">${['text', 'number', 'boolean', 'date']
            .map((type) => `<option value="${type}" ${selectedMapping.targetType === type ? 'selected' : ''}>${type}</option>`)
            .join('')}</select></label>
          <label>Transform Type<select id="inspector-transformType">${['', 'date', 'phone', 'currency', 'checkbox', 'expression']
            .map((type) => `<option value="${type}" ${selectedMapping.transformType === type ? 'selected' : ''}>${type || 'none'}</option>`)
            .join('')}</select></label>
          <label>Transform Expression<input id="inspector-transformExpression" value="${escapeHtml(selectedMapping.transformExpression || '')}" /></label>
          <label>Transform Currency<input id="inspector-transformCurrency" value="${escapeHtml(selectedMapping.transformCurrency || '')}" placeholder="USD" /></label>
          <label><input type="checkbox" id="inspector-required" ${selectedMapping.required ? 'checked' : ''} /> Required</label>
          <label><input type="checkbox" id="inspector-enabled" ${selectedMapping.enabled !== false ? 'checked' : ''} /> Mapping Enabled</label>
        </div>
      </section>
      <section class="item">
        <h3>Mapping Preview</h3>
        <div class="row gap-sm wrap">
          <select id="preview-client">${clients
            .map(
              (profile) =>
                `<option value="${profile.id}" ${profile.id === state.selectedClientId ? 'selected' : ''}>${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`
            )
            .join('')}</select>
          <select id="preview-submission">${submissions
            .map(
              (entry) =>
                `<option value="${entry.id}" ${entry.id === state.selectedSubmissionId ? 'selected' : ''}>${escapeHtml(entry.id)} · ${escapeHtml(entry.templateId)}</option>`
            )
            .join('')}</select>
          <button id="run-preview" class="tiny">Run Preview</button>
        </div>
        <div id="preview-results" class="muted">${
          preview
            ? `
          <div class="muted">mappingVersionHash: <code>${escapeHtml(preview.mappingVersionHash || '')}</code></div>
          <div class="muted">warnings: ${escapeHtml(String(preview.warningsCount || 0))}</div>
          ${preview.issues?.length ? `<div class="muted">issues: ${escapeHtml(String(preview.issues.length))}</div>` : ''}
          <table><thead><tr><th>PDF field</th><th>Source path</th><th>Resolved value</th><th>Warnings</th></tr></thead><tbody>
            ${(preview.rows || [])
              .map(
                (row) => `<tr>
              <td>${escapeHtml(row.pdfField || '')}</td>
              <td>${escapeHtml(row.sourcePath || '')}</td>
              <td>${escapeHtml(row.value == null ? '' : String(row.value))}</td>
              <td><button class="tiny secondary" data-jump-rowindex="${Number(row.rowIndex)}">Row ${Number(row.rowIndex) + 1}</button> ${previewWarningMarkup(row.warnings || [])}</td>
            </tr>`
              )
              .join('')}
          </tbody></table>
        `
            : 'Run preview to validate mapping output against real data. Sample values shown in the mapping table are non-blocking hints.'
        }</div>
      </section>
      <section class="item">
        <h3>Publish</h3>
        <div class="row gap-sm wrap">
          <button id="run-publish-preflight" class="tiny secondary">Run Publish Preflight</button>
          <button id="publish-template" class="tiny publish-action" ${publishDisabled ? 'disabled' : ''}>Publish</button>
        </div>
        ${hasLocalMappingErrors ? '<p class="publish-disabled-reason">Publish is blocked until local mapping errors are resolved.</p>' : ''}
        ${hasBlockingPreviewWarnings ? '<p class="publish-disabled-reason">Publish is blocked by preview validation issues. Resolve highlighted rows first.</p>' : ''}
        ${
          preflightIssues.length
            ? `<p class="publish-disabled-reason">Publish preflight found ${preflightIssues.length} schema validation issue(s) across ${preflightIssueRows.size || 0} mapped row(s).</p><ul>${preflightIssues
                .map((issue) => `<li><code>${escapeHtml(issue?.meta?.issueId || issue.code || 'issue')}</code> · ${escapeHtml(formatSchemaIssue(issue))}</li>`)
                .join('')}</ul>`
            : '<p class="muted">Run preflight to surface publish-time schema validation (unknown source paths, required mappings, and transform issues) before attempting publish.</p>'
        }
      </section>
      <section class="item">
        <h3>Version History</h3>
        <table><thead><tr><th>Version</th><th>Type</th><th>Created</th></tr></thead><tbody>
          ${(versions || [])
            .map(
              (entry) => `<tr><td>${entry.version}</td><td>${escapeHtml(entry.changeType || 'update')}</td><td>${escapeHtml(new Date(entry.createdAt || Date.now()).toLocaleString())}</td></tr>`
            )
            .join('') || '<tr><td colspan="3">No versions yet.</td></tr>'}
        </tbody></table>
      </section>
      <section class="item">
        <h3>Compare Versions</h3>
        <div class="row gap-sm wrap">
          <select id="compare-base">${versionOptions}</select>
          <select id="compare-target">${versionOptions}</select>
          <button id="compare-template-versions" class="tiny">Compare</button>
        </div>
        <div id="compare-results" class="muted">Select two versions to compare field + mapping changes.</div>
      </section>
      <section class="item">
        <h3>Revert Version</h3>
        <div class="row gap-sm wrap">
          <select id="revert-version">${versionOptions}</select>
          <button id="revert-template-version" class="tiny secondary">Revert to selected version</button>
        </div>
      </section>
      <section class="item">
        <h3>Publish Transition Log</h3>
        <table><thead><tr><th>From</th><th>To</th><th>When</th><th>By</th></tr></thead><tbody>
          ${(transitions || [])
            .map(
              (entry) => `<tr><td>${entry.fromVersion ?? 'N/A'}</td><td>${entry.toVersion ?? 'N/A'}</td><td>${escapeHtml(new Date(entry.createdAt || Date.now()).toLocaleString())}</td><td>${escapeHtml(entry.createdByUserId || 'system')}</td></tr>`
            )
            .join('') || '<tr><td colspan="4">No publish transitions yet.</td></tr>'}
        </tbody></table>
      </section>`
        : emptyStateMarkup('No document templates found yet. Create one to configure mappings and publish versions.')
    }
  `

  const persistMappings = async ({ autosave = false } = {}) => {
    const actionKey = `template-map-save-${template.id}`
    const previousSaveStatus = state.templateSaveStateByTemplateId[template.id]?.status || 'idle'
    if (autosave) setActionPending(actionKey, 'saving')
    state.templateSaveStateByTemplateId[template.id] = { status: 'saving' }
    const mappings = (state.templateMappingDrafts[template.id] || []).map((mapping) => normalizeMappingDraft(mapping))
    try {
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings, requiredPdfFields: template.extractedFields || [] })
      })
      state.templateSaveStateByTemplateId[template.id] =
        previousSaveStatus === 'error'
          ? { status: 'recovered', savedAt: new Date().toISOString() }
          : { status: 'saved', savedAt: new Date().toISOString() }
      state.templateMappingDrafts[template.id] = mappings.map((mapping) => mappingDraftFromServer(mapping))
      if (!autosave) setFlash('success', 'Mappings saved.')
    } catch (error) {
      state.templateSaveStateByTemplateId[template.id] = { status: 'error', message: error.message }
      if (!autosave) setFlash('error', error.message)
      throw error
    } finally {
      clearActionPending(actionKey)
    }
  }

  document.querySelector('#template-select')?.addEventListener('change', async (event) => {
    state.selectedTemplateId = event.target.value
    await renderTemplates()
  })
  document.querySelectorAll('[data-remove-extracted]').forEach((button) => {
    button.addEventListener('click', async () => {
      const next = [...(template.extractedFields || [])]
      next.splice(Number(button.dataset.removeExtracted), 1)
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings: (state.templateMappingDrafts[template.id] || []).map((entry) => normalizeMappingDraft(entry)), requiredPdfFields: next })
      })
      setFlash('success', 'Extracted field removed.')
      await renderTemplates()
    })
  })
  document.querySelector('#add-extracted-field')?.addEventListener('click', async () => {
    const input = document.querySelector('#new-extracted-field')
    const value = String(input?.value || '').trim()
    if (!value) return
    const next = Array.from(new Set([...(template.extractedFields || []), value]))
    await request(routes.documentTemplateMappings(template.id), {
      method: 'POST',
      body: JSON.stringify({ mappings: (state.templateMappingDrafts[template.id] || []).map((entry) => normalizeMappingDraft(entry)), requiredPdfFields: next })
    })
    setFlash('success', 'Extracted field added.')
    await renderTemplates()
  })

  document.querySelectorAll('[data-select-row]').forEach((row) => {
    row.addEventListener('click', async () => {
      if (!template) return
      state.templateInspector[template.id] = { rowIndex: Number(row.dataset.selectRow) }
      await renderTemplates()
    })
  })

  const applyInspectorToDraft = async () => {
    const idx = state.templateInspector[template.id]?.rowIndex || 0
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    nextDraft[idx] = {
      ...(nextDraft[idx] || mappingDraftFromServer({})),
      pdfField: String(document.querySelector('#inspector-pdfField')?.value || ''),
      fieldLabel: String(document.querySelector('#inspector-fieldLabel')?.value || ''),
      sourcePath: String(document.querySelector('#inspector-sourcePath')?.value || ''),
      defaultValue: String(document.querySelector('#inspector-defaultValue')?.value || ''),
      targetType: String(document.querySelector('#inspector-targetType')?.value || 'text'),
      transformType: String(document.querySelector('#inspector-transformType')?.value || ''),
      transformExpression: String(document.querySelector('#inspector-transformExpression')?.value || ''),
      transformCurrency: String(document.querySelector('#inspector-transformCurrency')?.value || ''),
      required: Boolean(document.querySelector('#inspector-required')?.checked),
      enabled: Boolean(document.querySelector('#inspector-enabled')?.checked)
    }
    state.templateMappingDrafts[template.id] = nextDraft
    if (state.templateAutosaveTimers[template.id]) clearTimeout(state.templateAutosaveTimers[template.id])
    state.templateAutosaveTimers[template.id] = setTimeout(async () => {
      try {
        await persistMappings({ autosave: true })
      } catch {
        // handled via save state
      }
      await renderTemplates()
    }, 700)
  }

  ;[
    '#inspector-pdfField',
    '#inspector-fieldLabel',
    '#inspector-sourcePath',
    '#inspector-defaultValue',
    '#inspector-targetType',
    '#inspector-transformType',
    '#inspector-transformExpression',
    '#inspector-transformCurrency',
    '#inspector-required',
    '#inspector-enabled'
  ].forEach((selector) => {
    document.querySelector(selector)?.addEventListener('input', applyInspectorToDraft)
    document.querySelector(selector)?.addEventListener('change', applyInspectorToDraft)
  })

  document.querySelector('#add-mapping-row')?.addEventListener('click', async () => {
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    nextDraft.push(mappingDraftFromServer({ targetType: 'text', enabled: true }))
    state.templateMappingDrafts[template.id] = nextDraft
    state.templateInspector[template.id] = { rowIndex: nextDraft.length - 1 }
    await renderTemplates()
  })

  document.querySelector('#save-mappings')?.addEventListener('click', async () => {
    await persistMappings({ autosave: false })
    await renderTemplates()
  })

  document.querySelector('#preview-client')?.addEventListener('change', (event) => {
    setWorkflowContext({ clientId: event.target.value })
  })
  document.querySelector('#preview-submission')?.addEventListener('change', (event) => {
    setWorkflowContext({ submissionId: event.target.value })
  })

  document.querySelector('#run-preview')?.addEventListener('click', async () => {
    try {
      const clientId = document.querySelector('#preview-client')?.value
      const submissionId = document.querySelector('#preview-submission')?.value
      setWorkflowContext({ clientId, submissionId })
      const nextPreview = await request(routes.documentTemplateMappingsPreview(template.id), {
        method: 'POST',
        body: JSON.stringify({ clientId, submissionId })
      })
      state.templatePreviewByTemplateId[template.id] = nextPreview
      await renderTemplates()
    } catch (error) {
      setFlash('error', error.message)
      await renderTemplates()
    }
  })

  document.querySelector('#run-publish-preflight')?.addEventListener('click', async () => {
    try {
      const clientId = document.querySelector('#preview-client')?.value
      const submissionId = document.querySelector('#preview-submission')?.value
      const nextPreview = await request(routes.documentTemplateMappingsPreview(template.id), {
        method: 'POST',
        body: JSON.stringify({ clientId, submissionId })
      })
      state.templatePreviewByTemplateId[template.id] = nextPreview
      state.templatePublishPreflightByTemplateId[template.id] = {
        checkedAt: new Date().toISOString(),
        issues: nextPreview.issues || [],
        warningsCount: nextPreview.warningsCount || 0,
        blockingWarningsCount: nextPreview.blockingWarningsCount || 0
      }
      if ((nextPreview.issues || []).length) {
        setFlash('error', `Publish preflight found ${(nextPreview.issues || []).length} schema issue(s).`)
      } else {
        setFlash('success', 'Publish preflight passed with no schema validation issues.')
      }
    } catch (error) {
      state.templatePublishPreflightByTemplateId[template.id] = { issues: error?.details?.issues || [] }
      reportActionError('Template publish preflight', error)
    }
    await renderTemplates()
  })

  document.querySelectorAll('[data-jump-rowindex]').forEach((button) => {
    button.addEventListener('click', () => {
      const rowIndex = Number(button.dataset.jumpRowindex)
      const target = document.querySelector(`#mapping-row-${rowIndex}`)
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.style.outline = '2px solid #f59e0b'
      setTimeout(() => {
        target.style.outline = ''
      }, 1500)
    })
  })

  document.querySelector('#publish-template')?.addEventListener('click', async () => {
    try {
      const clientId = document.querySelector('#preview-client')?.value
      const submissionId = document.querySelector('#preview-submission')?.value
      const preflightPreview = await request(routes.documentTemplateMappingsPreview(template.id), {
        method: 'POST',
        body: JSON.stringify({ clientId, submissionId })
      })
      state.templatePreviewByTemplateId[template.id] = preflightPreview
      state.templatePublishPreflightByTemplateId[template.id] = {
        checkedAt: new Date().toISOString(),
        issues: preflightPreview.issues || [],
        warningsCount: preflightPreview.warningsCount || 0,
        blockingWarningsCount: preflightPreview.blockingWarningsCount || 0
      }
      const hasBlockingWarnings =
        Number(preflightPreview?.blockingWarningsCount || 0) > 0 || (preflightPreview?.issues || []).some((issue) => issue.blocking)
      if (hasBlockingWarnings) throw new Error('Publish blocked: preview contains blocking warnings/issues.')
      await request(routes.documentTemplatePublish(template.id), {
        method: 'POST',
        body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Publish template mapping updates.', enforceKnownSourcePaths: true })
      })
      state.templatePublishPreflightByTemplateId[template.id] = { checkedAt: new Date().toISOString(), issues: [] }
      reportActionSuccess('Templates', 'Template published.')
    } catch (error) {
      if (Array.isArray(error?.details?.issues)) {
        state.templatePublishPreflightByTemplateId[template.id] = {
          checkedAt: new Date().toISOString(),
          issues: error.details.issues
        }
      }
      reportActionError('Templates', error)
    }
    await renderTemplates()
  })

  document.querySelector('#compare-base')?.addEventListener('change', (event) => {
    if (!document.querySelector('#compare-target')?.value) {
      document.querySelector('#compare-target').value = event.target.value
    }
  })
  const compareTargetEl = document.querySelector('#compare-target')
  if (compareTargetEl && latestVersion) compareTargetEl.value = latestVersion

  document.querySelector('#compare-template-versions')?.addEventListener('click', async () => {
    try {
      const baseVersion = Number(document.querySelector('#compare-base')?.value)
      const targetVersion = Number(document.querySelector('#compare-target')?.value)
      if (!Number.isFinite(baseVersion) || !Number.isFinite(targetVersion)) throw new Error('Select two valid versions to compare.')
      if (baseVersion === targetVersion) throw new Error('Choose different versions to compare changes.')
      const diff = await request(routes.documentTemplateCompare(template.id, { baseVersion, targetVersion }))
      document.querySelector('#compare-results').innerHTML = `<pre>${escapeHtml(JSON.stringify(diff, null, 2))}</pre>`
      reportActionSuccess('Templates', `Compared versions ${baseVersion} and ${targetVersion}.`)
    } catch (error) {
      reportActionError('Templates', error)
      await renderTemplates()
    }
  })

  document.querySelector('#revert-template-version')?.addEventListener('click', async () => {
    try {
      const targetVersion = Number(document.querySelector('#revert-version')?.value)
      if (!Number.isFinite(targetVersion)) throw new Error('Select a valid version to revert to.')
      const latestVersionNumber = Number(versions?.[0]?.version)
      if (Number.isFinite(latestVersionNumber)) {
        const previewDiff = await request(
          routes.documentTemplateCompare(template.id, { baseVersion: targetVersion, targetVersion: latestVersionNumber })
        )
        if (!previewDiff.changed) {
          reportActionSuccess('Templates', `Version ${targetVersion} already matches current state; no revert needed.`)
          await renderTemplates()
          return
        }
      }
      await request(routes.documentTemplateRevert(template.id), {
        method: 'POST',
        body: JSON.stringify({ targetVersion, changelog: `UI revert to version ${targetVersion}` })
      })
      reportActionSuccess('Templates', `Reverted template to version ${targetVersion}.`)
    } catch (error) {
      reportActionError('Templates', error)
    }
    await renderTemplates()
  })
}

function boardCardMarkup(card, kind) {
  const canEdit = canMutateProfiles()
  const inlineState = ensureInlineProfileState(kind, card.id, card)
  const displayName = `${card.firstName || ''} ${card.lastName || ''}`.trim() || card.id
  const cardStage = card.stage || getStageDefinitions({ includeInactive: false })[0]?.id || 'discovery'
  const workflow = card.workflowSummary || {}
  const workflowActionsMarkup =
    kind === 'client'
      ? `
      <div class="workflow-shortcuts" data-workflow-card="${card.id}">
        <button type="button" class="secondary tiny workflow-shortcut" data-open-profile-detail="${card.id}" aria-expanded="false" aria-controls="profile-detail-${card.id}">Profile detail</button>
        ${
          workflow.latestSubmissionId
            ? `<a class="secondary tiny workflow-shortcut-link" href="#${appRoutes.clientFormSubmission(card.id, workflow.latestSubmissionId)}" data-workflow-client="${card.id}" data-workflow-submission="${workflow.latestSubmissionId}">Edit submission</a>`
            : `<button type="button" class="secondary tiny workflow-shortcut" disabled>No submission</button>`
        }
        ${
          workflow.latestDraftId
            ? `<a class="secondary tiny workflow-shortcut-link" href="#${appRoutes.clientFormSubmission(card.id, workflow.latestDraftId)}" data-workflow-client="${card.id}" data-workflow-submission="${workflow.latestDraftId}">Edit draft</a>`
            : `<button type="button" class="secondary tiny workflow-shortcut" disabled>No draft</button>`
        }
        <button type="button" class="secondary tiny workflow-shortcut" data-open-doc-actions="${card.id}" data-workflow-submission="${workflow.latestSubmissionId || workflow.latestDraftId || ''}">Document actions</button>
      </div>
      <div class="muted compact-meta">Forms: ${workflow.submissionCount || 0} submissions · ${workflow.draftCount || 0} drafts</div>
      <div id="profile-detail-${card.id}" class="hidden card-detail muted compact-meta top-gap" data-profile-detail="${card.id}" role="status" aria-live="polite"></div>
    `
      : ''
  return `
    <article class="board-card" draggable="true" data-card-id="${card.id}" data-stage="${cardStage}">
      <header class="row between wrap">
        <strong>${escapeHtml(displayName)}</strong>
        <button type="button" class="secondary tiny" data-edit-profile="${card.id}" aria-expanded="false" aria-controls="profile-edit-${card.id}" ${canEdit ? '' : 'disabled'}>Edit</button>
      </header>
      ${inlineStatusMarkup(inlineState)}
      <div class="muted compact-meta">${escapeHtml(card.email || 'No email')} · ${escapeHtml(card.phone || 'No phone')}</div>
      <div class="muted compact-meta">Stage: ${escapeHtml(stageLabel(cardStage))}</div>
      ${workflowActionsMarkup}
      <div class="row gap-sm wrap top-gap">
        <label class="sr-only" for="stage-${card.id}">Move ${escapeHtml(displayName)} to stage</label>
        <select id="stage-${card.id}" data-stage-select="${card.id}">
          ${stageSelectOptionsMarkup(cardStage)}
        </select>
      </div>
      <form id="profile-edit-${card.id}" class="inline-edit hidden top-gap" data-edit-form="${card.id}" data-updated-at="${escapeHtml(card.updatedAt || '')}" aria-live="polite">
        <div class="grid two">
          <input name="firstName" value="${escapeHtml(inlineState.draft.firstName || '')}" placeholder="First name" required />
          <input name="lastName" value="${escapeHtml(inlineState.draft.lastName || '')}" placeholder="Last name" required />
        </div>
        <input name="email" type="email" value="${escapeHtml(inlineState.draft.email || '')}" placeholder="Email" />
        <input name="phone" value="${escapeHtml(inlineState.draft.phone || '')}" placeholder="Phone" />
        <div class="actions-row">
          <button type="submit" class="tiny" ${canEdit && inlineState.dirty && !inlineState.saving ? '' : 'disabled'}>${inlineState.saving ? 'Saving…' : 'Save'}</button>
          <button type="button" class="secondary tiny" data-cancel-edit="${card.id}" ${canEdit && !inlineState.saving ? '' : 'disabled'}>Cancel</button>
        </div>
        <p class="muted compact" data-inline-feedback="${card.id}" aria-live="polite"></p>
      </form>
      <div class="muted compact-meta">Type: ${escapeHtml(kind)}</div>
    </article>
  `
}

function boardMarkup(kind, board) {
  const activeStages = new Set(getStageDefinitions({ includeInactive: false }).map((stage) => stage.id))
  const columns = (board?.columns || []).filter((column) => activeStages.has(column.stage))
  return `
    ${flashMarkup()}
    ${alertMarkup()}
    <p class="muted compact" role="status" aria-live="polite">${escapeHtml(state.workflowStatusMessage || '')}</p>
    <div class="section-header">
      <div>
        <h2>${escapeHtml(kind === 'prospect' ? 'Prospects' : 'Clients')} Board</h2>
        <p class="muted">Drag cards to reorder or move across stages. Inline edits save optimistically.</p>
      </div>
    </div>
    <div class="kanban-board" data-board-kind="${kind}">
      ${columns
        .map(
          (column) => `
        <section class="kanban-column" data-stage="${column.stage}" aria-label="${escapeHtml(stageLabel(column.stage))}">
          <header class="row between"><h3>${escapeHtml(stageLabel(column.stage))}</h3><span class="badge subtle">${column.cards.length}</span></header>
          <div class="kanban-dropzone" data-drop-stage="${column.stage}">
            ${column.cards.map((card) => boardCardMarkup(card, kind)).join('') || '<p class="muted">Drop profiles here.</p>'}
          </div>
        </section>`
        )
        .join('') || emptyStateMarkup('No active board columns are available. Confirm stage configuration and try again.')}
    </div>
  `
}

async function reorderCard(kind, move) {
  if (kind === 'prospect') {
    return reorderPipelineOptimistically(move)
  }
  const previousBoard = state.clientBoard ? structuredClone(state.clientBoard) : null
  if (previousBoard) state.clientBoard = applyOptimisticReorder(previousBoard, move)
  const optimisticColumn = findBoardColumn(state.clientBoard, move.toStage)
  const optimisticCard = optimisticColumn?.cards.find((entry) => entry.id === move.profileId)
  const newIndex = optimisticColumn ? optimisticColumn.cards.indexOf(optimisticCard) + 1 : 1
  try {
    const latest = await request(`/api/profiles/${move.profileId}`)
    const previousCard = previousBoard?.columns
      ?.flatMap((column) => column.cards)
      .find((entry) => entry.id === move.profileId)
    if (previousCard?.updatedAt && latest?.profile?.updatedAt && previousCard.updatedAt !== latest.profile.updatedAt) {
      throw new Error('Conflict detected: this client changed on the server. Review latest board and retry.')
    }
    await request(`/api/profiles/${move.profileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: move.toStage, stageOrderIndex: newIndex, orderIndex: newIndex })
    })
  } catch (error) {
    state.clientBoard = previousBoard
    throw error
  }
}

async function saveInlineProfile(kind, profileId, patch, expectedUpdatedAt = '') {
  const boardKey = boardKeyForKind(kind)
  const previousBoard = state[boardKey] ? structuredClone(state[boardKey]) : null
  beginInlineSave(kind, profileId)
  if (previousBoard) state[boardKey] = updateCardInBoard(previousBoard, profileId, patch)
  try {
    const saved = await request(`/api/profiles/${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...patch,
        expectedUpdatedAt: expectedUpdatedAt || undefined
      })
    })
    if (saved?.id) {
      state[boardKey] = updateCardInBoard(state[boardKey], profileId, saved)
      completeInlineSave(kind, profileId, saved)
    } else {
      completeInlineSave(kind, profileId)
    }
  } catch (error) {
    state[boardKey] = previousBoard
    failInlineSave(kind, profileId, isConflictError(error) ? normalizeConflictMessage(error) : '')
    throw error
  }
}

async function refreshInlineProfileFromLatestBoard(kind, profileId) {
  const boardKey = boardKeyForKind(kind)
  const latest = await request(routes.profileDetail(profileId))
  const latestProfile = latest?.profile || latest
  if (!latestProfile?.id) return
  state[boardKey] = updateCardInBoard(state[boardKey], profileId, latestProfile)
  cancelInlineDraft(kind, profileId, latestProfile)
}

function wireBoardInteractions(kind) {
  let activeCardId = null
  const canMutate = canMutateProfiles()
  document.querySelectorAll('[data-card-id]').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (!canMutate) {
        event.preventDefault()
        return
      }
      activeCardId = cardEl.dataset.cardId
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', activeCardId)
      cardEl.classList.add('dragging')
    })
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging')
      activeCardId = null
    })
    cardEl.addEventListener('dragover', (event) => event.preventDefault())
    cardEl.addEventListener('drop', async (event) => {
      event.preventDefault()
      if (!canMutate) return
      const profileId = event.dataTransfer.getData('text/plain') || activeCardId
      const toStage = cardEl.dataset.stage
      const beforeProfileId = cardEl.dataset.cardId
      if (!profileId || profileId === beforeProfileId) return
      try {
        await reorderCard(kind, { profileId, toStage, beforeProfileId })
        setFlash('success', 'Board updated.')
      } catch (error) {
        setFlash('error', error.message)
      }
      await renderCurrentView()
    })
  })

  document.querySelectorAll('[data-drop-stage]').forEach((zone) => {
    zone.addEventListener('dragover', (event) => event.preventDefault())
    zone.addEventListener('drop', async (event) => {
      event.preventDefault()
      if (!canMutate) return
      const profileId = event.dataTransfer.getData('text/plain') || activeCardId
      const toStage = zone.dataset.dropStage
      if (!profileId || !toStage) return
      try {
        await reorderCard(kind, { profileId, toStage, beforeProfileId: null })
        setFlash('success', 'Board updated.')
      } catch (error) {
        setFlash('error', error.message)
      }
      await renderCurrentView()
    })
  })

  document.querySelectorAll('[data-edit-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!canMutate) return
      const profileId = button.dataset.editProfile
      const form = document.querySelector(`[data-edit-form="${profileId}"]`)
      const boardKey = boardKeyForKind(kind)
      const card = state[boardKey]?.columns?.flatMap((column) => column.cards)?.find((entry) => entry.id === profileId)
      const inlineState = ensureInlineProfileState(kind, profileId, card)
      form?.classList.toggle('hidden')
      inlineState.isEditing = !form?.classList.contains('hidden')
      button.setAttribute('aria-expanded', String(!form?.classList.contains('hidden')))
      if (inlineState.isEditing) {
        form?.querySelector('input[name="firstName"]')?.focus()
        setWorkflowStatus(`Editing profile ${profileId}.`)
      } else {
        button.focus()
        setWorkflowStatus(`Closed edit mode for profile ${profileId}.`)
      }
    })
  })
  document.querySelectorAll('[data-cancel-edit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const profileId = button.dataset.cancelEdit
      try {
        await refreshInlineProfileFromLatestBoard(kind, profileId)
      } catch (error) {
        failInlineSave(kind, profileId, isConflictError(error) ? normalizeConflictMessage(error) : error?.message || '')
      }
      await renderCurrentView()
    })
  })
  document.querySelectorAll('[data-edit-form]').forEach((form) => {
    const profileId = form.dataset.editForm
    form.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        setInlineDraftField(kind, profileId, input.name, input.value)
      })
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const inlineState = ensureInlineProfileState(kind, profileId)
      const payload = { ...inlineState.draft }
      const submitButton = form.querySelector('button[type="submit"]')
      const feedbackEl = form.querySelector('[data-inline-feedback]')
      if (submitButton) {
        submitButton.disabled = true
        submitButton.textContent = 'Saving…'
      }
      setAlert('success', `Saving profile ${profileId} optimistically…`)
      if (feedbackEl) feedbackEl.textContent = 'Saving profile changes…'
      try {
        await saveInlineProfile(kind, profileId, payload, inlineState.expectedUpdatedAt || form.dataset.updatedAt || '')
        clearAlert()
        if (feedbackEl) feedbackEl.textContent = 'Profile saved.'
        setWorkflowStatus(`Profile ${profileId} updated.`)
        reportActionSuccess('Profiles', 'Profile updated.')
      } catch (error) {
        const message = normalizeApiError(error, 'save this profile')
        setAlert('error', message)
        if (feedbackEl) feedbackEl.textContent = message
        setWorkflowStatus(message)
        reportActionError('Profiles', error)
      } finally {
        if (submitButton) {
          submitButton.disabled = false
          submitButton.textContent = ensureInlineProfileState(kind, profileId).saving ? 'Saving…' : 'Save'
        }
      }
      await renderCurrentView()
    })
  })
  document.querySelectorAll('[data-stage-select]').forEach((select) => {
    select.addEventListener('change', async () => {
      const profileId = select.dataset.stageSelect
      const toStage = select.value
      try {
        await reorderCard(kind, { profileId, toStage, beforeProfileId: null })
        setFlash('success', `Moved to ${stageLabel(toStage)}.`)
      } catch (error) {
        setFlash('error', error.message)
      }
      await renderCurrentView()
    })
  })

  document.querySelectorAll('[data-workflow-client]').forEach((link) => {
    link.addEventListener('click', () => {
      setWorkflowContext({
        clientId: link.dataset.workflowClient || '',
        submissionId: link.dataset.workflowSubmission || ''
      })
    })
  })

  document.querySelectorAll('[data-open-doc-actions]').forEach((button) => {
    button.addEventListener('click', async () => {
      const clientId = button.dataset.openDocActions
      const submissionId = button.dataset.workflowSubmission || ''
      setWorkflowContext({ clientId, submissionId })
      state.view = 'templates'
      setWorkflowStatus(`Opened document actions for profile ${clientId}.`)
      setFlash('success', `Document actions opened for client ${clientId}.`)
      await renderCurrentView()
    })
  })

  document.querySelectorAll('[data-open-profile-detail]').forEach((button) => {
    button.addEventListener('click', async () => {
      const profileId = button.dataset.openProfileDetail
      const detailEl = document.querySelector(`[data-profile-detail="${profileId}"]`)
      if (!detailEl) return
      const isVisible = !detailEl.classList.contains('hidden')
      if (isVisible) {
        detailEl.classList.add('hidden')
        button.setAttribute('aria-expanded', 'false')
        button.focus()
        setWorkflowStatus(`Closed profile detail for ${profileId}.`)
        return
      }
      try {
        button.disabled = true
        button.setAttribute('aria-busy', 'true')
        detailEl.innerHTML = '<span class="muted">Loading profile detail…</span>'
        detailEl.classList.remove('hidden')
        let detail = state.profileDetailById[profileId]
        if (!detail) {
          detail = await request(routes.profileDetail(profileId))
          state.profileDetailById[profileId] = detail
        }
        const summary = detail?.profile || {}
        const submissionsCount = Array.isArray(detail?.submissions) ? detail.submissions.length : 0
        const notesCount = Array.isArray(detail?.notes) ? detail.notes.length : 0
        detailEl.innerHTML = `Household: ${escapeHtml(detail?.household?.name || '—')} · Status: ${escapeHtml(
          summary.status || '—'
        )} · Submissions: ${submissionsCount} · Notes: ${notesCount}`
        detailEl.classList.remove('hidden')
        button.setAttribute('aria-expanded', 'true')
        setWorkflowStatus(`Profile detail loaded for ${profileId}.`)
      } catch (error) {
        const message = normalizeApiError(error, 'open profile detail')
        detailEl.innerHTML = `<span class="error-banner">${escapeHtml(message)}</span>`
        setWorkflowStatus(message)
        setFlash('error', `Failed to load profile detail: ${message}`)
        await renderCurrentView()
      } finally {
        button.disabled = false
        button.setAttribute('aria-busy', 'false')
      }
    })
  })
}

async function renderBoard(kind) {
  try {
    if (kind === 'prospect') {
      state.board = await request(routes.board())
      const boardStageDefinitions = stageDefinitionsFromBoard(state.board)
      hydrateStageConfig(boardStageDefinitions, { overwrite: true })
      renderProfileStageSelect()
      viewEl.innerHTML = boardMarkup(kind, state.board)
      wireBoardInteractions(kind)
      return
    }
    await ensureStageConfig()
    const [clients, drafts, submissions] = await Promise.all([
      request(routes.profiles({ kind: 'client' })),
      request(routes.formDrafts()),
      request(routes.formSubmissions())
    ])
    const workflowByClientId = buildClientWorkflowMap(drafts, submissions)
    const clientsWithWorkflow = clients.map((client) => ({
      ...client,
      workflowSummary:
        workflowByClientId.get(client.id) || { latestSubmissionId: '', latestDraftId: '', submissionCount: 0, draftCount: 0 }
    }))
    state.clientBoard = buildBoardFromProfiles(clientsWithWorkflow)
    viewEl.innerHTML = boardMarkup(kind, state.clientBoard)
    wireBoardInteractions(kind)
  } catch (error) {
    viewEl.innerHTML = `${flashMarkup()}${alertMarkup()}${viewErrorBanner(kind === 'prospect' ? 'prospect board' : 'client board', error)}${emptyStateMarkup()}`
  }
}

function roleAccessMatrixMarkup() {
  const matrix = [
    ['Dashboard', ['admin', 'advisor', 'readonly']],
    ['Prospects', ['admin', 'advisor']],
    ['Clients', ['admin', 'advisor', 'readonly']],
    ['Forms', ['admin', 'advisor', 'readonly']],
    ['Templates', ['admin', 'advisor']],
    ['Exports', ['admin', 'advisor']],
    ['Analytics', ['admin', 'advisor', 'readonly']]
  ]
  return `<table><thead><tr><th>Action/View</th><th>admin</th><th>advisor</th><th>readonly</th></tr></thead><tbody>
    ${matrix.map(([name, roles]) => `<tr><td>${name}</td><td>${roles.includes('admin') ? '✅' : '—'}</td><td>${roles.includes('advisor') ? '✅' : '—'}</td><td>${roles.includes('readonly') ? '✅' : '—'}</td></tr>`).join('')}
  </tbody></table>`
}

function formatBytes(bytes) {
  const amount = Number(bytes || 0)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B'
  if (amount < 1024) return `${amount} B`
  if (amount < 1024 * 1024) return `${(amount / 1024).toFixed(1)} KB`
  return `${(amount / (1024 * 1024)).toFixed(2)} MB`
}

function normalizeExportDateInput(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00.000Z`
  return trimmed
}

function isRetryableExport(job) {
  if (!job) return false
  if (typeof job?.retryEligible === 'boolean') return job.retryEligible
  if (typeof job?.retryState?.eligible === 'boolean') return job.retryState.eligible
  return !['completed', 'running'].includes(String(job?.status || '').toLowerCase())
}

function isDownloadableExport(job) {
  return Boolean(job?.artifactAvailable)
}

function normalizeFailureClassLabel(failureClass) {
  const normalized = String(failureClass || '').toLowerCase()
  if (normalized === 'transient') return 'Transient'
  if (normalized === 'permanent') return 'Permanent'
  if (normalized === 'manual') return 'Manual'
  if (normalized === 'dead-letter') return 'Dead Letter'
  return 'n/a'
}

function exportActionGuidance(job, { canMutate, retryable, downloadable }) {
  if (!canMutate) return 'Readonly role: retry actions hidden.'
  if (retryable && downloadable) return 'Ready now: you can retry or download.'
  if (retryable) return job?.deadLettered ? 'Dead-letter retry: validate root cause before retrying.' : 'Retry eligible.'
  if (downloadable) return 'Download ready.'
  if (String(job?.status || '').toLowerCase() === 'running') return 'In progress: wait for completion.'
  if (String(job?.status || '').toLowerCase() === 'completed') return 'Completed without artifact metadata.'
  return 'Action unavailable: inspect failure details.'
}

function exportSelectionState(job, canMutate) {
  const retryable = canMutate && isRetryableExport(job)
  const downloadable = isDownloadableExport(job)
  const failureClass = normalizeFailureClassLabel(job?.failureClass || job?.failure?.classification || job?.retryState?.class)
  const guidance = exportActionGuidance(job, { canMutate, retryable, downloadable })
  return {
    retryable,
    downloadable,
    selectable: retryable || downloadable,
    failureClass,
    guidance
  }
}

function summarizeBulkResults(action, { succeeded = [], failed = [], skipped = [] } = {}) {
  if (failed.length) {
    setFlash(
      'error',
      `${action}: ${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped.` +
        `${failed.length ? ` Failed IDs: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}.` : ''}` +
        ' Operator guidance: inspect failed rows for failure class and retry hint.'
    )
    return
  }
  setFlash(
    'success',
    `${action}: ${succeeded.length} succeeded${skipped.length ? `, ${skipped.length} skipped.` : '.'}` +
      `${skipped.length ? ' Skipped rows were not retry/download eligible.' : ''}`
  )
}

async function triggerExportDownload(exportId, { button = null } = {}) {
  if (button) button.disabled = true
  try {
    const response = await fetch(routes.exportDownload(exportId), { credentials: 'same-origin' })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || 'Download failed')
    }
    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') || ''
    const matched = disposition.match(/filename="?([^";]+)"?/)
    const fileName = matched?.[1] || `export-${exportId}`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return fileName
  } finally {
    if (button) button.disabled = false
  }
}

async function renderExports() {
  const viewState = {
    status: state.exportsFilters?.status || '',
    profileId: state.exportsFilters?.profileId || '',
    fromDate: state.exportsFilters?.fromDate || '',
    toDate: state.exportsFilters?.toDate || '',
    sort: state.exportsFilters?.sort || 'createdAt_desc',
    selectedIds: new Set(state.exportsFilters?.selectedIds || []),
    bulkBusy: state.exportsFilters?.bulkBusy === true
  }
  state.exportsFilters = viewState

  const query = {
    status: viewState.status || undefined,
    profileId: viewState.profileId || undefined,
    fromDate: normalizeExportDateInput(viewState.fromDate) || undefined,
    toDate: normalizeExportDateInput(viewState.toDate) || undefined,
    sort: viewState.sort || undefined
  }

  let jobs = []
  let queue = { queue: {} }
  let exportsLoadError = null
  try {
    ;[jobs, queue] = await Promise.all([request(routes.exports(query)), request(routes.exportsQueueHealth())])
  } catch (error) {
    reportActionError('Exports', error)
    exportsLoadError = error
  }

  const canMutate = state.user?.role === 'admin' || state.user?.role === 'advisor'
  const queueState = queue?.queue || {}
  const queueCards = [
    ['Pending (queued + retrying)', queueState.pending ?? queueState.queued ?? 0],
    ['Queued (new)', queueState.queuedOnly ?? 0],
    ['Retrying (auto)', queueState.retrying ?? 0],
    ['Processing', queueState.processing ?? queueState.running ?? 0],
    ['Failed (manual triage)', queueState.failed || 0],
    ['Dead Letter (needs root-cause)', queueState.deadLetter || 0],
    ['Retryable failures', queueState.failedRetryable ?? (queueState.failed || 0) + (queueState.deadLetter || 0)],
    ['Completed', queueState.completed || 0]
  ]

  const visibleIds = new Set(jobs.map((job) => job.id))
  viewState.selectedIds = new Set([...viewState.selectedIds].filter((id) => visibleIds.has(id)))
  const selectedJobs = jobs.filter((job) => viewState.selectedIds.has(job.id))
  const selectableJobs = jobs.filter((job) => exportSelectionState(job, canMutate).selectable)
  const selectedRetryable = selectedJobs.filter((job) => exportSelectionState(job, canMutate).retryable)
  const selectedDownloadable = selectedJobs.filter((job) => exportSelectionState(job, canMutate).downloadable)
  const selectedIneligible = selectedJobs.filter((job) => !exportSelectionState(job, canMutate).selectable)

  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    ${exportsLoadError ? viewErrorBanner('exports', exportsLoadError) : ''}
    <div class="section-header"><div><h2>Exports Operations</h2><p class="muted">Queue health, retries, and artifact readiness by job.</p></div></div>
    <p id="exports-live-region" class="muted compact" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(
      state.workflowStatusMessage || ''
    )}</p>
    <section class="item stack gap-md">
      <h3>Filters & Bulk Actions</h3>
      <form id="exports-filter-form" class="exports-filter-grid">
        <label>Status<input name="status" placeholder="completed" value="${escapeHtml(viewState.status)}" /></label>
        <label>Profile ID<input name="profileId" placeholder="profile-123" value="${escapeHtml(viewState.profileId)}" /></label>
        <label>From date<input name="fromDate" type="date" value="${escapeHtml(viewState.fromDate)}" /></label>
        <label>To date<input name="toDate" type="date" value="${escapeHtml(viewState.toDate)}" /></label>
        <label>Sort
          <select name="sort">
            <option value="createdAt_desc" ${viewState.sort === 'createdAt_desc' ? 'selected' : ''}>Created newest</option>
            <option value="createdAt_asc" ${viewState.sort === 'createdAt_asc' ? 'selected' : ''}>Created oldest</option>
            <option value="updatedAt_desc" ${viewState.sort === 'updatedAt_desc' ? 'selected' : ''}>Updated newest</option>
            <option value="updatedAt_asc" ${viewState.sort === 'updatedAt_asc' ? 'selected' : ''}>Updated oldest</option>
            <option value="attempts_desc" ${viewState.sort === 'attempts_desc' ? 'selected' : ''}>Attempts high-low</option>
            <option value="attempts_asc" ${viewState.sort === 'attempts_asc' ? 'selected' : ''}>Attempts low-high</option>
            <option value="status_asc" ${viewState.sort === 'status_asc' ? 'selected' : ''}>Status A-Z</option>
            <option value="status_desc" ${viewState.sort === 'status_desc' ? 'selected' : ''}>Status Z-A</option>
          </select>
        </label>
        <div class="actions-row exports-filter-actions">
          <button type="submit" class="tiny">Apply filters</button>
          <button type="button" class="tiny secondary" id="clear-export-filters">Clear</button>
        </div>
      </form>
      <div class="exports-bulk-actions">
        <span class="muted">Selected ${selectedJobs.length} of ${jobs.length} · Retryable ${selectedRetryable.length} · Downloadable ${selectedDownloadable.length}${selectedIneligible.length ? ` · Ineligible ${selectedIneligible.length}` : ''}</span>
        <button id="bulk-retry-exports" class="tiny secondary" ${canMutate && selectedRetryable.length && !viewState.bulkBusy ? '' : 'disabled'}>Retry selected (${selectedRetryable.length})</button>
        <button id="bulk-download-exports" class="tiny" ${selectedDownloadable.length && !viewState.bulkBusy ? '' : 'disabled'}>Download selected (${selectedDownloadable.length})</button>
      </div>
    </section>
    <section class="item">
      <h3>Queue State</h3>
      <div class="stat-grid">
        ${queueCards.map(([label, value]) => metricCard(label, value)).join('')}
      </div>
      <p class="muted">Operator guidance: retrying jobs are automatic, failed jobs need manual retry, and dead-letter jobs require remediation before retrying.</p>
      <pre>${escapeHtml(JSON.stringify(queueState, null, 2))}</pre>
      ${
        canMutate
          ? '<button id="retry-failed-jobs" class="tiny secondary">Retry failed + dead-letter jobs</button>'
          : '<p class="muted">Readonly role cannot trigger retries.</p>'
      }
    </section>
    <section class="item">
      <h3>Per-job Artifact Status</h3>
      <table aria-describedby="exports-live-region"><thead><tr><th><input id="select-all-exports" type="checkbox" aria-label="Select all eligible exports" ${selectableJobs.length && selectedJobs.length === selectableJobs.length ? 'checked' : ''} /></th><th>ID</th><th>Status</th><th>Attempts</th><th>Artifact Details</th><th>Actions</th></tr></thead><tbody>
        ${
          jobs
            .map(
              (job) => `<tr>
          <td><input data-select-export="${job.id}" type="checkbox" aria-label="Select export ${escapeHtml(job.id)}" ${viewState.selectedIds.has(job.id) ? 'checked' : ''} ${exportSelectionState(job, canMutate).selectable ? '' : 'disabled'} /></td>
          <td>${escapeHtml(job.id)}</td>
          <td>${escapeHtml(job.statusLabel || job.status)}</td>
          <td>${escapeHtml(exportSelectionState(job, canMutate).failureClass)}</td>
          <td>${job.attempts || 0}/${job.maxAttempts || 0}</td>
          <td>
            ${
              job.output?.object?.key
                ? `<div class="stack gap-sm">
                    <div><strong>${escapeHtml(job.artifact?.fileName || job.output?.fileName || 'artifact')}</strong></div>
                    <div class="muted">Format: ${escapeHtml(job.artifact?.format || job.type || 'n/a')} · Size: ${escapeHtml(formatBytes(job.artifact?.sizeBytes || 0))}</div>
                    <div class="muted">Generated: ${escapeHtml(job.artifact?.generatedAt || 'n/a')}</div>
                    <div class="muted">Version: ${escapeHtml(job.artifact?.templateVersion || 'n/a')}</div>
                    <div class="muted">Mapping: <code>${escapeHtml(job.artifact?.mappingVersionHash || 'n/a')}</code></div>
                    <div class="muted">Checksum: <code>${escapeHtml(job.artifact?.checksum || 'n/a')}</code></div>
                    <div><code>${escapeHtml(job.output.object.key)}</code></div>
                  </div>`
                : '<span class="muted">Not ready</span>'
            }
          </td>
          <td>${
            (() => {
              const selection = exportSelectionState(job, canMutate)
              return `<div class="actions-row">
                  <button data-retry-export="${job.id}" class="tiny secondary" aria-label="Retry export ${escapeHtml(job.id)}" ${selection.retryable ? '' : 'disabled'}>Retry</button>
                  <button data-download-export="${job.id}" class="tiny" aria-label="Download export ${escapeHtml(job.id)}" ${selection.downloadable ? '' : 'disabled'}>Download</button>
                </div>`
            })()
          }</td>
        </tr>`
            )
            .join('') || '<tr><td colspan="7">No export jobs yet. Run an export to populate queue activity and artifact status.</td></tr>'
        }
      </tbody></table>
    </section>
    <section class="item">
      <h3>Role Visibility Validation</h3>
      <p class="muted">Current signed-in role: <strong>${escapeHtml(state.user?.role || 'anonymous')}</strong></p>
      ${roleAccessMatrixMarkup()}
    </section>
  `

  document.querySelector('#exports-filter-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formData = withTrimmedFormData(event.currentTarget)
    viewState.status = formData.status || ''
    viewState.profileId = formData.profileId || ''
    viewState.fromDate = formData.fromDate || ''
    viewState.toDate = formData.toDate || ''
    viewState.sort = formData.sort || 'createdAt_desc'
    viewState.selectedIds = new Set()
    setWorkflowStatus('Exports filters applied.')
    await renderExports()
  })

  document.querySelector('#clear-export-filters')?.addEventListener('click', async () => {
    viewState.status = ''
    viewState.profileId = ''
    viewState.fromDate = ''
    viewState.toDate = ''
    viewState.sort = 'createdAt_desc'
    viewState.selectedIds = new Set()
    setWorkflowStatus('Exports filters cleared.')
    await renderExports()
  })

  document.querySelector('#select-all-exports')?.addEventListener('change', (event) => {
    if (event.currentTarget.checked) {
      selectableJobs.forEach((job) => viewState.selectedIds.add(job.id))
    } else {
      selectableJobs.forEach((job) => viewState.selectedIds.delete(job.id))
    }
    renderExports()
  })
  const selectAllEl = document.querySelector('#select-all-exports')
  if (selectAllEl) {
    const selectedSelectableCount = selectableJobs.filter((job) => viewState.selectedIds.has(job.id)).length
    selectAllEl.indeterminate = selectedSelectableCount > 0 && selectedSelectableCount < selectableJobs.length
  }

  document.querySelectorAll('[data-select-export]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const id = event.currentTarget.dataset.selectExport
      if (event.currentTarget.checked) viewState.selectedIds.add(id)
      else viewState.selectedIds.delete(id)
      renderExports()
    })
  })

  document.querySelector('#bulk-retry-exports')?.addEventListener('click', async () => {
    if (!selectedRetryable.length) {
      setFlash('error', 'Bulk retry: no selected exports are eligible for retry.')
      setWorkflowStatus('Bulk retry skipped. No eligible exports selected.')
      await renderExports()
      return
    }
    viewState.bulkBusy = true
    const succeeded = []
    const failed = []
    const skipped = selectedJobs.filter((job) => !exportSelectionState(job, canMutate).retryable).map((job) => job.id)
    for (const job of selectedRetryable) {
      try {
        await request(routes.exportRetry(job.id), { method: 'POST', body: JSON.stringify({}) })
        succeeded.push(job.id)
      } catch {
        failed.push(job.id)
      }
    }
    viewState.bulkBusy = false
    viewState.selectedIds = new Set()
    summarizeBulkResults('Bulk retry', { succeeded, failed, skipped })
    setWorkflowStatus('Bulk retry finished. Review flash summary for details.')
    await renderExports()
  })

  document.querySelector('#bulk-download-exports')?.addEventListener('click', async () => {
    if (!selectedDownloadable.length) {
      setFlash('error', 'Bulk download: no selected exports are ready to download.')
      setWorkflowStatus('Bulk download skipped. No ready exports selected.')
      await renderExports()
      return
    }
    viewState.bulkBusy = true
    const succeeded = []
    const failed = []
    const skipped = selectedJobs.filter((job) => !exportSelectionState(job, canMutate).downloadable).map((job) => job.id)
    for (const job of selectedDownloadable) {
      try {
        await triggerExportDownload(job.id)
        succeeded.push(job.id)
      } catch {
        failed.push(job.id)
      }
    }
    viewState.bulkBusy = false
    summarizeBulkResults('Bulk download', { succeeded, failed, skipped })
    setWorkflowStatus('Bulk download finished. Review flash summary for details.')
    await renderExports()
  })

  document.querySelector('#retry-failed-jobs')?.addEventListener('click', async () => {
    try {
      const result = await request(routes.exportsRetryFailed(), {
        method: 'POST',
        body: JSON.stringify({ includeDeadLetter: true, limit: 50 })
      })
      reportActionSuccess('Exports', `Retried ${result.retriedCount || 0} failed jobs.`)
      setWorkflowStatus(`Retry failed jobs completed for ${result.retriedCount || 0} jobs.`)
    } catch (error) {
      reportActionError('Exports', error)
      setWorkflowStatus('Retry failed jobs did not complete. See error details.')
    }
    await renderExports()
  })
  document.querySelectorAll('[data-retry-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await request(routes.exportRetry(button.dataset.retryExport), { method: 'POST', body: JSON.stringify({}) })
        reportActionSuccess('Exports', `Retry requested for ${button.dataset.retryExport}.`)
      } catch (error) {
        reportActionError('Exports', error)
      }
      await renderExports()
    })
  })
  document.querySelectorAll('[data-download-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const exportId = button.dataset.downloadExport
      try {
        const fileName = await triggerExportDownload(exportId, { button })
        reportActionSuccess('Exports', `Downloaded ${fileName}.`)
      } catch (error) {
        reportActionError('Exports', error)
      }
    })
  })
}

function operationsPayloadJson() {
  return JSON.stringify(
    {
      capturedAt: state.operations.lastUpdatedAt,
      snapshot: state.operations.snapshot
    },
    null,
    2
  )
}

async function renderOperations() {
  if (!state.operations.snapshot) {
    await loadOperationsSnapshot()
  }

  const snapshot = state.operations.snapshot || {}
  const cards = [
    { key: 'health', title: '/health', data: snapshot.health },
    { key: 'ready', title: '/ready', data: snapshot.ready },
    { key: 'queue', title: '/api/ops/exports/queue', data: snapshot.queue },
    { key: 'diagnostics', title: '/api/ops/diagnostics', data: snapshot.diagnostics }
  ]

  const statusCards = cards
    .map(({ key, title, data }) => {
      const status = deriveOpsCardStatus(key, data)
      const detail = data?.ok ? status.note : data?.error || 'Request failed.'
      return `<article class="ops-card">
        <div class="row between">
          <strong>${escapeHtml(title)}</strong>
          <span class="ops-badge ${status.level.toLowerCase()}">${status.level}</span>
        </div>
        <p class="muted compact">${escapeHtml(detail)}</p>
      </article>`
    })
    .join('')

  const payloadPreview = escapeHtml(operationsPayloadJson())
  viewEl.innerHTML = `
    ${flashMarkup()}
    <section class="section-card">
      <div class="row between">
        <div>
          <h2>Operations</h2>
          <p class="muted compact">Operator snapshot of readiness, health, exports queue, and diagnostics.</p>
        </div>
        <span class="badge subtle">${state.operations.lastUpdatedAt ? `Updated ${new Date(state.operations.lastUpdatedAt).toLocaleString()}` : 'Not yet updated'}</span>
      </div>
      <div class="ops-actions">
        <button type="button" data-ops-refresh>${state.operations.busy ? 'Refreshing…' : 'Refresh'}</button>
        <button type="button" data-ops-copy-json>Copy JSON</button>
        <a href="/docs/release-ready-checklist.md#deterministic-command-flows-operator-runbook">Runbook: deterministic checks</a>
        <a href="/docs/release-ready-checklist.md#go-no-go-sign-off-grid">Runbook: go/no-go grid</a>
      </div>
      <div class="ops-grid">${statusCards}</div>
      <details open>
        <summary>Diagnostics payload</summary>
        <pre class="ops-diagnostics-block">${payloadPreview}</pre>
      </details>
    </section>
  `

  const refreshButton = viewEl.querySelector('[data-ops-refresh]')
  refreshButton?.addEventListener('click', async () => {
    await loadOperationsSnapshot()
    await renderOperations()
  })

  const copyButton = viewEl.querySelector('[data-ops-copy-json]')
  copyButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(operationsPayloadJson())
      setFlash('success', 'Operations payload copied to clipboard.')
    } catch {
      setFlash('error', 'Clipboard copy failed. Copy from the diagnostics block instead.')
    }
    await renderOperations()
  })
}

function applyHashRoute() {
  const hashPath = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  const route = appRoutes.parseClientFormSubmission(hashPath)
  if (!route) return
  state.view = 'forms'
  setWorkflowContext({ clientId: route.clientId, submissionId: route.submissionId })
  setFlash('success', `Editing submission ${route.submissionId} for client ${route.clientId}.`)
}

async function renderFallback(title) {
  viewEl.innerHTML = `${flashMarkup()}<h2>${escapeHtml(title)}</h2><p class="muted">This view remains functional in API workflows and can be expanded with richer cards later.</p>`
}

async function renderCurrentView() {
  updateViewNavState()
  if (!state.user) {
    viewEl.innerHTML = `${flashMarkup()}<h2>Sign in to continue</h2>`
    return
  }
  if (state.view === 'dashboard') return renderDashboard()
  if (state.view === 'analytics') return renderAnalytics()
  if (state.view === 'forms') return renderForms()
  if (state.view === 'templates') return renderTemplates()
  if (state.view === 'exports') return renderExports()
  if (state.view === 'operations') return renderOperations()
  if (state.view === 'prospects') return renderBoard('prospect')
  if (state.view === 'clients') return renderBoard('client')
  return renderFallback(state.view)
}

async function hydrateSession() {
  try {
    const session = await request(routes.session())
    state.user = session.user
    setAuthStatus(JSON.stringify(session.user, null, 2))
    updateRoleVisibility()
    await refreshSelects()
    updateMfaUi()
  } catch {
    state.user = null
    setAuthStatus('Not signed in')
    updateRoleVisibility()
    updateMfaUi()
  }
}

async function finishAuth(session, message) {
  state.user = session.user
  setAuthStatus(JSON.stringify(session.user, null, 2))
  state.view = session.user.role === 'client' ? 'forms' : 'dashboard'
  updateRoleVisibility()
  await refreshSelects()
  clearMfaState()
  setFlash('success', message)
  await renderCurrentView()
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!roleAllowed(button.dataset.roles || '')) return
    state.view = button.dataset.view
    await renderCurrentView()
  })
})

const demoLoginButton = document.querySelector('#demo-login')
demoLoginButton.addEventListener('click', async () => {
  if (!state.enableDemoMode) return
  try {
    const session = await request(routes.login(), {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    })
    if (session.mfaRequired) {
      setPendingMfaLogin(session, { email: 'admin@demo.test', password: 'ChangeMe123!' })
      await renderCurrentView()
      return
    }
    await finishAuth(session, 'Signed in with demo account.')
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

registerFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  clearFormFeedback(registerFormEl)
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    const session = await request(routes.register(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    setFormFeedback(registerFormEl, 'Registration successful.', 'success')
    await finishAuth(session, 'Firm admin account created.')
  } catch (error) {
    setFormFeedback(registerFormEl, normalizeApiError(error, 'register this account'))
    setAuthStatus(`Registration failed: ${error.message}`, { assertive: true })
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

loginFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  clearFormFeedback(loginFormEl)
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    const session = await request(routes.login(), { method: 'POST', body: JSON.stringify(payload) })
    if (session.mfaRequired) {
      setPendingMfaLogin(session, payload)
      setFormFeedback(loginFormEl, 'MFA challenge required. Continue below.', 'success')
      await renderCurrentView()
      return
    }
    event.target.reset()
    setFormFeedback(loginFormEl, 'Sign-in successful.', 'success')
    await finishAuth(session, 'Signed in successfully.')
  } catch (error) {
    setFormFeedback(loginFormEl, normalizeApiError(error, 'sign in'))
    setAuthStatus(`Sign-in failed: ${error.message}`, { assertive: true })
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

profileCreateFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const formEl = event.target
  const actionKey = 'create-profile'
  if (!canMutateSection(formEl.closest('[data-requires-role]'))) return
  clearFormFeedback(formEl)
  const submitButton = formEl.querySelector('button[type="submit"]')
  setActionPending(actionKey, 'pending')
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = pendingLabel(actionKey, 'Create Profile', 'Creating…')
  }
  try {
    const payload = validateRequiredFields(formEl, ['firstName', 'lastName'])
    const source = payload.cityOrLocation
      ? { cityOrLocation: payload.cityOrLocation, venue: payload.venue, occurredOn: payload.occurredOn }
      : null
    await request(routes.profiles(), {
      method: 'POST',
      body: JSON.stringify({
        kind: payload.kind,
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        phone: payload.phone,
        stage: payload.stage,
        source
      })
    })
    formEl.reset()
    reportActionSuccess('Profiles', 'Profile created.')
    await refreshSelects()
    await renderCurrentView()
  } catch (error) {
    setFormFeedback(formEl, normalizeApiError(error, 'create this profile'))
    setWorkflowStatus(normalizeApiError(error, 'create this profile'))
    reportActionError('Profiles', error)
    await renderCurrentView()
  } finally {
    clearActionPending(actionKey)
    if (submitButton) {
      submitButton.disabled = false
      submitButton.textContent = 'Create Profile'
    }
  }
})

householdFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const formEl = event.target
  const actionKey = 'create-household'
  if (!canMutateSection(formEl.closest('[data-requires-role]'))) return
  clearFormFeedback(formEl)
  const submitButton = formEl.querySelector('button[type="submit"]')
  setActionPending(actionKey, 'pending')
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = pendingLabel(actionKey, 'Create Household', 'Creating…')
  }
  try {
    const payload = validateRequiredFields(formEl, ['name', 'primaryClientId'])
    await request(routes.households(), { method: 'POST', body: JSON.stringify(payload) })
    formEl.reset()
    setFormFeedback(formEl, 'Household created.', 'success')
    setWorkflowStatus('Household created successfully.')
    reportActionSuccess('Households', 'Household created.')
    await renderCurrentView()
  } catch (error) {
    const message = normalizeApiError(error, 'create this household')
    setFormFeedback(formEl, message)
    setWorkflowStatus(message)
    reportActionError('Households', error)
    await renderCurrentView()
  } finally {
    clearActionPending(actionKey)
    if (submitButton) {
      submitButton.disabled = false
      submitButton.textContent = 'Create Household'
    }
  }
})

formTemplateFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const formEl = event.target
  const actionKey = 'create-form-template'
  if (!canMutateSection(formEl.closest('[data-requires-role]'))) return
  clearFormFeedback(formEl)
  const submitButton = formEl.querySelector('button[type="submit"]')
  setActionPending(actionKey, 'pending')
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = pendingLabel(actionKey, 'Create Form Template', 'Creating…')
  }
  try {
    const payload = { ...validateRequiredFields(formEl, ['name']), sections: [] }
    await request(routes.formTemplates(), { method: 'POST', body: JSON.stringify(payload) })
    formEl.reset()
    state.view = 'forms'
    reportActionSuccess('Forms', 'Form template created.')
    await renderCurrentView()
  } catch (error) {
    setFormFeedback(formEl, error.message)
    reportActionError('Forms', error)
    await renderCurrentView()
  } finally {
    clearActionPending(actionKey)
    if (submitButton) {
      submitButton.disabled = false
      submitButton.textContent = 'Create Form Template'
    }
  }
})

docTemplateFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const formEl = event.target
  const actionKey = 'create-doc-template'
  if (!canMutateSection(formEl.closest('[data-requires-role]'))) return
  clearFormFeedback(formEl)
  const submitButton = formEl.querySelector('button[type="submit"]')
  setActionPending(actionKey, 'pending')
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = pendingLabel(actionKey, 'Create Template', 'Creating…')
  }
  try {
    const payload = {
      ...validateRequiredFields(formEl, ['name']),
      blueprint: { sections: [] },
      mappings: []
    }
    await request(routes.documentTemplates(), { method: 'POST', body: JSON.stringify(payload) })
    formEl.reset()
    reportActionSuccess('Templates', 'Document template created.')
    await renderCurrentView()
  } catch (error) {
    setFormFeedback(formEl, error.message)
    reportActionError('Templates', error)
    await renderCurrentView()
  } finally {
    clearActionPending(actionKey)
    if (submitButton) {
      submitButton.disabled = false
      submitButton.textContent = 'Create Template'
    }
  }
})

inviteFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const formEl = event.target
  const actionKey = 'create-invite'
  if (!canMutateSection(formEl.closest('[data-requires-role]'))) return
  clearFormFeedback(formEl)
  const submitButton = formEl.querySelector('button[type="submit"]')
  setActionPending(actionKey, 'pending')
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = pendingLabel(actionKey, 'Create Invite', 'Creating…')
  }
  try {
    const payload = validateRequiredFields(formEl, ['email', 'role'])
    const invite = await request(routes.invites(), { method: 'POST', body: JSON.stringify(payload) })
    formEl.reset()
    clearFormFeedback(formEl)
    reportActionSuccess('Invites', `Invite created (${invite.token}).`)
    await renderCurrentView()
  } catch (error) {
    setFormFeedback(formEl, error.message)
    reportActionError('Invites', error)
    await renderCurrentView()
  } finally {
    clearActionPending(actionKey)
    if (submitButton) {
      submitButton.disabled = false
      submitButton.textContent = 'Create Invite'
    }
  }
})

portalFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const formEl = event.target
  const actionKey = 'create-portal-link'
  if (!canMutateSection(formEl.closest('[data-requires-role]'))) return
  clearFormFeedback(formEl)
  const submitButton = formEl.querySelector('button[type="submit"]')
  setActionPending(actionKey, 'pending')
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = pendingLabel(actionKey, 'Create Link', 'Creating…')
  }
  try {
    const payload = validateRequiredFields(formEl, ['profileId'])
    const link = await request(routes.portalLinks(), { method: 'POST', body: JSON.stringify(payload) })
    clearFormFeedback(formEl)
    reportActionSuccess('Portal', `Portal link created: /portal?token=${link.token}`)
    await renderCurrentView()
  } catch (error) {
    setFormFeedback(formEl, error.message)
    reportActionError('Portal', error)
    await renderCurrentView()
  } finally {
    clearActionPending(actionKey)
    if (submitButton) {
      submitButton.disabled = false
      submitButton.textContent = 'Create Link'
    }
  }
})

mfaLoginFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.mfa.login) return
  const form = new FormData(event.target)
  const totpCode = String(form.get('totpCode') || '').trim()
  const backupCode = String(form.get('backupCode') || '').trim()
  try {
    const session = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: state.mfa.login.email,
        password: state.mfa.login.password,
        mfaChallengeToken: state.mfa.login.challengeToken,
        ...(totpCode ? { totpCode } : {}),
        ...(backupCode ? { backupCode } : {})
      })
    })
    event.target.reset()
    await finishAuth(session, 'Signed in successfully with MFA.')
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

mfaEnrollStartEl.addEventListener('click', async () => {
  try {
    const result = await request('/api/auth/mfa/enroll', { method: 'POST', body: JSON.stringify({}) })
    state.mfa.enrollment = result.mfa
    setFlash('success', 'MFA enrollment started. Confirm with your authenticator app code.')
    updateMfaUi()
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

mfaEnrollConfirmFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.mfa.enrollment) return
  const code = String(new FormData(event.target).get('code') || '').trim()
  try {
    const result = await request('/api/auth/mfa/enroll/confirm', {
      method: 'POST',
      body: JSON.stringify({ enrollmentToken: state.mfa.enrollment.enrollmentToken, code })
    })
    event.target.reset()
    state.mfa.enrollment = null
    const backupCodes = result?.mfa?.backupCodes || []
    setFlash('success', `MFA enabled. Save backup codes: ${backupCodes.join(', ')}`)
    updateMfaUi()
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

updateMfaUi()

await hydrateSession()
applyHashRoute()
window.addEventListener('hashchange', async () => {
  applyHashRoute()
  await renderCurrentView()
})
await renderCurrentView()
