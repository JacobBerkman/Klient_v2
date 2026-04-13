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
  templateMappingFilterByTemplateId: {},
  templateMappingSuggestionsByTemplateId: {},
  templateInspectorFocusRequestByTemplateId: {},
  templateJumpHighlightByTemplateId: {},
  customFieldSchema: {
    fetched: false,
    loading: false,
    fields: [],
    updatedAt: '',
    lastError: ''
  },
  formsUi: {
    activeDraftSharePanelId: '',
    collaboratorsByDraftId: {},
    shareFeedbackByDraftId: {},
    userLookupByDraftId: {},
    userLookupSearchByDraftId: {}
  },
  workflowStatusMessage: '',
  operations: {
    busy: false,
    lastUpdatedAt: '',
    snapshot: null,
    feedback: ''
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
const profileCustomFieldsEl = document.querySelector('#profile-custom-fields')
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

let pendingViewFocusSelector = ''

function queueViewFocus(selector = '') {
  pendingViewFocusSelector = String(selector || '').trim()
}

function focusLiveRegion(element) {
  if (!element) return
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1')
  element.focus()
}

function focusWithinView(defaultSelector = '') {
  const selector = pendingViewFocusSelector || defaultSelector
  pendingViewFocusSelector = ''
  if (!selector) return
  const focusTarget = viewEl?.querySelector(selector)
  if (focusTarget) focusLiveRegion(focusTarget)
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
  feedbackEl.setAttribute('aria-atomic', 'true')
  feedbackEl.textContent = message
  feedbackEl.classList.remove('error-banner', 'success-banner')
  if (message) feedbackEl.classList.add(type === 'success' ? 'success-banner' : 'error-banner')
  if (type === 'error' && message) focusLiveRegion(feedbackEl)
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
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

function canManageCustomFieldSchema() {
  return roleAllowed('admin')
}

function normalizeCustomFieldDefinitions(fields = []) {
  return (Array.isArray(fields) ? fields : [])
    .map((field) => ({
      key: String(field?.key || '')
        .trim()
        .replace(/[^a-zA-Z0-9_]+/g, '_'),
      type: String(field?.type || 'text')
        .trim()
        .toLowerCase(),
      label: String(field?.label || field?.key || '').trim(),
      required: Boolean(field?.required),
      metadata: field?.metadata && typeof field.metadata === 'object' && !Array.isArray(field.metadata) ? field.metadata : {}
    }))
    .filter((field) => field.key)
}

async function ensureCustomFieldSchema(force = false) {
  if (!state.user || state.user.role === 'client') {
    state.customFieldSchema = { fetched: true, loading: false, fields: [], updatedAt: '', lastError: '' }
    return state.customFieldSchema.fields
  }
  if (!force && state.customFieldSchema.fetched) return state.customFieldSchema.fields
  state.customFieldSchema.loading = true
  try {
    const schema = await request(routes.profileCustomFieldSchema())
    state.customFieldSchema.fields = normalizeCustomFieldDefinitions(schema?.fields || [])
    state.customFieldSchema.updatedAt = String(schema?.updatedAt || '')
    state.customFieldSchema.lastError = ''
  } catch (error) {
    state.customFieldSchema.fields = []
    state.customFieldSchema.lastError = normalizeApiError(error, 'load custom field schema')
  } finally {
    state.customFieldSchema.loading = false
    state.customFieldSchema.fetched = true
  }
  return state.customFieldSchema.fields
}

function customFieldInputName(key = '') {
  return `customField__${key}`
}

function parseCustomFieldInputValue(field, rawValue) {
  const value = String(rawValue ?? '').trim()
  if (!value) return null
  if (field.type === 'number') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (field.type === 'date') {
    return Number.isFinite(Date.parse(value)) ? value : null
  }
  if (field.type === 'boolean') return value === 'true'
  return value
}

function parseCustomFieldInputValueStrict(field, rawValue) {
  const value = String(rawValue ?? '').trim()
  if (!value) return { value: null, error: '' }
  if (field.type === 'number') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return { value: null, error: `${field.label || field.key} must be a valid number.` }
    }
    return { value: parsed, error: '' }
  }
  if (field.type === 'date') {
    if (!Number.isFinite(Date.parse(value))) {
      return { value: null, error: `${field.label || field.key} must be a valid date.` }
    }
    return { value, error: '' }
  }
  if (field.type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      return { value: null, error: `${field.label || field.key} must be true or false.` }
    }
    return { value: value === 'true', error: '' }
  }
  return { value, error: '' }
}

function customFieldControlMarkup(
  field,
  value = '',
  { disabled = false, idPrefix = 'profile-custom', booleanControl = 'select' } = {}
) {
  const name = customFieldInputName(field.key)
  const elementId = `${idPrefix}-${field.key}`
  const helpId = `${elementId}-help`
  const affordanceByType = {
    text: 'Freeform text value.',
    number: 'Numbers only (example: 125000).',
    date: 'Use YYYY-MM-DD.',
    boolean: 'Choose true/false.'
  }
  const affordance = affordanceByType[field.type] || affordanceByType.text
  if (field.type === 'boolean' && booleanControl === 'toggle') {
    const checked = String(value) === 'true'
    return `<label for="${escapeHtml(elementId)}" class="checkbox-row">${escapeHtml(field.label || field.key)}${field.required ? ' *' : ''}
      <input id="${escapeHtml(elementId)}" name="${escapeHtml(name)}" type="checkbox" value="true" ${checked ? 'checked' : ''} ${
        disabled ? 'disabled' : ''
      } aria-describedby="${escapeHtml(helpId)}" />
      <span id="${escapeHtml(helpId)}" class="muted compact">${escapeHtml(affordance)}</span>
    </label>`
  }
  if (field.type === 'boolean') {
    return `<label for="${escapeHtml(elementId)}">${escapeHtml(field.label || field.key)}${field.required ? ' *' : ''}
      <select id="${escapeHtml(elementId)}" name="${escapeHtml(name)}" ${disabled ? 'disabled' : ''} aria-describedby="${escapeHtml(helpId)}">
        <option value="">Not set</option>
        <option value="true" ${String(value) === 'true' ? 'selected' : ''}>True</option>
        <option value="false" ${String(value) === 'false' ? 'selected' : ''}>False</option>
      </select>
      <span id="${escapeHtml(helpId)}" class="muted compact">${escapeHtml(affordance)}</span>
    </label>`
  }
  const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
  return `<label for="${escapeHtml(elementId)}">${escapeHtml(field.label || field.key)}${field.required ? ' *' : ''}
    <input id="${escapeHtml(elementId)}" name="${escapeHtml(name)}" type="${inputType}" value="${escapeHtml(value || '')}" ${
      disabled ? 'disabled' : ''
    } ${field.required ? 'required' : ''} ${field.type === 'number' ? 'inputmode="decimal" step="any"' : ''} ${
      field.type === 'date' ? 'placeholder="YYYY-MM-DD"' : ''
    } aria-describedby="${escapeHtml(helpId)}" />
    <span id="${escapeHtml(helpId)}" class="muted compact">${escapeHtml(affordance)}</span>
  </label>`
}

function customFieldCreateFormActionsMarkup() {
  return `<div class="row gap-sm wrap top-gap">
    <button type="button" class="secondary tiny" data-retry-custom-field-schema>Retry schema load</button>
    <button type="button" class="secondary tiny" data-open-custom-fields-view>Manage field definitions</button>
  </div>`
}

function customFieldCreateFormMarkup() {
  if (!profileCustomFieldsEl) return
  const fields = state.customFieldSchema.fields || []
  if (state.customFieldSchema.loading) {
    profileCustomFieldsEl.innerHTML =
      '<h4>Firm Custom Fields</h4><p class="muted compact" role="status" aria-live="polite">Loading custom field schema…</p>'
    return
  }
  if (state.customFieldSchema.lastError) {
    profileCustomFieldsEl.innerHTML = `<h4>Firm Custom Fields</h4><p class="error-banner" role="alert">Could not load schema: ${escapeHtml(
      state.customFieldSchema.lastError
    )}</p>
    <p class="muted compact">Profile creation can continue without custom fields, or retry now.</p>
    ${customFieldCreateFormActionsMarkup()}`
    profileCustomFieldsEl.querySelector('[data-retry-custom-field-schema]')?.addEventListener('click', async () => {
      state.customFieldSchema.fetched = false
      await ensureCustomFieldSchema(true)
      customFieldCreateFormMarkup()
    })
    profileCustomFieldsEl.querySelector('[data-open-custom-fields-view]')?.addEventListener('click', () => {
      state.view = 'custom-fields'
      renderCurrentView()
    })
    return
  }
  if (!fields.length) {
    profileCustomFieldsEl.innerHTML =
      '<h4>Firm Custom Fields</h4><p class="muted compact" role="status" aria-live="polite">No custom fields are configured for this firm.</p><p class="muted compact">Create fields to capture operator-specific values in profile and draft workflows.</p>' +
      customFieldCreateFormActionsMarkup()
    profileCustomFieldsEl.querySelector('[data-open-custom-fields-view]')?.addEventListener('click', () => {
      state.view = 'custom-fields'
      renderCurrentView()
    })
    return
  }
  profileCustomFieldsEl.innerHTML = `<h4>Firm Custom Fields</h4><div class="grid two">${fields
    .map((field) => customFieldControlMarkup(field, ''))
    .join('')}</div><p class="muted compact" role="status" aria-live="polite">These values appear on client profiles and carry into draft review context for operators.</p>`
}

function collectCustomFieldValues(formEl, fields = []) {
  const values = {}
  const errors = []
  fields.forEach((field) => {
    const inputName = customFieldInputName(field.key)
    const control = formEl?.elements?.namedItem?.(inputName)
    const raw = control?.type === 'checkbox' ? (control.checked ? 'true' : '') : control?.value ?? ''
    const { value: parsed, error } = parseCustomFieldInputValueStrict(field, raw)
    if (error) errors.push(error)
    if (parsed !== null) values[field.key] = parsed
  })
  return { values, errors }
}

function editableProfileFieldsFromCard(card = {}) {
  const fields = {
    firstName: card.firstName || '',
    lastName: card.lastName || '',
    email: card.email || '',
    phone: card.phone || ''
  }
  ;(state.customFieldSchema.fields || []).forEach((field) => {
    const sourceValue = card?.extensions?.values?.[field.key]
    if (sourceValue == null) fields[customFieldInputName(field.key)] = ''
    else if (field.type === 'boolean') fields[customFieldInputName(field.key)] = sourceValue ? 'true' : 'false'
    else fields[customFieldInputName(field.key)] = String(sourceValue)
  })
  return fields
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
      lastSaveMessage: '',
      lastSaveWasError: false,
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
  entry.lastSaveMessage = 'Profile saved successfully.'
  entry.lastSaveWasError = false
  entry.isEditing = false
}

function failInlineSave(kind, profileId, conflictMessage = '') {
  const entry = ensureInlineProfileState(kind, profileId)
  entry.saving = false
  entry.conflictMessage = conflictMessage || 'Unable to save right now. Retry after reloading latest profile data.'
  entry.lastSaveMessage = entry.conflictMessage
  entry.lastSaveWasError = true
}

function cancelInlineDraft(kind, profileId, card = null) {
  const entry = ensureInlineProfileState(kind, profileId, card)
  entry.draft = { ...entry.latest }
  entry.dirty = false
  entry.saving = false
  entry.conflictMessage = ''
  entry.lastSaveMessage = ''
  entry.lastSaveWasError = false
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

function formatDateTime(value) {
  if (!value) return '—'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return String(value)
  return new Date(parsed).toLocaleString()
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

function isDraftOwner(draft) {
  return Boolean(draft?.createdByUserId) && draft.createdByUserId === state.user?.id
}

function canManageDraftCollaborators(draft) {
  if (!state.user) return false
  if (state.user.role === 'admin') return true
  if (state.user.role !== 'advisor') return false
  return isDraftOwner(draft)
}

function draftCollaboratorDeniedMessage(draft) {
  if (state.user?.role === 'readonly') {
    return 'Readonly role: you can view collaborators but cannot add or remove collaborators.'
  }
  if (state.user?.role === 'advisor' && !isDraftOwner(draft)) {
    return 'Only the draft owner can manage collaborators. You can still review current sharing access.'
  }
  return 'You do not have access to manage draft collaborators.'
}

function collaboratorLookupLabel(user = {}) {
  const name = String(user.label || '').trim()
  const email = String(user.email || '').trim()
  const role = String(user.role || '').trim()
  const pieces = [name || user.id, email && email !== name ? `<${email}>` : '', role ? `(${role})` : ''].filter(Boolean)
  return pieces.join(' ')
}

function canReadDiagnostics() {
  const operationsViewRoles = document.querySelector('[data-view="operations"]')?.dataset.roles || 'admin,advisor'
  return roleAllowed(operationsViewRoles)
}

function canViewLaunchOpsPanel() {
  return roleAllowed('admin') && canReadDiagnostics()
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
  if (!state.user || state.user.role === 'client') {
    state.customFieldSchema = { fetched: true, loading: false, fields: [], updatedAt: '', lastError: '' }
    customFieldCreateFormMarkup()
    return
  }
  await ensureStageConfig()
  await ensureCustomFieldSchema()
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
  customFieldCreateFormMarkup()
}

function metricCard(label, value) {
  return `<div class="stat"><strong>${escapeHtml(value)}</strong><div class="muted">${escapeHtml(label)}</div></div>`
}

const RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS = {
  maxQueueStalled: 0,
  maxQueueDeadLetter: 0,
  maxQueueFailedRetryable: 0
}

const RELEASE_POSTDEPLOY_RULE_RUNBOOK_LINKS = {
  'health-ok': '/docs/deployment-quick-reference.md#3-postdeploy-validation-run-in-this-phase-after-deploy',
  'ready-ok': '/docs/deployment-quick-reference.md#3-postdeploy-validation-run-in-this-phase-after-deploy',
  'ready-checks-all-true': '/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed',
  'queue-stalled-threshold': '/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed',
  'queue-dead-letter-threshold': '/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed',
  'queue-failed-retryable-threshold': '/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed',
  'ready-startup-diagnostics-ok': '/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed',
  'runtime-diagnostics-ok': '/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed'
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

function toOpsNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function evaluateReleaseReadinessRules(snapshot = {}) {
  const healthEndpoint = snapshot.health || {}
  const readyEndpoint = snapshot.ready || {}
  const queueEndpoint = snapshot.queue || {}
  const diagnosticsEndpoint = snapshot.diagnostics || {}

  const healthPayload = healthEndpoint.payload
  const readyPayload = readyEndpoint.payload
  const queuePayload = queueEndpoint.payload
  const diagnosticsPayload = diagnosticsEndpoint.payload

  const queue = queuePayload?.queue || queuePayload || {}
  const diagnosticsStartupRuntime = diagnosticsPayload?.startup?.runtime || diagnosticsPayload?.data?.startup?.runtime || {}
  const readyChecks = readyPayload?.checks && typeof readyPayload.checks === 'object' ? readyPayload.checks : {}
  const failedReadyChecks = Object.entries(readyChecks).filter(([, signal]) => normalizeOpsSignal(signal) !== true)
  const queueStalled = toOpsNumber(queue.stalled)
  const queueDeadLetter = toOpsNumber(queue.machineState?.deadLetter?.count ?? queue.deadLetter)
  const queueFailedRetryable = toOpsNumber(queue.failedRetryable)

  const rules = [
    {
      id: 'health-ok',
      title: '/health healthy',
      threshold: 'must evaluate healthy',
      passed: healthEndpoint.ok ? normalizeOpsSignal(healthPayload) === true : null,
      observed: `status=${healthPayload?.status || 'n/a'}`,
      remediation:
        'Stop GO decisioning, inspect /health dependency checks, remediate failing dependency, then rerun postdeploy evidence capture.'
    },
    {
      id: 'ready-ok',
      title: '/ready ready',
      threshold: 'must evaluate ready',
      passed: readyEndpoint.ok ? normalizeOpsSignal(readyPayload) === true : null,
      observed: `status=${readyPayload?.status || 'n/a'}`,
      remediation:
        'Treat as release blocker. Verify app startup state and external dependencies, remediate, then rerun /ready and postdeploy checks.'
    },
    {
      id: 'ready-checks-all-true',
      title: '/ready checks.*',
      threshold: 'all checks must be true',
      passed: readyEndpoint.ok ? failedReadyChecks.length === 0 && Object.keys(readyChecks).length > 0 : null,
      observed: `failed=${failedReadyChecks.map(([name]) => name).join(', ') || 'none'}; total=${Object.keys(readyChecks).length}`,
      remediation:
        'Review failing readiness checks and clear each dependency-level issue before proceeding. Missing checks evidence should be treated as NO-GO until restored.'
    },
    {
      id: 'queue-stalled-threshold',
      title: 'Queue stalled threshold',
      threshold: `value ≤ ${RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueStalled}`,
      passed: queueEndpoint.ok ? queueStalled <= RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueStalled : null,
      observed: `value=${queueStalled}`,
      remediation:
        'Resolve stalled jobs first: inspect worker lease contention, restart stuck workers safely, and confirm stalled count trends back to threshold.'
    },
    {
      id: 'queue-dead-letter-threshold',
      title: 'Queue dead-letter threshold',
      threshold: `value ≤ ${RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueDeadLetter}`,
      passed: queueEndpoint.ok ? queueDeadLetter <= RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueDeadLetter : null,
      observed: `value=${queueDeadLetter}`,
      remediation:
        'Do not proceed with dead-letter growth. Triage root cause per failed export, apply fix, then retry only safe dead-letter jobs after validation.'
    },
    {
      id: 'queue-failed-retryable-threshold',
      title: 'Queue failed-retryable threshold',
      threshold: `value ≤ ${RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueFailedRetryable}`,
      passed: queueEndpoint.ok
        ? queueFailedRetryable <= RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueFailedRetryable
        : null,
      observed: `value=${queueFailedRetryable}`,
      remediation:
        'Clear retryable backlog by fixing transient failures, validate retries are draining, and hold GO until retryable count remains within threshold.'
    },
    {
      id: 'ready-startup-diagnostics-ok',
      title: '/ready startupDiagnostics.ok',
      threshold: 'true when present',
      passed:
        readyEndpoint.ok && readyPayload
          ? readyPayload?.startupDiagnostics?.ok === undefined || normalizeOpsSignal(readyPayload?.startupDiagnostics?.ok) === true
          : null,
      observed: `ok=${readyPayload?.startupDiagnostics?.ok ?? 'not-present'}`,
      remediation:
        'If startup diagnostics is present and failing, fix runtime config/startup issues before progressing release decisions.'
    },
    {
      id: 'runtime-diagnostics-ok',
      title: '/api/ops/diagnostics startup.runtime.ok',
      threshold: 'must be true',
      passed: diagnosticsEndpoint.ok ? normalizeOpsSignal(diagnosticsStartupRuntime?.ok) === true : null,
      observed: `ok=${diagnosticsStartupRuntime?.ok ?? 'n/a'}`,
      remediation:
        'Treat runtime diagnostics failures as NO-GO. Correct config/security/runtime issues, redeploy if needed, and recapture diagnostics evidence.'
    }
  ]

  return rules.map((rule) => {
    const level = rule.passed === true ? 'PASS' : rule.passed === false ? 'FAIL' : 'WARN'
    const note = rule.passed === null ? 'Evidence unavailable for definitive evaluation.' : rule.observed
    return { ...rule, level, note, runbookHref: RELEASE_POSTDEPLOY_RULE_RUNBOOK_LINKS[rule.id] }
  })
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

function operationRuleSetMarkup() {
  return `
    <details>
      <summary>GO criteria enforced by <code>release:go-no-go --phase postdeploy</code></summary>
      <ul class="muted compact">
        <li><code>/health</code> must evaluate healthy.</li>
        <li><code>/ready</code> must evaluate ready and <code>checks.*</code> must all be true.</li>
        <li><code>queue.stalled</code> must be ≤ <strong>${RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueStalled}</strong>.</li>
        <li><code>queue.machineState.deadLetter.count</code> (or <code>queue.deadLetter</code>) must be ≤ <strong>${RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueDeadLetter}</strong>.</li>
        <li><code>queue.failedRetryable</code> must be ≤ <strong>${RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueFailedRetryable}</strong>.</li>
        <li><code>/ready startupDiagnostics.ok</code> must be true (when present).</li>
        <li><code>/api/ops/diagnostics startup.runtime.ok</code> must be true.</li>
      </ul>
      <p class="muted compact">Token guidance: set <code>KLIENT_OPS_TOKEN_ACTIVE</code> for current checks and keep <code>KLIENT_OPS_TOKEN_PREVIOUS</code> only during rotation windows.</p>
      <p class="muted compact">If a release uses tuned thresholds, set <code>RELEASE_POSTDEPLOY_MAX_QUEUE_*</code> env vars in the command block before running postdeploy.</p>
    </details>
  `
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
    if (canViewLaunchOpsPanel() && !state.operations.snapshot && !state.operations.busy) {
      try {
        await loadOperationsSnapshot()
      } catch {
        // Keep dashboard functional even if operations snapshot is temporarily unavailable.
      }
    }
    const stats = Object.entries(data?.stats || {})
    const launchOpsCards = [
      { key: 'health', title: '/health', href: '/health', data: state.operations.snapshot?.health },
      { key: 'ready', title: '/ready', href: '/ready', data: state.operations.snapshot?.ready },
      {
        key: 'queue',
        title: 'Exports queue',
        href: routes.exportsQueueHealth(),
        data: state.operations.snapshot?.queue
      }
    ]
      .map(({ key, title, href, data }) => {
        const status = deriveOpsCardStatus(key, data)
        const detail = data?.ok ? status.note : data?.error || 'Check unavailable. Open Operations for details.'
        return `<article class="ops-card">
          <div class="row between">
            <strong><a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></strong>
            <span class="ops-badge ${status.level.toLowerCase()}">${status.level}</span>
          </div>
          <p class="muted compact">${escapeHtml(detail)}</p>
        </article>`
      })
      .join('')
    const diagnosticsGeneratedAt = state.operations.snapshot?.diagnostics?.payload?.generatedAt || ''
    const launchOpsPanel = canViewLaunchOpsPanel()
      ? `
        <section class="section-card" data-launch-ops-panel data-requires-role="admin" data-policy-guard="canReadDiagnostics">
          <div class="row between">
            <div>
              <h3 id="launch-ops-heading">Launch Ops</h3>
              <p class="muted compact">Read-only operator checks for release GO/NO-GO decisions.</p>
            </div>
            <button type="button" class="tiny" data-launch-ops-open>Open Operations</button>
          </div>
          <p class="muted compact"><strong>GO:</strong> /health and /ready pass, exports queue has no stalled/dead-letter/retryable-failed jobs, and diagnostics runtime checks remain green.</p>
          <p class="muted compact"><strong>NO-GO:</strong> Any FAIL/WARN below, missing diagnostics evidence, or unresolved queue failures requiring remediation.</p>
          <p class="muted compact">
            Evidence artifacts: store release proof under
            <code>artifacts/release-evidence/&lt;release-id&gt;</code>.
          </p>
          <p class="muted compact">Latest diagnostics timestamp: <strong>${escapeHtml(diagnosticsGeneratedAt || 'Not yet captured')}</strong></p>
          <div class="ops-grid">${launchOpsCards}</div>
        </section>
      `
      : ''
    viewEl.innerHTML = `
      ${flashMarkup()}
      <div class="section-header"><h2 id="dashboard-heading">Dashboard</h2></div>
      <div class="stat-grid">
        ${stats.map(([key, value]) => metricCard(key, value)).join('') || emptyStateMarkup('No dashboard metrics are available yet.')}
      </div>
      ${launchOpsPanel}
      <div class="item compact muted">Recent activity and profile management remain available in their dedicated tabs.</div>
    `
    viewEl.querySelector('[data-launch-ops-open]')?.addEventListener('click', async () => {
      state.view = 'operations'
      queueViewFocus('#operations-heading')
      await renderCurrentView()
    })
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
    <div class="section-header"><div><h2 id="analytics-heading">Analytics</h2><p class="muted">Advisor-facing panels powered by live and materialized summaries.</p></div></div>
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
      (draft) => {
        const panelVisible = state.formsUi.activeDraftSharePanelId === draft.id
        const panelId = `draft-share-panel-${draft.id}`
        const list = state.formsUi.collaboratorsByDraftId[draft.id]
        const lookupResults = state.formsUi.userLookupByDraftId[draft.id] || []
        const lookupSearch = state.formsUi.userLookupSearchByDraftId[draft.id] || ''
        const existingCollaboratorIds = new Set((Array.isArray(list) ? list : []).map((entry) => entry.userId || entry.id))
        const selectableLookupResults = lookupResults.filter(
          (entry) => entry?.id && entry.id !== state.user?.id && !existingCollaboratorIds.has(entry.id)
        )
        const canManage = canManageDraftCollaborators(draft)
        const deniedMessage = draftCollaboratorDeniedMessage(draft)
        const shareFeedback = state.formsUi.shareFeedbackByDraftId[draft.id] || ''
        return `
    <tr>
      <td>${escapeHtml(draft.id)}</td>
      <td>${escapeHtml(draft.templateId)}</td>
      <td>${draft.revisionId || 1}</td>
      <td>${draft.lock ? `Locked (${escapeHtml(draft.lock.holderUserId)})` : 'Unlocked'}</td>
      <td>
        <a href="#${appRoutes.clientFormSubmission(draft.clientId, draft.id)}">Edit from profile</a>
        <button data-lock="${draft.id}">${pendingLabel(`lock-${draft.id}`, 'Acquire lock', 'Acquiring…')}</button>
        <button data-save="${draft.id}">${pendingLabel(`draft-save-${draft.id}`, 'Save revision', 'Saving…')}</button>
        <button data-open-draft-share-panel="${draft.id}" aria-expanded="${panelVisible ? 'true' : 'false'}" aria-controls="${panelId}">
          ${panelVisible ? 'Hide sharing' : 'Share draft'}
        </button>
      </td>
    </tr>
    <tr id="${panelId}" data-draft-share-panel="${draft.id}" ${panelVisible ? '' : 'hidden'}>
      <td colspan="5">
        <div class="item compact">
          <h4>Draft sharing</h4>
          <p class="muted compact">Owner: <code>${escapeHtml(draft.createdByUserId || 'unknown')}</code></p>
          <form data-search-draft-collaborator-users="${draft.id}">
            <label>Search firm users
              <input name="search" placeholder="name, email, or user id" value="${escapeHtml(lookupSearch)}" ${canManage ? '' : 'disabled'} />
            </label>
            <button type="submit" ${canManage ? '' : 'disabled'}>${pendingLabel(`draft-share-search-${draft.id}`, 'Find users', 'Searching…')}</button>
          </form>
          <form data-add-draft-collaborator="${draft.id}">
            <label>Add collaborator
              <select name="userId" ${canManage ? '' : 'disabled'}>
                <option value="">Select a firm user…</option>
                ${selectableLookupResults
                  .map((user) => `<option value="${escapeHtml(user.id || '')}">${escapeHtml(collaboratorLookupLabel(user))}</option>`)
                  .join('')}
              </select>
            </label>
            <button type="submit" ${canManage ? '' : 'disabled'}>${pendingLabel(`draft-share-add-${draft.id}`, 'Add', 'Adding…')}</button>
          </form>
          <p class="muted compact" data-draft-share-feedback="${draft.id}" role="status" aria-live="polite" aria-atomic="true">
            ${escapeHtml(shareFeedback || (!canManage ? deniedMessage : ''))}
          </p>
          ${
            Array.isArray(list)
              ? list.length
                ? `<ul>${list
                    .map(
                      (collaborator) => `<li>
                    <code>${escapeHtml(collaborator.userId || collaborator.id || '')}</code>
                    <button data-remove-draft-collaborator="${draft.id}" data-collaborator-user-id="${escapeHtml(collaborator.userId || collaborator.id || '')}" ${
                      canManage ? '' : 'disabled'
                    }>
                      ${pendingLabel(
                        `draft-share-remove-${draft.id}-${collaborator.userId || collaborator.id || ''}`,
                        'Remove',
                        'Removing…'
                      )}
                    </button>
                  </li>`
                    )
                    .join('')}</ul>`
                : '<p class="muted compact">No collaborators added.</p>'
              : '<p class="muted compact">Load draft sharing to manage collaborators.</p>'
          }
        </div>
      </td>
    </tr>
  `
      }
    )
    .join('')

  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    <p class="muted compact" role="status" aria-live="polite">${escapeHtml(state.workflowStatusMessage || '')}</p>
    <h2 id="forms-heading">Forms + Collaboration</h2>
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
      queueViewFocus(`[data-lock="${button.dataset.lock}"]`)
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
      queueViewFocus(`[data-lock="${button.dataset.lock}"]`)
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
      queueViewFocus(`[data-save="${draftId}"]`)
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
      queueViewFocus(`[data-save="${draftId}"]`)
      await renderForms()
    })
  })

  document.querySelectorAll('[data-open-draft-share-panel]').forEach((button) => {
    button.addEventListener('click', async () => {
      const draftId = button.dataset.openDraftSharePanel
      const isOpen = state.formsUi.activeDraftSharePanelId === draftId
      state.formsUi.activeDraftSharePanelId = isOpen ? '' : draftId
      if (isOpen) {
        await renderForms()
        return
      }
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canManageDraftCollaborators(draft)) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        await renderForms()
        return
      }
      const actionKey = `draft-share-fetch-${draftId}`
      setActionPending(actionKey, 'pending')
      try {
        const [collaborators, userLookup] = await Promise.all([
          request(routes.formDraftCollaborators(draftId)),
          request(routes.users({ mode: 'lookup', limit: 25 }))
        ])
        state.formsUi.collaboratorsByDraftId[draftId] = Array.isArray(collaborators) ? collaborators : collaborators?.collaborators || []
        state.formsUi.userLookupByDraftId[draftId] = Array.isArray(userLookup?.users) ? userLookup.users : []
        state.formsUi.userLookupSearchByDraftId[draftId] = ''
        state.formsUi.shareFeedbackByDraftId[draftId] = 'Collaborators loaded.'
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = normalizeApiError(error, 'load draft collaborators')
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      await renderForms()
    })
  })

  document.querySelectorAll('form[data-search-draft-collaborator-users]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const draftId = form.dataset.searchDraftCollaboratorUsers
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canManageDraftCollaborators(draft)) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        await renderForms()
        return
      }
      const search = String(new FormData(form).get('search') || '').trim()
      state.formsUi.userLookupSearchByDraftId[draftId] = search
      const actionKey = `draft-share-search-${draftId}`
      setActionPending(actionKey, 'pending')
      try {
        const userLookup = await request(routes.users({ mode: 'lookup', search, limit: 25 }))
        state.formsUi.userLookupByDraftId[draftId] = Array.isArray(userLookup?.users) ? userLookup.users : []
        state.formsUi.shareFeedbackByDraftId[draftId] = state.formsUi.userLookupByDraftId[draftId].length
          ? `Found ${state.formsUi.userLookupByDraftId[draftId].length} matching firm users.`
          : 'No matching firm users found.'
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = normalizeApiError(error, 'search firm users')
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      await renderForms()
    })
  })

  document.querySelectorAll('form[data-add-draft-collaborator]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const draftId = form.dataset.addDraftCollaborator
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canManageDraftCollaborators(draft)) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        await renderForms()
        return
      }
      const userId = String(new FormData(form).get('userId') || '').trim()
      if (!userId) {
        state.formsUi.shareFeedbackByDraftId[draftId] = 'Select a collaborator from the firm user results.'
        await renderForms()
        return
      }
      const actionKey = `draft-share-add-${draftId}`
      setActionPending(actionKey, 'pending')
      try {
        await request(routes.formDraftCollaborators(draftId), {
          method: 'POST',
          body: JSON.stringify({ userId })
        })
        const collaborators = await request(routes.formDraftCollaborators(draftId))
        state.formsUi.collaboratorsByDraftId[draftId] = Array.isArray(collaborators)
          ? collaborators
          : collaborators?.collaborators || []
        state.formsUi.userLookupByDraftId[draftId] = (state.formsUi.userLookupByDraftId[draftId] || []).filter(
          (candidate) => candidate.id !== userId
        )
        state.formsUi.shareFeedbackByDraftId[draftId] = `Collaborator ${userId} added.`
        reportActionSuccess('Forms', `Collaborator ${userId} added to draft ${draftId}.`)
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = normalizeApiError(error, 'add a draft collaborator')
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      await renderForms()
    })
  })

  document.querySelectorAll('[data-remove-draft-collaborator]').forEach((button) => {
    button.addEventListener('click', async () => {
      const draftId = button.dataset.removeDraftCollaborator
      const userId = button.dataset.collaboratorUserId
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canManageDraftCollaborators(draft)) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        await renderForms()
        return
      }
      const actionKey = `draft-share-remove-${draftId}-${userId}`
      setActionPending(actionKey, 'pending')
      try {
        await request(routes.formDraftCollaborator(draftId, userId), { method: 'DELETE' })
        const collaborators = await request(routes.formDraftCollaborators(draftId))
        state.formsUi.collaboratorsByDraftId[draftId] = Array.isArray(collaborators)
          ? collaborators
          : collaborators?.collaborators || []
        if (!state.formsUi.userLookupByDraftId[draftId]?.some((candidate) => candidate.id === userId)) {
          state.formsUi.userLookupByDraftId[draftId] = [
            ...(state.formsUi.userLookupByDraftId[draftId] || []),
            { id: userId, label: userId, email: '', role: '' }
          ]
        }
        state.formsUi.shareFeedbackByDraftId[draftId] = `Collaborator ${userId} removed.`
        reportActionSuccess('Forms', `Collaborator ${userId} removed from draft ${draftId}.`)
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = normalizeApiError(error, 'remove a draft collaborator')
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
        queueViewFocus(`form[data-repeater-update="${form.dataset.repeaterUpdate}"][data-item-key="${itemKey}"]`)
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
        queueViewFocus(`[data-repeater-delete="${button.dataset.repeaterDelete}"][data-item-key="${itemKey}"]`)
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
  focusWithinView('#forms-heading')
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
  const savedAt = saveState.savedAt ? new Date(saveState.savedAt).toLocaleTimeString() : ''
  if (saveState.status === 'saving') return 'Saving…'
  if (saveState.status === 'dirty') return 'Unsaved edits · autosave pending'
  if (saveState.status === 'error') return `Error (${saveState.message || 'retry'})`
  if (saveState.status === 'recovered') return savedAt ? `Recovered · saved ${savedAt}` : 'Recovered'
  if (saveState.status === 'saved') return savedAt ? `Saved ${savedAt}` : 'Saved'
  return 'Ready'
}

function publishBlockersMarkup({ hasLocalMappingErrors, hasBlockingPreviewWarnings, preflightIssues = [], preflightIssueRows = new Set() }) {
  const blockers = []
  if (hasLocalMappingErrors) {
    blockers.push(
      '<li><strong>Local mapping validation failed.</strong> Fix rows marked in <em>Local validation</em>, then run <em>Save Now</em> to clear this blocker.</li>'
    )
  }
  if (hasBlockingPreviewWarnings) {
    blockers.push(
      '<li><strong>Preview reported blocking warnings/issues.</strong> Use the row jump buttons in Preview/Remediation, correct the source path or transform, then rerun Preview.</li>'
    )
  }
  if (preflightIssues.length) {
    blockers.push(
      `<li><strong>Publish preflight failed.</strong> ${preflightIssues.length} schema issue(s) across ${preflightIssueRows.size || 0} row(s). Resolve listed issue IDs and rerun preflight.</li>`
    )
  }
  if (!blockers.length) return ''
  return `<div class="publish-blockers" role="status" aria-live="polite"><p class="publish-disabled-reason"><strong>Publish blocked:</strong></p><ul>${blockers.join('')}</ul></div>`
}

function operationsQueueActionPlanMarkup(snapshot = {}) {
  const queuePayload = snapshot?.queue?.payload
  const queue = queuePayload?.queue || queuePayload || {}
  const stalled = toOpsNumber(queue.stalled)
  const deadLetter = toOpsNumber(queue.machineState?.deadLetter?.count ?? queue.deadLetter)
  const retryable = toOpsNumber(queue.failedRetryable)
  const actions = []
  if (stalled > RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueStalled) {
    actions.push(
      `<li><span class="ops-badge fail">STALLED</span> ${stalled} stalled job(s). <strong>Next step:</strong> inspect worker lease contention and restart stuck workers safely. <a href="/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed">Runbook</a></li>`
    )
  }
  if (deadLetter > RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueDeadLetter) {
    actions.push(
      `<li><span class="ops-badge fail">DEAD-LETTER</span> ${deadLetter} dead-letter job(s). <strong>Next step:</strong> triage root cause per failed export, patch the cause, then retry only validated jobs. <a href="/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed">Runbook</a></li>`
    )
  }
  if (retryable > RELEASE_POSTDEPLOY_GUIDANCE_THRESHOLDS.maxQueueFailedRetryable) {
    actions.push(
      `<li><span class="ops-badge warn">RETRYABLE</span> ${retryable} retryable failure(s). <strong>Next step:</strong> fix transient dependencies and confirm backlog drains before GO.</li>`
    )
  }
  if (!actions.length) {
    return '<p class="muted compact">Queue action plan: no actionable queue blockers detected for stalled/dead-letter/retryable thresholds.</p>'
  }
  return `<section class="ops-action-plan" aria-labelledby="ops-action-plan-heading"><h3 id="ops-action-plan-heading">Actionable queue states</h3><ul class="ops-action-list">${actions.join('')}</ul><p class="muted compact">Proceed to GO only after each state returns to threshold and diagnostics evidence is recaptured.</p></section>`
}

function previewWarningMarkup(warnings = []) {
  if (!Array.isArray(warnings) || !warnings.length) return '<span class="muted">None</span>'
  return warnings
    .map((warning) => {
      const title = escapeHtml(warning.message || warning.code || 'Warning')
      const badgeClass = warning.blocking ? 'error-badge' : 'badge'
      const suffix = warning.blocking ? ' (blocking)' : ''
      return `<span class="${badgeClass}" title="${title}">${escapeHtml((warning.code || 'warning') + suffix)}</span>`
    })
    .join(' ')
}

function normalizedExtractedFields(template = {}) {
  if (!Array.isArray(template?.extractedFields)) return []
  return template.extractedFields
    .map((field, index) => {
      if (typeof field === 'string') {
        return {
          id: field,
          fieldName: field,
          fieldType: 'text',
          pageIndex: null,
          required: false,
          readOnly: false,
          index
        }
      }
      const fieldName = String(field?.fieldName || field?.name || field?.pdfField || '').trim()
      if (!fieldName) return null
      return {
        id: `${fieldName}-${index}`,
        fieldName,
        fieldType: String(field?.fieldType || field?.type || 'text'),
        pageIndex: Number.isInteger(field?.pageIndex) ? field.pageIndex : null,
        required: field?.required === true,
        readOnly: field?.readOnly === true,
        index
      }
    })
    .filter(Boolean)
}

function normalizedKnownPathIndex(knownPaths = new Map()) {
  const entries = [...knownPaths.entries()].map(([path, type]) => {
    const normalizedPath = String(path || '').trim()
    const leaf = normalizedPath.split('.').pop() || normalizedPath
    return {
      path: normalizedPath,
      type: String(type || 'text'),
      leaf,
      normalizedLeaf: leaf.toLowerCase().replace(/[^a-z0-9]+/g, '')
    }
  })
  return {
    entries,
    byPath: new Map(entries.map((entry) => [entry.path, entry]))
  }
}

function mappingAutoMatchScore(sourceLabel = '', candidatePath = '') {
  const left = String(sourceLabel || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const rightLeaf = String(candidatePath || '')
    .split('.')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  if (!left || !rightLeaf) return 0
  if (left === rightLeaf) return 1
  if (left.includes(rightLeaf) || rightLeaf.includes(left)) return 0.85
  const leftTokens = new Set(String(sourceLabel || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const rightTokens = new Set(String(candidatePath || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const tokenScore = overlap / Math.max(1, leftTokens.size, rightTokens.size)
  return tokenScore * 0.75
}

function bestSourcePathSuggestion({ mapping = {}, knownPathIndex, localIssues = [], serverPreflightIssues = [] }) {
  const currentPath = String(mapping.sourcePath || '').trim()
  const sourceLabel = String(mapping.fieldLabel || mapping.pdfField || '').trim()
  const hasUnknownPathIssue =
    localIssues.includes('Unknown source path') ||
    serverPreflightIssues.some((issue) => String(issue.code || '').includes('unknown_source_path'))
  const isMissingPath = !currentPath
  if (!isMissingPath && !hasUnknownPathIssue) return null

  const serverSuggestion = serverPreflightIssues
    .flatMap((issue) => issue?.meta?.suggestedSourcePaths || [])
    .map((entry) =>
      typeof entry === 'string'
        ? { path: entry, score: 0.91, reason: 'Server suggestion' }
        : { path: String(entry?.path || ''), score: Number(entry?.score || 0.9), reason: 'Server suggestion' }
    )
    .find((entry) => entry.path)
  if (serverSuggestion && (!currentPath || currentPath !== serverSuggestion.path)) return serverSuggestion

  const bestLocal = knownPathIndex.entries
    .map((candidate) => ({ candidate, score: mappingAutoMatchScore(sourceLabel, candidate.path) }))
    .sort((a, b) => b.score - a.score)[0]
  if (!bestLocal || bestLocal.score < 0.8) return null
  if (currentPath && currentPath === bestLocal.candidate.path) return null
  return {
    path: bestLocal.candidate.path,
    score: bestLocal.score,
    reason: 'Name similarity'
  }
}

function normalizeTransformDraftFromMapping(mapping = {}) {
  const legacyTransform = mapping?.formatter || mapping?.format || ''
  const transformInput = mapping?.transform ?? legacyTransform
  if (typeof transformInput === 'string') {
    const transformType = transformInput === 'custom' ? 'expression' : transformInput
    return {
      transformType: String(transformType || ''),
      transformExpression: String(mapping?.expression || ''),
      transformCurrency: ''
    }
  }
  const transformType = String(transformInput?.type || '').trim()
  return {
    transformType: transformType === 'custom' ? 'expression' : transformType,
    transformExpression: String(transformInput?.expression || mapping?.expression || ''),
    transformCurrency: String(transformInput?.currency || '')
  }
}

function mappingDraftFromAnyShape(mapping = {}) {
  const transformDraft = normalizeTransformDraftFromMapping(mapping)
  return {
    pdfField: String(mapping.pdfField || mapping.targetField || mapping.field || mapping.key || ''),
    fieldLabel: String(mapping.fieldLabel || mapping.label || mapping.fieldName || ''),
    sourcePath: String(mapping.sourcePath || mapping.path || mapping.source || ''),
    defaultValue: mapping.defaultValue == null ? '' : String(mapping.defaultValue),
    targetType: String(mapping.targetType || 'text'),
    required: mapping.required === true,
    enabled: mapping.enabled !== false,
    ...transformDraft
  }
}

function mappingConfidenceBadge(mapping = {}, knownPathIndex) {
  const sourcePath = String(mapping.sourcePath || '').trim()
  if (!sourcePath) return { tone: 'low', label: 'Unmapped' }
  if (!knownPathIndex.byPath.has(sourcePath)) return { tone: 'low', label: 'Low confidence' }
  const sourceLabel = String(mapping.fieldLabel || mapping.pdfField || '').trim()
  const score = mappingAutoMatchScore(sourceLabel, sourcePath)
  if (score >= 0.95) return { tone: 'high', label: 'High confidence' }
  if (score >= 0.75) return { tone: 'medium', label: 'Medium confidence' }
  return { tone: 'low', label: 'Low confidence' }
}

function templateIngestionRecoveryMessage(extraction = {}) {
  const reasonCode = String(extraction?.reasonCode || '').trim()
  if (reasonCode === 'malformed_pdf') {
    return 'The uploaded file could not be parsed as a valid PDF. Re-export the document from the source system, verify it opens locally, then upload again.'
  }
  if (reasonCode === 'no_acroform') {
    return 'No AcroForm metadata was found. Use a fillable PDF with AcroForm fields, or continue with manual template creation and add mappings yourself.'
  }
  if (reasonCode === 'no_fields') {
    return 'AcroForm metadata exists, but no fillable fields were detected. Confirm fields are interactive inputs (not flattened text), then re-upload.'
  }
  return extraction?.error?.message || 'Template ingestion failed. Review the PDF and retry upload, or continue with manual mappings.'
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
  if (!state.templateMappingFilterByTemplateId) state.templateMappingFilterByTemplateId = {}
  if (!state.templateMappingSuggestionsByTemplateId) state.templateMappingSuggestionsByTemplateId = {}
  if (!state.templateInspectorFocusRequestByTemplateId) state.templateInspectorFocusRequestByTemplateId = {}
  if (!state.templateJumpHighlightByTemplateId) state.templateJumpHighlightByTemplateId = {}

  const mappingDraftFromServer = (mapping = {}) => mappingDraftFromAnyShape(mapping)
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
  const preflightIssuesByRowIndex = new Map()
  const preflightIssuesByRowId = new Map()
  preflightIssues.forEach((issue) => {
    const rowIndex = Number(issue.rowIndex)
    const rowId = String(issue?.rowId || issue?.meta?.rowId || '').trim()
    if (Number.isFinite(rowIndex)) {
      const list = preflightIssuesByRowIndex.get(rowIndex) || []
      list.push(issue)
      preflightIssuesByRowIndex.set(rowIndex, list)
    }
    if (rowId) {
      const list = preflightIssuesByRowId.get(rowId) || []
      list.push(issue)
      preflightIssuesByRowId.set(rowId, list)
    }
  })
  const preflightIssueRows = new Set(preflightIssues.map((issue) => Number(issue.rowIndex)).filter((value) => Number.isFinite(value)))
  const previewRows = Array.isArray(preview?.rows) ? preview.rows : []
  const previewRowsByIndex = new Map(previewRows.map((row) => [Number(row.rowIndex), row]).filter(([index]) => Number.isFinite(index)))
  const previewWarningRows = new Set(previewRows.filter((row) => Array.isArray(row.warnings) && row.warnings.length).map((row) => Number(row.rowIndex)).filter((value) => Number.isFinite(value)))
  const previewIssueRows = new Set((preview?.issues || []).map((issue) => Number(issue.rowIndex)).filter((value) => Number.isFinite(value)))
  const remediationRows = [
    ...previewRows
      .flatMap((row) =>
        (row.warnings || []).map((warning) => ({
          rowIndex: Number(row.rowIndex),
          rowId: row.rowId || '',
          blocking: warning.blocking === true,
          code: warning.code || 'warning',
          message: warning.message || 'Preview warning'
        }))
      ),
    ...preflightIssues.map((issue) => ({
      rowIndex: Number(issue.rowIndex),
      rowId: issue?.meta?.rowId || '',
      blocking: true,
      code: issue.errorCode || issue.code || 'issue',
      message: issue.errorMessage || issue.message || 'Preflight validation issue'
    }))
  ].filter((entry) => Number.isFinite(entry.rowIndex))
  const hasLocalMappingErrors = [...mappingIssuesByIndex.values()].some((issues) => issues.length > 0)
  const hasBlockingPreviewWarnings =
    Number(preview?.blockingWarningsCount || 0) > 0 || (preview?.issues || []).some((issue) => issue.blocking)
  const publishDisabled = hasLocalMappingErrors || hasBlockingPreviewWarnings || preflightIssues.length > 0
  const templateFilter = state.templateMappingFilterByTemplateId[template?.id] || 'all'
  const allowedTemplateFilters = new Set(['all', 'needs-fix', 'unresolved-only', 'unmapped', 'preview-warning', 'required-only'])
  const activeTemplateFilter = allowedTemplateFilters.has(templateFilter) ? templateFilter : 'all'
  if (template && activeTemplateFilter !== templateFilter) state.templateMappingFilterByTemplateId[template.id] = activeTemplateFilter
  const rowJumpHighlight = template ? Number(state.templateJumpHighlightByTemplateId[template.id]) : NaN
  const suggestionDraftByIndex = template ? state.templateMappingSuggestionsByTemplateId[template.id] || {} : {}
  const suggestionByIndex = new Map()
  let unresolvedRowsCount = 0
  draftMappings.forEach((mapping, index) => {
    const rowIssues = mappingIssuesByIndex.get(index) || []
    const previewRow = previewRowsByIndex.get(index)
    const rowId = String(previewRow?.rowId || '').trim()
    const serverPreflightIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
    const unresolved = !String(mapping.sourcePath || '').trim() || rowIssues.includes('Unknown source path') || serverPreflightIssues.length > 0
    if (unresolved) unresolvedRowsCount += 1
    const persistedSuggestion = suggestionDraftByIndex[index]
    if (persistedSuggestion?.path) {
      suggestionByIndex.set(index, persistedSuggestion)
      return
    }
    const computed = bestSourcePathSuggestion({
      mapping,
      knownPathIndex,
      localIssues: rowIssues,
      serverPreflightIssues
    })
    if (computed) suggestionByIndex.set(index, computed)
  })

  const selectedRowIndex = Number.isInteger(state.templateInspector?.[template?.id]?.rowIndex)
    ? state.templateInspector[template.id].rowIndex
    : 0
  const safeSelectedRowIndex = Math.min(Math.max(selectedRowIndex, 0), Math.max(0, draftMappings.length - 1))
  if (template) state.templateInspector[template.id] = { rowIndex: safeSelectedRowIndex }
  const selectedMapping = draftMappings[safeSelectedRowIndex] || mappingDraftFromServer({})

  const mappedFieldSet = new Set(draftMappings.map((entry) => String(entry.pdfField || '').trim()).filter(Boolean))
  const extractedFields = normalizedExtractedFields(template)
  const knownPathIndex = normalizedKnownPathIndex(knownPaths)
  const mappedExtractedCount = extractedFields.filter((field) => mappedFieldSet.has(field.fieldName)).length
  const extraction = template?.extraction || {}
  const wizardSteps = ['upload', 'extraction', 'mapping', 'preview', 'publish']
  const defaultWizardStep = extraction?.status === 'failed' ? 'extraction' : extractedFields.length ? 'mapping' : 'upload'
  const activeWizardStep = wizardSteps.includes(state.templateWizardStepByTemplateId?.[template?.id])
    ? state.templateWizardStepByTemplateId[template.id]
    : defaultWizardStep
  if (template) state.templateWizardStepByTemplateId[template.id] = activeWizardStep
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
    <div class="section-header"><h2 id="templates-heading">Template Builder</h2></div>
    <label>Template
      <select id="template-select">${templates
        .map((entry) => `<option value="${entry.id}" ${entry.id === template?.id ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`)
        .join('')}</select>
    </label>
    ${
      template
        ? `
      <section class="item">
        <h3>Template Builder Flow</h3>
        <div class="row gap-sm wrap">
          ${wizardSteps
            .map((step, index) => {
              const label = `${index + 1}. ${step.charAt(0).toUpperCase() + step.slice(1)}`
              return `<button type="button" class="tiny ${activeWizardStep === step ? '' : 'secondary'}" data-template-wizard-step="${step}" aria-pressed="${activeWizardStep === step ? 'true' : 'false'}">${label}</button>`
            })
            .join('')}
        </div>
      </section>
      <section class="item" data-template-wizard-section="upload" ${activeWizardStep === 'upload' ? '' : 'hidden'}>
        <h3>Step 1 · Upload</h3>
        <p class="muted">Use the Create Document Template form to upload a fillable PDF and auto-build mappings, or continue manually without upload.</p>
      </section>
      <section class="item" data-template-wizard-section="extraction" ${activeWizardStep === 'extraction' ? '' : 'hidden'}>
        <h3>Step 2 · Extraction Summary</h3>
        <p class="muted">Status: <span class="badge ${extraction?.status === 'failed' ? 'error-badge' : 'subtle'}">${escapeHtml(extraction?.status || 'unknown')}</span></p>
        <p class="muted">Reason code: <code>${escapeHtml(extraction?.reasonCode || 'none')}</code></p>
        ${
          extraction?.status === 'failed'
            ? `<p class="error-banner">${escapeHtml(templateIngestionRecoveryMessage(extraction))}</p>`
            : '<p class="muted">Extraction completed. Review mapped/unmapped fields before editing mappings.</p>'
        }
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Mapping Health</h3>
        <div class="row wrap gap-sm">
          <span class="badge">Mapped ${draftMappings.filter((entry) => entry.enabled !== false && String(entry.pdfField || '').trim()).length}</span>
          <span class="badge subtle">Unmapped ${Math.max(0, extractedFields.length - mappedExtractedCount)}</span>
          <span class="badge ${hasLocalMappingErrors ? 'error-badge' : 'warning-badge'}">Validation ${hasLocalMappingErrors ? 'Needs fixes' : 'Ready'}</span>
          <span class="badge subtle">Autosave: ${escapeHtml(mappingSaveStateLabel(saveState))}</span>
        </div>
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Extracted AcroForm Fields</h3>
        <ul>${extractedFields
          .map((field) => {
            const mapped = mappedFieldSet.has(field.fieldName)
            return `<li><strong>${escapeHtml(field.fieldName)}</strong> <span class="badge">${escapeHtml(field.fieldType)}</span>${field.required ? ' <span class="badge warning-badge">Required</span>' : ''}${field.readOnly ? ' <span class="badge subtle">Read-only</span>' : ''}${field.pageIndex != null ? ` <span class="badge subtle">Page ${field.pageIndex + 1}</span>` : ''} <span class="badge ${mapped ? 'subtle' : ''}">${mapped ? 'Mapped' : 'Unmapped'}</span><button data-remove-extracted="${field.index}" class="secondary tiny">Remove</button></li>`
          })
          .join('') || '<li class="muted">No extracted fields yet.</li>'}</ul>
        <div class="row gap-sm">
          <input id="new-extracted-field" placeholder="pdf_field_name" />
          <button id="add-extracted-field" class="tiny">Add</button>
        </div>
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Source Path Discovery</h3>
        <div class="muted">Known paths from profile + form schema: ${[...knownPaths.keys()]
          .map((path) => `<code>${escapeHtml(path)}</code>`)
          .join(', ')}</div>
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Mappings</h3>
        <div class="row gap-sm wrap">
          <button id="add-mapping-row" class="tiny">Add Mapping</button>
          <button id="save-mappings" class="tiny">Save Now</button>
          <button id="suggest-source-paths" class="tiny secondary">Suggest source paths</button>
          <button id="apply-suggested-mappings" class="tiny secondary">Apply suggestions</button>
          <button id="filter-unresolved-rows" class="tiny secondary">Filter unresolved</button>
          <button id="auto-map-similar" class="tiny secondary">Auto-map similar names</button>
          <button id="clear-unresolved-rows" class="tiny secondary">Clear unresolved rows</button>
        </div>
        <div class="row gap-sm wrap top-gap">
          ${[
            { value: 'all', label: `All (${draftMappings.length})` },
            { value: 'needs-fix', label: `Needs fix (${draftMappings.filter((_, index) => (mappingIssuesByIndex.get(index) || []).length > 0 || preflightIssues.some((issue) => Number(issue.rowIndex) === index)).length})` },
            { value: 'unresolved-only', label: `Unresolved only (${unresolvedRowsCount})` },
            { value: 'unmapped', label: `Unmapped (${draftMappings.filter((mapping) => !String(mapping.pdfField || '').trim()).length})` },
            { value: 'preview-warning', label: `Preview warning (${draftMappings.filter((_, index) => previewWarningRows.has(index) || previewIssueRows.has(index)).length})` },
            { value: 'required-only', label: `Required only (${draftMappings.filter((mapping) => mapping.required === true).length})` }
          ]
            .map(
              (filter) =>
                `<button type="button" class="tiny ${activeTemplateFilter === filter.value ? '' : 'secondary'}" data-mapping-filter="${filter.value}" aria-pressed="${activeTemplateFilter === filter.value ? 'true' : 'false'}">${filter.label}</button>`
            )
            .join('')}
        </div>
        <table><thead><tr><th>#</th><th>State</th><th>PDF Field</th><th>Source Path</th><th>Suggested</th><th>Label</th><th>Confidence</th><th>Local validation</th><th>Server preflight</th><th>Preview</th><th>Sample</th></tr></thead><tbody>
          ${draftMappings
            .map((mapping, index) => {
              const issues = mappingIssuesByIndex.get(index) || []
              const hasPreviewWarnings = previewWarningRows.has(index) || previewIssueRows.has(index)
              const previewRow = previewRowsByIndex.get(index)
              const rowId = String(previewRow?.rowId || '').trim()
              const serverPreflightIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
              const isUnmapped = !String(mapping.pdfField || '').trim()
              const isUnresolved = !String(mapping.sourcePath || '').trim() || issues.includes('Unknown source path') || serverPreflightIssues.length > 0
              const showRow =
                activeTemplateFilter === 'all' ||
                (activeTemplateFilter === 'needs-fix' && (issues.length > 0 || serverPreflightIssues.length > 0)) ||
                (activeTemplateFilter === 'unresolved-only' && isUnresolved) ||
                (activeTemplateFilter === 'unmapped' && isUnmapped) ||
                (activeTemplateFilter === 'preview-warning' && hasPreviewWarnings) ||
                (activeTemplateFilter === 'required-only' && mapping.required === true)
              if (!showRow) return ''
              const sampleValue = resolveSampleValue(mapping.sourcePath)
              const rowClasses = ['mapping-row-item']
              if (index === safeSelectedRowIndex) rowClasses.push('is-selected')
              if (index === rowJumpHighlight) rowClasses.push('is-jumped')
              const confidence = mappingConfidenceBadge(mapping, knownPathIndex)
              const suggestion = suggestionByIndex.get(index)
              const stateBadge =
                mapping.enabled === false
                  ? '<span class="badge subtle">Disabled</span>'
                  : issues.length || serverPreflightIssues.length
                    ? '<span class="error-badge">Needs fix</span>'
                    : !String(mapping.sourcePath || '').trim()
                      ? '<span class="warning-badge">Missing source</span>'
                      : '<span class="badge subtle">Ready</span>'
              return `<tr id="mapping-row-${index}" class="${rowClasses.join(' ')}" data-select-row="${index}" data-row-id="${escapeHtml(rowId)}" tabindex="0">
                <td>${index + 1}</td>
                <td>${stateBadge}</td>
                <td>${escapeHtml(mapping.pdfField || '')}</td>
                <td>${escapeHtml(mapping.sourcePath || '')}</td>
                <td>${
                  suggestion
                    ? `<span class="badge subtle">${escapeHtml(suggestion.path)}</span><div class="muted">${escapeHtml(suggestion.reason || 'Suggested')} (${Math.round(Number(suggestion.score || 0) * 100)}%)</div>`
                    : '<span class="muted">None</span>'
                }</td>
                <td>${escapeHtml(mapping.fieldLabel || '')}</td>
                <td><span class="badge subtle">${escapeHtml(confidence.label)}</span></td>
                <td>${issues.length ? `<span class="error-badge">${escapeHtml(issues.join('; '))}</span><div class="muted">Hint: update Source Path using known paths and rerun Save Now.</div>` : '<span class="muted">OK</span>'}</td>
                <td>${serverPreflightIssues.length ? `<span class="error-badge">${escapeHtml(serverPreflightIssues.map((issue) => issue.code || issue.message || 'issue').join(', '))}</span>` : '<span class="muted">None</span>'}</td>
                <td>${hasPreviewWarnings ? '<span class="warning-badge">Preview warning</span>' : '<span class="muted">OK</span>'}</td>
                <td>${escapeHtml(sampleValue == null ? '' : String(sampleValue))}</td>
              </tr>`
            })
            .join('') || '<tr><td colspan="11" class="muted">No mappings match this filter.</td></tr>'}
        </tbody></table>
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Field Inspector</h3>
        <div class="muted">Selected row ${safeSelectedRowIndex + 1} of ${Math.max(1, draftMappings.length)}${selectedMapping.enabled === false ? ' (disabled)' : ''}</div>
        <div class="row wrap gap-sm">
          ${
            selectedMapping.enabled === false
              ? '<span class="badge subtle">State: disabled</span>'
              : '<span class="badge subtle">State: enabled</span>'
          }
          ${
            (mappingIssuesByIndex.get(safeSelectedRowIndex) || []).length
              ? `<span class="error-badge">Local issues: ${escapeHtml((mappingIssuesByIndex.get(safeSelectedRowIndex) || []).join('; '))}</span>`
              : '<span class="badge subtle">Local validation: OK</span>'
          }
          ${
            (preflightIssuesByRowIndex.get(safeSelectedRowIndex) || []).length
              ? `<span class="error-badge">Preflight issues: ${escapeHtml(
                  (preflightIssuesByRowIndex.get(safeSelectedRowIndex) || []).map((issue) => issue.code || issue.message || 'issue').join(', ')
                )}</span>`
              : '<span class="badge subtle">Preflight: clear</span>'
          }
        </div>
        <p class="muted">Validation hints: ensure PDF Field + Source Path are filled, Source Path exists in known paths, and expression transforms include an expression.</p>
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
      <section class="item" data-template-wizard-section="preview" ${activeWizardStep === 'preview' ? '' : 'hidden'}>
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
          <div class="muted">blocking warnings: ${escapeHtml(String(preview.blockingWarningsCount || 0))}</div>
          ${preview.issues?.length ? `<div class="muted">issues: ${escapeHtml(String(preview.issues.length))}</div>` : ''}
          <table><thead><tr><th>PDF field</th><th>Source path</th><th>Resolved value</th><th>Warnings</th></tr></thead><tbody>
            ${(preview.rows || [])
              .map((row) => {
                const rowIndex = Number(row.rowIndex)
                const hasWarnings = Array.isArray(row.warnings) && row.warnings.length > 0
                return `<tr>
              <td>${escapeHtml(row.pdfField || '')}</td>
              <td>${escapeHtml(row.sourcePath || '')}</td>
              <td>${escapeHtml(row.value == null ? '' : String(row.value))}</td>
              <td>${
                hasWarnings
                  ? `<button class="tiny secondary" data-jump-rowindex="${rowIndex}" data-jump-rowid="${escapeHtml(row.rowId || '')}" data-focus-inspector="sourcePath">Jump to row ${rowIndex + 1}</button>`
                  : `<span class="muted">Row ${rowIndex + 1}</span>`
              } <span class="muted">id:<code>${escapeHtml(row.rowId || '')}</code></span> ${previewWarningMarkup(row.warnings || [])}</td>
            </tr>`
              })
              .join('')}
          </tbody></table>
        `
            : 'Run preview to validate mapping output against real data. Sample values shown in the mapping table are non-blocking hints.'
        }</div>
      </section>
      <section class="item" data-template-wizard-section="publish" ${activeWizardStep === 'publish' ? '' : 'hidden'}>
        <h3>Publish</h3>
        <div class="row gap-sm wrap">
          <button id="run-publish-preflight" class="tiny secondary">Run Publish Preflight</button>
          <button id="publish-template" class="tiny publish-action" ${publishDisabled ? 'disabled' : ''}>Publish</button>
        </div>
        ${publishBlockersMarkup({ hasLocalMappingErrors, hasBlockingPreviewWarnings, preflightIssues, preflightIssueRows })}
        ${
          preflightIssues.length
            ? `<p class="publish-disabled-reason">Publish preflight found ${preflightIssues.length} schema validation issue(s) across ${preflightIssueRows.size || 0} mapped row(s).</p><ul>${preflightIssues
                .map((issue) => {
                  const rowIndex = Number(issue.rowIndex)
                  const rowId = String(issue?.rowId || issue?.meta?.rowId || '').trim()
                  const rowCta = Number.isFinite(rowIndex)
                    ? `<button class="tiny secondary" data-preflight-rowindex="${rowIndex}" data-preflight-rowid="${escapeHtml(rowId)}" data-focus-inspector="sourcePath">Row ${rowIndex + 1}</button> · `
                    : ''
                  return `<li>${rowCta}<code>${escapeHtml(issue?.meta?.issueId || issue.code || 'issue')}</code> · ${escapeHtml(formatSchemaIssue(issue))}</li>`
                })
                .join('')}</ul>`
            : '<p class="muted">Run preflight to surface publish-time schema validation (unknown source paths, required mappings, and transform issues) before attempting publish.</p>'
        }
        ${
          remediationRows.length
            ? `<h4>Row-level remediation</h4><ul>${remediationRows
                .map(
                  (item) =>
                    `<li><button class="tiny secondary" data-remediate-rowindex="${item.rowIndex}" data-remediate-rowid="${escapeHtml(item.rowId || '')}" data-focus-inspector="sourcePath">Row ${item.rowIndex + 1}</button> · <code>${escapeHtml(item.code)}</code> · ${escapeHtml(item.message)}${item.rowId ? ` · rowId <code>${escapeHtml(item.rowId)}</code>` : ''}${item.blocking ? ' · <strong>blocking</strong>' : ' · non-blocking'}</li>`
                )
                .join('')}</ul>`
            : ''
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

  const rerenderTemplates = async (selector = '#templates-heading') => {
    queueViewFocus(selector)
    await renderTemplates()
  }

  const persistMappings = async ({ autosave = false } = {}) => {
    const actionKey = `template-map-save-${template.id}`
    const previousSaveStatus = state.templateSaveStateByTemplateId[template.id]?.status || 'idle'
    if (autosave) setActionPending(actionKey, 'saving')
    state.templateSaveStateByTemplateId[template.id] = { status: 'saving' }
    const mappings = (state.templateMappingDrafts[template.id] || []).map((mapping) => normalizeMappingDraft(mapping))
    const requiredPdfFields = normalizedExtractedFields(template).map((field) => field.fieldName)
    try {
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings, requiredPdfFields })
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
    const selectedTemplate = templates.find((entry) => entry.id === state.selectedTemplateId)
    if (selectedTemplate) {
      const mappingCount = (selectedTemplate.mappings || []).length
      setWorkflowStatus(`Template selected: ${selectedTemplate.name} (${mappingCount} mappings).`)
    }
    await rerenderTemplates()
  })
  document.querySelectorAll('[data-template-wizard-step]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!template) return
      state.templateWizardStepByTemplateId[template.id] = button.dataset.templateWizardStep || 'mapping'
      await rerenderTemplates()
    })
  })
  document.querySelectorAll('[data-remove-extracted]').forEach((button) => {
    button.addEventListener('click', async () => {
      const next = normalizedExtractedFields(template).map((field) => field.fieldName)
      next.splice(Number(button.dataset.removeExtracted), 1)
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings: (state.templateMappingDrafts[template.id] || []).map((entry) => normalizeMappingDraft(entry)), requiredPdfFields: next })
      })
      setFlash('success', 'Extracted field removed.')
      await rerenderTemplates()
    })
  })
  document.querySelector('#add-extracted-field')?.addEventListener('click', async () => {
    const input = document.querySelector('#new-extracted-field')
    const value = String(input?.value || '').trim()
    if (!value) return
    const next = Array.from(new Set([...normalizedExtractedFields(template).map((field) => field.fieldName), value]))
    await request(routes.documentTemplateMappings(template.id), {
      method: 'POST',
      body: JSON.stringify({ mappings: (state.templateMappingDrafts[template.id] || []).map((entry) => normalizeMappingDraft(entry)), requiredPdfFields: next })
    })
    setFlash('success', 'Extracted field added.')
    await rerenderTemplates()
  })

  const selectTemplateRow = async (rowIndex, { focusInspector = false, focusField = 'sourcePath', highlightRow = false } = {}) => {
    if (!template) return
    const normalizedRowIndex = Number(rowIndex)
    if (!Number.isFinite(normalizedRowIndex)) return
    state.templateInspector[template.id] = { rowIndex: normalizedRowIndex }
    state.templateInspectorFocusRequestByTemplateId[template.id] = focusInspector ? focusField : ''
    state.templateJumpHighlightByTemplateId[template.id] = highlightRow ? normalizedRowIndex : NaN
    await renderTemplates()
  }

  const selectTemplateRowFromIssue = async (
    rowIndex,
    rowId,
    { focusInspector = false, focusField = 'sourcePath', highlightRow = true } = {}
  ) => {
    const numericRowIndex = Number(rowIndex)
    if (Number.isFinite(numericRowIndex)) {
      await selectTemplateRow(numericRowIndex, { focusInspector, focusField, highlightRow })
      return
    }
    const normalizedRowId = String(rowId || '').trim()
    if (!normalizedRowId) return
    const mappedRowIndex = Number(
      [...(state.templatePreviewByTemplateId?.[template.id]?.rows || [])].find((row) => String(row?.rowId || '').trim() === normalizedRowId)
        ?.rowIndex
    )
    if (Number.isFinite(mappedRowIndex)) {
      await selectTemplateRow(mappedRowIndex, { focusInspector, focusField, highlightRow })
    }
  }

  document.querySelectorAll('[data-select-row]').forEach((row) => {
    const rowIndex = Number(row.dataset.selectRow)
    row.addEventListener('click', async () => selectTemplateRow(rowIndex))
    row.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      await selectTemplateRow(rowIndex)
    })
  })

  document.querySelectorAll('[data-mapping-filter]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!template) return
      state.templateMappingFilterByTemplateId[template.id] = String(button.dataset.mappingFilter || 'all')
      await rerenderTemplates()
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
    state.templateSaveStateByTemplateId[template.id] = { status: 'dirty' }
    if (state.templateAutosaveTimers[template.id]) clearTimeout(state.templateAutosaveTimers[template.id])
    state.templateAutosaveTimers[template.id] = setTimeout(async () => {
      try {
        await persistMappings({ autosave: true })
      } catch {
        // handled via save state
      }
      await rerenderTemplates()
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
    await rerenderTemplates()
  })

  document.querySelector('#save-mappings')?.addEventListener('click', async () => {
    await persistMappings({ autosave: false })
    await rerenderTemplates()
  })

  document.querySelector('#suggest-source-paths')?.addEventListener('click', async () => {
    if (!template) return
    const suggestions = {}
    draftMappings.forEach((mapping, index) => {
      const rowIssues = mappingIssuesByIndex.get(index) || []
      const previewRow = previewRowsByIndex.get(index)
      const rowId = String(previewRow?.rowId || '').trim()
      const serverIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
      const suggestion = bestSourcePathSuggestion({
        mapping,
        knownPathIndex,
        localIssues: rowIssues,
        serverPreflightIssues: serverIssues
      })
      if (suggestion) suggestions[index] = suggestion
    })
    state.templateMappingSuggestionsByTemplateId[template.id] = suggestions
    setFlash('success', `Suggested source paths for ${Object.keys(suggestions).length} unresolved row(s).`)
    await rerenderTemplates()
  })

  document.querySelector('#apply-suggested-mappings')?.addEventListener('click', async () => {
    if (!template) return
    const savedSuggestions = state.templateMappingSuggestionsByTemplateId[template.id] || {}
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    let updates = 0
    nextDraft.forEach((mapping, index) => {
      const suggestion = savedSuggestions[index] || suggestionByIndex.get(index)
      if (!suggestion?.path) return
      const rowIssues = mappingIssuesByIndex.get(index) || []
      const previewRow = previewRowsByIndex.get(index)
      const rowId = String(previewRow?.rowId || '').trim()
      const serverIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
      const unresolved = !String(mapping.sourcePath || '').trim() || rowIssues.includes('Unknown source path') || serverIssues.length > 0
      if (!unresolved) return
      if (String(mapping.sourcePath || '').trim() === suggestion.path) return
      nextDraft[index] = { ...mapping, sourcePath: suggestion.path }
      updates += 1
    })
    if (!updates) {
      setFlash('error', 'No unresolved rows were updated from suggestions.')
      return
    }
    state.templateMappingDrafts[template.id] = nextDraft
    state.templateSaveStateByTemplateId[template.id] = { status: 'dirty' }
    state.templateWizardStepByTemplateId[template.id] = 'mapping'
    setFlash('success', `Applied suggestions to ${updates} unresolved row(s).`)
    await rerenderTemplates()
  })

  document.querySelector('#filter-unresolved-rows')?.addEventListener('click', async () => {
    if (!template) return
    state.templateMappingFilterByTemplateId[template.id] = 'unresolved-only'
    await rerenderTemplates()
  })

  document.querySelector('#auto-map-similar')?.addEventListener('click', async () => {
    if (!template) return
    const suggestions = {}
    draftMappings.forEach((mapping, index) => {
      const rowIssues = mappingIssuesByIndex.get(index) || []
      const previewRow = previewRowsByIndex.get(index)
      const rowId = String(previewRow?.rowId || '').trim()
      const serverIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
      const suggestion = bestSourcePathSuggestion({
        mapping,
        knownPathIndex,
        localIssues: rowIssues,
        serverPreflightIssues: serverIssues
      })
      if (suggestion) suggestions[index] = suggestion
    })
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    let updates = 0
    nextDraft.forEach((mapping, index) => {
      const suggestion = suggestions[index]
      if (!suggestion?.path) return
      const rowIssues = mappingIssuesByIndex.get(index) || []
      const previewRow = previewRowsByIndex.get(index)
      const rowId = String(previewRow?.rowId || '').trim()
      const serverIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
      const unresolved = !String(mapping.sourcePath || '').trim() || rowIssues.includes('Unknown source path') || serverIssues.length > 0
      if (!unresolved) return
      if (String(mapping.sourcePath || '').trim() === suggestion.path) return
      nextDraft[index] = { ...mapping, sourcePath: suggestion.path }
      updates += 1
    })
    if (!updates) {
      setFlash('error', 'No unresolved rows matched known source paths by name similarity.')
      return
    }
    state.templateMappingSuggestionsByTemplateId[template.id] = suggestions
    state.templateMappingDrafts[template.id] = nextDraft
    state.templateSaveStateByTemplateId[template.id] = { status: 'dirty' }
    state.templateWizardStepByTemplateId[template.id] = 'mapping'
    setFlash('success', `Auto-mapped ${updates} row(s) from suggestions.`)
    await rerenderTemplates()
  })

  document.querySelector('#clear-unresolved-rows')?.addEventListener('click', async () => {
    if (!template) return
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    let updates = 0
    nextDraft.forEach((mapping, index) => {
      const previewWarnings = previewRowsByIndex.get(index)?.warnings || []
      const hasUnresolvedPreviewIssue = previewWarnings.some((warning) => String(warning.code || '') === 'UNRESOLVED_SOURCE_PATH')
      const hasUnknownLocalPath = (mappingIssuesByIndex.get(index) || []).includes('Unknown source path')
      if (!hasUnresolvedPreviewIssue && !hasUnknownLocalPath) return
      if (!String(mapping.sourcePath || '').trim()) return
      nextDraft[index] = { ...mapping, sourcePath: '' }
      updates += 1
    })
    state.templateMappingDrafts[template.id] = nextDraft
    state.templateSaveStateByTemplateId[template.id] = { status: 'dirty' }
    state.templateWizardStepByTemplateId[template.id] = 'mapping'
    setFlash('success', `Cleared ${updates} unresolved row(s).`)
    await rerenderTemplates()
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
      state.templateWizardStepByTemplateId[template.id] = 'preview'
      await rerenderTemplates()
    } catch (error) {
      setFlash('error', error.message)
      await rerenderTemplates()
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
      state.templateWizardStepByTemplateId[template.id] = 'publish'
      if ((nextPreview.issues || []).length) {
        setFlash('error', `Publish preflight found ${(nextPreview.issues || []).length} schema issue(s).`)
      } else {
        setFlash('success', 'Publish preflight passed with no schema validation issues.')
      }
    } catch (error) {
      state.templatePublishPreflightByTemplateId[template.id] = { issues: error?.details?.issues || [] }
      reportActionError('Template publish preflight', error)
    }
    await rerenderTemplates()
  })

  document.querySelectorAll('[data-jump-rowindex]').forEach((button) => {
    button.addEventListener('click', async () => {
      const rowIndex = Number(button.dataset.jumpRowindex)
      const rowId = String(button.dataset.jumpRowid || '').trim()
      await selectTemplateRowFromIssue(rowIndex, rowId, {
        focusInspector: true,
        focusField: button.dataset.focusInspector || 'sourcePath',
        highlightRow: true
      })
    })
  })
  document.querySelectorAll('[data-preflight-rowindex]').forEach((button) => {
    button.addEventListener('click', async () => {
      const rowIndex = Number(button.dataset.preflightRowindex)
      const rowId = String(button.dataset.preflightRowid || '').trim()
      await selectTemplateRowFromIssue(rowIndex, rowId, {
        focusInspector: true,
        focusField: button.dataset.focusInspector || 'sourcePath',
        highlightRow: true
      })
    })
  })
  document.querySelectorAll('[data-remediate-rowindex]').forEach((button) => {
    button.addEventListener('click', async () => {
      const rowIndex = Number(button.dataset.remediateRowindex)
      const rowId = String(button.dataset.remediateRowid || '').trim()
      await selectTemplateRowFromIssue(rowIndex, rowId, {
        focusInspector: true,
        focusField: button.dataset.focusInspector || 'sourcePath',
        highlightRow: true
      })
    })
  })

  const pendingInspectorFocusField = template ? state.templateInspectorFocusRequestByTemplateId[template.id] : ''
  if (pendingInspectorFocusField) {
    const inspectorEl = document.querySelector(`#inspector-${pendingInspectorFocusField}`)
    inspectorEl?.focus({ preventScroll: true })
    state.templateInspectorFocusRequestByTemplateId[template.id] = ''
  }
  const pendingJumpRow = template ? Number(state.templateJumpHighlightByTemplateId[template.id]) : NaN
  if (Number.isFinite(pendingJumpRow)) {
    const target = document.querySelector(`#mapping-row-${pendingJumpRow}`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target?.focus({ preventScroll: true })
    setTimeout(() => {
      if (template) state.templateJumpHighlightByTemplateId[template.id] = NaN
      renderTemplates()
    }, 1500)
  }

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
        body: JSON.stringify({
          versionBump: '1.0.0',
          changelog: 'Publish template mapping updates.',
          enforceKnownSourcePaths: true,
          clientId,
          submissionId
        })
      })
      state.templatePublishPreflightByTemplateId[template.id] = { checkedAt: new Date().toISOString(), issues: [] }
      state.templateWizardStepByTemplateId[template.id] = 'publish'
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
    await rerenderTemplates()
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
      await rerenderTemplates()
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
          await rerenderTemplates()
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
    await rerenderTemplates()
  })
  focusWithinView('#templates-heading')
}

function boardCardMarkup(card, kind) {
  const canEdit = canMutateProfiles()
  const inlineState = ensureInlineProfileState(kind, card.id, card)
  const displayName = `${card.firstName || ''} ${card.lastName || ''}`.trim() || card.id
  const cardStage = card.stage || getStageDefinitions({ includeInactive: false })[0]?.id || 'discovery'
  const workflow = card.workflowSummary || {}
  const submissionCount = Number(workflow.submissionCount || 0)
  const draftCount = Number(workflow.draftCount || 0)
  const hasDraft = Boolean(workflow.latestDraftId)
  const hasSubmission = Boolean(workflow.latestSubmissionId)
  const workflowStatusText = hasDraft
    ? 'Draft in progress'
    : hasSubmission
      ? 'Submission ready for review'
      : 'No forms started'
  const primaryAction = hasDraft
    ? { id: workflow.latestDraftId, label: 'Resume draft' }
    : hasSubmission
      ? { id: workflow.latestSubmissionId, label: 'Review submission' }
      : null
  const secondaryAction =
    hasDraft && hasSubmission && workflow.latestDraftId !== workflow.latestSubmissionId
      ? { id: workflow.latestSubmissionId, label: 'Latest submission' }
      : null
  const workflowActionsMarkup =
    kind === 'client'
      ? `
      <div class="workflow-shortcuts" data-workflow-card="${card.id}">
        <button type="button" class="secondary tiny workflow-shortcut" data-open-profile-detail="${card.id}" aria-expanded="false" aria-controls="profile-detail-${card.id}">Profile detail</button>
        ${
          primaryAction
            ? `<button type="button" class="secondary tiny workflow-shortcut" data-workflow-nav-primary="${card.id}" data-workflow-submission="${primaryAction.id}">${primaryAction.label}</button>`
            : `<button type="button" class="secondary tiny workflow-shortcut" disabled>Start forms</button>`
        }
        ${
          secondaryAction
            ? `<button type="button" class="secondary tiny workflow-shortcut" data-workflow-nav-secondary="${card.id}" data-workflow-submission="${secondaryAction.id}">${secondaryAction.label}</button>`
            : ''
        }
        <button type="button" class="secondary tiny workflow-shortcut" data-open-doc-actions="${card.id}" data-workflow-submission="${workflow.latestSubmissionId || workflow.latestDraftId || ''}">Document actions</button>
      </div>
      <div class="workflow-action-meta">
        <span class="badge subtle">${workflowStatusText}</span>
        <span class="muted compact-meta">Forms: ${submissionCount} submissions · ${draftCount} drafts</span>
      </div>
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
        ${
          state.customFieldSchema.fields.length
            ? `<div class="item compact">
              <h4>Custom Fields</h4>
              <div class="grid two">
                ${state.customFieldSchema.fields
                  .map((field) =>
                    customFieldControlMarkup(field, inlineState.draft[customFieldInputName(field.key)] || '', {
                      disabled: !canEdit,
                      idPrefix: `profile-edit-${card.id}`,
                      booleanControl: 'toggle'
                    })
                  )
                  .join('')}
              </div>
              <p class="muted compact">Where these appear: profile detail + draft/resume flows for advisor operators.</p>
              <p class="muted compact" data-inline-custom-field-errors="${card.id}" role="status" aria-live="polite"></p>
            </div>`
            : '<p class="muted compact">No custom fields configured yet for this firm.</p>'
        }
        <div class="actions-row">
          <button type="submit" class="tiny" ${canEdit && inlineState.dirty && !inlineState.saving ? '' : 'disabled'}>${inlineState.saving ? 'Saving…' : 'Save'}</button>
          <button type="button" class="secondary tiny" data-inline-retry-save="${card.id}" ${canEdit && inlineState.lastSaveWasError && !inlineState.saving ? '' : 'hidden'}>Retry save</button>
          <button type="button" class="secondary tiny" data-cancel-edit="${card.id}" ${canEdit && !inlineState.saving ? '' : 'disabled'}>Cancel</button>
        </div>
        <p class="muted compact" data-inline-feedback="${card.id}" role="${inlineState.lastSaveWasError ? 'alert' : 'status'}" aria-live="${inlineState.lastSaveWasError ? 'assertive' : 'polite'}">${escapeHtml(
          inlineState.lastSaveMessage || ''
        )}</p>
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
        <h2 id="board-heading">${escapeHtml(kind === 'prospect' ? 'Prospects' : 'Clients')} Board</h2>
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
  document.querySelectorAll('[data-inline-retry-save]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.inlineRetrySave
      const form = document.querySelector(`[data-edit-form="${profileId}"]`)
      form?.requestSubmit()
    })
  })
  document.querySelectorAll('[data-edit-form]').forEach((form) => {
    const profileId = form.dataset.editForm
    form.querySelectorAll('input, select, textarea').forEach((input) => {
      input.addEventListener('input', () => {
        const nextValue = input.type === 'checkbox' ? (input.checked ? 'true' : '') : input.value
        setInlineDraftField(kind, profileId, input.name, nextValue)
      })
      input.addEventListener('change', () => {
        const nextValue = input.type === 'checkbox' ? (input.checked ? 'true' : '') : input.value
        setInlineDraftField(kind, profileId, input.name, nextValue)
      })
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const inlineState = ensureInlineProfileState(kind, profileId)
      const feedbackEl = form.querySelector('[data-inline-feedback]')
      const payload = {
        firstName: inlineState.draft.firstName || '',
        lastName: inlineState.draft.lastName || '',
        email: inlineState.draft.email || '',
        phone: inlineState.draft.phone || ''
      }
      const extensionValues = {}
      const extensionErrors = []
      const extensionErrorsByInput = {}
      state.customFieldSchema.fields.forEach((field) => {
        const inputName = customFieldInputName(field.key)
        const { value: parsed, error } = parseCustomFieldInputValueStrict(
          field,
          inlineState.draft[inputName] || ''
        )
        if (error) extensionErrors.push(error)
        if (error) extensionErrorsByInput[inputName] = error
        if (parsed !== null) extensionValues[field.key] = parsed
      })
      const customErrorEl = form.querySelector(`[data-inline-custom-field-errors="${profileId}"]`)
      state.customFieldSchema.fields.forEach((field) => {
        const input = form.elements?.namedItem?.(customFieldInputName(field.key))
        if (input?.setAttribute) {
          input.setAttribute('aria-invalid', extensionErrorsByInput[customFieldInputName(field.key)] ? 'true' : 'false')
        }
      })
      if (customErrorEl) {
        customErrorEl.textContent = extensionErrors.length
          ? extensionErrors.join(' ')
          : 'Custom field values look good.'
        customErrorEl.classList.remove('error-banner', 'success-banner')
        customErrorEl.classList.add(extensionErrors.length ? 'error-banner' : 'success-banner')
      }
      if (extensionErrors.length) {
        if (feedbackEl) feedbackEl.textContent = extensionErrors[0]
        setAlert('error', extensionErrors[0])
        return
      }
      payload.extensions = {
        schemaVersion: '1.0.0',
        values: extensionValues
      }
      const submitButton = form.querySelector('button[type="submit"]')
      if (submitButton) {
        submitButton.disabled = true
        submitButton.textContent = 'Saving…'
      }
      inlineState.lastSaveMessage = ''
      inlineState.lastSaveWasError = false
      setAlert('success', `Saving profile ${profileId} optimistically…`)
      if (feedbackEl) feedbackEl.textContent = 'Saving profile changes…'
      try {
        await saveInlineProfile(kind, profileId, payload, inlineState.expectedUpdatedAt || form.dataset.updatedAt || '')
        clearAlert()
        if (feedbackEl) feedbackEl.textContent = 'Profile saved successfully.'
        setWorkflowStatus(`Profile ${profileId} updated.`)
        reportActionSuccess('Profiles', 'Profile updated.')
      } catch (error) {
        const message = normalizeApiError(error, 'save this profile')
        setAlert('error', message)
        if (feedbackEl) feedbackEl.textContent = `${message} Use retry to attempt save again.`
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

  const navigateWorkflowTarget = (control) => {
    const clientId = control?.dataset?.workflowClient || ''
    const submissionId = control?.dataset?.workflowSubmission || ''
    if (!clientId || !submissionId) return
    const targetRoute = appRoutes.clientFormSubmission(clientId, submissionId)
    setWorkflowContext({ clientId, submissionId })
    if (window.location.hash === `#${targetRoute}`) return
    window.location.hash = targetRoute
  }

  document.querySelectorAll('[data-workflow-client]').forEach((link) => {
    link.addEventListener('click', () => {
      setWorkflowContext({
        clientId: link.dataset.workflowClient || '',
        submissionId: link.dataset.workflowSubmission || ''
      })
    })
  })

  document.querySelectorAll('[data-workflow-nav-primary], [data-workflow-nav-secondary]').forEach((button) => {
    button.addEventListener('click', () => {
      navigateWorkflowTarget({
        dataset: {
          workflowClient: button.dataset.workflowNavPrimary || button.dataset.workflowNavSecondary || '',
          workflowSubmission: button.dataset.workflowSubmission || ''
        }
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
    await ensureCustomFieldSchema()
    if (kind === 'prospect') {
      state.board = await request(routes.board())
      const boardStageDefinitions = stageDefinitionsFromBoard(state.board)
      hydrateStageConfig(boardStageDefinitions, { overwrite: true })
      renderProfileStageSelect()
      viewEl.innerHTML = boardMarkup(kind, state.board)
      wireBoardInteractions(kind)
      focusWithinView('#board-heading')
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
  focusWithinView('#board-heading')
}

function roleAccessMatrixMarkup() {
  const matrix = [
    ['Dashboard', ['admin', 'advisor', 'readonly']],
    ['Prospects', ['admin', 'advisor']],
    ['Clients', ['admin', 'advisor', 'readonly']],
    ['Forms', ['admin', 'advisor', 'readonly']],
    ['Templates', ['admin', 'advisor']],
    ['Exports', ['admin', 'advisor']],
    ['Analytics', ['admin', 'advisor', 'readonly']],
    ['Custom Fields (view)', ['admin', 'advisor', 'readonly']],
    ['Custom Fields (mutate)', ['admin']]
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
    <div class="section-header"><div><h2 id="exports-heading">Exports Operations</h2><p class="muted">Queue health, retries, and artifact readiness by job.</p></div></div>
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
      <table aria-describedby="exports-live-region"><thead><tr><th><input id="select-all-exports" type="checkbox" aria-label="Select all eligible exports" ${selectableJobs.length && selectedJobs.length === selectableJobs.length ? 'checked' : ''} /></th><th>ID</th><th>Status</th><th>Failure Class</th><th>Attempts</th><th>Artifact Details</th><th>Actions</th></tr></thead><tbody>
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

  const rerenderExports = async (selector = '#exports-heading') => {
    queueViewFocus(selector)
    await renderExports()
  }

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
    await rerenderExports('#exports-filter-form [name="status"]')
  })

  document.querySelector('#clear-export-filters')?.addEventListener('click', async () => {
    viewState.status = ''
    viewState.profileId = ''
    viewState.fromDate = ''
    viewState.toDate = ''
    viewState.sort = 'createdAt_desc'
    viewState.selectedIds = new Set()
    setWorkflowStatus('Exports filters cleared.')
    await rerenderExports('#exports-filter-form [name="status"]')
  })

  document.querySelector('#select-all-exports')?.addEventListener('change', (event) => {
    if (event.currentTarget.checked) {
      selectableJobs.forEach((job) => viewState.selectedIds.add(job.id))
    } else {
      selectableJobs.forEach((job) => viewState.selectedIds.delete(job.id))
    }
    queueViewFocus('#select-all-exports')
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
      queueViewFocus(`[data-select-export="${id}"]`)
      renderExports()
    })
  })

  document.querySelector('#bulk-retry-exports')?.addEventListener('click', async () => {
    if (!selectedRetryable.length) {
      setFlash('error', 'Bulk retry: no selected exports are eligible for retry.')
      setWorkflowStatus('Bulk retry skipped. No eligible exports selected.')
      await rerenderExports('#exports-heading')
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
    await rerenderExports('#exports-heading')
  })

  document.querySelector('#bulk-download-exports')?.addEventListener('click', async () => {
    if (!selectedDownloadable.length) {
      setFlash('error', 'Bulk download: no selected exports are ready to download.')
      setWorkflowStatus('Bulk download skipped. No ready exports selected.')
      await rerenderExports('#exports-heading')
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
    await rerenderExports('#exports-heading')
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
    await rerenderExports('#exports-heading')
  })
  document.querySelectorAll('[data-retry-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await request(routes.exportRetry(button.dataset.retryExport), { method: 'POST', body: JSON.stringify({}) })
        reportActionSuccess('Exports', `Retry requested for ${button.dataset.retryExport}.`)
      } catch (error) {
        reportActionError('Exports', error)
      }
      await rerenderExports(`[data-retry-export="${button.dataset.retryExport}"]`)
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
  focusWithinView('#exports-heading')
}

function customFieldReadonlyMessage() {
  if (state.user?.role === 'advisor') {
    return 'Advisor role is read-only for schema changes (backend guard: canManageUsers).'
  }
  if (state.user?.role === 'readonly') {
    return 'Readonly role can view schema only; create/update/delete are forbidden by policy.'
  }
  return ''
}

function customFieldTypeHelpText(type = 'text') {
  if (type === 'number') return 'Numbers only (decimals allowed). Leave blank to store no value.'
  if (type === 'date') return 'Use YYYY-MM-DD format.'
  if (type === 'boolean') return 'Stores true/false and renders as a toggle in profile edit.'
  return 'Plain text value.'
}

async function renderCustomFieldsAdmin() {
  await ensureCustomFieldSchema()
  const canManage = canManageCustomFieldSchema()
  const readonlyMessage = !canManage ? customFieldReadonlyMessage() : ''
  const fields = state.customFieldSchema.fields || []
  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    <div class="section-header">
      <div>
        <h2 id="custom-fields-heading">Custom Field Schema</h2>
        <p class="muted">Manage firm-level profile custom fields (key, type, label, required, metadata).</p>
      </div>
      <span class="badge subtle">${state.customFieldSchema.updatedAt ? `Updated ${new Date(state.customFieldSchema.updatedAt).toLocaleString()}` : 'No updates yet'}</span>
    </div>
    ${
      readonlyMessage
        ? `<p class="error-banner" role="status" aria-live="polite">${escapeHtml(readonlyMessage)}</p>`
        : '<p class="muted">Admin can create, update, and delete schema fields.</p>'
    }
    ${
      state.customFieldSchema.lastError
        ? `<p class="error-banner">${escapeHtml(state.customFieldSchema.lastError)}</p>`
        : ''
    }
    <section class="item">
      <h3>Create Field</h3>
      <form id="custom-field-create-form" class="grid two">
        <input name="key" placeholder="field_key" ${canManage ? '' : 'disabled'} />
        <select name="type" ${canManage ? '' : 'disabled'}>
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="date">date</option>
        </select>
        <input name="label" placeholder="Display label" ${canManage ? '' : 'disabled'} />
        <label><input name="required" type="checkbox" ${canManage ? '' : 'disabled'} /> Required</label>
        <input name="metadata" placeholder='{"group":"planning"}' ${canManage ? '' : 'disabled'} />
        <p class="muted compact">Key uses letters, numbers, and underscores only.</p>
        <p class="muted compact" data-type-help>Field type help: Plain text value.</p>
        <p class="muted compact">Metadata is optional JSON object used for grouping and UI hints.</p>
        <p class="field-error-text" data-field-error="key" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="type" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="required" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="metadata" role="alert" aria-live="polite"></p>
        <button type="submit" ${canManage ? '' : 'disabled'}>Create Field</button>
        <p class="muted compact" data-form-feedback aria-live="polite"></p>
      </form>
    </section>
    <section class="item">
      <h3>Bulk Edit Existing Fields</h3>
      <form id="custom-field-bulk-form">
        <p class="muted compact">Paste JSON array or tab-separated rows (key, type, label, required, metadata).</p>
        <textarea
          name="bulkRows"
          rows="8"
          placeholder='[{"key":"risk_tolerance","type":"number","label":"Risk Tolerance","required":false,"metadata":{"group":"planning"}}]'
          ${canManage ? '' : 'disabled'}
        ></textarea>
        <div class="actions-row">
          <button type="submit" class="tiny" ${canManage ? '' : 'disabled'}>Apply + Save Rows</button>
        </div>
        <p class="muted compact" data-form-feedback aria-live="polite"></p>
      </form>
    </section>
    <section class="item">
      <h3>Current Fields</h3>
      <table><thead><tr><th>Key</th><th>Type</th><th>Label</th><th>Required</th><th>Metadata</th><th>Actions</th></tr></thead><tbody>
      ${
        fields.length
          ? fields
              .map(
                (field) => `<tr>
            <td><code>${escapeHtml(field.key)}</code></td>
            <td>${escapeHtml(field.type)}</td>
            <td>${escapeHtml(field.label || field.key)}</td>
            <td>${field.required ? 'Yes' : 'No'}</td>
            <td><code>${escapeHtml(JSON.stringify(field.metadata || {}))}</code></td>
            <td>
              <form data-custom-field-update="${escapeHtml(field.key)}" class="grid two">
                <input type="hidden" name="key" value="${escapeHtml(field.key)}" />
                <input name="label" value="${escapeHtml(field.label || '')}" placeholder="Label" ${canManage ? '' : 'disabled'} />
                <select name="type" ${canManage ? '' : 'disabled'}>
                  <option value="text" ${field.type === 'text' ? 'selected' : ''}>text</option>
                  <option value="number" ${field.type === 'number' ? 'selected' : ''}>number</option>
                  <option value="boolean" ${field.type === 'boolean' ? 'selected' : ''}>boolean</option>
                  <option value="date" ${field.type === 'date' ? 'selected' : ''}>date</option>
                </select>
                <label><input name="required" type="checkbox" ${field.required ? 'checked' : ''} ${canManage ? '' : 'disabled'} /> Required</label>
                <input name="metadata" value="${escapeHtml(JSON.stringify(field.metadata || {}))}" placeholder='{"group":"planning"}' ${canManage ? '' : 'disabled'} />
                <p class="muted compact" data-type-help>Field type help: ${escapeHtml(customFieldTypeHelpText(field.type))}</p>
                <p class="field-error-text" data-field-error="key" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="type" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="required" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="metadata" role="alert" aria-live="polite"></p>
                <div class="actions-row">
                  <button type="submit" class="tiny" ${canManage ? '' : 'disabled'}>Update</button>
                  <button type="button" class="tiny secondary" data-custom-field-delete="${escapeHtml(field.key)}" ${canManage ? '' : 'disabled'}>Delete</button>
                </div>
                <p class="muted compact" data-form-feedback aria-live="polite"></p>
              </form>
            </td>
          </tr>`
              )
              .join('')
          : '<tr><td colspan="6"><p class="empty-state" role="status">No custom fields configured. Create your first field to enable profile extensions.</p></td></tr>'
      }
      </tbody></table>
    </section>
  `

  const markFieldError = (form, fieldName, message) => {
    const field = form?.elements?.namedItem?.(fieldName)
    if (field?.setAttribute) field.setAttribute('aria-invalid', message ? 'true' : 'false')
    const errorEl = form?.querySelector(`[data-field-error="${fieldName}"]`)
    if (errorEl) errorEl.textContent = message || ''
  }
  const applyFieldErrors = (form, fieldErrors = {}) => {
    ;['key', 'type', 'required', 'metadata'].forEach((fieldName) =>
      markFieldError(form, fieldName, fieldErrors[fieldName] || '')
    )
  }
  const updateTypeHelp = (form) => {
    const type = String(form?.elements?.namedItem?.('type')?.value || 'text').toLowerCase()
    const helpEl = form?.querySelector('[data-type-help]')
    if (helpEl) helpEl.textContent = `Field type help: ${customFieldTypeHelpText(type)}`
  }
  const parseMetadataJson = (raw) => {
    const text = String(raw || '').trim()
    if (!text) return { value: {}, error: '' }
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { value: null, error: 'Metadata must be a JSON object.' }
      }
      return { value: parsed, error: '' }
    } catch {
      return { value: null, error: 'Metadata must be valid JSON.' }
    }
  }
  const validateCustomFieldInput = (rawInput, { requireKey = true } = {}) => {
    const normalizeRequiredInput = (value) => {
      if (typeof value === 'boolean') return { value, error: '' }
      if (value == null) return { value: false, error: '' }
      const normalized = String(value).trim().toLowerCase()
      if (!normalized) return { value: false, error: '' }
      if (['true', '1', 'yes', 'y'].includes(normalized)) return { value: true, error: '' }
      if (['false', '0', 'no', 'n'].includes(normalized)) return { value: false, error: '' }
      return { value: false, error: 'Required must be a boolean (true/false).' }
    }
    const requiredResult = normalizeRequiredInput(rawInput?.required)
    const payload = {
      key: String(rawInput?.key || '')
        .trim()
        .replace(/[^a-zA-Z0-9_]+/g, '_'),
      type: String(rawInput?.type || 'text')
        .trim()
        .toLowerCase(),
      label: String(rawInput?.label || '').trim(),
      required: requiredResult.value
    }
    const fieldErrors = {}
    if (requireKey && !payload.key) fieldErrors.key = 'Key is required (letters, numbers, underscore).'
    if (!new Set(['text', 'number', 'boolean', 'date']).has(payload.type)) {
      fieldErrors.type = 'Type must be one of: text, number, boolean, date.'
    }
    if (requiredResult.error) fieldErrors.required = requiredResult.error
    const metadataResult = parseMetadataJson(rawInput?.metadata)
    if (metadataResult.error) fieldErrors.metadata = metadataResult.error
    payload.metadata = metadataResult.value
    return { payload, fieldErrors }
  }
  const parseBulkRows = (rawText = '') => {
    const trimmed = String(rawText || '').trim()
    if (!trimmed) return { rows: [], parseError: 'Paste at least one row to bulk update.' }
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (!Array.isArray(parsed)) {
          return { rows: [], parseError: 'Bulk payload must be a JSON array when using JSON input.' }
        }
        return { rows: parsed, parseError: '' }
      } catch {
        return { rows: [], parseError: 'Bulk JSON payload is invalid.' }
      }
    }
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const rows = lines.map((line) => {
      const [key = '', type = '', label = '', required = '', metadata = ''] = line.split('\t')
      return { key, type, label, required, metadata }
    })
    return { rows, parseError: '' }
  }

  document.querySelector('#custom-field-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!canManage) return
    const form = event.currentTarget
    clearFormFeedback(form)
    applyFieldErrors(form, {})
    const formData = new FormData(form)
    const validation = validateCustomFieldInput(
      {
        key: formData.get('key'),
        type: formData.get('type'),
        label: formData.get('label'),
        required: formData.get('required'),
        metadata: formData.get('metadata')
      },
      { requireKey: true }
    )
    applyFieldErrors(form, validation.fieldErrors)
    if (Object.keys(validation.fieldErrors).length) {
      setFormFeedback(form, Object.values(validation.fieldErrors)[0])
      return
    }
    const previousSchema = structuredClone(state.customFieldSchema)
    const optimisticField = { ...validation.payload }
    state.customFieldSchema.fields = [...(state.customFieldSchema.fields || []), optimisticField]
    state.customFieldSchema.updatedAt = new Date().toISOString()
    state.customFieldSchema.lastError = ''
    setFormFeedback(form, 'Creating custom field…', 'success')
    try {
      await request(routes.profileCustomFieldSchema(), {
        method: 'POST',
        body: JSON.stringify(validation.payload)
      })
      setFormFeedback(form, 'Custom field created.', 'success')
      state.customFieldSchema.fetched = false
      await refreshSelects()
      await renderCustomFieldsAdmin()
    } catch (error) {
      state.customFieldSchema = previousSchema
      applyFieldErrors(form, error?.details?.fieldErrors || {})
      setFormFeedback(form, normalizeApiError(error, 'create custom field schema'))
    }
  })
  const createForm = document.querySelector('#custom-field-create-form')
  if (createForm) {
    updateTypeHelp(createForm)
    createForm.elements?.namedItem?.('type')?.addEventListener('change', () => updateTypeHelp(createForm))
  }
  document.querySelector('#custom-field-bulk-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!canManage) return
    const form = event.currentTarget
    clearFormFeedback(form)
    document.querySelectorAll('[data-custom-field-update]').forEach((updateForm) => applyFieldErrors(updateForm, {}))
    const formData = new FormData(form)
    const parsed = parseBulkRows(formData.get('bulkRows'))
    if (parsed.parseError) {
      setFormFeedback(form, parsed.parseError)
      return
    }
    const knownKeys = new Set((state.customFieldSchema.fields || []).map((field) => field.key))
    const preparedRows = parsed.rows.map((row) => {
      const validation = validateCustomFieldInput(row, { requireKey: true })
      if (validation.payload.key && !knownKeys.has(validation.payload.key)) {
        validation.fieldErrors.key = `Field ${validation.payload.key} was not found in current schema.`
      }
      return { payload: validation.payload, fieldErrors: validation.fieldErrors }
    })
    const hasClientErrors = preparedRows.some((row) => Object.keys(row.fieldErrors).length)
    preparedRows.forEach((row) => {
      const targetForm = Array.from(document.querySelectorAll('[data-custom-field-update]')).find(
        (entry) => entry.dataset.customFieldUpdate === row.payload.key
      )
      if (targetForm) applyFieldErrors(targetForm, row.fieldErrors)
    })
    if (hasClientErrors) {
      setFormFeedback(form, 'Bulk edit contains validation errors. Fix highlighted rows and retry.')
      return
    }
    const previousSchema = structuredClone(state.customFieldSchema)
    state.customFieldSchema.fields = (state.customFieldSchema.fields || []).map((field) => {
      const row = preparedRows.find((entry) => entry.payload.key === field.key)
      return row ? { ...field, ...row.payload, key: field.key } : field
    })
    state.customFieldSchema.updatedAt = new Date().toISOString()
    setFlash('success', `Saving ${preparedRows.length} custom field updates…`)
    await renderCustomFieldsAdmin()
    const serverErrors = []
    for (const row of preparedRows) {
      try {
        await request(routes.profileCustomFieldSchemaField(row.payload.key), {
          method: 'PATCH',
          body: JSON.stringify({
            type: row.payload.type,
            label: row.payload.label,
            required: row.payload.required,
            metadata: row.payload.metadata
          })
        })
      } catch (error) {
        serverErrors.push({ key: row.payload.key, fieldErrors: error?.details?.fieldErrors || {}, error })
      }
    }
    if (serverErrors.length) {
      state.customFieldSchema = previousSchema
      setFlash('error', normalizeApiError(serverErrors[0].error, 'bulk update custom fields'))
      await renderCustomFieldsAdmin()
      serverErrors.forEach((entry) => {
        const targetForm = Array.from(document.querySelectorAll('[data-custom-field-update]')).find(
          (rowForm) => rowForm.dataset.customFieldUpdate === entry.key
        )
        if (targetForm) applyFieldErrors(targetForm, entry.fieldErrors)
      })
      const rerenderedBulkForm = document.querySelector('#custom-field-bulk-form')
      if (rerenderedBulkForm) {
        const bulkRowsInput = rerenderedBulkForm.elements?.namedItem?.('bulkRows')
        if (bulkRowsInput) bulkRowsInput.value = String(formData.get('bulkRows') || '')
        setFormFeedback(rerenderedBulkForm, 'Some rows failed validation on save. Review inline errors and retry.')
      }
      return
    }
    state.customFieldSchema.fetched = false
    await refreshSelects()
    setFlash('success', `Updated ${preparedRows.length} custom fields.`)
    await renderCustomFieldsAdmin()
  })

  document.querySelectorAll('[data-custom-field-update]').forEach((form) => {
    updateTypeHelp(form)
    form.elements?.namedItem?.('type')?.addEventListener('change', () => updateTypeHelp(form))
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!canManage) return
      clearFormFeedback(form)
      applyFieldErrors(form, {})
      const fieldKey = form.dataset.customFieldUpdate
      const formData = new FormData(form)
      const validation = validateCustomFieldInput(
        {
          type: formData.get('type'),
          label: formData.get('label'),
          required: formData.get('required'),
          metadata: formData.get('metadata')
        },
        { requireKey: false }
      )
      applyFieldErrors(form, validation.fieldErrors)
      if (Object.keys(validation.fieldErrors).length) {
        setFormFeedback(form, Object.values(validation.fieldErrors)[0])
        return
      }
      const previousSchema = structuredClone(state.customFieldSchema)
      state.customFieldSchema.fields = (state.customFieldSchema.fields || []).map((field) =>
        field.key === fieldKey ? { ...field, ...validation.payload, key: fieldKey } : field
      )
      state.customFieldSchema.updatedAt = new Date().toISOString()
      setFormFeedback(form, `Updating ${fieldKey}…`, 'success')
      try {
        await request(routes.profileCustomFieldSchemaField(fieldKey), {
          method: 'PATCH',
          body: JSON.stringify(validation.payload)
        })
        setFormFeedback(form, `Custom field ${fieldKey} updated.`, 'success')
        state.customFieldSchema.fetched = false
        await refreshSelects()
        await renderCustomFieldsAdmin()
      } catch (error) {
        state.customFieldSchema = previousSchema
        applyFieldErrors(form, error?.details?.fieldErrors || {})
        setFormFeedback(form, normalizeApiError(error, `update custom field ${fieldKey}`))
      }
    })
  })

  document.querySelectorAll('[data-custom-field-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!canManage) return
      const fieldKey = button.dataset.customFieldDelete
      const previousSchema = structuredClone(state.customFieldSchema)
      state.customFieldSchema.fields = (state.customFieldSchema.fields || []).filter((field) => field.key !== fieldKey)
      state.customFieldSchema.updatedAt = new Date().toISOString()
      setFlash('success', `Deleting custom field ${fieldKey}…`)
      await renderCustomFieldsAdmin()
      try {
        await request(routes.profileCustomFieldSchemaField(fieldKey), { method: 'DELETE' })
        setFlash('success', `Custom field ${fieldKey} deleted.`)
        state.customFieldSchema.fetched = false
        await refreshSelects()
        await renderCustomFieldsAdmin()
      } catch (error) {
        state.customFieldSchema = previousSchema
        setFlash('error', normalizeApiError(error, `delete custom field ${fieldKey}`))
        await renderCustomFieldsAdmin()
      }
    })
  })

  focusWithinView('#custom-fields-heading')
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

function operationsCommandBlock() {
  return [
    'export RELEASE_ID=<release-id>',
    'export KLIENT_BASE_URL=https://<env-host>',
    'export KLIENT_OPS_TOKEN_ACTIVE=<ops-token-active>',
    'export KLIENT_OPS_TOKEN_PREVIOUS=<ops-token-previous-during-rotation>',
    'export RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED=0',
    'export RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER=0',
    'export RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE=0',
    'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight',
    'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy',
    'export RESTORE_BACKUP_PATH=data/backup-<timestamp>.db',
    'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"',
    'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"'
  ].join('\n')
}

function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  link.click()
  URL.revokeObjectURL(objectUrl)
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

  const releaseRules = evaluateReleaseReadinessRules(snapshot)
  const releaseRuleCards = releaseRules
    .map((rule) => {
      const remediationMarkup =
        rule.level === 'FAIL'
          ? `<p class="muted compact"><strong>Remediation:</strong> ${escapeHtml(rule.remediation)}</p>`
          : ''
      return `<article class="ops-card">
        <div class="row between">
          <strong><code>${escapeHtml(rule.id)}</code></strong>
          <span class="ops-badge ${rule.level.toLowerCase()}">${rule.level}</span>
        </div>
        <p class="muted compact"><strong>${escapeHtml(rule.title)}</strong></p>
        <p class="muted compact">Threshold: <code>${escapeHtml(rule.threshold)}</code></p>
        <p class="muted compact">Observed: ${escapeHtml(rule.note)}</p>
        ${remediationMarkup}
        <p class="muted compact"><a href="${escapeHtml(rule.runbookHref)}">Runbook section</a></p>
      </article>`
    })
    .join('')

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
  const queueActionPlan = operationsQueueActionPlanMarkup(snapshot)
  viewEl.innerHTML = `
    ${flashMarkup()}
    <section class="section-card">
      <div class="row between">
        <div>
          <h2 id="operations-heading">Operations / Launch readiness</h2>
          <p class="muted compact">Operator snapshot of readiness, health, exports queue, and diagnostics.</p>
        </div>
        <span class="badge subtle">${state.operations.lastUpdatedAt ? `Updated ${new Date(state.operations.lastUpdatedAt).toLocaleString()}` : 'Not yet updated'}</span>
      </div>
      <section class="ops-quickstart" aria-labelledby="ops-quickstart-heading">
        <h3 id="ops-quickstart-heading">Quickstart links and canonical release references</h3>
        <ul class="ops-quickstart-list">
          <li><a href="/health"><code>/health</code></a> — immediate service health check (must be healthy for GO).</li>
          <li><a href="/ready"><code>/ready</code></a> — dependency readiness + <code>checks.*</code> contract (must all be true).</li>
          <li><a href="/api/ops/diagnostics"><code>/api/ops/diagnostics</code></a> — runtime/startup diagnostics for release blocker triage.</li>
          <li><a href="/api/ops/exports/queue"><code>/api/ops/exports/queue</code></a> — queue stalled/dead-letter/retryable trend checks.</li>
          <li><a href="/docs/deployment-quick-reference.md#expected-artifact-outputs-and-locations">Release evidence directory convention: <code>artifacts/release-evidence/&lt;release-id&gt;/</code>.</a></li>
          <li><a href="/docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts">Canonical release evidence bundle (required artifacts + gate summaries).</a></li>
          <li><a href="/docs/deployment-quick-reference.md#admin-shell-operations-panel-quick-links">Operator runbook details for this panel.</a></li>
        </ul>
      </section>
      <div class="ops-actions">
        <button type="button" data-ops-refresh>${state.operations.busy ? 'Refreshing…' : 'Refresh'}</button>
        <button type="button" data-ops-copy-json>Copy JSON</button>
        <button type="button" class="tiny secondary" data-ops-copy-commands>Copy command block</button>
        <button type="button" class="tiny secondary" data-ops-download-commands>Download command block</button>
        <a href="/docs/deployment-quick-reference.md#0-one-time-shell-setup-for-the-release-window">Runbook: token + env setup</a>
        <a href="/docs/deployment-quick-reference.md#3-postdeploy-validation-run-in-this-phase-after-deploy">Runbook: postdeploy checks</a>
        <a href="/docs/deployment-quick-reference.md#common-failure-signatures-diagnostics-keyed">Runbook: failure signatures</a>
      </div>
      <p class="muted compact" data-ops-action-feedback role="status" aria-live="polite" aria-atomic="true">${escapeHtml(state.operations.feedback || '')}</p>
      ${queueActionPlan}
      ${operationRuleSetMarkup()}
      <section class="section-card" aria-labelledby="ops-release-readiness-heading">
        <h3 id="ops-release-readiness-heading">Release readiness summary (postdeploy rule IDs)</h3>
        <p class="muted compact">Primary decision surface aligned to <code>scripts/release-go-no-go.mjs</code> rule IDs.</p>
        <div class="ops-grid">${releaseRuleCards}</div>
      </section>
      <div class="ops-grid">${statusCards}</div>
      <details>
        <summary>Advanced details (JSON payload)</summary>
        <pre class="ops-diagnostics-block">${payloadPreview}</pre>
      </details>
    </section>
  `

  const refreshButton = viewEl.querySelector('[data-ops-refresh]')
  refreshButton?.addEventListener('click', async () => {
    await loadOperationsSnapshot()
    queueViewFocus('[data-ops-refresh]')
    await renderOperations()
  })

  const copyButton = viewEl.querySelector('[data-ops-copy-json]')
  copyButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(operationsPayloadJson())
      setFlash('success', 'Operations payload copied to clipboard.')
      state.operations.feedback = 'Copied JSON snapshot to clipboard.'
    } catch {
      setFlash('error', 'Clipboard copy failed. Copy from the diagnostics block instead.')
      state.operations.feedback = 'Copy JSON failed. Copy from the diagnostics block instead.'
    }
    await renderOperations()
  })

  const commandCopyButton = viewEl.querySelector('[data-ops-copy-commands]')
  commandCopyButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(operationsCommandBlock())
      state.operations.feedback = 'Copied preflight/postdeploy/restore command block.'
    } catch {
      state.operations.feedback = 'Copy command block failed. Download the command block instead.'
    }
    queueViewFocus('[data-ops-copy-json]')
    await renderOperations()
  })
  focusWithinView('#operations-heading')
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
  viewEl.innerHTML = `${flashMarkup()}<h2 id="fallback-heading">${escapeHtml(title)}</h2><p class="muted">This view remains functional in API workflows and can be expanded with richer cards later.</p>`
}

async function renderCurrentView() {
  updateViewNavState()
  if (!state.user) {
    viewEl.innerHTML = `${flashMarkup()}<h2 id="auth-view-heading">Sign in to continue</h2>`
    focusWithinView('#auth-view-heading')
    return
  }
  const viewFocusByName = {
    dashboard: '#dashboard-heading',
    analytics: '#analytics-heading',
    forms: '#forms-heading',
    templates: '#templates-heading',
    exports: '#exports-heading',
    'custom-fields': '#custom-fields-heading',
    operations: '#operations-heading',
    prospects: '#board-heading',
    clients: '#board-heading'
  }
  if (state.view === 'dashboard') await renderDashboard()
  else if (state.view === 'analytics') await renderAnalytics()
  else if (state.view === 'forms') await renderForms()
  else if (state.view === 'templates') await renderTemplates()
  else if (state.view === 'exports') await renderExports()
  else if (state.view === 'custom-fields') await renderCustomFieldsAdmin()
  else if (state.view === 'operations') await renderOperations()
  else if (state.view === 'prospects') await renderBoard('prospect')
  else if (state.view === 'clients') await renderBoard('client')
  else await renderFallback(state.view)
  focusWithinView(viewFocusByName[state.view] || '#fallback-heading')
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
    const { values: extensionValues, errors: extensionErrors } = collectCustomFieldValues(
      formEl,
      state.customFieldSchema.fields || []
    )
    if (extensionErrors.length) throw new Error(extensionErrors[0])
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
        source,
        extensions: {
          schemaVersion: '1.0.0',
          values: extensionValues
        }
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
    const payload = validateRequiredFields(formEl, ['name'])
    const useAutoBuild = Boolean(formEl.elements?.namedItem?.('useAutoBuild')?.checked)
    const uploadFile = formEl.elements?.namedItem?.('templatePdf')?.files?.[0] || null
    if (useAutoBuild) {
      if (!uploadFile) throw new Error('Choose a PDF file to use auto-build.')
      const buffer = await uploadFile.arrayBuffer()
      const autoBuilt = await request(routes.documentTemplateAutoBuild(), {
        method: 'POST',
        body: JSON.stringify({
          name: payload.name,
          fileName: uploadFile.name || payload.fileName || 'template.pdf',
          fileBytesBase64: arrayBufferToBase64(buffer)
        })
      })
      state.view = 'templates'
      state.selectedTemplateId = autoBuilt.id
      reportActionSuccess('Templates', `Auto-build finished with extraction status: ${autoBuilt?.extraction?.status || 'unknown'}.`)
    } else {
      await request(routes.documentTemplates(), {
        method: 'POST',
        body: JSON.stringify({
          ...payload,
          blueprint: { sections: [] },
          mappings: []
        })
      })
      reportActionSuccess('Templates', 'Document template created.')
    }
    formEl.reset()
    await renderCurrentView()
  } catch (error) {
    const ingestionReason = String(error?.details?.reasonCode || error?.body?.error?.details?.reasonCode || '')
    if (ingestionReason) {
      setFormFeedback(formEl, templateIngestionRecoveryMessage({ reasonCode: ingestionReason, error }))
    } else {
      setFormFeedback(formEl, error.message)
    }
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
