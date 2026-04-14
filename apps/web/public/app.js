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
  templatePublishIntentByTemplateId: {},
  templateMappingFilterByTemplateId: {},
  templateMappingSearchByTemplateId: {},
  templateMappingSuggestionsByTemplateId: {},
  templateInspectorFocusRequestByTemplateId: {},
  templateJumpHighlightByTemplateId: {},
  templateNavigationRequestByTemplateId: {},
  customFieldSchema: {
    fetched: false,
    loading: false,
    fields: [],
    updatedAt: '',
    lastError: '',
    bulkPreview: null,
    ui: defaultCustomFieldAdminUiState()
  },
  formsUi: {
    activeDraftSharePanelId: '',
    collaboratorsByDraftId: {},
    membershipRefreshedAtByDraftId: {},
    shareFeedbackByDraftId: {},
    shareFeedbackRecoveryByDraftId: {},
    userLookupByDraftId: {},
    userLookupSearchByDraftId: {},
    selectedUserIdByDraftId: {},
    lastShareFocusByDraftId: {}
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
  return sortCustomFieldDefinitions(
    (Array.isArray(fields) ? fields : [])
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
  )
}

function customFieldGroupName(field = {}) {
  const rawGroup = field?.metadata && typeof field.metadata === 'object' ? field.metadata.group : ''
  return String(rawGroup || 'General').trim() || 'General'
}

function customFieldSortOrder(field = {}) {
  const rawOrder = field?.metadata && typeof field.metadata === 'object' ? field.metadata.order : null
  if (rawOrder == null || rawOrder === '') return Number.POSITIVE_INFINITY
  const parsed = Number(rawOrder)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function sortCustomFieldDefinitions(fields = []) {
  return [...fields].sort((a, b) => {
    const groupCompare = customFieldGroupName(a).localeCompare(customFieldGroupName(b))
    if (groupCompare !== 0) return groupCompare
    const orderCompare = customFieldSortOrder(a) - customFieldSortOrder(b)
    if (orderCompare !== 0) return orderCompare
    const labelCompare = String(a.label || a.key || '').localeCompare(String(b.label || b.key || ''))
    if (labelCompare !== 0) return labelCompare
    return String(a.key || '').localeCompare(String(b.key || ''))
  })
}

function groupedCustomFields(fields = []) {
  return sortCustomFieldDefinitions(fields).reduce((groups, field) => {
    const groupName = customFieldGroupName(field)
    if (!groups[groupName]) groups[groupName] = []
    groups[groupName].push(field)
    return groups
  }, {})
}

async function ensureCustomFieldSchema(force = false) {
  if (!state.user || state.user.role === 'client') {
    state.customFieldSchema = {
      fetched: true,
      loading: false,
      fields: [],
      updatedAt: '',
      lastError: '',
      bulkPreview: null,
      ui: defaultCustomFieldAdminUiState()
    }
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
    <button type="button" class="secondary tiny" data-retry-custom-field-schema aria-label="Retry loading firm custom field schema">Retry schema load</button>
    <button type="button" class="secondary tiny" data-open-custom-fields-view aria-label="Open custom field schema management view">Manage field definitions</button>
  </div>`
}

function customFieldSchemaPanelMarkup({ tone = 'status', summary = '', detail = '', includeManageHint = true } = {}) {
  const role = tone === 'error' ? 'alert' : 'status'
  const bannerClass = tone === 'error' ? 'error-banner' : 'muted compact'
  return `<h4>Firm Custom Fields</h4>
    <p id="custom-field-schema-status" class="${bannerClass}" role="${role}" aria-live="${tone === 'error' ? 'assertive' : 'polite'}" aria-atomic="true" tabindex="-1">${escapeHtml(summary)}</p>
    ${detail ? `<p class="muted compact">${escapeHtml(detail)}</p>` : ''}
    ${includeManageHint ? customFieldCreateFormActionsMarkup() : ''}`
}

function customFieldCreateFormMarkup() {
  if (!profileCustomFieldsEl) return
  const fields = state.customFieldSchema.fields || []
  if (state.customFieldSchema.loading) {
    profileCustomFieldsEl.innerHTML = customFieldSchemaPanelMarkup({
      summary: 'Loading firm custom fields. You can continue with base profile details while this loads.',
      detail: 'If loading stalls, retry the schema request or open Manage field definitions.',
      includeManageHint: true
    })
    queueViewFocus('#custom-field-schema-status')
    focusWithinView('#custom-field-schema-status')
    return
  }
  if (state.customFieldSchema.lastError) {
    profileCustomFieldsEl.innerHTML = customFieldSchemaPanelMarkup({
      tone: 'error',
      summary: `Custom field schema is unavailable: ${state.customFieldSchema.lastError}`,
      detail: 'You can continue profile creation without custom fields, retry loading, or open Manage field definitions.'
    })
    profileCustomFieldsEl.querySelector('[data-retry-custom-field-schema]')?.addEventListener('click', async () => {
      state.customFieldSchema.fetched = false
      profileCustomFieldsEl.innerHTML = customFieldSchemaPanelMarkup({
        summary: 'Retrying custom field schema load…',
        detail: 'Please wait while we reconnect to schema services.'
      })
      queueViewFocus('#custom-field-schema-status')
      focusWithinView('#custom-field-schema-status')
      await ensureCustomFieldSchema(true)
      customFieldCreateFormMarkup()
    })
    profileCustomFieldsEl.querySelector('[data-open-custom-fields-view]')?.addEventListener('click', () => {
      state.view = 'custom-fields'
      queueViewFocus('#custom-fields-heading')
      renderCurrentView()
    })
    queueViewFocus('#custom-field-schema-status')
    focusWithinView('#custom-field-schema-status')
    return
  }
  if (!fields.length) {
    profileCustomFieldsEl.innerHTML = customFieldSchemaPanelMarkup({
      summary: 'No firm custom fields are configured yet.',
      detail: 'Create fields to capture operator-specific values in profile and draft workflows.'
    })
    profileCustomFieldsEl.querySelector('[data-open-custom-fields-view]')?.addEventListener('click', () => {
      state.view = 'custom-fields'
      queueViewFocus('#custom-fields-heading')
      renderCurrentView()
    })
    queueViewFocus('#custom-field-schema-status')
    focusWithinView('#custom-field-schema-status')
    return
  }
  const grouped = groupedCustomFields(fields)
  profileCustomFieldsEl.innerHTML = `<h4>Firm Custom Fields</h4>${Object.entries(grouped)
    .map(
      ([groupName, groupFields]) => `<div class="top-gap">
      <h5>${escapeHtml(groupName)}</h5>
      <div class="grid two">${groupFields.map((field) => customFieldControlMarkup(field, '')).join('')}</div>
    </div>`
    )
    .join('')}<p class="muted compact" role="status" aria-live="polite">These values appear on client profiles and carry into draft review context for operators.</p>`
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
      conflictRecoveryHint: '',
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
  entry.conflictMessage =
    conflictMessage || 'Unable to save right now. Retry after reloading latest profile data.'
  entry.conflictRecoveryHint = 'Your unsaved edits are still in the form. Reload latest server values, then retry save.'
  entry.lastSaveMessage = entry.conflictMessage
  entry.lastSaveWasError = true
}

function cancelInlineDraft(kind, profileId, card = null) {
  const entry = ensureInlineProfileState(kind, profileId, card)
  entry.draft = { ...entry.latest }
  entry.dirty = false
  entry.saving = false
  entry.conflictMessage = ''
  entry.conflictRecoveryHint = ''
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
      ${entry.conflictRecoveryHint ? `<span class="muted inline-status-text">${escapeHtml(entry.conflictRecoveryHint)}</span>` : ''}
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
  if (!state.user) {
    return 'Sign in again to view draft sharing members.'
  }
  if (state.user?.role === 'readonly') {
    return 'Readonly role: collaborator membership is visible, but add/remove actions are disabled.'
  }
  if (state.user?.role === 'advisor' && !isDraftOwner(draft)) {
    return 'Advisor access is view-only on drafts you do not own. Ask the draft owner (or an admin) to change collaborators.'
  }
  return 'You do not have permission to manage collaborators for this draft.'
}

function collaboratorLookupLabel(user = {}) {
  const name = String(user.label || '').trim()
  const email = String(user.email || '').trim()
  const role = String(user.role || '').trim()
  const pieces = [name || user.id, email && email !== name ? `<${email}>` : '', role ? `(${role})` : ''].filter(Boolean)
  return pieces.join(' ')
}

function findKnownFirmUserById(userId) {
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedUserId) return null
  if (state.user?.id === normalizedUserId) {
    return {
      id: state.user.id,
      label: `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() || state.user.email || state.user.id,
      email: state.user.email || '',
      role: state.user.role || ''
    }
  }
  for (const list of Object.values(state.formsUi.userLookupByDraftId)) {
    const found = (Array.isArray(list) ? list : []).find((entry) => String(entry?.id || '') === normalizedUserId)
    if (found) return found
  }
  return null
}

function collaboratorIdentityLabel(userId, { fallbackLabel = '' } = {}) {
  const known = findKnownFirmUserById(userId)
  if (!known) return fallbackLabel || String(userId || 'unknown user')
  const contextual = collaboratorLookupLabel(known)
  return contextual || fallbackLabel || String(userId || 'unknown user')
}

function renderCollaboratorIdentity(userId, { fallbackLabel = '' } = {}) {
  const canonicalId = String(userId || '').trim() || 'unknown-user-id'
  const contextualLabel = collaboratorIdentityLabel(canonicalId, { fallbackLabel })
  if (!contextualLabel || contextualLabel === canonicalId) return `<code>${escapeHtml(canonicalId)}</code>`
  return `${escapeHtml(contextualLabel)} <span class="muted">(<code>${escapeHtml(canonicalId)}</code>)</span>`
}

function draftShareMembershipState(draftId) {
  const collaborators = state.formsUi.collaboratorsByDraftId[draftId]
  if (!Array.isArray(collaborators)) return { status: 'not-loaded', collaborators: [] }
  return { status: 'loaded', collaborators }
}

function draftShareErrorOutcome(error, action = 'complete this collaborator action') {
  const message = String(error?.message || '').toLowerCase()
  const code = String(error?.code || '').toUpperCase()
  const reason = String(error?.details?.reason || '').toLowerCase()
  if (code === 'FORMS_DRAFT_COLLABORATORS_STALE_DRAFT' || reason === 'draft_not_found') {
    return {
      category: 'stale',
      recovery: 'refresh-first',
      message: 'This draft is stale or no longer available. Refresh drafts, then reopen sharing.'
    }
  }
  if (code === 'FORMS_DRAFT_COLLABORATORS_ALREADY_ADDED' || reason === 'already_added') {
    return {
      category: 'duplicate-add',
      recovery: 'retry-latest',
      message: 'That user is already a collaborator. Refresh membership to confirm the latest state.'
    }
  }
  if (code === 'FORMS_DRAFT_COLLABORATORS_ALREADY_REMOVED' || reason === 'already_removed') {
    return {
      category: 'duplicate-remove',
      recovery: 'retry-latest',
      message: 'That collaborator was already removed. Refresh membership to sync with the latest server state.'
    }
  }
  if (code === 'FORMS_DRAFT_COLLABORATORS_OWNER_IMMUTABLE' || reason === 'owner_immutable') {
    return {
      category: 'owner-immutable',
      recovery: 'retry-latest',
      message: 'Draft owner membership is immutable and cannot be removed.'
    }
  }
  if (isConflictError(error) || Number(error?.status) === 409) {
    return {
      category: 'conflict',
      recovery: 'refresh-first',
      message: 'Membership changed on another session. Refresh membership first, then retry with the latest revision.'
    }
  }
  if (message.includes('already added') || message.includes('already a collaborator')) {
    return {
      category: 'duplicate-add',
      recovery: 'retry-latest',
      message: 'That user is already a collaborator. Refresh membership to confirm the latest state.'
    }
  }
  if (message.includes('not assigned')) {
    return {
      category: 'duplicate-remove',
      recovery: 'retry-latest',
      message: 'That collaborator was already removed. Refresh membership to sync with the latest server state.'
    }
  }
  if (message.includes('cannot be removed')) {
    return {
      category: 'owner-immutable',
      recovery: 'retry-latest',
      message: 'Draft owner membership is immutable and cannot be removed.'
    }
  }
  return {
    category: 'unknown',
    recovery: 'retry-latest',
    message: normalizeApiError(error, action)
  }
}

function draftShareRecoveryInstruction(recovery) {
  if (recovery === 'refresh-first') return 'refresh membership first.'
  return 'retry with latest revision.'
}

function collaboratorDisabledReason(draft, control) {
  if (!state.user) return 'Sign in again to continue.'
  if (control === 'refresh' && !canViewDraftCollaborators()) {
    return 'Your role cannot view collaborator membership for this draft.'
  }
  if (canManageDraftCollaborators(draft)) return ''
  if (state.user.role === 'readonly') {
    if (control === 'search') return 'Readonly role can review membership but cannot run collaborator search.'
    if (control === 'add') return 'Readonly role cannot add collaborators.'
    if (control === 'remove') return 'Readonly role cannot remove collaborators.'
  }
  if (state.user.role === 'advisor' && !isDraftOwner(draft)) {
    if (control === 'search') return 'Only the draft owner or an admin can search and stage collaborator changes.'
    if (control === 'add') return 'Only the draft owner or an admin can add collaborators.'
    if (control === 'remove') return 'Only the draft owner or an admin can remove collaborators.'
  }
  return draftCollaboratorDeniedMessage(draft)
}

function draftShareCapabilitySummary(draft, membershipState) {
  const isOwner = isDraftOwner(draft)
  const collaboratorIds = new Set((membershipState?.collaborators || []).map((entry) => entry.userId || entry.id))
  const isCollaborator = isOwner || collaboratorIds.has(state.user?.id)
  const canManage = canManageDraftCollaborators(draft)
  const roleStateLabel = canManage
    ? isOwner
      ? 'Owner + manager'
      : 'Admin manager'
    : isCollaborator
      ? 'Collaborator (view-only sharing)'
      : 'No collaborator access'
  return {
    isOwner,
    isCollaborator,
    canManage,
    roleStateLabel,
    cannotManageReason: canManage ? '' : draftCollaboratorDeniedMessage(draft),
    actionHint: canManage
      ? isOwner
        ? 'Owner controls: you can search firm users, add collaborators, and remove collaborators.'
        : 'Admin override: you can manage collaborators even when you are not the draft owner.'
      : isCollaborator
        ? 'You can edit the draft content, but only the owner/admin can change collaborator membership.'
        : 'You do not currently have collaborator access or collaborator management rights on this draft.'
  }
}

function markDraftMembershipRefreshedAt(draftId, timestamp = new Date()) {
  const iso = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || '').trim()
  state.formsUi.membershipRefreshedAtByDraftId[draftId] = iso || new Date().toISOString()
}

function draftMembershipRefreshLabel(draftId, membershipState) {
  if (membershipState.status !== 'loaded') return 'not loaded yet'
  const refreshedAt = state.formsUi.membershipRefreshedAtByDraftId[draftId]
  if (refreshedAt) return new Date(refreshedAt).toLocaleString()
  return 'loaded (timestamp unavailable)'
}

function draftShareCollaboratorsFromResponse(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.collaborators)) return payload.collaborators
  return []
}

function canViewDraftCollaborators() {
  return roleAllowed('admin,advisor,readonly')
}

function templateOperationPermissions() {
  const role = state.user?.role || ''
  return {
    canRead: roleAllowed('admin,advisor,readonly'),
    canWrite: roleAllowed('admin,advisor'),
    readOnlyMessage: role === 'readonly' ? 'Readonly role: version history and diffs are available, while publish and revert stay disabled.' : ''
  }
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
    state.customFieldSchema = {
      fetched: true,
      loading: false,
      fields: [],
      updatedAt: '',
      lastError: '',
      bulkPreview: null,
      ui: defaultCustomFieldAdminUiState()
    }
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
        const membershipState = draftShareMembershipState(draft.id)
        const list = membershipState.collaborators
        const collaboratorCount = Array.isArray(list) ? list.length : 0
        const lookupResults = state.formsUi.userLookupByDraftId[draft.id] || []
        const lookupSearch = state.formsUi.userLookupSearchByDraftId[draft.id] || ''
        const existingCollaboratorIds = new Set((Array.isArray(list) ? list : []).map((entry) => entry.userId || entry.id))
        const selectableLookupResults = lookupResults.filter(
          (entry) => entry?.id && entry.id !== state.user?.id && !existingCollaboratorIds.has(entry.id)
        )
        const isLookupLoading = Boolean(state.pendingActions[`draft-share-search-${draft.id}`])
        const isMembershipLoading = Boolean(
          state.pendingActions[`draft-share-fetch-${draft.id}`] || state.pendingActions[`draft-share-refresh-${draft.id}`]
        )
        const capability = draftShareCapabilitySummary(draft, membershipState)
        const canManage = capability.canManage
        const shareFeedback = state.formsUi.shareFeedbackByDraftId[draft.id] || ''
        const isShareFeedbackError = /^Error:/.test(shareFeedback)
        const isShareFeedbackSuccess = /^Success:/.test(shareFeedback)
        const shareFeedbackRecovery = state.formsUi.shareFeedbackRecoveryByDraftId[draft.id] || ''
        const showRefreshFirstCta = isShareFeedbackError && shareFeedbackRecovery === 'refresh-first'
        const selectedLookupUserId = state.formsUi.selectedUserIdByDraftId[draft.id] || ''
        const currentUserRole = state.user?.role || 'unknown'
        const ownerIdentity = renderCollaboratorIdentity(draft.createdByUserId, { fallbackLabel: 'unknown owner' })
        const searchDisabledReason = collaboratorDisabledReason(draft, 'search')
        const addDisabledReason = collaboratorDisabledReason(draft, 'add')
        const removeDisabledReason = collaboratorDisabledReason(draft, 'remove')
        const refreshDisabledReason = collaboratorDisabledReason(draft, 'refresh')
        const roleChip = canManage ? (capability.isOwner ? 'Owner manager' : 'Admin manager') : 'View-only'
        const accessChip = capability.isCollaborator ? 'Has draft access' : 'No draft access'
        return `
    <tr>
      <td>${escapeHtml(draft.id)}</td>
      <td>${escapeHtml(draft.templateId)}</td>
      <td>${draft.revisionId || 1}</td>
      <td>${draft.lock ? `Locked (${escapeHtml(draft.lock.holderUserId)})` : 'Unlocked'}</td>
      <td>${membershipState.status === 'loaded' ? collaboratorCount : '—'}</td>
      <td>${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : '—'}</td>
      <td>
        <p class="muted compact">Role state: <strong>${escapeHtml(capability.roleStateLabel)}</strong></p>
        <a href="#${appRoutes.clientFormSubmission(draft.clientId, draft.id)}">Edit from profile</a>
        <button data-lock="${draft.id}">${pendingLabel(`lock-${draft.id}`, 'Acquire lock', 'Acquiring…')}</button>
        <button data-save="${draft.id}">${pendingLabel(`draft-save-${draft.id}`, 'Save revision', 'Saving…')}</button>
        <button data-open-draft-share-panel="${draft.id}" aria-expanded="${panelVisible ? 'true' : 'false'}" aria-controls="${panelId}">
          ${panelVisible ? 'Hide sharing' : 'Share draft'}
        </button>
      </td>
    </tr>
    <tr id="${panelId}" data-draft-share-panel="${draft.id}" ${panelVisible ? '' : 'hidden'}>
      <td colspan="7">
        <div class="item compact">
          <h4>Draft sharing</h4>
          <p class="muted compact">Owner: ${ownerIdentity}</p>
          <p class="muted compact">Collaborators: <strong>${collaboratorCount}</strong> ${membershipState.status === 'loaded' ? '' : '(open sharing to load membership)'}</p>
          <div class="collaborator-status-row">
            <span class="badge subtle collaborator-chip">Role: ${escapeHtml(currentUserRole)}</span>
            <span class="badge subtle collaborator-chip">${escapeHtml(roleChip)}</span>
            <span class="badge subtle collaborator-chip">${escapeHtml(accessChip)}</span>
          </div>
          <p class="muted compact collaborator-action-hint">${escapeHtml(capability.actionHint)}</p>
          <p class="muted compact">Membership refreshed: ${escapeHtml(draftMembershipRefreshLabel(draft.id, membershipState))}
            <button data-refresh-draft-collaborators="${draft.id}" ${canViewDraftCollaborators() ? '' : 'disabled'} aria-describedby="${!canViewDraftCollaborators() ? `refresh-reason-${draft.id}` : ''}">${pendingLabel(`draft-share-refresh-${draft.id}`, 'Refresh membership', 'Refreshing…')}</button>
          </p>
          ${!canViewDraftCollaborators() ? `<p id="refresh-reason-${draft.id}" class="muted compact disabled-control-reason">${escapeHtml(refreshDisabledReason)}</p>` : ''}
          <form data-search-draft-collaborator-users="${draft.id}">
            <label>Search firm users
              <input name="search" placeholder="name, email, or user id" value="${escapeHtml(lookupSearch)}" ${canManage ? '' : 'disabled'} aria-describedby="${!canManage ? `search-reason-${draft.id}` : ''}" />
            </label>
            <button type="submit" ${canManage ? '' : 'disabled'} aria-describedby="${!canManage ? `search-reason-${draft.id}` : ''}">${pendingLabel(`draft-share-search-${draft.id}`, 'Find users', 'Searching…')}</button>
          </form>
          ${!canManage ? `<p id="search-reason-${draft.id}" class="muted compact disabled-control-reason">${escapeHtml(searchDisabledReason)}</p>` : ''}
          <form data-add-draft-collaborator="${draft.id}">
            <label>Add collaborator
              <select name="userId" ${canManage ? '' : 'disabled'} aria-describedby="${!canManage ? `add-reason-${draft.id}` : ''}">
                <option value="">Select a firm user…</option>
                ${selectableLookupResults
                  .map(
                    (user) =>
                      `<option value="${escapeHtml(user.id || '')}" ${String(user.id || '') === selectedLookupUserId ? 'selected' : ''}>${escapeHtml(collaboratorLookupLabel(user))}</option>`
                  )
                  .join('')}
              </select>
            </label>
            <button type="submit" ${canManage ? '' : 'disabled'} aria-describedby="${!canManage ? `add-reason-${draft.id}` : ''}">${pendingLabel(`draft-share-add-${draft.id}`, 'Add', 'Adding…')}</button>
          </form>
          ${!canManage ? `<p id="add-reason-${draft.id}" class="muted compact disabled-control-reason">${escapeHtml(addDisabledReason)}</p>` : ''}
          <p class="muted compact">
            ${
              isLookupLoading
                ? 'Searching firm users…'
                : lookupResults.length
                  ? `${lookupResults.length} user option(s) loaded.`
                  : lookupSearch
                    ? 'No lookup matches yet. Try a different name, email, or user ID.'
                    : 'Search to load firm users you can add as collaborators.'
            }
          </p>
          <p class="muted compact collaborator-feedback ${isShareFeedbackError ? 'error-banner' : isShareFeedbackSuccess ? 'success-banner' : ''}" data-draft-share-feedback="${draft.id}" role="status" aria-live="polite" aria-atomic="true">
            ${escapeHtml(shareFeedback || (!canManage ? capability.cannotManageReason : ''))}
          </p>
          ${
            showRefreshFirstCta
              ? `<div class="collaborator-recovery-hint"><p class="muted compact">Recovery: refresh membership first, then retry with the latest revision. Your in-panel draft context is preserved.</p><button data-refresh-draft-collaborators="${draft.id}" class="tiny">Refresh first</button></div>`
              : ''
          }
          ${
            isMembershipLoading
              ? '<p class="muted compact">Loading collaborator membership…</p>'
              : membershipState.status === 'loaded'
                ? list.length
                ? `<ul>${list
                    .map(
                      (collaborator) => `<li>
                    <span>${renderCollaboratorIdentity(collaborator.userId || collaborator.id || '', { fallbackLabel: collaborator.label || '' })}</span>
                    <button data-remove-draft-collaborator="${draft.id}" data-collaborator-user-id="${escapeHtml(collaborator.userId || collaborator.id || '')}" ${
                      canManage ? '' : 'disabled'
                    } aria-describedby="${!canManage ? `remove-reason-${draft.id}` : ''}">
                      ${pendingLabel(
                        `draft-share-remove-${draft.id}-${collaborator.userId || collaborator.id || ''}`,
                        'Remove',
                        'Removing…'
                      )}
                    </button>
                  </li>`
                    )
                    .join('')}</ul>`
                : '<p class="muted compact">No collaborators assigned yet. Search and add a firm user to grant draft access.</p>'
              : '<p class="muted compact">Open sharing to load current collaborator membership.</p>'
          }
          ${!canManage ? `<p id="remove-reason-${draft.id}" class="muted compact disabled-control-reason">${escapeHtml(removeDisabledReason)}</p>` : ''}
          ${
            membershipState.status === 'loaded' && !isMembershipLoading
              ? '<p class="muted compact">Membership list shown here is the latest loaded snapshot for this panel.</p>'
              : ''
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
    <table><thead><tr><th>Draft ID</th><th>Template</th><th>Revision</th><th>Lock</th><th>Collaborators</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No drafts yet. Create or import a form draft to begin collaboration.</td></tr>'}</tbody></table>
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
      if (!canViewDraftCollaborators()) {
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
        state.formsUi.collaboratorsByDraftId[draftId] = draftShareCollaboratorsFromResponse(collaborators)
        markDraftMembershipRefreshedAt(draftId)
        state.formsUi.userLookupByDraftId[draftId] = canManageDraftCollaborators(draft)
          ? Array.isArray(userLookup?.users)
            ? userLookup.users
            : []
          : []
        state.formsUi.userLookupSearchByDraftId[draftId] = ''
        state.formsUi.shareFeedbackByDraftId[draftId] = canManageDraftCollaborators(draft)
          ? 'Success: membership loaded. Next: search users, then add/remove collaborators.'
          : 'Success: membership loaded in view-only mode. Next: refresh membership to monitor changes.'
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = ''
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = `Error: ${normalizeApiError(error, 'load draft collaborators')} Next: refresh membership and retry.`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = 'refresh-first'
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      queueViewFocus(state.formsUi.lastShareFocusByDraftId[draftId] || `#draft-share-panel-${draftId} h4`)
      await renderForms()
    })
  })

  document.querySelectorAll('[data-refresh-draft-collaborators]').forEach((button) => {
    button.addEventListener('click', async () => {
      const draftId = button.dataset.refreshDraftCollaborators
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canViewDraftCollaborators()) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        await renderForms()
        return
      }
      const actionKey = `draft-share-refresh-${draftId}`
      setActionPending(actionKey, 'pending')
      try {
        const collaborators = await request(routes.formDraftCollaborators(draftId))
        state.formsUi.collaboratorsByDraftId[draftId] = draftShareCollaboratorsFromResponse(collaborators)
        markDraftMembershipRefreshedAt(draftId)
        state.formsUi.shareFeedbackByDraftId[draftId] = `Success: membership refreshed (${state.formsUi.collaboratorsByDraftId[draftId].length} collaborator(s)). Next: retry with latest revision.`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = ''
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = `Error: ${normalizeApiError(error, 'refresh draft collaborators')} Next: retry refresh membership.`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = 'retry-latest'
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      queueViewFocus(state.formsUi.lastShareFocusByDraftId[draftId] || `[data-refresh-draft-collaborators="${draftId}"]`)
      await renderForms()
    })
  })

  document.querySelectorAll('form[data-search-draft-collaborator-users]').forEach((form) => {
    const draftId = form.dataset.searchDraftCollaboratorUsers
    form.querySelector('input[name="search"]')?.addEventListener('focus', () => {
      state.formsUi.lastShareFocusByDraftId[draftId] = `form[data-search-draft-collaborator-users="${draftId}"] input[name="search"]`
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
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
        const visibleCandidateCount = state.formsUi.userLookupByDraftId[draftId].filter((entry) => entry?.id && entry.id !== state.user?.id).length
        state.formsUi.shareFeedbackByDraftId[draftId] = visibleCandidateCount
          ? `Success: ${visibleCandidateCount} user option(s) found. Next: select one and add collaborator.`
          : 'Error: no matching firm users available to add. Next: retry with a broader search.'
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = visibleCandidateCount ? '' : 'retry-latest'
      } catch (error) {
        state.formsUi.shareFeedbackByDraftId[draftId] = `Error: ${normalizeApiError(error, 'search firm users')} Next: retry with latest revision.`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = 'retry-latest'
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      queueViewFocus(state.formsUi.lastShareFocusByDraftId[draftId] || `form[data-search-draft-collaborator-users="${draftId}"] input[name="search"]`)
      await renderForms()
    })
  })

  document.querySelectorAll('form[data-add-draft-collaborator]').forEach((form) => {
    const draftId = form.dataset.addDraftCollaborator
    const selectEl = form.querySelector('select[name="userId"]')
    selectEl?.addEventListener('change', () => {
      state.formsUi.selectedUserIdByDraftId[draftId] = String(selectEl.value || '').trim()
    })
    selectEl?.addEventListener('focus', () => {
      state.formsUi.lastShareFocusByDraftId[draftId] = `form[data-add-draft-collaborator="${draftId}"] select[name="userId"]`
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canManageDraftCollaborators(draft)) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = 'retry-latest'
        await renderForms()
        return
      }
      const userId = String(new FormData(form).get('userId') || '').trim()
      state.formsUi.selectedUserIdByDraftId[draftId] = userId
      const selectFocusSelector = `form[data-add-draft-collaborator="${draftId}"] select[name="userId"]`
      state.formsUi.lastShareFocusByDraftId[draftId] = selectFocusSelector
      if (!userId) {
        state.formsUi.shareFeedbackByDraftId[draftId] = 'Error: select a collaborator from lookup results. Next: search users, then retry add.'
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = 'retry-latest'
        await renderForms()
        return
      }
      const optimisticUser = findKnownFirmUserById(userId) || { id: userId, userId, label: userId, email: '', role: '', permission: 'read' }
      const actionKey = `draft-share-add-${draftId}`
      const previousCollaborators = Array.isArray(state.formsUi.collaboratorsByDraftId[draftId])
        ? [...state.formsUi.collaboratorsByDraftId[draftId]]
        : []
      const previousLookup = [...(state.formsUi.userLookupByDraftId[draftId] || [])]
      setActionPending(actionKey, 'pending')
      if (!previousCollaborators.some((entry) => (entry.userId || entry.id) === userId)) {
        state.formsUi.collaboratorsByDraftId[draftId] = [
          ...previousCollaborators,
          { userId, id: userId, permission: optimisticUser.permission || 'read', label: optimisticUser.label, email: optimisticUser.email }
        ]
      }
      state.formsUi.userLookupByDraftId[draftId] = previousLookup.filter((candidate) => candidate.id !== userId)
      state.formsUi.shareFeedbackByDraftId[draftId] = `Working: granting draft access to ${collaboratorIdentityLabel(userId)}…`
      state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = ''
      await renderForms()
      try {
        await request(routes.formDraftCollaborators(draftId), {
          method: 'POST',
          body: JSON.stringify({ userId })
        })
        const collaborators = await request(routes.formDraftCollaborators(draftId))
        state.formsUi.collaboratorsByDraftId[draftId] = draftShareCollaboratorsFromResponse(collaborators)
        markDraftMembershipRefreshedAt(draftId)
        state.formsUi.userLookupByDraftId[draftId] = (state.formsUi.userLookupByDraftId[draftId] || []).filter(
          (candidate) => candidate.id !== userId
        )
        state.formsUi.selectedUserIdByDraftId[draftId] = ''
        state.formsUi.shareFeedbackByDraftId[draftId] = `Success: ${collaboratorIdentityLabel(userId)} added. Next: refresh membership if other sessions are active.`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = ''
        state.formsUi.lastShareFocusByDraftId[draftId] = selectFocusSelector
        reportActionSuccess('Forms', `Collaborator ${userId} added to draft ${draftId}.`)
      } catch (error) {
        state.formsUi.collaboratorsByDraftId[draftId] = previousCollaborators
        state.formsUi.userLookupByDraftId[draftId] = previousLookup
        const normalized = draftShareErrorOutcome(error, 'add a draft collaborator')
        state.formsUi.shareFeedbackByDraftId[draftId] = `Error: ${normalized.message} Next: ${draftShareRecoveryInstruction(normalized.recovery)}`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = normalized.recovery
        state.formsUi.lastShareFocusByDraftId[draftId] =
          normalized.recovery === 'refresh-first'
            ? `[data-refresh-draft-collaborators="${draftId}"]`
            : selectFocusSelector
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      queueViewFocus(state.formsUi.lastShareFocusByDraftId[draftId] || selectFocusSelector)
      await renderForms()
    })
  })

  document.querySelectorAll('[data-remove-draft-collaborator]').forEach((button) => {
    const initialDraftId = button.dataset.removeDraftCollaborator
    button.addEventListener('focus', () => {
      const candidateUserId = button.dataset.collaboratorUserId
      state.formsUi.lastShareFocusByDraftId[initialDraftId] = `[data-remove-draft-collaborator="${initialDraftId}"][data-collaborator-user-id="${candidateUserId}"]`
    })
    button.addEventListener('click', async () => {
      const draftId = button.dataset.removeDraftCollaborator
      const userId = button.dataset.collaboratorUserId
      const removeFocusSelector = `[data-remove-draft-collaborator="${draftId}"][data-collaborator-user-id="${userId}"]`
      const refreshFocusSelector = `[data-refresh-draft-collaborators="${draftId}"]`
      state.formsUi.lastShareFocusByDraftId[draftId] = removeFocusSelector
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!canManageDraftCollaborators(draft)) {
        state.formsUi.shareFeedbackByDraftId[draftId] = draftCollaboratorDeniedMessage(draft)
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = 'retry-latest'
        await renderForms()
        return
      }
      const actionKey = `draft-share-remove-${draftId}-${userId}`
      const previousCollaborators = Array.isArray(state.formsUi.collaboratorsByDraftId[draftId])
        ? [...state.formsUi.collaboratorsByDraftId[draftId]]
        : []
      const removedCollaborator =
        previousCollaborators.find((entry) => (entry.userId || entry.id) === userId) || findKnownFirmUserById(userId) || { id: userId, label: userId }
      const previousLookup = [...(state.formsUi.userLookupByDraftId[draftId] || [])]
      setActionPending(actionKey, 'pending')
      state.formsUi.collaboratorsByDraftId[draftId] = previousCollaborators.filter((entry) => (entry.userId || entry.id) !== userId)
      if (!previousLookup.some((candidate) => candidate.id === userId)) {
        state.formsUi.userLookupByDraftId[draftId] = [
          ...previousLookup,
          { id: userId, label: removedCollaborator.label || userId, email: removedCollaborator.email || '', role: removedCollaborator.role || '' }
        ]
      }
      state.formsUi.shareFeedbackByDraftId[draftId] = `Working: revoking draft access for ${collaboratorIdentityLabel(userId)}…`
      state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = ''
      await renderForms()
      try {
        await request(routes.formDraftCollaborator(draftId, userId), { method: 'DELETE' })
        const collaborators = await request(routes.formDraftCollaborators(draftId))
        state.formsUi.collaboratorsByDraftId[draftId] = draftShareCollaboratorsFromResponse(collaborators)
        markDraftMembershipRefreshedAt(draftId)
        if (!state.formsUi.userLookupByDraftId[draftId]?.some((candidate) => candidate.id === userId)) {
          state.formsUi.userLookupByDraftId[draftId] = [
            ...(state.formsUi.userLookupByDraftId[draftId] || []),
            { id: userId, label: userId, email: '', role: '' }
          ]
        }
        state.formsUi.shareFeedbackByDraftId[draftId] = `Success: ${collaboratorIdentityLabel(userId)} removed. Next: refresh membership if any race is suspected.`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = ''
        state.formsUi.lastShareFocusByDraftId[draftId] = refreshFocusSelector
        reportActionSuccess('Forms', `Collaborator ${userId} removed from draft ${draftId}.`)
      } catch (error) {
        state.formsUi.collaboratorsByDraftId[draftId] = previousCollaborators
        state.formsUi.userLookupByDraftId[draftId] = previousLookup
        const normalized = draftShareErrorOutcome(error, 'remove a draft collaborator')
        state.formsUi.shareFeedbackByDraftId[draftId] = `Error: ${normalized.message} Next: ${draftShareRecoveryInstruction(normalized.recovery)}`
        state.formsUi.shareFeedbackRecoveryByDraftId[draftId] = normalized.recovery
        state.formsUi.lastShareFocusByDraftId[draftId] = normalized.recovery === 'refresh-first' ? refreshFocusSelector : removeFocusSelector
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      queueViewFocus(state.formsUi.lastShareFocusByDraftId[draftId] || removeFocusSelector)
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

function formatTemplateSampleValue(value, sourcePath = '') {
  const normalizedPath = String(sourcePath || '').trim()
  if (!normalizedPath) return '<span class="muted">No source path</span>'
  if (value === undefined) return '<span class="error-badge">Unresolved source</span>'
  if (value === null || value === '') return '<span class="warning-badge">Empty value</span>'
  const compactJsonPreview = (input) => {
    const serialized = JSON.stringify(input)
    if (serialized.length <= 120) return serialized
    return `${serialized.slice(0, 117)}…`
  }
  const expandLabel = (label, input) => `${label} · ${Array.isArray(input) ? `${input.length} item(s)` : `${Object.keys(input || {}).length} key(s)`}`
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="warning-badge">Repeater empty (0 items)</span>'
    const preview = compactJsonPreview(value.slice(0, 2))
    return `<details class="sample-preview-disclosure"><summary><span class="badge subtle">Repeater (${value.length} items)</span> <span class="muted compact">Preview ${escapeHtml(preview)}</span></summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`
  }
  if (typeof value === 'object') {
    const preview = compactJsonPreview(value)
    return `<details class="sample-preview-disclosure"><summary><span class="badge subtle">${escapeHtml(expandLabel('Object', value))}</span> <span class="muted compact">${escapeHtml(preview)}</span></summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`
  }
  return `<span>${escapeHtml(String(value))}</span>`
}

function toRepeaterDiagnosticPath(issue = {}) {
  const rawPath = String(
    issue?.repeaterPath || issue?.meta?.repeaterPath || issue?.sourcePath || issue?.path || issue?.field || issue?.meta?.path || ''
  ).trim()
  if (!rawPath) return 'root'
  const normalized = rawPath.replace(/\[(\d+)\]/g, '.$1')
  const parts = normalized
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
  const repeaterParts = []
  for (const segment of parts) {
    if (/^\d+$/.test(segment)) break
    repeaterParts.push(segment)
  }
  return repeaterParts.join('.') || rawPath
}

function groupDiagnosticsByRepeaterContext(issues = []) {
  const grouped = new Map()
  issues.forEach((issue) => {
    const rowIndex = Number(issue?.rowIndex)
    const rowKey = Number.isFinite(rowIndex) ? `row-${rowIndex}` : 'row-unknown'
    const repeaterPath = toRepeaterDiagnosticPath(issue)
    const key = `${rowKey}::${repeaterPath}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        rowIndex,
        rowId: String(issue?.rowId || issue?.meta?.rowId || '').trim(),
        repeaterPath,
        issues: []
      })
    }
    grouped.get(key).issues.push(issue)
  })
  return [...grouped.values()].sort((a, b) => Number(a.rowIndex || 0) - Number(b.rowIndex || 0))
}

function mappingLocalIssues(mapping, knownPaths) {
  const issues = []
  const pdfField = String(mapping.pdfField || '').trim()
  const sourcePath = String(mapping.sourcePath || '').trim()
  const targetType = String(mapping.targetType || '').trim()
  const transformType = String(mapping.transformType || '').trim()
  const transformExpression = String(mapping.transformExpression || '').trim()
  if (!pdfField) issues.push(createIssue('required_pdf_field', 'Missing PDF field', 'pdfField'))
  if (!sourcePath) issues.push(createIssue('required_source_path', 'Missing source path', 'sourcePath'))
  if (sourcePath && !knownPaths.has(sourcePath)) issues.push(createIssue('unknown_source_path', 'Unknown source path', 'sourcePath'))
  const sourceType = sourcePath ? knownPaths.get(sourcePath) : ''
  if (sourceType && targetType && sourceType !== targetType) {
    issues.push(createIssue('target_type_mismatch', `Type mismatch (${sourceType} → ${targetType})`, 'targetType'))
  }
  if (transformType === 'expression' && !transformExpression) {
    issues.push(createIssue('missing_transform_expression', 'Missing transform expression', 'transformExpression'))
  }
  return issues
}

function isUnknownOrInvalidSourceIssueCode(code = '') {
  const normalized = String(code || '').toLowerCase()
  return (
    normalized.includes('unknown_source_path') ||
    normalized.includes('invalid_source_path') ||
    normalized.includes('unresolved_source_path')
  )
}

function hasUnresolvedSourcePathIssue(localIssues = [], serverIssues = []) {
  return (
    localIssues.some((issue) => isUnknownOrInvalidSourceIssueCode(issue?.code)) ||
    serverIssues.some((issue) =>
      [issue?.code, issue?.errorCode, issue?.issueId, issue?.meta?.issueId].some((value) => isUnknownOrInvalidSourceIssueCode(value))
    )
  )
}

function formatSchemaIssue(issue = {}) {
  const path = String(issue.field || issue.path || 'mapping')
  const message = String(issue.message || issue.code || 'Validation issue')
  const rowIndex = Number(issue.rowIndex)
  const rowPrefix = Number.isFinite(rowIndex) ? `Row ${rowIndex + 1}: ` : ''
  return `${rowPrefix}${path} — ${message}`
}

function formatTemplateVersionLabel(version = null) {
  const value = Number(version)
  return Number.isFinite(value) ? `v${value}` : 'vN/A'
}

function formatTemplateVersionOptionLabel(entry = {}) {
  const versionLabel = formatTemplateVersionLabel(entry?.version)
  const changeType = String(entry?.changeType || 'update').trim()
  const publishState = String(entry?.publishState || 'draft').trim()
  const bumpIntent = String(entry?.changelog?.versionBump || '').trim()
  const bumpSuffix = bumpIntent ? ` · bump ${bumpIntent}` : ''
  return `${versionLabel} · ${changeType} · ${publishState}${bumpSuffix}`
}

function transitionStateChipMarkup(transition = {}) {
  const fromState = String(transition?.from || transition?.fromVersion || '').trim()
  const toState = String(transition?.to || transition?.toVersion || '').trim()
  const stableStates = new Set(['published', 'active', 'released'])
  const regressed = Boolean(fromState && toState && fromState !== toState && !stableStates.has(toState))
  const chipClass = regressed ? 'warning-badge' : 'subtle'
  const label = regressed ? 'Rollback/Unpublish' : 'Publish progression'
  return `<span class="badge ${chipClass}">${escapeHtml(label)}</span>`
}

function templateCompareSummaryMarkup(diff = {}) {
  const changed = diff?.changed === true
  const summaryItems = [
    ['Blueprint', Boolean(diff?.diff?.blueprintChanged)],
    ['Mappings', Boolean(diff?.diff?.mappingsChanged)],
    ['Publish state', Boolean(diff?.diff?.publishStateChanged)]
  ]
  const mappingDelta = Number(diff?.target?.mappings?.length || 0) - Number(diff?.base?.mappings?.length || 0)
  return `<div class="stack gap-sm">
    <div class="row wrap gap-sm">
      <span class="badge ${changed ? 'warning-badge' : 'subtle'}">${changed ? 'Changed' : 'No changes'}</span>
      ${summaryItems
        .map(([label, value]) => `<span class="badge ${value ? 'warning-badge' : 'subtle'}">${escapeHtml(label)} ${value ? 'Δ' : 'same'}</span>`)
        .join('')}
      <span class="badge subtle">Mapping rows Δ ${mappingDelta >= 0 ? '+' : ''}${mappingDelta}</span>
    </div>
    <div class="muted compact">Base ${formatTemplateVersionLabel(diff?.baseVersion)} (${escapeHtml(diff?.base?.changeType || 'update')}) → Target ${formatTemplateVersionLabel(diff?.targetVersion)} (${escapeHtml(diff?.target?.changeType || 'update')})</div>
    <details>
      <summary>Raw diff payload</summary>
      <pre>${escapeHtml(JSON.stringify(diff, null, 2))}</pre>
    </details>
  </div>`
}

function deriveTemplateIssueRowAnchor(rowIndex) {
  const rowAnchor = Number.isFinite(Number(rowIndex)) ? `#mapping-row-${Number(rowIndex)}` : ''
  return rowAnchor
}

function mappingSaveStateLabel(saveState = {}, statusContext = {}) {
  if (statusContext.hasLocalValidationFailures) return 'Local validation failed'
  if (statusContext.hasPreflightSchemaFailures) return 'Preflight schema failed'
  if (statusContext.publishReady) return 'Publish-ready'
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
      '<li><strong>Local validation failures.</strong> Fix rows marked in <em>Local validation</em>, then run <em>Save Now</em>.</li>'
    )
  }
  if (hasBlockingPreviewWarnings) {
    blockers.push(
      '<li><strong>Preview reported blocking warnings/issues.</strong> Use the row jump buttons in Preview/Remediation, correct the source path or transform, then rerun Preview.</li>'
    )
  }
  if (preflightIssues.length) {
    blockers.push(
      `<li><strong>Preflight schema failures.</strong> ${preflightIssues.length} issue(s) across ${preflightIssueRows.size || 0} row(s). Resolve listed issue IDs and rerun preflight.</li>`
    )
  }
  if (!blockers.length) return ''
  return `<div class="publish-blockers" role="status" aria-live="polite"><p class="publish-disabled-reason"><strong>Publish blocked:</strong></p><ul>${blockers.join('')}</ul></div>`
}

function publishReadinessPanelMarkup({ readiness = null, fallbackIssues = [] }) {
  const blockers = Array.isArray(readiness?.blockers)
    ? readiness.blockers
    : fallbackIssues.filter((issue) => issue?.blocking !== false)
  const warnings = Array.isArray(readiness?.warnings)
    ? readiness.warnings
    : fallbackIssues.filter((issue) => issue?.blocking === false || issue?.severity === 'warning')
  const quickLinks = Array.isArray(readiness?.quickLinks)
    ? readiness.quickLinks
    : blockers
        .map((issue) => {
          const rowIndex = Number(issue?.rowIndex)
          if (!Number.isFinite(rowIndex)) return null
          const rowId = String(issue?.rowId || issue?.meta?.rowId || '').trim()
          return { rowIndex, rowId, field: issue?.field || 'sourcePath', label: `Row ${rowIndex + 1}` }
        })
        .filter(Boolean)
  const renderIssue = (issue) => {
    const rowIndex = Number(issue?.rowIndex)
    const rowId = String(issue?.rowId || issue?.meta?.rowId || '').trim()
    const rowAnchor = deriveTemplateIssueRowAnchor(rowIndex)
    const anchor = String(issue?.rowAnchor || issue?.meta?.rowAnchor || rowAnchor)
    const inspectorTarget = String(issue?.inspectorTarget || issue?.meta?.inspectorTarget || issue?.field || 'sourcePath')
    const cta = Number.isFinite(rowIndex)
      ? `<a href="${escapeHtml(anchor)}" class="tiny secondary" data-preflight-rowindex="${rowIndex}" data-preflight-rowid="${escapeHtml(rowId)}" data-focus-inspector="${escapeHtml(inspectorTarget)}">Row ${rowIndex + 1}</a> · `
      : ''
    return `<li>${cta}<code>${escapeHtml(issue?.issueId || issue?.meta?.issueId || issue?.code || 'issue')}</code> · ${escapeHtml(formatSchemaIssue(issue))}</li>`
  }
  const groupedBlockers = groupDiagnosticsByRepeaterContext(blockers)
  const groupedWarnings = groupDiagnosticsByRepeaterContext(warnings)
  const renderGroup = (group, tone = 'error-badge') => {
    const rowAnchor = deriveTemplateIssueRowAnchor(group.rowIndex)
    const focusField =
      group.issues.find((entry) => String(entry?.inspectorTarget || entry?.meta?.inspectorTarget || '').trim())?.inspectorTarget ||
      group.issues[0]?.field ||
      'sourcePath'
    const issueCountLabel = `${group.issues.length} issue${group.issues.length === 1 ? '' : 's'}`
    const rowLink = Number.isFinite(group.rowIndex)
      ? `<a href="${escapeHtml(rowAnchor)}" class="tiny secondary" data-preflight-rowindex="${group.rowIndex}" data-preflight-rowid="${escapeHtml(group.rowId)}" data-focus-inspector="${escapeHtml(focusField)}">Row ${group.rowIndex + 1}</a>`
      : '<span class="muted">Row n/a</span>'
    return `<li>${rowLink} · <span class="${tone}">${escapeHtml(group.repeaterPath)}</span> · ${escapeHtml(issueCountLabel)}<ul>${group.issues.map(renderIssue).join('')}</ul></li>`
  }
  const readinessStatus = blockers.length ? 'Blocked' : warnings.length ? 'Ready with warnings' : 'Ready'
  const readinessTone = blockers.length ? 'error-badge' : warnings.length ? 'warning-badge' : 'badge subtle'
  return `<section class="publish-readiness-panel" aria-labelledby="publish-readiness-heading">
    <h4 id="publish-readiness-heading">Publish readiness</h4>
    <p class="muted compact">Local validation and preflight schema failures block publish; publish-ready means both are clear.</p>
    <p class="row wrap gap-sm"><span class="${readinessTone}">Status: ${escapeHtml(readinessStatus)}</span><span class="badge subtle">Blockers ${blockers.length}</span><span class="badge subtle">Warnings ${warnings.length}</span></p>
    <div class="grid two">
      <div>
        <h5>Blockers (${blockers.length})</h5>
        ${blockers.length ? `<ul>${blockers.map(renderIssue).join('')}</ul>` : '<p class="muted">No blockers found.</p>'}
        ${
          groupedBlockers.length
            ? `<h6>Grouped by row + repeater path</h6><ul>${groupedBlockers.map((group) => renderGroup(group, 'error-badge')).join('')}</ul>`
            : ''
        }
      </div>
      <div>
        <h5>Warnings (${warnings.length})</h5>
        ${warnings.length ? `<ul>${warnings.map(renderIssue).join('')}</ul>` : '<p class="muted">No warnings.</p>'}
        ${
          groupedWarnings.length
            ? `<h6>Grouped by row + repeater path</h6><ul>${groupedWarnings.map((group) => renderGroup(group, 'warning-badge')).join('')}</ul>`
            : ''
        }
      </div>
    </div>
    <h5>Quick links</h5>
    ${
      quickLinks.length
        ? `<p class="row wrap gap-sm">${quickLinks
            .map((entry) => {
              const rowIndex = Number(entry?.rowIndex)
              const rowId = String(entry?.rowId || '').trim()
              if (!Number.isFinite(rowIndex)) return ''
              const rowAnchor = deriveTemplateIssueRowAnchor(rowIndex)
              return `<a href="${escapeHtml(entry?.anchor || rowAnchor)}" class="tiny secondary" data-preflight-rowindex="${rowIndex}" data-preflight-rowid="${escapeHtml(rowId)}" data-focus-inspector="${escapeHtml(entry?.field || 'sourcePath')}">${escapeHtml(entry?.label || `Row ${rowIndex + 1}`)}</a>`
            })
            .join(' ')}</p>`
        : '<p class="muted">Quick links appear after preflight finds row-level diagnostics.</p>'
    }
  </section>`
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
    localIssues.some((issue) => issue.code === 'unknown_source_path') ||
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
  if (!state.templateMappingSearchByTemplateId) state.templateMappingSearchByTemplateId = {}
  if (!state.templateMappingSuggestionsByTemplateId) state.templateMappingSuggestionsByTemplateId = {}
  if (!state.templateInspectorFocusRequestByTemplateId) state.templateInspectorFocusRequestByTemplateId = {}
  if (!state.templateJumpHighlightByTemplateId) state.templateJumpHighlightByTemplateId = {}
  if (!state.templateNavigationRequestByTemplateId) state.templateNavigationRequestByTemplateId = {}

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
    .map((entry) => `<option value="${entry.version}">${escapeHtml(formatTemplateVersionOptionLabel(entry))}</option>`)
    .join('')
  const latestVersionEntry = versions?.[0] || null
  const previousVersionEntry = versions?.[1] || null
  const latestVersion = latestVersionEntry?.version || ''
  const compareDefaultBaseVersion = previousVersionEntry?.version ?? latestVersionEntry?.version ?? ''
  const compareDefaultTargetVersion = latestVersionEntry?.version ?? ''
  const publishIntentOptions = [
    { id: 'patch', label: 'Patch', versionBump: '0.0.1', guidance: 'small mapping or wording updates' },
    { id: 'minor', label: 'Minor', versionBump: '0.1.0', guidance: 'additive mapping coverage changes' },
    { id: 'major', label: 'Major', versionBump: '1.0.0', guidance: 'breaking mapping/schema behavior' }
  ]
  const persistedPublishIntentId = template ? state.templatePublishIntentByTemplateId[template.id] : ''
  const selectedPublishIntent =
    publishIntentOptions.find((entry) => entry.id === persistedPublishIntentId) || publishIntentOptions[0]
  if (template && selectedPublishIntent?.id !== persistedPublishIntentId) {
    state.templatePublishIntentByTemplateId[template.id] = selectedPublishIntent.id
  }
  const templateOpsPermissions = templateOperationPermissions()

  const knownPaths = knownProfileSourcePaths()
  ;(template?.formSchema?.sections || []).forEach((section) => collectTemplateSchemaPaths(section.fields || [], '', knownPaths))
  const knownPathIndex = normalizedKnownPathIndex(knownPaths)

  const mappingIssuesByIndex = new Map(draftMappings.map((mapping, index) => [index, mappingLocalIssues(mapping, knownPaths, index)]))
  const preview = template ? state.templatePreviewByTemplateId[template.id] : null
  const preflight = template ? state.templatePublishPreflightByTemplateId[template.id] : null
  const preflightIssues = Array.isArray(preflight?.issues) ? preflight.issues : []
  const publishReadiness = preflight?.publishReadiness || null
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
      message: issue.errorMessage || issue.message || 'Preflight validation issue',
      focusField: issue.inspectorTarget || issue?.meta?.inspectorTarget || issue.field || 'sourcePath',
      anchor: issue.rowAnchor || issue?.meta?.rowAnchor || deriveTemplateIssueRowAnchor(issue?.rowIndex)
    }))
  ].filter((entry) => Number.isFinite(entry.rowIndex))
  const hasLocalMappingErrors = [...mappingIssuesByIndex.values()].some((issues) => issues.length > 0)
  const hasBlockingPreviewWarnings =
    Number(preview?.blockingWarningsCount || 0) > 0 || (preview?.issues || []).some((issue) => issue.blocking)
  const hasPreflightCheck = Boolean(preflight?.checkedAt)
  const publishDisabled = hasLocalMappingErrors || hasBlockingPreviewWarnings || preflightIssues.length > 0 || !hasPreflightCheck
  const templateFilter = state.templateMappingFilterByTemplateId[template?.id] || 'all'
  const templateSearch = String(state.templateMappingSearchByTemplateId[template?.id] || '').trim()
  const allowedTemplateFilters = new Set(['all', 'needs-fix', 'unresolved-only', 'unmapped', 'preview-warning', 'required-only'])
  const activeTemplateFilter = allowedTemplateFilters.has(templateFilter) ? templateFilter : 'all'
  if (template && activeTemplateFilter !== templateFilter) state.templateMappingFilterByTemplateId[template.id] = activeTemplateFilter
  const navigationRequest = template ? state.templateNavigationRequestByTemplateId[template.id] || null : null
  const rowJumpHighlight = (() => {
    const requestIndex = Number(navigationRequest?.rowIndex)
    if (Number.isFinite(requestIndex)) return requestIndex
    const requestRowId = String(navigationRequest?.rowId || '').trim()
    if (requestRowId) {
      const byDraftRowId = draftMappings.findIndex((mapping) => String(mapping?.rowId || '').trim() === requestRowId)
      if (byDraftRowId >= 0) return byDraftRowId
      const byPreviewRowId = Number(
        [...(state.templatePreviewByTemplateId?.[template.id]?.rows || [])].find((row) => String(row?.rowId || '').trim() === requestRowId)
          ?.rowIndex
      )
      if (Number.isFinite(byPreviewRowId)) return byPreviewRowId
    }
    return template ? Number(state.templateJumpHighlightByTemplateId[template.id]) : NaN
  })()
  const suggestionDraftByIndex = template ? state.templateMappingSuggestionsByTemplateId[template.id] || {} : {}
  const suggestionByIndex = new Map()
  let unresolvedRowsCount = 0
  draftMappings.forEach((mapping, index) => {
    const rowIssues = mappingIssuesByIndex.get(index) || []
    const previewRow = previewRowsByIndex.get(index)
    const rowId = String(previewRow?.rowId || '').trim()
    const serverPreflightIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
    const unresolved = hasUnresolvedSourcePathIssue(rowIssues, serverPreflightIssues)
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
  const mappingHealthCounts = {
    unmapped: draftMappings.filter((mapping) => !String(mapping.sourcePath || '').trim()).length,
    localErrors: [...mappingIssuesByIndex.values()].filter((issues) => issues.length > 0).length,
    preflightBlockers: preflightIssueRows.size,
    previewWarnings: draftMappings.filter((_, index) => previewWarningRows.has(index) || previewIssueRows.has(index)).length,
    lowConfidence: draftMappings.filter((mapping) => {
      const confidence = mappingConfidenceBadge(mapping, knownPathIndex)
      return confidence.tone === 'low' && String(mapping.sourcePath || '').trim()
    }).length
  }
  const mappingFilterMatches = (mapping, index) => {
    const issues = mappingIssuesByIndex.get(index) || []
    const hasPreviewWarnings = previewWarningRows.has(index) || previewIssueRows.has(index)
    const previewRow = previewRowsByIndex.get(index)
    const rowId = String(previewRow?.rowId || mapping?.rowId || '').trim()
    const serverPreflightIssues = [...(preflightIssuesByRowIndex.get(index) || []), ...(rowId ? preflightIssuesByRowId.get(rowId) || [] : [])]
    const isUnmapped = !String(mapping.sourcePath || '').trim()
    const isUnresolved = hasUnresolvedSourcePathIssue(issues, serverPreflightIssues)
    const passesFilter =
      activeTemplateFilter === 'all' ||
      (activeTemplateFilter === 'needs-fix' && (issues.length > 0 || serverPreflightIssues.length > 0)) ||
      (activeTemplateFilter === 'unresolved-only' && isUnresolved) ||
      (activeTemplateFilter === 'unmapped' && isUnmapped) ||
      (activeTemplateFilter === 'preview-warning' && hasPreviewWarnings) ||
      (activeTemplateFilter === 'required-only' && mapping.required === true)
    const searchCorpus = [index + 1, mapping.pdfField || '', mapping.fieldLabel || '', mapping.sourcePath || '', rowId].join(' ').toLowerCase()
    const passesSearch = !templateSearch || searchCorpus.includes(templateSearch.toLowerCase())
    return { passesFilter, passesSearch, rowId, issues, hasPreviewWarnings, serverPreflightIssues, isUnmapped, isUnresolved }
  }
  const filteredRowIndices = draftMappings
    .map((mapping, index) => ({ index, outcome: mappingFilterMatches(mapping, index) }))
    .filter((entry) => entry.outcome.passesFilter && entry.outcome.passesSearch)
    .map((entry) => entry.index)

  const selectedRowIndex = Number.isInteger(state.templateInspector?.[template?.id]?.rowIndex)
    ? state.templateInspector[template.id].rowIndex
    : 0
  const safeSelectedRowIndex = Math.min(Math.max(selectedRowIndex, 0), Math.max(0, draftMappings.length - 1))
  if (template) state.templateInspector[template.id] = { rowIndex: safeSelectedRowIndex }
  const selectedMapping = draftMappings[safeSelectedRowIndex] || mappingDraftFromServer({})

  const mappedFieldSet = new Set(draftMappings.map((entry) => String(entry.pdfField || '').trim()).filter(Boolean))
  const extractedFields = normalizedExtractedFields(template)
  const extractedFieldMetaByName = new Map(
    extractedFields.map((field) => [String(field.fieldName || '').trim(), field]).filter(([name]) => Boolean(name))
  )
  const extractedFieldsForReconciliation = [...extractedFields].sort((left, right) => {
    const leftUnmapped = mappedFieldSet.has(left.fieldName) ? 0 : 1
    const rightUnmapped = mappedFieldSet.has(right.fieldName) ? 0 : 1
    const leftPriority = (left.required ? 2 : 0) + leftUnmapped
    const rightPriority = (right.required ? 2 : 0) + rightUnmapped
    if (leftPriority !== rightPriority) return rightPriority - leftPriority
    return String(left.fieldName || '').localeCompare(String(right.fieldName || ''))
  })
  const mappedExtractedCount = extractedFields.filter((field) => mappedFieldSet.has(field.fieldName)).length
  const extraction = template?.extraction || {}
  const hasExtractionData = extractedFields.length > 0 || Boolean(extraction?.status)
  const hasMappingData = draftMappings.length > 0 || extractedFields.length > 0
  const hasPreviewableMappings = draftMappings.length > 0
  const wizardStepEnabled = {
    upload: true,
    extraction: hasExtractionData,
    mapping: hasMappingData,
    preview: hasPreviewableMappings,
    publish: hasPreviewableMappings
  }
  const wizardSteps = ['upload', 'extraction', 'mapping', 'preview', 'publish']
  const defaultWizardStep = extraction?.status === 'failed' ? 'extraction' : extractedFields.length ? 'mapping' : 'upload'
  const activeWizardStepCandidate = wizardSteps.includes(state.templateWizardStepByTemplateId?.[template?.id])
    ? state.templateWizardStepByTemplateId[template.id]
    : defaultWizardStep
  const activeWizardStep = wizardStepEnabled[activeWizardStepCandidate] ? activeWizardStepCandidate : defaultWizardStep
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
              return `<button type="button" class="tiny ${activeWizardStep === step ? '' : 'secondary'}" data-template-wizard-step="${step}" aria-pressed="${activeWizardStep === step ? 'true' : 'false'}" ${wizardStepEnabled[step] ? '' : 'disabled'}>${label}</button>`
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
        <div class="row wrap gap-sm">
          <span class="badge subtle">Extracted fields ${extractedFields.length}</span>
          <span class="badge ${mappedExtractedCount === extractedFields.length && extractedFields.length ? 'subtle' : 'warning-badge'}">Mapped ${mappedExtractedCount}</span>
          <span class="badge ${Math.max(0, extractedFields.length - mappedExtractedCount) > 0 ? 'error-badge' : 'subtle'}">Unmapped ${Math.max(0, extractedFields.length - mappedExtractedCount)}</span>
          <button id="jump-to-unmapped-extracted" class="tiny secondary">Review unmapped in mapping</button>
        </div>
        ${
          extraction?.status === 'failed'
            ? `<p class="error-banner">${escapeHtml(templateIngestionRecoveryMessage(extraction))}</p>`
            : '<p class="muted">Extraction completed. Review mapped/unmapped fields before editing mappings.</p>'
        }
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Mapping Health</h3>
        <div class="row wrap gap-sm mapping-health-header" data-mapping-health-summary>
          <span class="badge">Unmapped ${mappingHealthCounts.unmapped}</span>
          <span class="badge ${mappingHealthCounts.localErrors ? 'error-badge' : 'subtle'}">Local errors ${mappingHealthCounts.localErrors}</span>
          <span class="badge ${mappingHealthCounts.preflightBlockers ? 'error-badge' : 'subtle'}">Preflight blockers ${mappingHealthCounts.preflightBlockers}</span>
          <span class="badge ${mappingHealthCounts.previewWarnings ? 'warning-badge' : 'subtle'}">Preview warnings ${mappingHealthCounts.previewWarnings}</span>
          <span class="badge ${mappingHealthCounts.lowConfidence ? 'warning-badge' : 'subtle'}">Low confidence ${mappingHealthCounts.lowConfidence}</span>
        </div>
        <div class="row wrap gap-sm">
          <span class="badge">Mapped ${draftMappings.filter((entry) => entry.enabled !== false && String(entry.pdfField || '').trim()).length}</span>
          <span class="badge subtle">Unmapped ${Math.max(0, extractedFields.length - mappedExtractedCount)}</span>
          <span class="badge ${hasLocalMappingErrors ? 'error-badge' : 'warning-badge'}">Local validation ${hasLocalMappingErrors ? 'Failed' : 'Clear'}</span>
          <span class="badge ${preflightIssues.length ? 'error-badge' : 'subtle'}">Preflight schema ${preflightIssues.length ? 'Failed' : 'Clear'}</span>
          <span class="badge ${publishDisabled ? 'warning-badge' : 'subtle'}">Publish state ${publishDisabled ? 'Blocked' : 'Ready'}</span>
          <span class="badge subtle">Autosave: ${escapeHtml(
            mappingSaveStateLabel(saveState, {
              hasLocalValidationFailures: hasLocalMappingErrors,
              hasPreflightSchemaFailures: preflightIssues.length > 0,
              publishReady: !publishDisabled
            })
          )}</span>
        </div>
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Extracted AcroForm Fields</h3>
        <p class="muted compact">Priority order surfaces <strong>unmapped required</strong> fields first for faster remediation.</p>
        <ul>${extractedFieldsForReconciliation
          .map((field) => {
            const mapped = mappedFieldSet.has(field.fieldName)
            return `<li><strong>${escapeHtml(field.fieldName)}</strong> <span class="badge">${escapeHtml(field.fieldType)}</span>${field.required ? ' <span class="badge warning-badge">Required</span>' : ''}${field.readOnly ? ' <span class="badge subtle">Read-only</span>' : ''}${field.pageIndex != null ? ` <span class="badge subtle">Page ${field.pageIndex + 1}</span>` : ''} <span class="badge ${mapped ? 'subtle' : 'error-badge'}">${mapped ? 'Mapped' : 'Unmapped'}</span><button data-remove-extracted="${field.index}" class="secondary tiny">Remove</button></li>`
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
        <p class="muted compact">Keyboard shortcuts: <code>j</code>/<code>k</code> next/previous row, <code>g</code> first row, <code>Shift+G</code> last row, <code>i</code> focus inspector Source Path.</p>
        <p class="muted compact">Next actions: <strong>Save Now</strong> after edits, use <strong>Filter unresolved</strong> to isolate blockers, then switch to <strong>4. Preview</strong> when validation reads Ready.</p>
        <div class="row gap-sm wrap sticky-remediation-actions">
          <button id="add-mapping-row" class="tiny">Add Mapping</button>
          <button id="save-mappings" class="tiny">Save Now</button>
          <button id="suggest-source-paths" class="tiny secondary">Suggest source paths</button>
          <button id="apply-suggested-mappings" class="tiny secondary">Apply suggestions</button>
          <button id="filter-unresolved-rows" class="tiny secondary">Filter unresolved</button>
          <button id="auto-map-similar" class="tiny secondary">Auto-map similar names</button>
          <button id="clear-unresolved-rows" class="tiny secondary">Clear unresolved rows</button>
          <button type="button" class="tiny secondary" data-template-wizard-step="preview">Go to Step 4 · Preview</button>
        </div>
        <div class="row gap-sm wrap top-gap">
          ${[
            { value: 'all', label: `All (${draftMappings.length})` },
            { value: 'needs-fix', label: `Needs fix (${draftMappings.filter((_, index) => (mappingIssuesByIndex.get(index) || []).length > 0 || preflightIssues.some((issue) => Number(issue.rowIndex) === index)).length})` },
            { value: 'unresolved-only', label: `Unresolved only (${unresolvedRowsCount})` },
            { value: 'unmapped', label: `Unmapped (${draftMappings.filter((mapping) => !String(mapping.sourcePath || '').trim()).length})` },
            { value: 'preview-warning', label: `Preview warning (${draftMappings.filter((_, index) => previewWarningRows.has(index) || previewIssueRows.has(index)).length})` },
            { value: 'required-only', label: `Required only (${draftMappings.filter((mapping) => mapping.required === true).length})` }
          ]
            .map(
              (filter) =>
                `<button type="button" class="tiny ${activeTemplateFilter === filter.value ? '' : 'secondary'}" data-mapping-filter="${filter.value}" aria-pressed="${activeTemplateFilter === filter.value ? 'true' : 'false'}">${filter.label}</button>`
            )
            .join('')}
        </div>
        <label class="top-gap">Search mappings
          <input id="mapping-search" value="${escapeHtml(templateSearch)}" placeholder="Filter by row, pdf field, label, source path, or row id" />
        </label>
        <p class="muted compact">Showing ${filteredRowIndices.length} of ${draftMappings.length} mapping row(s).</p>
        <table><thead><tr><th>#</th><th>State</th><th>PDF Field</th><th>Field context</th><th>Source Path</th><th>Suggested</th><th>Label</th><th>Confidence</th><th>Local validation</th><th>Server preflight</th><th>Preview</th><th>Sample</th></tr></thead><tbody>
          ${draftMappings
            .map((mapping, index) => {
              const { passesFilter, passesSearch, issues, hasPreviewWarnings, rowId, serverPreflightIssues } = mappingFilterMatches(mapping, index)
              if (!passesFilter || !passesSearch) return ''
              const sampleValue = resolveSampleValue(mapping.sourcePath)
              const rowClasses = ['mapping-row-item']
              const extractedMeta = extractedFieldMetaByName.get(String(mapping.pdfField || '').trim()) || null
              if (index === safeSelectedRowIndex) rowClasses.push('is-selected')
              if (index === rowJumpHighlight) rowClasses.push('is-jumped')
              if (mapping.required === true && !String(mapping.sourcePath || '').trim()) rowClasses.push('is-required-unmapped')
              if (issues.length || serverPreflightIssues.length) rowClasses.push('has-blocker')
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
              return `<tr id="mapping-row-${index}" class="${rowClasses.join(' ')}" data-select-row="${index}" data-row-id="${escapeHtml(rowId)}" tabindex="0" aria-label="Mapping row ${index + 1}">
                <td>${index + 1}</td>
                <td>${stateBadge}</td>
                <td>${escapeHtml(mapping.pdfField || '')}</td>
                <td>${extractedMeta ? `<span class="badge subtle">${escapeHtml(extractedMeta.fieldType || 'unknown')}</span>${extractedMeta.required ? ' <span class="warning-badge">Required</span>' : ''}${extractedMeta.readOnly ? ' <span class="badge subtle">Read-only</span>' : ''}${extractedMeta.pageIndex != null ? ` <span class="badge subtle">Page ${Number(extractedMeta.pageIndex) + 1}</span>` : ''}` : '<span class="muted">No extraction metadata</span>'}</td>
                <td>${escapeHtml(mapping.sourcePath || '')}</td>
                <td>${
                  suggestion
                    ? `<span class="badge subtle">${escapeHtml(suggestion.path)}</span><div class="muted">${escapeHtml(suggestion.reason || 'Suggested')} (${Math.round(Number(suggestion.score || 0) * 100)}%)</div><button class="tiny secondary top-gap" data-apply-suggestion-row="${index}" data-suggested-path="${escapeHtml(suggestion.path)}">Apply</button>`
                    : '<span class="muted">None</span>'
                }</td>
                <td>${escapeHtml(mapping.fieldLabel || '')}</td>
                <td><span class="badge subtle">${escapeHtml(confidence.label)}</span></td>
                <td>${
                  issues.length
                    ? `<ul>${issues
                        .map(
                          (issue) =>
                            `<li><a href="${escapeHtml(issue.rowAnchor || deriveTemplateIssueRowAnchor(index))}" class="tiny secondary" data-preflight-rowindex="${index}" data-focus-inspector="${escapeHtml(issue.inspectorTarget || 'sourcePath')}">${escapeHtml(issue.code)}</a> · ${escapeHtml(issue.message)}</li>`
                        )
                        .join('')}</ul><div class="muted">Hint: update Source Path using known paths and rerun Save Now.</div>`
                    : '<span class="muted">OK</span>'
                }</td>
                <td>${
                  serverPreflightIssues.length
                    ? `<ul>${serverPreflightIssues
                        .map((issue) => {
                          const rowIndex = Number(issue?.rowIndex)
                          const rowAnchor = deriveTemplateIssueRowAnchor(rowIndex)
                          const anchor = issue?.rowAnchor || issue?.meta?.rowAnchor || rowAnchor || '#'
                          const inspectorTarget = issue?.inspectorTarget || issue?.meta?.inspectorTarget || issue?.field || 'sourcePath'
                          return `<li><a href="${escapeHtml(anchor)}" class="tiny secondary" data-preflight-rowindex="${Number.isFinite(rowIndex) ? rowIndex : index}" data-preflight-rowid="${escapeHtml(issue?.rowId || issue?.meta?.rowId || '')}" data-focus-inspector="${escapeHtml(inspectorTarget)}">${escapeHtml(issue.issueId || issue.code || 'issue')}</a></li>`
                        })
                        .join('')}</ul>`
                    : '<span class="muted">None</span>'
                }</td>
                <td>${hasPreviewWarnings ? '<span class="warning-badge">Preview warning</span>' : '<span class="muted">OK</span>'}</td>
                <td>${formatTemplateSampleValue(sampleValue, mapping.sourcePath)}</td>
              </tr>`
            })
            .join('') || '<tr><td colspan="12" class="muted">No mappings match this filter.</td></tr>'}
        </tbody></table>
      </section>
      <section class="item mapping-current-row-context" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Current Row Context</h3>
        <div class="row wrap gap-sm">
          <span class="badge">Row ${safeSelectedRowIndex + 1}</span>
          <span class="badge subtle">PDF field ${escapeHtml(selectedMapping.pdfField || 'n/a')}</span>
          <span class="badge subtle">Source path ${escapeHtml(selectedMapping.sourcePath || 'unmapped')}</span>
          <span class="badge subtle">Row id ${escapeHtml(selectedMapping.rowId || previewRowsByIndex.get(safeSelectedRowIndex)?.rowId || 'n/a')}</span>
        </div>
      </section>
      <section class="item" data-template-wizard-section="mapping" ${activeWizardStep === 'mapping' ? '' : 'hidden'}>
        <h3>Field Inspector</h3>
        <div class="muted">Selected row ${safeSelectedRowIndex + 1} of ${Math.max(1, draftMappings.length)}${selectedMapping.enabled === false ? ' (disabled)' : ''}</div>
        ${(() => {
          const inspectorMeta = extractedFieldMetaByName.get(String(selectedMapping.pdfField || '').trim()) || null
          if (!inspectorMeta) return '<p class="muted compact">No extracted metadata for this row yet.</p>'
          return `<div class="row wrap gap-sm"><span class="badge">Type: ${escapeHtml(inspectorMeta.fieldType || 'unknown')}</span>${inspectorMeta.required ? '<span class="warning-badge">Required field</span>' : '<span class="badge subtle">Optional field</span>'}${inspectorMeta.readOnly ? '<span class="badge subtle">Read-only</span>' : '<span class="badge subtle">Editable</span>'}${inspectorMeta.pageIndex != null ? `<span class="badge subtle">Page ${Number(inspectorMeta.pageIndex) + 1}</span>` : '<span class="badge subtle">Page n/a</span>'}</div>`
        })()}
        <div class="row wrap gap-sm">
          ${
            selectedMapping.enabled === false
              ? '<span class="badge subtle">State: disabled</span>'
              : '<span class="badge subtle">State: enabled</span>'
          }
          ${
            (mappingIssuesByIndex.get(safeSelectedRowIndex) || []).length
              ? `<span class="error-badge">Local issues: ${escapeHtml((mappingIssuesByIndex.get(safeSelectedRowIndex) || []).map((issue) => issue.message).join('; '))}</span>`
              : '<span class="badge subtle">Local validation: OK</span>'
          }
          ${
            (preflightIssuesByRowIndex.get(safeSelectedRowIndex) || []).length
              ? `<span class="error-badge">Preflight issues: ${escapeHtml(
                  (preflightIssuesByRowIndex.get(safeSelectedRowIndex) || []).map((issue) => issue.code || issue.message || 'issue').join(', ')
                )}</span>`
              : '<span class="badge subtle">Preflight: clear</span>'
          }
          ${(() => {
            const selectedConfidence = mappingConfidenceBadge(selectedMapping, knownPathIndex)
            return `<span class="badge subtle">Confidence: ${escapeHtml(selectedConfidence.label)}</span>`
          })()}
        </div>
        <p class="muted">Validation hints: ensure PDF Field + Source Path are filled, Source Path exists in known paths, and expression transforms include an expression.</p>
        <datalist id="source-path-options">${[...knownPaths.keys()].map((path) => `<option value="${escapeHtml(path)}"></option>`).join('')}</datalist>
        <div class="grid two">
          <label>PDF Field<input id="inspector-pdfField" value="${escapeHtml(selectedMapping.pdfField || '')}" /></label>
          <label>Field Label/Name<input id="inspector-fieldLabel" value="${escapeHtml(selectedMapping.fieldLabel || '')}" /></label>
          <label>Source Path<input id="inspector-sourcePath" list="source-path-options" value="${escapeHtml(selectedMapping.sourcePath || '')}" /><div class="muted">Use <code>profile.*</code> for client profile fields or <code>submission.*</code>/<code>form.*</code> for form answers.</div></label>
          <label>Default Value<input id="inspector-defaultValue" value="${escapeHtml(selectedMapping.defaultValue || '')}" /></label>
          <label>Target Type<select id="inspector-targetType">${['text', 'number', 'boolean', 'date']
            .map((type) => `<option value="${type}" ${selectedMapping.targetType === type ? 'selected' : ''}>${type}</option>`)
            .join('')}</select></label>
          <label>Transform Type<select id="inspector-transformType">${['', 'date', 'phone', 'currency', 'checkbox', 'expression']
            .map((type) => `<option value="${type}" ${selectedMapping.transformType === type ? 'selected' : ''}>${type || 'none'}</option>`)
            .join('')}</select></label>
          <label>Transform Expression<input id="inspector-transformExpression" value="${escapeHtml(selectedMapping.transformExpression || '')}" /><div class="muted">Only required for <code>expression</code>. Clear transform fields to make mapping pass-through again.</div></label>
          <label>Transform Currency<input id="inspector-transformCurrency" value="${escapeHtml(selectedMapping.transformCurrency || '')}" placeholder="USD" /></label>
          <label><input type="checkbox" id="inspector-required" ${selectedMapping.required ? 'checked' : ''} /> Required</label>
          <label><input type="checkbox" id="inspector-enabled" ${selectedMapping.enabled !== false ? 'checked' : ''} /> Mapping Enabled</label>
        </div>
        <div class="row gap-sm wrap top-gap">
          <button id="inspector-reset-source-path" class="tiny secondary">Clear source path</button>
          <button id="inspector-reset-source-path-suggested" class="tiny secondary">Reset to suggested source path</button>
          <button id="inspector-reset-transform" class="tiny secondary">Reset transform to none</button>
        </div>
      </section>
      <section class="item" data-template-wizard-section="preview" ${activeWizardStep === 'preview' ? '' : 'hidden'}>
        <h3>Mapping Preview</h3>
        <p class="muted compact">Run Preview after each mapping save. If warnings appear, use <strong>Jump to row</strong> to open the exact mapping row, fix it in Field Inspector, then rerun preview.</p>
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
        <p class="muted compact">${
          templateOpsPermissions.readOnlyMessage
            ? escapeHtml(templateOpsPermissions.readOnlyMessage)
            : 'Write-capable operators can run preflight, publish, and revert from this panel.'
        }</p>
        <div class="row wrap gap-sm">
          <span class="badge subtle">Current ${escapeHtml(formatTemplateVersionLabel(latestVersionEntry?.version))}</span>
          <span class="badge subtle">Change type ${escapeHtml(latestVersionEntry?.changeType || 'n/a')}</span>
          <span class="badge subtle">Publish state ${escapeHtml(latestVersionEntry?.publishState || template?.publishState || 'draft')}</span>
          <span class="badge subtle">Last bump ${escapeHtml(latestVersionEntry?.changelog?.versionBump || 'n/a')}</span>
        </div>
        <p class="muted compact">Recommended order: <strong>Run Publish Preflight</strong> → remediate listed rows using row actions → rerun preflight until clear → <strong>Publish</strong>.</p>
        <div class="row wrap gap-sm">
          <label>Publish bump intent
            <select id="publish-version-bump-intent" ${templateOpsPermissions.canWrite ? '' : 'disabled'}>
              ${publishIntentOptions
                .map(
                  (entry) =>
                    `<option value="${entry.id}" ${selectedPublishIntent.id === entry.id ? 'selected' : ''}>${escapeHtml(entry.label)} · ${escapeHtml(entry.versionBump)} (${escapeHtml(entry.guidance)})</option>`
                )
                .join('')}
            </select>
          </label>
          <span class="badge subtle">Selected bump value ${escapeHtml(selectedPublishIntent.versionBump)}</span>
        </div>
        <p class="muted compact">${
          hasPreflightCheck
            ? `Preflight summary (${escapeHtml(new Date(preflight?.checkedAt || Date.now()).toLocaleString())}): ${preflightIssues.length} schema issue(s), ${Number(preflight?.blockingWarningsCount || 0)} blocking warning(s), ${Number(preflight?.warningsCount || 0)} total warning(s).`
            : 'Preflight summary: not run yet in this session. Publish stays disabled until preflight executes.'
        }</p>
        <div class="row gap-sm wrap">
          <button type="button" class="tiny secondary" data-template-wizard-step="mapping">Back to Step 3 · Mapping</button>
          <button type="button" class="tiny secondary" data-template-wizard-step="preview">Back to Step 4 · Preview</button>
          <button id="run-publish-preflight" class="tiny secondary" ${templateOpsPermissions.canWrite ? '' : 'disabled'}>Run Publish Preflight</button>
          <button id="publish-template" class="tiny publish-action" ${publishDisabled || !templateOpsPermissions.canWrite ? 'disabled' : ''}>Publish</button>
        </div>
        ${publishBlockersMarkup({ hasLocalMappingErrors, hasBlockingPreviewWarnings, preflightIssues, preflightIssueRows })}
        ${publishReadinessPanelMarkup({ readiness: publishReadiness, fallbackIssues: preflightIssues })}
        ${
          preflightIssues.length
            ? `<p class="publish-disabled-reason">Publish preflight found ${preflightIssues.length} schema validation issue(s) across ${preflightIssueRows.size || 0} mapped row(s).</p>`
            : '<p class="muted">Run preflight to surface publish-time schema validation (unknown source paths, required mappings, and transform issues) before attempting publish.</p>'
        }
        ${
          remediationRows.length
            ? `<h4>Row-level remediation</h4><ul>${remediationRows
                .map(
                  (item) =>
                    `<li><a href="${escapeHtml(item.anchor || deriveTemplateIssueRowAnchor(item.rowIndex))}" class="tiny secondary" data-remediate-rowindex="${item.rowIndex}" data-remediate-rowid="${escapeHtml(item.rowId || '')}" data-focus-inspector="${escapeHtml(item.focusField || 'sourcePath')}">Row ${item.rowIndex + 1}</a> · <code>${escapeHtml(item.code)}</code> · ${escapeHtml(item.message)}${item.rowId ? ` · rowId <code>${escapeHtml(item.rowId)}</code>` : ''}${item.blocking ? ' · <strong>blocking</strong>' : ' · non-blocking'}</li>`
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
        <p class="muted compact">Read path: compare is available to readonly, advisor, and admin operators.</p>
        <p class="muted compact">Default hint: base auto-selects the previous revision (when available), target auto-selects current revision.</p>
        <div class="row gap-sm wrap">
          <select id="compare-base">${versionOptions}</select>
          <select id="compare-target">${versionOptions}</select>
          <button id="compare-template-versions" class="tiny">Compare</button>
        </div>
        <div id="compare-results" class="muted">Select two versions to compare field + mapping changes. Compare highlights blueprint, mapping, and publish-state deltas with version context.</div>
      </section>
      <section class="item">
        <h3>Revert Version</h3>
        <p class="muted compact">Write path: revert requires advisor/admin permissions.</p>
        <p class="muted compact">Default hint: selected revert version starts on the previous revision to avoid accidental no-op requests.</p>
        <div class="row gap-sm wrap">
          <select id="revert-version">${versionOptions}</select>
          <button id="revert-template-version" class="tiny secondary" ${templateOpsPermissions.canWrite ? '' : 'disabled'}>Revert to selected version</button>
        </div>
      </section>
      <section class="item">
        <h3>Publish Transition Log</h3>
        <table><thead><tr><th>From</th><th>To</th><th>When</th><th>By</th></tr></thead><tbody>
          ${(transitions || [])
            .map((entry) => {
              const fromLabel = formatTemplateVersionLabel(entry.fromVersion ?? entry.from)
              const toLabel = formatTemplateVersionLabel(entry.toVersion ?? entry.to)
              return `<tr><td>${fromLabel}</td><td>${toLabel}</td><td>${escapeHtml(new Date(entry.createdAt || entry.at || Date.now()).toLocaleString())}</td><td>${escapeHtml(entry.createdByUserId || entry.actorUserId || 'system')}<div class="muted compact">${transitionStateChipMarkup(entry)}</div></td></tr>`
            })
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
  const ensureTemplateWriteAccess = async (actionLabel) => {
    if (templateOperationPermissions().canWrite) return true
    reportActionError('Templates', { message: `Permission denied: ${actionLabel} requires advisor/admin template write access.` })
    await rerenderTemplates()
    return false
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
      const requestedStep = String(button.dataset.templateWizardStep || 'mapping')
      if (!wizardStepEnabled[requestedStep]) return
      state.templateWizardStepByTemplateId[template.id] = requestedStep
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

  const selectTemplateRow = async (
    rowIndex,
    { focusInspector = false, focusField = 'sourcePath', highlightRow = false, wizardStep = '', ensureVisibleInFilter = false } = {}
  ) => {
    if (!template) return
    const normalizedRowIndex = Math.max(0, Math.min(draftMappings.length - 1, Number(rowIndex)))
    if (!Number.isFinite(normalizedRowIndex)) return
    if (ensureVisibleInFilter) {
      if (activeTemplateFilter !== 'all') state.templateMappingFilterByTemplateId[template.id] = 'all'
      if (state.templateMappingSearchByTemplateId[template.id]) state.templateMappingSearchByTemplateId[template.id] = ''
    }
    state.templateInspector[template.id] = { rowIndex: normalizedRowIndex }
    if (wizardStep && wizardSteps.includes(wizardStep)) state.templateWizardStepByTemplateId[template.id] = wizardStep
    state.templateInspectorFocusRequestByTemplateId[template.id] = focusInspector ? focusField : ''
    state.templateJumpHighlightByTemplateId[template.id] = highlightRow ? normalizedRowIndex : NaN
    const resolvedRowId = String(
      draftMappings[normalizedRowIndex]?.rowId || state.templatePreviewByTemplateId?.[template.id]?.rows?.[normalizedRowIndex]?.rowId || ''
    ).trim()
    state.templateNavigationRequestByTemplateId[template.id] =
      focusInspector || highlightRow
        ? {
            rowIndex: normalizedRowIndex,
            rowId: resolvedRowId,
            focusField: focusInspector ? focusField : '',
            remainingRenders: 3
          }
        : null
    await renderTemplates()
  }

  const resolveTemplateRowIndexFromIssue = (rowIndex, rowId = '') => {
    const numericRowIndex = Number(rowIndex)
    if (Number.isFinite(numericRowIndex)) return numericRowIndex
    const normalizedRowId = String(rowId || '').trim()
    if (!normalizedRowId) return NaN
    const previewMatchIndex = Number(
      [...(state.templatePreviewByTemplateId?.[template.id]?.rows || [])].find((row) => String(row?.rowId || '').trim() === normalizedRowId)
        ?.rowIndex
    )
    if (Number.isFinite(previewMatchIndex)) return previewMatchIndex
    return draftMappings.findIndex((mapping) => String(mapping?.rowId || '').trim() === normalizedRowId)
  }

  const selectTemplateRowFromIssue = async (
    rowIndex,
    rowId,
    { focusInspector = false, focusField = 'sourcePath', highlightRow = true } = {}
  ) => {
    const resolvedRowIndex = resolveTemplateRowIndexFromIssue(rowIndex, rowId)
    if (!Number.isFinite(resolvedRowIndex) || resolvedRowIndex < 0) return
    await selectTemplateRow(resolvedRowIndex, { focusInspector, focusField, highlightRow, wizardStep: 'mapping', ensureVisibleInFilter: true })
  }

  document.querySelectorAll('[data-select-row]').forEach((row) => {
    const rowIndex = Number(row.dataset.selectRow)
    row.addEventListener('click', async () => selectTemplateRow(rowIndex))
    row.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        await selectTemplateRow(rowIndex)
        return
      }
      const currentVisibleIndex = filteredRowIndices.indexOf(rowIndex)
      if (event.key === 'ArrowDown' && currentVisibleIndex >= 0 && currentVisibleIndex < filteredRowIndices.length - 1) {
        event.preventDefault()
        await selectTemplateRow(filteredRowIndices[currentVisibleIndex + 1], { highlightRow: true })
      }
      if (event.key === 'ArrowUp' && currentVisibleIndex > 0) {
        event.preventDefault()
        await selectTemplateRow(filteredRowIndices[currentVisibleIndex - 1], { highlightRow: true })
      }
      if (event.key === 'Home' && filteredRowIndices.length) {
        event.preventDefault()
        await selectTemplateRow(filteredRowIndices[0], { highlightRow: true })
      }
      if (event.key === 'End' && filteredRowIndices.length) {
        event.preventDefault()
        await selectTemplateRow(filteredRowIndices[filteredRowIndices.length - 1], { highlightRow: true })
      }
    })
  })
  document.querySelector('[data-template-wizard-section="mapping"] table')?.addEventListener('keydown', async (event) => {
    if (!filteredRowIndices.length) return
    const targetTag = String(event.target?.tagName || '').toLowerCase()
    if (['input', 'textarea', 'select', 'button'].includes(targetTag)) return
    if (event.key === 'j') {
      event.preventDefault()
      const nextIndex = Math.min(filteredRowIndices.length - 1, filteredRowIndices.indexOf(safeSelectedRowIndex) + 1)
      await selectTemplateRow(filteredRowIndices[Math.max(0, nextIndex)], { highlightRow: true })
      return
    }
    if (event.key === 'k') {
      event.preventDefault()
      const previousIndex = Math.max(0, filteredRowIndices.indexOf(safeSelectedRowIndex) - 1)
      await selectTemplateRow(filteredRowIndices[previousIndex], { highlightRow: true })
      return
    }
    if (event.key === 'g' && !event.shiftKey) {
      event.preventDefault()
      await selectTemplateRow(filteredRowIndices[0], { highlightRow: true })
      return
    }
    if (event.key === 'G' || (event.key === 'g' && event.shiftKey)) {
      event.preventDefault()
      await selectTemplateRow(filteredRowIndices[filteredRowIndices.length - 1], { highlightRow: true })
      return
    }
    if (event.key === 'i') {
      event.preventDefault()
      await selectTemplateRow(safeSelectedRowIndex, { focusInspector: true, focusField: 'sourcePath', highlightRow: true })
    }
  })

  document.querySelectorAll('[data-mapping-filter]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!template) return
      state.templateMappingFilterByTemplateId[template.id] = String(button.dataset.mappingFilter || 'all')
      await rerenderTemplates()
    })
  })
  document.querySelector('#mapping-search')?.addEventListener('input', async (event) => {
    if (!template) return
    state.templateMappingSearchByTemplateId[template.id] = String(event.target?.value || '')
    await rerenderTemplates()
  })

  document.querySelector('#jump-to-unmapped-extracted')?.addEventListener('click', async () => {
    if (!template) return
    const firstUnmappedIndex = draftMappings.findIndex((mapping) => !String(mapping.sourcePath || '').trim())
    state.templateWizardStepByTemplateId[template.id] = 'mapping'
    state.templateMappingFilterByTemplateId[template.id] = 'unmapped'
    if (firstUnmappedIndex >= 0) {
      state.templateInspector[template.id] = { rowIndex: firstUnmappedIndex }
      state.templateNavigationRequestByTemplateId[template.id] = {
        rowIndex: firstUnmappedIndex,
        rowId: String(draftMappings[firstUnmappedIndex]?.rowId || '').trim(),
        focusField: 'sourcePath',
        remainingRenders: 3
      }
    }
    state.templateInspectorFocusRequestByTemplateId[template.id] = 'sourcePath'
    await rerenderTemplates()
  })

  document.querySelectorAll('[data-apply-suggestion-row]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!template) return
      const rowIndex = Number(button.dataset.applySuggestionRow)
      if (!Number.isFinite(rowIndex)) return
      const suggestionPath = String(button.dataset.suggestedPath || '').trim()
      if (!suggestionPath) return
      const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
      const current = nextDraft[rowIndex] || mappingDraftFromServer({})
      if (String(current.sourcePath || '').trim() === suggestionPath) {
        setFlash('success', `Row ${rowIndex + 1} already uses suggested source path.`)
        await rerenderTemplates()
        return
      }
      nextDraft[rowIndex] = { ...current, sourcePath: suggestionPath }
      state.templateMappingDrafts[template.id] = nextDraft
      state.templateInspector[template.id] = { rowIndex }
      state.templateSaveStateByTemplateId[template.id] = { status: 'dirty' }
      setFlash('success', `Applied suggestion to row ${rowIndex + 1}.`)
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

  document.querySelector('#inspector-reset-source-path')?.addEventListener('click', async () => {
    const sourcePathEl = document.querySelector('#inspector-sourcePath')
    if (!sourcePathEl) return
    sourcePathEl.value = ''
    await applyInspectorToDraft()
    await rerenderTemplates()
  })
  document.querySelector('#inspector-reset-source-path-suggested')?.addEventListener('click', async () => {
    if (!template) return
    const rowIndex = Number(state.templateInspector?.[template.id]?.rowIndex || 0)
    const suggestion = suggestionByIndex.get(rowIndex)
    const sourcePathEl = document.querySelector('#inspector-sourcePath')
    if (!sourcePathEl || !suggestion?.path) return
    sourcePathEl.value = String(suggestion.path).trim()
    await applyInspectorToDraft()
    await rerenderTemplates()
  })

  document.querySelector('#inspector-reset-transform')?.addEventListener('click', async () => {
    const typeEl = document.querySelector('#inspector-transformType')
    const expressionEl = document.querySelector('#inspector-transformExpression')
    const currencyEl = document.querySelector('#inspector-transformCurrency')
    if (typeEl) typeEl.value = ''
    if (expressionEl) expressionEl.value = ''
    if (currencyEl) currencyEl.value = ''
    await applyInspectorToDraft()
    await rerenderTemplates()
  })

  document.querySelector('#add-mapping-row')?.addEventListener('click', async () => {
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    nextDraft.push(mappingDraftFromServer({ targetType: 'text', enabled: true }))
    state.templateMappingDrafts[template.id] = nextDraft
    state.templateInspector[template.id] = { rowIndex: nextDraft.length - 1 }
    await rerenderTemplates()
  })

  document.querySelector('#save-mappings')?.addEventListener('click', async () => {
    if (template) {
      const currentRowIndex = Number(state.templateInspector?.[template.id]?.rowIndex || 0)
      state.templateNavigationRequestByTemplateId[template.id] = {
        rowIndex: currentRowIndex,
        rowId: String(draftMappings[currentRowIndex]?.rowId || '').trim(),
        focusField: 'sourcePath',
        remainingRenders: 2
      }
    }
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
      const unresolved = hasUnresolvedSourcePathIssue(rowIssues, serverIssues)
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
      const unresolved = hasUnresolvedSourcePathIssue(rowIssues, serverIssues)
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
    setFlash('success', `Auto-mapped ${updates} row(s) by name similarity.`)
    await rerenderTemplates()
  })

  document.querySelector('#clear-unresolved-rows')?.addEventListener('click', async () => {
    if (!template) return
    const nextDraft = [...(state.templateMappingDrafts[template.id] || [])]
    let updates = 0
    nextDraft.forEach((mapping, index) => {
      const previewWarnings = previewRowsByIndex.get(index)?.warnings || []
      const hasUnresolvedPreviewIssue = previewWarnings.some((warning) => String(warning.code || '') === 'UNRESOLVED_SOURCE_PATH')
      const hasUnknownLocalPath = (mappingIssuesByIndex.get(index) || []).some((issue) => issue.code === 'unknown_source_path')
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
    if (!(await ensureTemplateWriteAccess('publish preflight'))) return
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
        blockingWarningsCount: nextPreview.blockingWarningsCount || 0,
        publishReadiness: nextPreview.publishReadiness || null
      }
      state.templateWizardStepByTemplateId[template.id] = 'publish'
      if ((nextPreview.issues || []).length) {
        setFlash('error', `Publish preflight found ${(nextPreview.issues || []).length} schema issue(s).`)
      } else {
        setFlash('success', 'Publish preflight passed with no schema validation issues.')
      }
    } catch (error) {
      state.templatePublishPreflightByTemplateId[template.id] = {
        checkedAt: new Date().toISOString(),
        issues: error?.details?.issues || [],
        publishReadiness: error?.details?.publishReadiness || null
      }
      reportActionError('Template publish preflight', error)
    }
    await rerenderTemplates()
  })

  document.querySelector('#publish-version-bump-intent')?.addEventListener('change', async (event) => {
    if (!template) return
    state.templatePublishIntentByTemplateId[template.id] = String(event.target.value || 'patch')
    await rerenderTemplates('#publish-version-bump-intent')
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
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      const rowIndex = Number(button.dataset.preflightRowindex)
      const rowId = String(button.dataset.preflightRowid || '').trim()
      await selectTemplateRowFromIssue(rowIndex, rowId, {
        focusInspector: true,
        focusField: button.dataset.focusInspector || 'sourcePath',
        highlightRow: true
      })
    })
    button.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
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
    button.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      const rowIndex = Number(button.dataset.remediateRowindex)
      const rowId = String(button.dataset.remediateRowid || '').trim()
      await selectTemplateRowFromIssue(rowIndex, rowId, {
        focusInspector: true,
        focusField: button.dataset.focusInspector || 'sourcePath',
        highlightRow: true
      })
    })
  })

  const pendingNavigation = template ? state.templateNavigationRequestByTemplateId[template.id] || null : null
  const pendingInspectorFocusField = pendingNavigation?.focusField || (template ? state.templateInspectorFocusRequestByTemplateId[template.id] : '')
  if (pendingInspectorFocusField) {
    const inspectorEl = document.querySelector(`#inspector-${pendingInspectorFocusField}`)
    inspectorEl?.focus({ preventScroll: true })
    if (template && !pendingNavigation) state.templateInspectorFocusRequestByTemplateId[template.id] = ''
  }
  const resolvePendingJumpRowIndex = () => {
    if (!template) return NaN
    const rowIndexFromRequest = Number(pendingNavigation?.rowIndex)
    if (Number.isFinite(rowIndexFromRequest) && rowIndexFromRequest >= 0 && rowIndexFromRequest < draftMappings.length) return rowIndexFromRequest
    const pendingRowId = String(pendingNavigation?.rowId || '').trim()
    if (pendingRowId) {
      const draftMatchIndex = draftMappings.findIndex((mapping) => String(mapping?.rowId || '').trim() === pendingRowId)
      if (draftMatchIndex >= 0) return draftMatchIndex
      const previewMatchIndex = Number(
        [...(state.templatePreviewByTemplateId?.[template.id]?.rows || [])].find((row) => String(row?.rowId || '').trim() === pendingRowId)
          ?.rowIndex
      )
      if (Number.isFinite(previewMatchIndex) && previewMatchIndex >= 0 && previewMatchIndex < draftMappings.length) return previewMatchIndex
    }
    const highlightedIndex = Number(state.templateJumpHighlightByTemplateId[template.id])
    return Number.isFinite(highlightedIndex) ? highlightedIndex : NaN
  }
  const pendingJumpRow = resolvePendingJumpRowIndex()
  let navigationTargetSettled = false
  if (Number.isFinite(pendingJumpRow)) {
    const target = document.querySelector(`#mapping-row-${pendingJumpRow}`)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.focus({ preventScroll: true })
      navigationTargetSettled = true
    }
  }
  if (template && pendingNavigation) {
    const decrement = navigationTargetSettled || !Number.isFinite(pendingJumpRow) ? 1 : 0
    const remainingRenders = Math.max(0, Number(pendingNavigation.remainingRenders || 0) - decrement)
    if (remainingRenders > 0) {
      state.templateNavigationRequestByTemplateId[template.id] = {
        ...pendingNavigation,
        rowIndex: Number.isFinite(pendingJumpRow) ? pendingJumpRow : pendingNavigation.rowIndex,
        remainingRenders
      }
      if (Number.isFinite(pendingJumpRow)) state.templateJumpHighlightByTemplateId[template.id] = pendingJumpRow
    } else {
      state.templateNavigationRequestByTemplateId[template.id] = null
      state.templateJumpHighlightByTemplateId[template.id] = NaN
      state.templateInspectorFocusRequestByTemplateId[template.id] = ''
    }
  }

  document.querySelector('#publish-template')?.addEventListener('click', async () => {
    if (!(await ensureTemplateWriteAccess('template publish'))) return
    try {
      const clientId = document.querySelector('#preview-client')?.value
      const submissionId = document.querySelector('#preview-submission')?.value
      const selectedIntentId = String(document.querySelector('#publish-version-bump-intent')?.value || selectedPublishIntent.id)
      const resolvedPublishIntent = publishIntentOptions.find((entry) => entry.id === selectedIntentId) || selectedPublishIntent
      const preflightPreview = await request(routes.documentTemplateMappingsPreview(template.id), {
        method: 'POST',
        body: JSON.stringify({ clientId, submissionId })
      })
      state.templatePreviewByTemplateId[template.id] = preflightPreview
      state.templatePublishPreflightByTemplateId[template.id] = {
        checkedAt: new Date().toISOString(),
        issues: preflightPreview.issues || [],
        warningsCount: preflightPreview.warningsCount || 0,
        blockingWarningsCount: preflightPreview.blockingWarningsCount || 0,
        publishReadiness: preflightPreview.publishReadiness || null
      }
      const hasBlockingWarnings =
        Number(preflightPreview?.blockingWarningsCount || 0) > 0 || (preflightPreview?.issues || []).some((issue) => issue.blocking)
      if (hasBlockingWarnings) throw new Error('Publish blocked: preview contains blocking warnings/issues.')
      await request(routes.documentTemplatePublish(template.id), {
        method: 'POST',
        body: JSON.stringify({
          versionBump: resolvedPublishIntent.versionBump,
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
          issues: error.details.issues,
          publishReadiness: error.details.publishReadiness || null
        }
      }
      reportActionError('Templates', error)
    }
    await rerenderTemplates()
  })

  document.querySelector('#compare-base')?.addEventListener('change', (event) => {
    const compareTargetSelect = document.querySelector('#compare-target')
    if (!compareTargetSelect?.value) compareTargetSelect.value = event.target.value
  })
  const compareBaseEl = document.querySelector('#compare-base')
  const compareTargetEl = document.querySelector('#compare-target')
  const revertVersionEl = document.querySelector('#revert-version')
  if (compareBaseEl && compareDefaultBaseVersion !== '') compareBaseEl.value = String(compareDefaultBaseVersion)
  if (compareTargetEl && compareDefaultTargetVersion !== '') compareTargetEl.value = String(compareDefaultTargetVersion)
  if (revertVersionEl) revertVersionEl.value = String(compareDefaultBaseVersion || latestVersion || '')

  document.querySelector('#compare-template-versions')?.addEventListener('click', async () => {
    try {
      const baseVersion = Number(document.querySelector('#compare-base')?.value)
      const targetVersion = Number(document.querySelector('#compare-target')?.value)
      if (!Number.isFinite(baseVersion) || !Number.isFinite(targetVersion)) throw new Error('Select two valid versions to compare.')
      if (baseVersion === targetVersion) {
        throw new Error('No-op compare: base and target are the same version. Choose a prior base version to inspect deltas.')
      }
      const diff = await request(routes.documentTemplateCompare(template.id, { baseVersion, targetVersion }))
      document.querySelector('#compare-results').innerHTML = templateCompareSummaryMarkup(diff)
      reportActionSuccess('Templates', `Compared versions ${baseVersion} and ${targetVersion}.`)
    } catch (error) {
      reportActionError('Templates', error)
      await rerenderTemplates()
    }
  })

  document.querySelector('#revert-template-version')?.addEventListener('click', async () => {
    if (!(await ensureTemplateWriteAccess('template revert'))) return
    try {
      const targetVersion = Number(document.querySelector('#revert-version')?.value)
      if (!Number.isFinite(targetVersion)) throw new Error('Select a valid version to revert to.')
      const latestVersionNumber = Number(versions?.[0]?.version)
      if (Number.isFinite(latestVersionNumber)) {
        const previewDiff = await request(
          routes.documentTemplateCompare(template.id, { baseVersion: targetVersion, targetVersion: latestVersionNumber })
        )
        if (!previewDiff.changed) {
          reportActionSuccess('Templates', `No-op revert: version ${targetVersion} already matches current template state, so nothing changed.`)
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
  const customFieldGroups = groupedCustomFields(state.customFieldSchema.fields || [])
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
        <select id="stage-${card.id}" data-stage-select="${card.id}" ${canEdit ? '' : 'disabled'}>
          ${stageSelectOptionsMarkup(cardStage)}
        </select>
      </div>
      <form id="profile-edit-${card.id}" class="inline-edit hidden top-gap" data-edit-form="${card.id}" data-updated-at="${escapeHtml(card.updatedAt || '')}" aria-live="polite">
        <div class="grid two">
          <input name="firstName" value="${escapeHtml(inlineState.draft.firstName || '')}" placeholder="First name" required ${canEdit ? '' : 'disabled'} />
          <input name="lastName" value="${escapeHtml(inlineState.draft.lastName || '')}" placeholder="Last name" required ${canEdit ? '' : 'disabled'} />
        </div>
        <input name="email" type="email" value="${escapeHtml(inlineState.draft.email || '')}" placeholder="Email" ${canEdit ? '' : 'disabled'} />
        <input name="phone" value="${escapeHtml(inlineState.draft.phone || '')}" placeholder="Phone" ${canEdit ? '' : 'disabled'} />
        ${
          state.customFieldSchema.fields.length
            ? `<div class="item compact">
              <h4>Custom Fields</h4>
              ${Object.entries(customFieldGroups)
                .map(
                  ([groupName, fields]) => `<div class="top-gap">
                  <h5>${escapeHtml(groupName)}</h5>
                  <div class="grid two">
                ${fields
                  .map((field) =>
                    customFieldControlMarkup(field, inlineState.draft[customFieldInputName(field.key)] || '', {
                      disabled: !canEdit,
                      idPrefix: `profile-edit-${card.id}`,
                      booleanControl: 'toggle'
                    })
                  )
                  .join('')}
              </div></div>`
                )
                .join('')}
              <p class="muted compact">Where these appear: profile detail + draft/resume flows for advisor operators.</p>
              <p class="muted compact" data-inline-custom-field-errors="${card.id}" role="status" aria-live="polite"></p>
            </div>`
            : '<p class="muted compact">No custom fields configured yet for this firm.</p>'
        }
        <div class="actions-row">
          <button type="submit" class="tiny" ${canEdit && inlineState.dirty && !inlineState.saving ? '' : 'disabled'}>${inlineState.saving ? 'Saving…' : 'Save'}</button>
          <button type="button" class="secondary tiny" data-inline-retry-save="${card.id}" ${canEdit && inlineState.lastSaveWasError && !inlineState.saving ? '' : 'hidden'}>Retry save</button>
          <button type="button" class="secondary tiny" data-inline-conflict-refresh="${card.id}" ${canEdit && inlineState.lastSaveWasError && !inlineState.saving ? '' : 'hidden'}>Reload latest (keep my edits)</button>
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

async function refreshInlineProfileFromLatestBoard(kind, profileId, { preserveDraft = false } = {}) {
  const boardKey = boardKeyForKind(kind)
  const latest = await request(routes.profileDetail(profileId))
  const latestProfile = latest?.profile || latest
  if (!latestProfile?.id) return
  state[boardKey] = updateCardInBoard(state[boardKey], profileId, latestProfile)
  if (preserveDraft) {
    const entry = ensureInlineProfileState(kind, profileId, latestProfile)
    entry.latest = editableProfileFieldsFromCard(latestProfile)
    entry.expectedUpdatedAt = latestProfile.updatedAt || ''
    entry.conflictRecoveryHint = 'Reloaded latest server values. Your unsaved edits remain in the form.'
    updateInlineDirtyState(kind, profileId)
    return
  }
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
  document.querySelectorAll('[data-inline-conflict-refresh]').forEach((button) => {
    button.addEventListener('click', async () => {
      const profileId = button.dataset.inlineConflictRefresh
      await refreshInlineProfileFromLatestBoard(kind, profileId, { preserveDraft: true })
      await renderCurrentView()
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
      if (!canMutate) return
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
        if (feedbackEl) feedbackEl.textContent = `${message} Your unsaved edits were preserved. Use retry, or reload latest and keep edits.`
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
          <td><span class="badge ${isDownloadableExport(job) ? 'subtle' : String(job.status || '').toLowerCase() === 'failed' || String(job.status || '').toLowerCase() === 'dead-letter' ? 'error-badge' : 'warning-badge'}">${escapeHtml(job.statusLabel || job.status)}</span><div class="muted compact">${escapeHtml(job.retryState?.hint || 'No retry hint')}</div></td>
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
                : `<span class="muted">Not ready</span><div class="muted compact">${escapeHtml(job.failureReason || job.deadLetterReason || job.retryState?.hint || 'Artifact will appear after successful completion.')}</div>`
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
  if (type === 'number') return 'Numbers only. Decimals allowed (example: 125000.50).'
  if (type === 'date') return 'Date only in YYYY-MM-DD format.'
  if (type === 'boolean') return 'Boolean true/false. UI renders as select/toggle controls.'
  return 'Text value. Keep labels concise for board card readability.'
}

function defaultCustomFieldAdminUiState() {
  return {
    create: { status: '', message: '', fieldErrors: {}, dirty: false },
    updatesByKey: {},
    deleteByKey: {},
    bulk: { status: '', message: '', rowErrorsByKey: {}, draftRows: [] },
    optimisticBanner: { status: '', message: '' },
    dirtyByKey: {},
    saveStatus: { state: 'idle', message: '', savedAt: '', retryTarget: '', conflictHint: '' }
  }
}

async function renderCustomFieldsAdmin() {
  await ensureCustomFieldSchema()
  const canManage = canManageCustomFieldSchema()
  const readonlyMessage = !canManage ? customFieldReadonlyMessage() : ''
  const fields = state.customFieldSchema.fields || []
  state.customFieldSchema.ui = state.customFieldSchema.ui || defaultCustomFieldAdminUiState()
  const uiState = state.customFieldSchema.ui
  const createUi = uiState.create || { status: '', message: '', fieldErrors: {}, dirty: false }
  const bulkUi = uiState.bulk || { status: '', message: '', rowErrorsByKey: {}, draftRows: [] }
  const optimisticBanner = uiState.optimisticBanner || { status: '', message: '' }
  const saveStatus = uiState.saveStatus || { state: 'idle', message: '', savedAt: '', retryTarget: '', conflictHint: '' }
  const dirtyByKey = uiState.dirtyByKey || {}
  const dirtyCount = Number(Boolean(createUi.dirty)) + Object.values(dirtyByKey).filter(Boolean).length
  const saveStatusToneClass = saveStatus.state === 'error' ? 'error-banner' : 'muted compact'
  const bulkDraftRows = Array.isArray(bulkUi.draftRows) && bulkUi.draftRows.length
    ? bulkUi.draftRows
    : [{ key: '', type: 'text', label: '', required: '', group: '', order: '', metadata: '' }]
  const bulkValidationSummaryItems = Object.entries(bulkUi.rowErrorsByKey || {})
    .flatMap(([key, errors]) => Object.values(errors || {}).map((message) => `<li><strong>${escapeHtml(key || 'row')}</strong>: ${escapeHtml(message)}</li>`))
    .join('')
  const createButtonLabel = createUi.status === 'pending' ? 'Creating…' : 'Create Field'
  const createButtonDisabled = !canManage || createUi.status === 'pending'
  const bulkPreviewButtonLabel = bulkUi.status === 'pending-preview' ? 'Generating Preview…' : 'Preview Changes'
  const bulkPreviewButtonDisabled = !canManage || bulkUi.status === 'pending-preview' || bulkUi.status === 'pending-confirm'
  const bulkConfirmButtonLabel = bulkUi.status === 'pending-confirm' ? 'Saving Changes…' : 'Confirm + Save Changes'
  const bulkConfirmButtonDisabled = !canManage || bulkUi.status === 'pending-confirm'
  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    <div class="section-header">
      <div>
        <h2 id="custom-fields-heading">Custom Field Schema</h2>
        <p class="muted">Manage firm-level profile custom fields (key, type, label, required, metadata).</p>
      </div>
      <div class="stack gap-sm">
        <span class="badge subtle">${state.customFieldSchema.updatedAt ? `Updated ${new Date(state.customFieldSchema.updatedAt).toLocaleString()}` : 'No updates yet'}</span>
        ${
          dirtyCount
            ? `<span class="badge warning" data-custom-field-unsaved-badge>${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}</span>`
            : '<span class="badge success" data-custom-field-unsaved-badge>All changes saved</span>'
        }
      </div>
    </div>
    <section class="item">
      <p id="custom-field-admin-save-status" class="${saveStatusToneClass}" role="${saveStatus.state === 'error' ? 'alert' : 'status'}" aria-live="${
        saveStatus.state === 'error' ? 'assertive' : 'polite'
      }" aria-atomic="true">
        ${
          saveStatus.state === 'saving'
            ? 'Saving custom field schema changes…'
            : saveStatus.state === 'saved'
              ? `Saved at ${escapeHtml(new Date(saveStatus.savedAt || Date.now()).toLocaleTimeString())}.`
              : saveStatus.state === 'error'
                ? escapeHtml(saveStatus.message || 'Save failed. You can retry without losing local edits.')
                : 'No save operations yet in this session.'
        }
        ${saveStatus.conflictHint ? `<span class="muted"> ${escapeHtml(saveStatus.conflictHint)}</span>` : ''}
      </p>
      ${
        saveStatus.state === 'error' && saveStatus.retryTarget
          ? `<button type="button" class="tiny secondary top-gap" data-custom-field-retry-last-save="${escapeHtml(saveStatus.retryTarget)}">Retry last save</button>`
          : ''
      }
    </section>
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
    ${
      optimisticBanner.message
        ? `<p class="${optimisticBanner.status === 'error' ? 'error-banner' : 'success-banner'}" role="${
            optimisticBanner.status === 'error' ? 'alert' : 'status'
          }" aria-live="${optimisticBanner.status === 'error' ? 'assertive' : 'polite'}" aria-atomic="true" id="custom-field-admin-optimistic-banner" tabindex="-1">${escapeHtml(
            optimisticBanner.message
          )}</p>`
        : ''
    }
    <section class="item">
      <h3>Create Field <span class="badge ${createUi.status === 'pending' ? 'warning' : createUi.dirty ? 'warning' : 'success'}" data-custom-field-create-dirty>${createUi.status === 'pending' ? 'Saving…' : createUi.dirty ? 'Unsaved changes' : 'Saved'}</span></h3>
      <form id="custom-field-create-form" class="grid two">
        <div class="validation-summary" data-validation-summary role="region" aria-live="polite" aria-label="Create field validation summary"></div>
        <input id="custom-field-create-key" name="key" placeholder="field_key" ${canManage ? '' : 'disabled'} />
        <select id="custom-field-create-type" name="type" ${canManage ? '' : 'disabled'}>
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="date">date</option>
        </select>
        <input id="custom-field-create-label" name="label" placeholder="Display label" ${canManage ? '' : 'disabled'} />
        <label><input id="custom-field-create-required" name="required" type="checkbox" ${canManage ? '' : 'disabled'} /> Required</label>
        <input id="custom-field-create-group" name="group" placeholder="Group (default: General)" ${canManage ? '' : 'disabled'} />
        <input id="custom-field-create-order" name="order" type="number" step="1" placeholder="Order (optional)" ${canManage ? '' : 'disabled'} />
        <input id="custom-field-create-metadata" name="metadata" placeholder='{"uiHint":"currency"}' ${canManage ? '' : 'disabled'} />
        <p class="muted compact">Key uses letters, numbers, and underscores only.</p>
        <p class="muted compact" data-type-help>Field type help: Plain text value.</p>
        <p class="muted compact">Metadata is optional JSON object used for grouping and UI hints.</p>
        <p class="field-error-text" data-field-error="key" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="label" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="type" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="required" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="group" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="order" role="alert" aria-live="polite"></p>
        <p class="field-error-text" data-field-error="metadata" role="alert" aria-live="polite"></p>
        <button type="submit" ${createButtonDisabled ? 'disabled' : ''}>${createButtonLabel}</button>
        <p class="muted compact" data-form-feedback aria-live="polite"></p>
      </form>
    </section>
    <section class="item">
      <h3>Bulk Edit Existing Fields</h3>
      <form id="custom-field-bulk-form">
        <p class="muted compact">Use guided rows (key, type, label, required, metadata). JSON import is optional.</p>
        <table><thead><tr><th>Key</th><th>Type</th><th>Label</th><th>Required</th><th>Group</th><th>Order</th><th>Metadata</th><th>Row</th></tr></thead><tbody>
          ${bulkDraftRows
            .map((row, index) => `<tr data-bulk-row="${index}">
              <td><input name="bulkKey" data-bulk-col="key" value="${escapeHtml(row.key || '')}" placeholder="field_key" ${canManage ? '' : 'disabled'} /></td>
              <td>
                <select name="bulkType" data-bulk-col="type" ${canManage ? '' : 'disabled'}>
                  <option value="text" ${row.type === 'text' ? 'selected' : ''}>text</option>
                  <option value="number" ${row.type === 'number' ? 'selected' : ''}>number</option>
                  <option value="boolean" ${row.type === 'boolean' ? 'selected' : ''}>boolean</option>
                  <option value="date" ${row.type === 'date' ? 'selected' : ''}>date</option>
                </select>
              </td>
              <td><input name="bulkLabel" data-bulk-col="label" value="${escapeHtml(row.label || '')}" placeholder="Display label" ${canManage ? '' : 'disabled'} /></td>
              <td><input name="bulkRequired" data-bulk-col="required" value="${escapeHtml(String(row.required ?? ''))}" placeholder="true/false" ${canManage ? '' : 'disabled'} /></td>
              <td><input name="bulkGroup" data-bulk-col="group" value="${escapeHtml(String(row.group ?? ''))}" placeholder="General" ${canManage ? '' : 'disabled'} /></td>
              <td><input name="bulkOrder" data-bulk-col="order" value="${escapeHtml(String(row.order ?? ''))}" placeholder="1" ${canManage ? '' : 'disabled'} /></td>
              <td><input name="bulkMetadata" data-bulk-col="metadata" value="${escapeHtml(String(row.metadata ?? ''))}" placeholder='{"uiHint":"currency"}' ${canManage ? '' : 'disabled'} /></td>
              <td><button type="button" class="tiny secondary" data-remove-bulk-row="${index}" ${canManage && bulkDraftRows.length > 1 ? '' : 'disabled'}>Remove</button></td>
            </tr>`)
            .join('')}
        </tbody></table>
        <div class="actions-row">
          <button type="button" class="tiny secondary" id="custom-field-bulk-add-row" ${canManage ? '' : 'disabled'}>Add row</button>
        </div>
        <details class="top-gap">
          <summary>Import from raw JSON/TSV</summary>
          <textarea
            name="bulkRowsRaw"
            rows="5"
            placeholder='[{"key":"risk_tolerance","type":"number","label":"Risk Tolerance","required":false,"metadata":{"group":"planning"}}]'
            ${canManage ? '' : 'disabled'}
          >${escapeHtml(state.customFieldSchema.bulkPreview?.rawRows || '')}</textarea>
          <button type="button" class="tiny secondary top-gap" id="custom-field-bulk-import-raw" ${canManage ? '' : 'disabled'}>Import rows</button>
        </details>
        <div class="actions-row">
          <button type="submit" class="tiny" ${bulkPreviewButtonDisabled ? 'disabled' : ''}>${bulkPreviewButtonLabel}</button>
        </div>
        <div id="custom-field-bulk-validation-summary" class="${bulkValidationSummaryItems ? 'error-banner' : 'muted compact'}" role="status" aria-live="polite">
          ${bulkValidationSummaryItems ? `<p>Validation summary:</p><ul>${bulkValidationSummaryItems}</ul>` : 'No row validation issues.'}
        </div>
        <p class="muted compact" data-form-feedback aria-live="polite"></p>
      </form>
      ${
        state.customFieldSchema.bulkPreview
          ? `<div class="item" id="custom-field-bulk-preview">
        <h4>Bulk Diff Preview</h4>
        <p class="muted compact">Review summary, then confirm to persist changes.</p>
        <ul>
          <li>Added: <strong>${state.customFieldSchema.bulkPreview.diff?.counts?.added || 0}</strong></li>
          <li>Updated: <strong>${state.customFieldSchema.bulkPreview.diff?.counts?.updated || 0}</strong></li>
          <li>Removed: <strong>${state.customFieldSchema.bulkPreview.diff?.counts?.removed || 0}</strong></li>
          <li>Unchanged: <strong>${state.customFieldSchema.bulkPreview.diff?.counts?.unchanged || 0}</strong></li>
        </ul>
        <form id="custom-field-bulk-confirm-form">
          <button type="submit" class="tiny" ${bulkConfirmButtonDisabled ? 'disabled' : ''}>${bulkConfirmButtonLabel}</button>
          <button type="button" class="tiny secondary" id="custom-field-bulk-cancel-preview" ${bulkConfirmButtonDisabled ? 'disabled' : ''}>Cancel Preview</button>
          <p class="muted compact" data-form-feedback aria-live="polite"></p>
        </form>
      </div>`
          : ''
      }
    </section>
    <section class="item">
      <h3>Current Fields</h3>
      <table><thead><tr><th>Key</th><th>Type</th><th>Label</th><th>Required</th><th>Group</th><th>Order</th><th>Metadata</th><th>Actions</th></tr></thead><tbody>
      ${
        fields.length
          ? fields
              .map(
                (field) => `<tr>
            <td><code>${escapeHtml(field.key)}</code></td>
            <td>${escapeHtml(field.type)}</td>
            <td>${escapeHtml(field.label || field.key)}</td>
            <td>${field.required ? 'Yes' : 'No'}</td>
            <td>${escapeHtml(customFieldGroupName(field))}</td>
            <td>${Number.isFinite(customFieldSortOrder(field)) ? escapeHtml(String(customFieldSortOrder(field))) : '<span class="muted">Auto</span>'}</td>
            <td><code>${escapeHtml(JSON.stringify(field.metadata || {}))}</code></td>
            <td>
              <form data-custom-field-update="${escapeHtml(field.key)}" class="grid two">
                <input type="hidden" name="key" value="${escapeHtml(field.key)}" />
                <div class="validation-summary" data-validation-summary role="region" aria-live="polite" aria-label="Update field validation summary"></div>
                <input id="custom-field-${escapeHtml(field.key)}-label" name="label" value="${escapeHtml(field.label || '')}" placeholder="Label" ${canManage ? '' : 'disabled'} />
                <select id="custom-field-${escapeHtml(field.key)}-type" name="type" ${canManage ? '' : 'disabled'}>
                  <option value="text" ${field.type === 'text' ? 'selected' : ''}>text</option>
                  <option value="number" ${field.type === 'number' ? 'selected' : ''}>number</option>
                  <option value="boolean" ${field.type === 'boolean' ? 'selected' : ''}>boolean</option>
                  <option value="date" ${field.type === 'date' ? 'selected' : ''}>date</option>
                </select>
                <label><input id="custom-field-${escapeHtml(field.key)}-required" name="required" type="checkbox" ${field.required ? 'checked' : ''} ${canManage ? '' : 'disabled'} /> Required</label>
                <input id="custom-field-${escapeHtml(field.key)}-group" name="group" value="${escapeHtml(customFieldGroupName(field))}" placeholder="Group (default: General)" ${canManage ? '' : 'disabled'} />
                <input id="custom-field-${escapeHtml(field.key)}-order" name="order" type="number" step="1" value="${Number.isFinite(customFieldSortOrder(field)) ? escapeHtml(String(customFieldSortOrder(field))) : ''}" placeholder="Order (optional)" ${canManage ? '' : 'disabled'} />
                <input id="custom-field-${escapeHtml(field.key)}-metadata" name="metadata" value="${escapeHtml(JSON.stringify(field.metadata || {}))}" placeholder='{"uiHint":"currency"}' ${canManage ? '' : 'disabled'} />
                <p class="muted compact" data-type-help>Field type help: ${escapeHtml(customFieldTypeHelpText(field.type))}</p>
                <p class="field-error-text" data-field-error="key" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="label" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="type" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="required" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="group" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="order" role="alert" aria-live="polite"></p>
                <p class="field-error-text" data-field-error="metadata" role="alert" aria-live="polite"></p>
                <div class="actions-row">
                  <span class="badge ${uiState.updatesByKey?.[field.key]?.status === 'pending' ? 'warning' : dirtyByKey[field.key] ? 'warning' : 'success'}" data-custom-field-dirty-badge="${escapeHtml(
                    field.key
                  )}">${uiState.updatesByKey?.[field.key]?.status === 'pending' ? 'Saving…' : dirtyByKey[field.key] ? 'Unsaved changes' : 'Saved'}</span>
                  <button type="submit" class="tiny" ${
                    canManage && uiState.updatesByKey?.[field.key]?.status !== 'pending' && uiState.deleteByKey?.[field.key]?.status !== 'pending'
                      ? ''
                      : 'disabled'
                  }>${
                    uiState.updatesByKey?.[field.key]?.status === 'pending' ? 'Updating…' : 'Update'
                  }</button>
                  <button type="button" class="tiny secondary" data-custom-field-delete="${escapeHtml(field.key)}" ${
                    canManage && uiState.deleteByKey?.[field.key]?.status !== 'pending' && uiState.updatesByKey?.[field.key]?.status !== 'pending'
                      ? ''
                      : 'disabled'
                  }>${
                    uiState.deleteByKey?.[field.key]?.status === 'pending' ? 'Deleting…' : 'Delete'
                  }</button>
                </div>
                <p class="muted compact" data-form-feedback aria-live="polite"></p>
              </form>
            </td>
          </tr>`
              )
              .join('')
          : '<tr><td colspan="8"><div class="empty-state" role="status"><p>No custom fields configured. Create your first field to enable profile extensions.</p><p>No custom fields configured yet. Create your first field to capture firm-specific profile and workflow context.</p><button type="button" class="tiny" data-scroll-create-field>Create first field</button><p class="muted compact">Expected outcome: new fields appear on profile create/edit forms and are available in draft/operator review context.</p></div></td></tr>'
      }
      </tbody></table>
    </section>
  `

  const validationLinkTargetId = (form, fieldName) => {
    const key = form?.dataset?.customFieldUpdate || 'create'
    return `custom-field-${key}-${fieldName}`
  }
  const renderValidationSummary = (form, fieldErrors = {}) => {
    const summary = form?.querySelector('[data-validation-summary]')
    if (!summary) return
    const entries = Object.entries(fieldErrors).filter(([, message]) => message)
    if (!entries.length) {
      summary.className = 'validation-summary muted compact'
      summary.innerHTML = 'No validation issues.'
      return
    }
    summary.className = 'validation-summary error-banner'
    const links = entries
      .map(([fieldName, message]) => {
        const targetId = validationLinkTargetId(form, fieldName)
        return `<li><a href="#${escapeHtml(targetId)}" data-validation-jump="${escapeHtml(targetId)}">${escapeHtml(message)}</a></li>`
      })
      .join('')
    summary.innerHTML = `<p>Validation summary:</p><ul>${links}</ul>`
  }
  const markFieldError = (form, fieldName, message) => {
    const field = form?.elements?.namedItem?.(fieldName)
    if (field?.setAttribute) {
      field.setAttribute('aria-invalid', message ? 'true' : 'false')
      const targetId = validationLinkTargetId(form, fieldName)
      if (!field.id) field.id = targetId
      if (message) field.setAttribute('aria-describedby', `${targetId}-error`)
      else field.removeAttribute('aria-describedby')
    }
    const errorEl = form?.querySelector(`[data-field-error="${fieldName}"]`)
    if (errorEl) {
      errorEl.textContent = message || ''
      errorEl.id = `${validationLinkTargetId(form, fieldName)}-error`
    }
  }
  const applyFieldErrors = (form, fieldErrors = {}) => {
    ;['key', 'label', 'type', 'required', 'group', 'order', 'metadata'].forEach((fieldName) =>
      markFieldError(form, fieldName, fieldErrors[fieldName] || '')
    )
    renderValidationSummary(form, fieldErrors)
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
    if (!payload.label) fieldErrors.label = 'Label is required so operators understand what this field captures.'
    if (!new Set(['text', 'number', 'boolean', 'date']).has(payload.type)) {
      fieldErrors.type = 'Type must be one of: text, number, boolean, date.'
    }
    if (requiredResult.error) fieldErrors.required = requiredResult.error
    const group = String(rawInput?.group || '').trim() || 'General'
    if (group.length > 80) fieldErrors.group = 'Group must be 80 characters or fewer.'
    const orderRaw = String(rawInput?.order ?? '').trim()
    let order = null
    if (orderRaw) {
      const parsed = Number(orderRaw)
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        fieldErrors.order = 'Order must be a whole number 0 or higher.'
      } else {
        order = parsed
      }
    }
    const metadataResult = parseMetadataJson(rawInput?.metadata)
    if (metadataResult.error) fieldErrors.metadata = metadataResult.error
    payload.metadata = {
      ...(metadataResult.value || {}),
      group,
      ...(order == null ? {} : { order })
    }
    return { payload, fieldErrors }
  }
  const hasExistingFieldKey = (key = '', { ignoreKey = '' } = {}) => {
    const normalized = String(key || '').trim().toLowerCase()
    const ignored = String(ignoreKey || '').trim().toLowerCase()
    return (state.customFieldSchema.fields || []).some((field) => {
      const existingKey = String(field?.key || '').trim().toLowerCase()
      if (!existingKey) return false
      if (ignored && existingKey === ignored) return false
      return existingKey === normalized
    })
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
      const [key = '', type = '', label = '', required = '', group = '', order = '', metadata = ''] = line.split('\t')
      return { key, type, label, required, group, order, metadata }
    })
    return { rows, parseError: '' }
  }
  const collectBulkRowsFromForm = (form) => {
    const keys = Array.from(form.querySelectorAll('input[name="bulkKey"]')).map((input) => input.value)
    const types = Array.from(form.querySelectorAll('select[name="bulkType"]')).map((input) => input.value)
    const labels = Array.from(form.querySelectorAll('input[name="bulkLabel"]')).map((input) => input.value)
    const required = Array.from(form.querySelectorAll('input[name="bulkRequired"]')).map((input) => input.value)
    const groups = Array.from(form.querySelectorAll('input[name="bulkGroup"]')).map((input) => input.value)
    const orders = Array.from(form.querySelectorAll('input[name="bulkOrder"]')).map((input) => input.value)
    const metadata = Array.from(form.querySelectorAll('input[name="bulkMetadata"]')).map((input) => input.value)
    const size = Math.max(keys.length, types.length, labels.length, required.length, groups.length, orders.length, metadata.length)
    return Array.from({ length: size }, (_, index) => ({
      key: keys[index] || '',
      type: types[index] || 'text',
      label: labels[index] || '',
      required: required[index] || '',
      group: groups[index] || '',
      order: orders[index] || '',
      metadata: metadata[index] || ''
    })).filter((row) => Object.values(row).some((value) => String(value || '').trim()))
  }
  const markCreateDirty = (dirty = true) => {
    state.customFieldSchema.ui.create = state.customFieldSchema.ui.create || { status: '', message: '', fieldErrors: {}, dirty: false }
    state.customFieldSchema.ui.create.dirty = Boolean(dirty)
  }
  const markFieldDirty = (fieldKey, dirty = true) => {
    state.customFieldSchema.ui.dirtyByKey = state.customFieldSchema.ui.dirtyByKey || {}
    state.customFieldSchema.ui.dirtyByKey[fieldKey] = Boolean(dirty)
  }
  const setSaveStatusState = ({ state: status = 'idle', message = '', retryTarget = '', conflictHint = '' } = {}) => {
    state.customFieldSchema.ui.saveStatus = {
      state: status,
      message,
      retryTarget,
      conflictHint,
      savedAt: status === 'saved' ? new Date().toISOString() : state.customFieldSchema.ui.saveStatus?.savedAt || ''
    }
  }
  const formatBulkConfirmFailureContext = (context = {}) => {
    const operationType = String(context?.type || '').trim().toLowerCase()
    const fieldKey = String(context?.key || '').trim()
    const operationLabel =
      operationType === 'add'
        ? 'add'
        : operationType === 'update'
          ? 'update'
          : operationType === 'delete'
            ? 'delete'
            : 'unknown operation'
    const keyLabel = fieldKey || 'unknown key'
    return `${operationLabel} (${keyLabel})`
  }

  const applyPersistedAdminUiState = () => {
    const currentCreateForm = document.querySelector('#custom-field-create-form')
    if (currentCreateForm) {
      applyFieldErrors(currentCreateForm, state.customFieldSchema.ui?.create?.fieldErrors || {})
      if (state.customFieldSchema.ui?.create?.message) {
        setFormFeedback(
          currentCreateForm,
          state.customFieldSchema.ui.create.message,
          state.customFieldSchema.ui.create.status === 'error' ? 'error' : 'success'
        )
      }
    }
    const currentBulkForm = document.querySelector('#custom-field-bulk-form')
    if (currentBulkForm && state.customFieldSchema.ui?.bulk?.message) {
      setFormFeedback(
        currentBulkForm,
        state.customFieldSchema.ui.bulk.message,
        state.customFieldSchema.ui.bulk.status === 'error' ? 'error' : 'success'
      )
    }
    document.querySelectorAll('[data-custom-field-update]').forEach((updateForm) => {
      const fieldKey = updateForm.dataset.customFieldUpdate
      const rowErrors =
        state.customFieldSchema.ui?.bulk?.rowErrorsByKey?.[fieldKey] || state.customFieldSchema.ui?.updatesByKey?.[fieldKey]?.fieldErrors || {}
      applyFieldErrors(updateForm, rowErrors)
      const statusEntry = state.customFieldSchema.ui?.updatesByKey?.[fieldKey]
      if (statusEntry?.message) setFormFeedback(updateForm, statusEntry.message, statusEntry.status === 'error' ? 'error' : 'success')
      const deleteEntry = state.customFieldSchema.ui?.deleteByKey?.[fieldKey]
      if (deleteEntry?.status === 'error' && deleteEntry?.message) setFormFeedback(updateForm, deleteEntry.message, 'error')
      if (deleteEntry?.status === 'success' && deleteEntry?.message) setFormFeedback(updateForm, deleteEntry.message, 'success')
    })
    const bulkConfirmForm = document.querySelector('#custom-field-bulk-confirm-form')
    if (bulkConfirmForm && state.customFieldSchema.ui?.bulk?.confirmMessage) {
      setFormFeedback(
        bulkConfirmForm,
        state.customFieldSchema.ui.bulk.confirmMessage,
        state.customFieldSchema.ui.bulk.confirmStatus === 'error' ? 'error' : 'success'
      )
    }
  }
  applyPersistedAdminUiState()
  viewEl.querySelectorAll('[data-validation-jump]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      const target = document.getElementById(link.dataset.validationJump)
      if (target) focusLiveRegion(target)
    })
  })
  if (optimisticBanner.message) focusWithinView('#custom-field-admin-optimistic-banner')

  document.querySelector('#custom-field-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!canManage) return
    const form = event.currentTarget
    state.customFieldSchema.ui.create = { status: '', message: '', fieldErrors: {}, dirty: false }
    markCreateDirty(false)
    clearFormFeedback(form)
    applyFieldErrors(form, {})
    const formData = new FormData(form)
    const validation = validateCustomFieldInput(
      {
        key: formData.get('key'),
        type: formData.get('type'),
        label: formData.get('label'),
        required: formData.get('required'),
        group: formData.get('group'),
        order: formData.get('order'),
        metadata: formData.get('metadata')
      },
      { requireKey: true }
    )
    applyFieldErrors(form, validation.fieldErrors)
    if (Object.keys(validation.fieldErrors).length) {
      state.customFieldSchema.ui.create = {
        status: 'error',
        message: Object.values(validation.fieldErrors)[0],
        fieldErrors: validation.fieldErrors,
        dirty: true
      }
      setFormFeedback(form, state.customFieldSchema.ui.create.message)
      return
    }
    if (hasExistingFieldKey(validation.payload.key)) {
      const duplicateError = { key: 'Key already exists. Use a unique key.' }
      state.customFieldSchema.ui.create = {
        status: 'error',
        message: duplicateError.key,
        fieldErrors: duplicateError,
        dirty: true
      }
      applyFieldErrors(form, duplicateError)
      setFormFeedback(form, duplicateError.key)
      return
    }
    const previousSchema = structuredClone(state.customFieldSchema)
    const optimisticField = { ...validation.payload }
    state.customFieldSchema.fields = [...(state.customFieldSchema.fields || []), optimisticField]
    state.customFieldSchema.updatedAt = new Date().toISOString()
    state.customFieldSchema.lastError = ''
    state.customFieldSchema.ui.create = { status: 'pending', message: 'Pending: creating custom field…', fieldErrors: {}, dirty: false }
    setSaveStatusState({ state: 'saving' })
    state.customFieldSchema.ui.optimisticBanner = {
      status: 'pending',
      message: `Saving new field ${validation.payload.key}…`
    }
    setFormFeedback(form, state.customFieldSchema.ui.create.message, 'success')
    queueViewFocus('#custom-field-admin-optimistic-banner')
    await renderCustomFieldsAdmin()
    try {
      await request(routes.profileCustomFieldSchema(), {
        method: 'POST',
        body: JSON.stringify(validation.payload)
      })
      state.customFieldSchema.ui.create = { status: 'success', message: 'Success: custom field created.', fieldErrors: {}, dirty: false }
      markCreateDirty(false)
      setSaveStatusState({ state: 'saved', message: 'Custom field created.' })
      state.customFieldSchema.ui.optimisticBanner = {
        status: 'success',
        message: `Field ${validation.payload.key} created.`
      }
      state.customFieldSchema.fetched = false
      await refreshSelects()
      await renderCustomFieldsAdmin()
    } catch (error) {
      state.customFieldSchema = previousSchema
      state.customFieldSchema.ui = state.customFieldSchema.ui || defaultCustomFieldAdminUiState()
      const serverFieldErrors = error?.details?.fieldErrors || {}
      state.customFieldSchema.ui.create = {
        status: 'error',
        message: `Error: ${normalizeApiError(error, 'create custom field schema')}`,
        fieldErrors: serverFieldErrors,
        dirty: true
      }
      const createErrorMessage = normalizeApiError(error, 'create custom field schema')
      setSaveStatusState({
        state: 'error',
        message: `Save failed while creating field: ${createErrorMessage}. Retry to keep your edits.`,
        retryTarget: 'create',
        conflictHint: isConflictError(error) ? normalizeConflictMessage(error) : ''
      })
      state.customFieldSchema.ui.optimisticBanner = {
        status: 'error',
        message: `Create failed and changes were rolled back: ${normalizeApiError(error, 'create custom field schema')}`
      }
      applyFieldErrors(form, serverFieldErrors)
      setFormFeedback(form, state.customFieldSchema.ui.create.message)
    }
  })
  const createForm = document.querySelector('#custom-field-create-form')
  if (createForm) {
    updateTypeHelp(createForm)
    createForm.elements?.namedItem?.('type')?.addEventListener('change', () => updateTypeHelp(createForm))
    createForm.querySelectorAll('input,select,textarea').forEach((input) => {
      input.addEventListener('input', () => {
        markCreateDirty(true)
      })
      input.addEventListener('change', () => {
        markCreateDirty(true)
      })
    })
  }
  document.querySelector('#custom-field-bulk-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!canManage) return
    const form = event.currentTarget
    state.customFieldSchema.ui.bulk = {
      status: '',
      message: '',
      rowErrorsByKey: {},
      confirmStatus: '',
      confirmMessage: '',
      draftRows: state.customFieldSchema.ui.bulk?.draftRows || []
    }
    clearFormFeedback(form)
    state.customFieldSchema.bulkPreview = null
    document.querySelectorAll('[data-custom-field-update]').forEach((updateForm) => applyFieldErrors(updateForm, {}))
    const enteredRows = collectBulkRowsFromForm(form)
    state.customFieldSchema.ui.bulk.draftRows = enteredRows.length ? enteredRows : [{ key: '', type: 'text', label: '', required: '', group: '', order: '', metadata: '' }]
    if (!enteredRows.length) {
      state.customFieldSchema.ui.bulk = {
        status: 'error',
        message: 'Error: add at least one non-empty row before preview.',
        rowErrorsByKey: {},
        confirmStatus: '',
        confirmMessage: '',
        draftRows: state.customFieldSchema.ui.bulk.draftRows
      }
      setFormFeedback(form, state.customFieldSchema.ui.bulk.message)
      return
    }
    const preparedRows = enteredRows.map((row) => {
      const validation = validateCustomFieldInput(row, { requireKey: true })
      return { payload: validation.payload, fieldErrors: validation.fieldErrors }
    })
    const duplicateKeys = new Set()
    preparedRows.forEach((row, index) => {
      if (!row.payload.key) return
      const duplicate = preparedRows.findIndex((entry) => entry.payload.key === row.payload.key)
      if (duplicate !== index) duplicateKeys.add(row.payload.key)
    })
    preparedRows.forEach((row) => {
      if (duplicateKeys.has(row.payload.key)) row.fieldErrors.key = 'Duplicate key in bulk payload.'
      if (!row.fieldErrors.key && hasExistingFieldKey(row.payload.key)) {
        row.fieldErrors.key = 'Key already exists in current schema.'
      }
    })
    const hasClientErrors = preparedRows.some((row) => Object.keys(row.fieldErrors).length)
    const rowErrorsByKey = {}
    preparedRows.forEach((row) => {
      const targetForm = Array.from(document.querySelectorAll('[data-custom-field-update]')).find(
        (entry) => entry.dataset.customFieldUpdate === row.payload.key
      )
      if (targetForm) applyFieldErrors(targetForm, row.fieldErrors)
      if (Object.keys(row.fieldErrors).length && row.payload.key) rowErrorsByKey[row.payload.key] = row.fieldErrors
    })
    if (hasClientErrors) {
      state.customFieldSchema.ui.bulk = {
        status: 'error',
        message: 'Error: bulk edit contains validation errors. Fix highlighted rows and retry.',
        rowErrorsByKey,
        confirmStatus: '',
        confirmMessage: '',
        draftRows: enteredRows
      }
      setFormFeedback(form, state.customFieldSchema.ui.bulk.message)
      return
    }
    state.customFieldSchema.ui.bulk = {
      status: 'pending-preview',
      message: 'Pending: generating bulk preview…',
      rowErrorsByKey: {},
      confirmStatus: '',
      confirmMessage: '',
      draftRows: enteredRows
    }
    await renderCustomFieldsAdmin()
    const dryRun = await request(routes.profileCustomFieldSchema({ dryRun: true }), {
      method: 'POST',
      body: JSON.stringify({ rows: preparedRows.map((row) => row.payload) })
    })
    if (!dryRun.valid) {
      const serverRowErrorsByKey = {}
      dryRun.validation.forEach((entry) => {
        const targetForm = Array.from(document.querySelectorAll('[data-custom-field-update]')).find(
          (rowForm) => rowForm.dataset.customFieldUpdate === entry.key
        )
        if (targetForm) applyFieldErrors(targetForm, entry.fieldErrors || {})
        if (entry.key) serverRowErrorsByKey[entry.key] = entry.fieldErrors || {}
      })
      state.customFieldSchema.ui.bulk = {
        status: 'error',
        message: 'Error: bulk edit contains server validation errors. Fix highlighted rows and retry.',
        rowErrorsByKey: serverRowErrorsByKey,
        confirmStatus: '',
        confirmMessage: '',
        draftRows: enteredRows
      }
      setFormFeedback(form, state.customFieldSchema.ui.bulk.message)
      return
    }
    state.customFieldSchema.bulkPreview = { ...dryRun, rawRows: JSON.stringify(enteredRows, null, 2) }
    state.customFieldSchema.ui.bulk = {
      status: 'success',
      message: 'Success: preview generated. Confirm to persist changes.',
      rowErrorsByKey: {},
      confirmStatus: '',
      confirmMessage: '',
      draftRows: enteredRows
    }
    setFormFeedback(form, state.customFieldSchema.ui.bulk.message, 'success')
    await renderCustomFieldsAdmin()
  })
  document.querySelector('#custom-field-bulk-import-raw')?.addEventListener('click', async () => {
    const form = document.querySelector('#custom-field-bulk-form')
    if (!form || !canManage) return
    const raw = form.elements?.namedItem?.('bulkRowsRaw')?.value || ''
    const parsed = parseBulkRows(raw)
    if (parsed.parseError) {
      state.customFieldSchema.ui.bulk = {
        ...(state.customFieldSchema.ui.bulk || {}),
        status: 'error',
        message: `Error: ${parsed.parseError}`
      }
      setFormFeedback(form, state.customFieldSchema.ui.bulk.message)
      return
    }
    state.customFieldSchema.ui.bulk = {
      ...(state.customFieldSchema.ui.bulk || {}),
      status: 'success',
      message: `Imported ${parsed.rows.length} row(s) from raw input.`,
      draftRows: parsed.rows.map((row) => ({
        key: row.key || '',
        type: row.type || 'text',
        label: row.label || '',
        required: row.required ?? '',
        group: row.group ?? row.metadata?.group ?? '',
        order: row.order ?? row.metadata?.order ?? '',
        metadata:
          typeof row.metadata === 'object' && row.metadata
            ? JSON.stringify(row.metadata)
            : row.metadata == null
              ? ''
              : String(row.metadata)
      }))
    }
    await renderCustomFieldsAdmin()
  })
  document.querySelector('#custom-field-bulk-add-row')?.addEventListener('click', async () => {
    if (!canManage) return
    state.customFieldSchema.ui.bulk = state.customFieldSchema.ui.bulk || {}
    const existing = state.customFieldSchema.ui.bulk.draftRows || []
    state.customFieldSchema.ui.bulk.draftRows = [...existing, { key: '', type: 'text', label: '', required: '', group: '', order: '', metadata: '' }]
    await renderCustomFieldsAdmin()
  })
  document.querySelectorAll('[data-remove-bulk-row]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!canManage) return
      const index = Number(button.dataset.removeBulkRow)
      const rows = [...(state.customFieldSchema.ui.bulk?.draftRows || [])]
      if (!Number.isInteger(index) || index < 0 || index >= rows.length) return
      rows.splice(index, 1)
      state.customFieldSchema.ui.bulk = state.customFieldSchema.ui.bulk || {}
      state.customFieldSchema.ui.bulk.draftRows = rows.length
        ? rows
        : [{ key: '', type: 'text', label: '', required: '', group: '', order: '', metadata: '' }]
      await renderCustomFieldsAdmin()
    })
  })

  document.querySelector('#custom-field-bulk-cancel-preview')?.addEventListener('click', async () => {
    state.customFieldSchema.bulkPreview = null
    state.customFieldSchema.ui.bulk = {
      status: '',
      message: '',
      rowErrorsByKey: {},
      confirmStatus: '',
      confirmMessage: '',
      draftRows: state.customFieldSchema.ui.bulk?.draftRows || []
    }
    await renderCustomFieldsAdmin()
  })

  document.querySelector('#custom-field-bulk-confirm-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!canManage || !state.customFieldSchema.bulkPreview?.diff) return
    const form = event.currentTarget
    clearFormFeedback(form)
    const preview = state.customFieldSchema.bulkPreview
    const previousSchema = structuredClone(state.customFieldSchema)
    let failingOperationContext = { type: '', key: '' }
    state.customFieldSchema.ui.bulk = state.customFieldSchema.ui.bulk || {}
    state.customFieldSchema.ui.bulk.status = 'pending-confirm'
    state.customFieldSchema.ui.bulk.confirmStatus = 'pending'
    state.customFieldSchema.ui.bulk.confirmMessage = 'Pending: applying confirmed schema changes…'
    setSaveStatusState({ state: 'saving' })
    setFormFeedback(form, state.customFieldSchema.ui.bulk.confirmMessage, 'success')
    await renderCustomFieldsAdmin()
    try {
      for (const field of preview.diff.added || []) {
        failingOperationContext = { type: 'add', key: field?.key || '' }
        await request(routes.profileCustomFieldSchema(), { method: 'POST', body: JSON.stringify(field) })
      }
      for (const change of preview.diff.updated || []) {
        failingOperationContext = { type: 'update', key: change?.after?.key || change?.before?.key || '' }
        await request(routes.profileCustomFieldSchemaField(change.after.key), {
          method: 'PATCH',
          body: JSON.stringify(change.after)
        })
      }
      for (const field of preview.diff.removed || []) {
        failingOperationContext = { type: 'delete', key: field?.key || '' }
        await request(routes.profileCustomFieldSchemaField(field.key), { method: 'DELETE' })
      }
    } catch (error) {
      state.customFieldSchema = previousSchema
      state.customFieldSchema.bulkPreview = preview
      state.customFieldSchema.ui.bulk = state.customFieldSchema.ui.bulk || {}
      state.customFieldSchema.ui.bulk.status = 'error'
      state.customFieldSchema.ui.bulk.confirmStatus = 'error'
      const failureContextLabel = formatBulkConfirmFailureContext(failingOperationContext)
      state.customFieldSchema.ui.bulk.confirmMessage = `Error: ${normalizeApiError(error, `apply bulk schema changes (${failureContextLabel})`)}`
      const bulkErrorMessage = normalizeApiError(error, 'apply bulk schema changes')
      setSaveStatusState({
        state: 'error',
        message: `Bulk save failed during ${failureContextLabel}: ${bulkErrorMessage}. Local UI state was restored for retry, but server-side partial writes may still exist.`,
        retryTarget: 'bulk-confirm',
        conflictHint: isConflictError(error) ? normalizeConflictMessage(error) : ''
      })
      state.customFieldSchema.ui.optimisticBanner = {
        status: 'error',
        message: `Bulk save failed during ${failureContextLabel}. Local UI preview and edit state were restored; reload to reconcile any partial server-side writes.`
      }
      setFormFeedback(form, state.customFieldSchema.ui.bulk.confirmMessage)
      return
    }
    state.customFieldSchema.bulkPreview = null
    state.customFieldSchema.ui.bulk = {
      status: 'success',
      message: 'Success: preview confirmed.',
      rowErrorsByKey: {},
      confirmStatus: 'success',
      confirmMessage: 'Success: bulk schema changes saved.',
      draftRows: state.customFieldSchema.ui.bulk?.draftRows || []
    }
    state.customFieldSchema.ui.optimisticBanner = { status: 'success', message: 'Bulk schema changes saved.' }
    state.customFieldSchema.ui.dirtyByKey = {}
    markCreateDirty(false)
    setSaveStatusState({ state: 'saved', message: 'Bulk schema changes saved.' })
    state.customFieldSchema.fetched = false
    await refreshSelects()
    setFlash('success', 'Bulk schema changes saved.')
    await renderCustomFieldsAdmin()
  })

  document.querySelectorAll('[data-custom-field-update]').forEach((form) => {
    updateTypeHelp(form)
    form.elements?.namedItem?.('type')?.addEventListener('change', () => updateTypeHelp(form))
    const fieldKey = form.dataset.customFieldUpdate
    form.querySelectorAll('input,select,textarea').forEach((input) => {
      if (input.type === 'hidden') return
      input.addEventListener('input', () => {
        markFieldDirty(fieldKey, true)
      })
      input.addEventListener('change', () => {
        markFieldDirty(fieldKey, true)
      })
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!canManage) return
      state.customFieldSchema.ui.updatesByKey = state.customFieldSchema.ui.updatesByKey || {}
      clearFormFeedback(form)
      applyFieldErrors(form, {})
      state.customFieldSchema.ui.updatesByKey[fieldKey] = { status: '', message: '', fieldErrors: {} }
      const formData = new FormData(form)
      const validation = validateCustomFieldInput(
        {
          type: formData.get('type'),
          label: formData.get('label'),
          required: formData.get('required'),
          group: formData.get('group'),
          order: formData.get('order'),
          metadata: formData.get('metadata')
        },
        { requireKey: false }
      )
      applyFieldErrors(form, validation.fieldErrors)
      if (Object.keys(validation.fieldErrors).length) {
        state.customFieldSchema.ui.updatesByKey[fieldKey] = {
          status: 'error',
          message: `Error: ${Object.values(validation.fieldErrors)[0]}`,
          fieldErrors: validation.fieldErrors
        }
        setFormFeedback(form, state.customFieldSchema.ui.updatesByKey[fieldKey].message)
        return
      }
      const previousSchema = structuredClone(state.customFieldSchema)
      state.customFieldSchema.fields = (state.customFieldSchema.fields || []).map((field) =>
        field.key === fieldKey ? { ...field, ...validation.payload, key: fieldKey } : field
      )
      state.customFieldSchema.updatedAt = new Date().toISOString()
      state.customFieldSchema.ui.updatesByKey[fieldKey] = { status: 'pending', message: `Pending: updating ${fieldKey}…`, fieldErrors: {} }
      setSaveStatusState({ state: 'saving' })
      state.customFieldSchema.ui.optimisticBanner = { status: 'pending', message: `Saving changes for field ${fieldKey}…` }
      setFormFeedback(form, state.customFieldSchema.ui.updatesByKey[fieldKey].message, 'success')
      queueViewFocus('#custom-field-admin-optimistic-banner')
      await renderCustomFieldsAdmin()
      try {
        await request(routes.profileCustomFieldSchemaField(fieldKey), {
          method: 'PATCH',
          body: JSON.stringify(validation.payload)
        })
        state.customFieldSchema.ui.updatesByKey[fieldKey] = {
          status: 'success',
          message: `Success: custom field ${fieldKey} updated.`,
          fieldErrors: {}
        }
        markFieldDirty(fieldKey, false)
        setSaveStatusState({ state: 'saved', message: `Saved ${fieldKey}.` })
        state.customFieldSchema.ui.optimisticBanner = { status: 'success', message: `Field ${fieldKey} updated.` }
        state.customFieldSchema.fetched = false
        await refreshSelects()
        await renderCustomFieldsAdmin()
      } catch (error) {
        state.customFieldSchema = previousSchema
        state.customFieldSchema.ui = state.customFieldSchema.ui || defaultCustomFieldAdminUiState()
        const serverFieldErrors = error?.details?.fieldErrors || {}
        state.customFieldSchema.ui.updatesByKey[fieldKey] = {
          status: 'error',
          message: `Error: ${normalizeApiError(error, `update custom field ${fieldKey}`)}`,
          fieldErrors: serverFieldErrors
        }
        const updateErrorMessage = normalizeApiError(error, `update custom field ${fieldKey}`)
        setSaveStatusState({
          state: 'error',
          message: `Save failed for ${fieldKey}: ${updateErrorMessage}. Retry to keep your edits.`,
          retryTarget: `update:${fieldKey}`,
          conflictHint: isConflictError(error) ? normalizeConflictMessage(error) : ''
        })
        state.customFieldSchema.ui.optimisticBanner = {
          status: 'error',
          message: `Update failed and changes were rolled back for ${fieldKey}: ${normalizeApiError(error, `update custom field ${fieldKey}`)}`
        }
        applyFieldErrors(form, serverFieldErrors)
        setFormFeedback(form, state.customFieldSchema.ui.updatesByKey[fieldKey].message)
      }
    })
  })

  document.querySelectorAll('[data-custom-field-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!canManage) return
      const fieldKey = button.dataset.customFieldDelete
      state.customFieldSchema.ui.deleteByKey = state.customFieldSchema.ui.deleteByKey || {}
      state.customFieldSchema.ui.deleteByKey[fieldKey] = { status: 'pending', message: `Pending: deleting custom field ${fieldKey}…` }
      setSaveStatusState({ state: 'saving' })
      const previousSchema = structuredClone(state.customFieldSchema)
      state.customFieldSchema.fields = (state.customFieldSchema.fields || []).filter((field) => field.key !== fieldKey)
      state.customFieldSchema.updatedAt = new Date().toISOString()
      state.customFieldSchema.ui.optimisticBanner = { status: 'pending', message: `Deleting field ${fieldKey}…` }
      setFlash('success', `Pending: deleting custom field ${fieldKey}…`)
      queueViewFocus('#custom-field-admin-optimistic-banner')
      await renderCustomFieldsAdmin()
      try {
        await request(routes.profileCustomFieldSchemaField(fieldKey), { method: 'DELETE' })
        state.customFieldSchema.ui.deleteByKey[fieldKey] = { status: 'success', message: `Success: custom field ${fieldKey} deleted.` }
        markFieldDirty(fieldKey, false)
        setSaveStatusState({ state: 'saved', message: `Deleted ${fieldKey}.` })
        state.customFieldSchema.ui.optimisticBanner = { status: 'success', message: `Field ${fieldKey} deleted.` }
        setFlash('success', `Success: custom field ${fieldKey} deleted.`)
        state.customFieldSchema.fetched = false
        await refreshSelects()
        await renderCustomFieldsAdmin()
      } catch (error) {
        state.customFieldSchema = previousSchema
        state.customFieldSchema.ui = state.customFieldSchema.ui || defaultCustomFieldAdminUiState()
        state.customFieldSchema.ui.deleteByKey[fieldKey] = {
          status: 'error',
          message: `Error: ${normalizeApiError(error, `delete custom field ${fieldKey}`)}`
        }
        const deleteErrorMessage = normalizeApiError(error, `delete custom field ${fieldKey}`)
        setSaveStatusState({
          state: 'error',
          message: `Delete failed for ${fieldKey}: ${deleteErrorMessage}. Retry is available.`,
          retryTarget: `delete:${fieldKey}`,
          conflictHint: isConflictError(error) ? normalizeConflictMessage(error) : ''
        })
        state.customFieldSchema.ui.optimisticBanner = {
          status: 'error',
          message: `Delete failed and changes were rolled back for ${fieldKey}: ${normalizeApiError(error, `delete custom field ${fieldKey}`)}`
        }
        setFlash('error', state.customFieldSchema.ui.deleteByKey[fieldKey].message)
        await renderCustomFieldsAdmin()
      }
    })
  })

  document.querySelector('[data-scroll-create-field]')?.addEventListener('click', () => {
    const createFieldHeading = document.querySelector('#custom-field-create-form')
    if (createFieldHeading) focusLiveRegion(createFieldHeading.querySelector('[name="key"]') || createFieldHeading)
  })
  document.querySelector('[data-custom-field-retry-last-save]')?.addEventListener('click', async (event) => {
    const retryTarget = event.currentTarget?.dataset?.customFieldRetryLastSave
    if (!retryTarget) return
    if (retryTarget === 'create') {
      document.querySelector('#custom-field-create-form button[type="submit"]')?.click()
      return
    }
    if (retryTarget === 'bulk-confirm') {
      document.querySelector('#custom-field-bulk-confirm-form button[type="submit"]')?.click()
      return
    }
    if (retryTarget.startsWith('update:')) {
      const key = retryTarget.slice('update:'.length)
      document.querySelector(`[data-custom-field-update="${key}"] button[type="submit"]`)?.click()
      return
    }
    if (retryTarget.startsWith('delete:')) {
      const key = retryTarget.slice('delete:'.length)
      document.querySelector(`[data-custom-field-delete="${key}"]`)?.click()
    }
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
