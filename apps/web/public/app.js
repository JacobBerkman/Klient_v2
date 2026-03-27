import { appRoutes, routes } from './api-contract.js'

const state = {
  user: null,
  view: 'dashboard',
  flash: null,
  alert: null,
  board: null,
  clientBoard: null,
  pendingActions: {},
  mfa: {
    login: null,
    enrollment: null
  },
  templatePreviewByTemplateId: {},
  templatePublishPreflightByTemplateId: {},
  templatePreviewSelectionByTemplateId: {}
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
const formTemplateFormEl = document.querySelector('#form-template-form')
const docTemplateFormEl = document.querySelector('#doc-template-form')
const inviteFormEl = document.querySelector('#invite-form')
const portalFormEl = document.querySelector('#portal-form')

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

function normalizeConflictMessage(error, fallbackMessage = 'Conflict detected. Reload and try again.') {
  if (error?.details?.mergePrompt?.suggestion) return error.details.mergePrompt.suggestion
  const rawMessage = String(error?.message || '').toLowerCase()
  if (rawMessage.includes('conflict') || rawMessage.includes('stale') || rawMessage.includes('version')) {
    return 'Conflict detected: another change was saved first. Review latest data and retry.'
  }
  return fallbackMessage
}

function isConflictError(error) {
  if (error?.details?.mergePrompt?.suggestion) return true
  const rawMessage = String(error?.message || '').toLowerCase()
  return rawMessage.includes('conflict') || rawMessage.includes('stale') || rawMessage.includes('version')
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
  feedbackEl.textContent = message
  feedbackEl.classList.remove('error-banner', 'success-banner')
  if (message) feedbackEl.classList.add(type === 'success' ? 'success-banner' : 'error-banner')
}

function clearFormFeedback(form) {
  setFormFeedback(form, '')
}

function withTrimmedFormData(form) {
  return Object.fromEntries(
    Array.from(new FormData(form).entries()).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
  )
}

function validateRequiredFields(form, requiredKeys = []) {
  const payload = withTrimmedFormData(form)
  const missingLabel = requiredKeys.find((key) => !payload[key])
  if (missingLabel) {
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

async function renderDashboard() {
  const data = await request(routes.dashboard())
  viewEl.innerHTML = `
    ${flashMarkup()}
    <div class="section-header"><h2>Dashboard</h2></div>
    <div class="stat-grid">
      ${Object.entries(data.stats)
        .map(([key, value]) => metricCard(key, value))
        .join('')}
    </div>
    <div class="item compact muted">Recent activity and profile management remain available in their dedicated tabs.</div>
  `
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
  const [templates, drafts] = await Promise.all([request(routes.formTemplates()), request(routes.formDrafts())])
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
    <h2>Forms + Collaboration</h2>
    <p class="muted">Draft editing now uses revision IDs, short leases, and conflict-aware save prompts.</p>
    <div class="stat-grid compact-stats">
      ${metricCard('templates', templates.length)}
      ${metricCard('drafts', drafts.length)}
    </div>
    <table><thead><tr><th>Draft ID</th><th>Template</th><th>Revision</th><th>Lock</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No drafts</td></tr>'}</tbody></table>
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
        reportActionSuccess('Forms', `Lock acquired. Lease ${result.lock.leaseId.slice(0, 8)}…`)
      } catch (error) {
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
        if (!response.ok) {
          setAlert('error', response.mergePrompt?.suggestion || 'Draft conflict.')
          reportActionError('Forms', new Error(response.mergePrompt?.suggestion || 'Draft conflict.'))
        } else {
          clearAlert()
          reportActionSuccess('Forms', `Draft saved at revision ${response.submission.revisionId}.`)
        }
      } catch (error) {
        if (error?.details?.mergePrompt?.suggestion) {
          setAlert('error', error.details.mergePrompt.suggestion)
        }
        reportActionError('Forms', error)
      } finally {
        clearActionPending(actionKey)
      }
      await renderForms()
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
  const path = String(issue.path || issue.field || 'mapping')
  const message = String(issue.message || issue.code || 'Validation issue')
  const rowIndex = Number(issue.rowIndex)
  const rowPrefix = Number.isFinite(rowIndex) ? `Row ${rowIndex + 1}: ` : ''
  return `${rowPrefix}${path} — ${message}`
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
  const [templates, clients, submissions] = await Promise.all([
    request(routes.documentTemplates()),
    request(routes.profiles({ kind: 'client' })),
    request(routes.formSubmissions())
  ])
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
          <span class="badge subtle">Save state: ${escapeHtml(saveState.status === 'saving' ? 'Saving…' : saveState.status === 'error' ? `Error (${saveState.message || 'retry'})` : 'Saved')}</span>
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
        <table><thead><tr><th>#</th><th>PDF Field</th><th>Source Path</th><th>Label</th><th>Status</th><th>Preview</th></tr></thead><tbody>
          ${draftMappings
            .map((mapping, index) => {
              const issues = mappingIssuesByIndex.get(index) || []
              const hasWarnings = previewWarningRows.has(index) || previewIssueRows.has(index)
              const sampleValue = resolveSampleValue(mapping.sourcePath)
              return `<tr id="mapping-row-${index}" data-select-row="${index}" style="cursor:pointer;${index === safeSelectedRowIndex ? 'outline:1px solid #60a5fa;' : ''}">
                <td>${index + 1}</td>
                <td>${escapeHtml(mapping.pdfField || '')}</td>
                <td>${escapeHtml(mapping.sourcePath || '')}</td>
                <td>${escapeHtml(mapping.fieldLabel || '')}</td>
                <td>${issues.length ? `<span class="error-badge">${escapeHtml(issues.join('; '))}</span>` : hasWarnings ? '<span class="warning-badge">Preview warning</span>' : '<span class="muted">OK</span>'}</td>
                <td>${escapeHtml(sampleValue == null ? '' : String(sampleValue))}</td>
              </tr>`
            })
            .join('') || '<tr><td colspan="6" class="muted">No mappings configured.</td></tr>'}
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
            .map((profile) => `<option value="${profile.id}">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`)
            .join('')}</select>
          <select id="preview-submission">${submissions
            .map((entry) => `<option value="${entry.id}">${escapeHtml(entry.id)} · ${escapeHtml(entry.templateId)}</option>`)
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
        ${preflightIssues.length ? `<p class="publish-disabled-reason">Publish preflight found ${preflightIssues.length} schema validation issue(s).</p><ul>${preflightIssues.map((issue) => `<li>${escapeHtml(formatSchemaIssue(issue))}</li>`).join('')}</ul>` : '<p class="muted">Run preflight to surface publish-time schema validation (unknown source paths, required mappings, and transform issues) before attempting publish.</p>'}
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
        : '<p class="muted">No document templates found.</p>'
    }
  `

  const persistMappings = async ({ autosave = false } = {}) => {
    const actionKey = `template-map-save-${template.id}`
    if (autosave) setActionPending(actionKey, 'saving')
    state.templateSaveStateByTemplateId[template.id] = { status: 'saving' }
    const mappings = (state.templateMappingDrafts[template.id] || []).map((mapping) => normalizeMappingDraft(mapping))
    try {
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings, requiredPdfFields: template.extractedFields || [] })
      })
      state.templateSaveStateByTemplateId[template.id] = { status: 'saved', savedAt: new Date().toISOString() }
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

  document.querySelector('#run-preview')?.addEventListener('click', async () => {
    try {
      const clientId = document.querySelector('#preview-client')?.value
      const submissionId = document.querySelector('#preview-submission')?.value
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
  const displayName = `${card.firstName || ''} ${card.lastName || ''}`.trim() || card.id
  const cardStage = card.stage || getStageDefinitions({ includeInactive: false })[0]?.id || 'discovery'
  return `
    <article class="board-card" draggable="true" data-card-id="${card.id}" data-stage="${cardStage}">
      <header class="row between wrap">
        <strong>${escapeHtml(displayName)}</strong>
        <button type="button" class="secondary tiny" data-edit-profile="${card.id}" aria-expanded="false" ${canEdit ? '' : 'disabled'}>Edit</button>
      </header>
      <div class="muted compact-meta">${escapeHtml(card.email || 'No email')} · ${escapeHtml(card.phone || 'No phone')}</div>
      <div class="muted compact-meta">Stage: ${escapeHtml(stageLabel(cardStage))}</div>
      <div class="row gap-sm wrap top-gap">
        <label class="sr-only" for="stage-${card.id}">Move ${escapeHtml(displayName)} to stage</label>
        <select id="stage-${card.id}" data-stage-select="${card.id}">
          ${stageSelectOptionsMarkup(cardStage)}
        </select>
      </div>
      <form class="inline-edit hidden top-gap" data-edit-form="${card.id}" data-updated-at="${escapeHtml(card.updatedAt || '')}">
        <div class="grid two">
          <input name="firstName" value="${escapeHtml(card.firstName || '')}" placeholder="First name" required />
          <input name="lastName" value="${escapeHtml(card.lastName || '')}" placeholder="Last name" required />
        </div>
        <input name="email" type="email" value="${escapeHtml(card.email || '')}" placeholder="Email" />
        <input name="phone" value="${escapeHtml(card.phone || '')}" placeholder="Phone" />
        <div class="actions-row">
          <button type="submit" class="tiny" ${canEdit ? '' : 'disabled'}>${pendingLabel(`profile-save-${card.id}`, 'Save', 'Saving…')}</button>
          <button type="button" class="secondary tiny" data-cancel-edit="${card.id}" ${canEdit ? '' : 'disabled'}>Cancel</button>
        </div>
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
        .join('')}
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
  const boardKey = kind === 'prospect' ? 'board' : 'clientBoard'
  const previousBoard = state[boardKey] ? structuredClone(state[boardKey]) : null
  if (previousBoard) state[boardKey] = updateCardInBoard(previousBoard, profileId, patch)
  try {
    const latest = await request(routes.profileDetail(profileId))
    if (expectedUpdatedAt && latest?.profile?.updatedAt && latest.profile.updatedAt !== expectedUpdatedAt) {
      throw new Error('Conflict detected: this profile was edited elsewhere. Review latest data and try again.')
    }
    await request(`/api/profiles/${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    })
  } catch (error) {
    state[boardKey] = previousBoard
    throw error
  }
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
      form?.classList.toggle('hidden')
      button.setAttribute('aria-expanded', String(!form?.classList.contains('hidden')))
    })
  })
  document.querySelectorAll('[data-cancel-edit]').forEach((button) => {
    button.addEventListener('click', async () => {
      await renderCurrentView()
    })
  })
  document.querySelectorAll('[data-edit-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const profileId = form.dataset.editForm
      const payload = Object.fromEntries(new FormData(form).entries())
      const submitButton = form.querySelector('button[type="submit"]')
      if (submitButton) {
        submitButton.disabled = true
        submitButton.textContent = 'Saving…'
      }
      setAlert('success', `Saving profile ${profileId} optimistically…`)
      try {
        await saveInlineProfile(kind, profileId, payload, form.dataset.updatedAt || '')
        clearAlert()
        reportActionSuccess('Profiles', 'Profile updated.')
      } catch (error) {
        const message = isConflictError(error) ? normalizeConflictMessage(error) : error.message
        setAlert('error', message)
        reportActionError('Profiles', error)
      } finally {
        if (submitButton) {
          submitButton.disabled = false
          submitButton.textContent = 'Save'
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
}

async function renderBoard(kind) {
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
  const clients = await request(routes.profiles({ kind: 'client' }))
  state.clientBoard = buildBoardFromProfiles(clients)
  viewEl.innerHTML = boardMarkup(kind, state.clientBoard)
  wireBoardInteractions(kind)
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

async function renderExports() {
  let jobs = []
  let queue = { queue: {} }
  try {
    ;[jobs, queue] = await Promise.all([request(routes.exports()), request(routes.exportsQueueHealth())])
  } catch (error) {
    reportActionError('Exports', error)
  }
  const canMutate = state.user?.role === 'admin' || state.user?.role === 'advisor'
  const queueState = queue?.queue || {}
  const queueCards = [
    ['Queued', queueState.queued || 0],
    ['Running', queueState.running || 0],
    ['Failed', queueState.failed || 0],
    ['Dead Letter', queueState.deadLetter || 0],
    ['Completed', queueState.completed || 0],
    ['Ready Now', queueState.readyNow || 0]
  ]
  viewEl.innerHTML = `
    ${flashMarkup()}
    ${alertMarkup()}
    <div class="section-header"><div><h2>Exports Operations</h2><p class="muted">Queue health, retries, and artifact readiness by job.</p></div></div>
    <section class="item">
      <h3>Queue State</h3>
      <div class="stat-grid">
        ${queueCards.map(([label, value]) => metricCard(label, value)).join('')}
      </div>
      <pre>${escapeHtml(JSON.stringify(queueState, null, 2))}</pre>
      ${canMutate ? '<button id="retry-failed-jobs" class="tiny secondary">Retry failed jobs</button>' : '<p class="muted">Readonly role cannot trigger retries.</p>'}
    </section>
    <section class="item">
      <h3>Per-job Artifact Status</h3>
      <table><thead><tr><th>ID</th><th>Status</th><th>Attempts</th><th>Artifact Details</th><th>Actions</th></tr></thead><tbody>
        ${
          jobs
            .map(
              (job) => `<tr>
          <td>${escapeHtml(job.id)}</td>
          <td>${escapeHtml(job.status)}</td>
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
            canMutate
              ? `<div class="actions-row">
                  <button data-retry-export="${job.id}" class="tiny secondary" ${job.status === 'completed' ? 'disabled' : ''}>Retry</button>
                  <button data-download-export="${job.id}" class="tiny" ${job.artifactAvailable ? '' : 'disabled'}>Download</button>
                </div>`
              : '<span class="muted">N/A</span>'
          }</td>
        </tr>`
            )
            .join('') || '<tr><td colspan="5">No export jobs.</td></tr>'
        }
      </tbody></table>
    </section>
    <section class="item">
      <h3>Role Visibility Validation</h3>
      <p class="muted">Current signed-in role: <strong>${escapeHtml(state.user?.role || 'anonymous')}</strong></p>
      ${roleAccessMatrixMarkup()}
    </section>
  `
  document.querySelector('#retry-failed-jobs')?.addEventListener('click', async () => {
    try {
      const result = await request(routes.exportsRetryFailed(), {
        method: 'POST',
        body: JSON.stringify({ includeDeadLetter: true, limit: 50 })
      })
      reportActionSuccess('Exports', `Retried ${result.retriedCount || 0} failed jobs.`)
    } catch (error) {
      reportActionError('Exports', error)
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
        button.disabled = true
        const response = await fetch(routes.exportDownload(exportId), { credentials: 'same-origin' })
        if (!response.ok) {
          const text = await response.text()
          throw new Error(text || 'Download failed')
        }
        const blob = await response.blob()
        const disposition = response.headers.get('content-disposition') || ''
        const matched = disposition.match(/filename=\"?([^\";]+)\"?/)
        const fileName = matched?.[1] || `export-${exportId}`
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        reportActionSuccess('Exports', `Downloaded ${fileName}.`)
      } catch (error) {
        reportActionError('Exports', error)
      } finally {
        button.disabled = false
      }
    })
  })
}

function applyHashRoute() {
  const hashPath = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  const route = appRoutes.parseClientFormSubmission(hashPath)
  if (!route) return
  state.view = 'forms'
  state.selectedClientId = route.clientId
  state.selectedSubmissionId = route.submissionId
  setFlash('success', `Editing submission ${route.submissionId} for client ${route.clientId}.`)
}

async function renderFallback(title) {
  viewEl.innerHTML = `${flashMarkup()}<h2>${escapeHtml(title)}</h2><p class="muted">This view remains functional in API workflows and can be expanded with richer cards later.</p>`
}

async function renderCurrentView() {
  if (!state.user) {
    viewEl.innerHTML = `${flashMarkup()}<h2>Sign in to continue</h2>`
    return
  }
  if (state.view === 'dashboard') return renderDashboard()
  if (state.view === 'analytics') return renderAnalytics()
  if (state.view === 'forms') return renderForms()
  if (state.view === 'templates') return renderTemplates()
  if (state.view === 'exports') return renderExports()
  if (state.view === 'prospects') return renderBoard('prospect')
  if (state.view === 'clients') return renderBoard('client')
  return renderFallback(state.view)
}

async function hydrateSession() {
  try {
    const session = await request(routes.session())
    state.user = session.user
    authStatusEl.textContent = JSON.stringify(session.user, null, 2)
    updateRoleVisibility()
    await refreshSelects()
    updateMfaUi()
  } catch {
    state.user = null
    authStatusEl.textContent = 'Not signed in'
    updateRoleVisibility()
    updateMfaUi()
  }
}

async function finishAuth(session, message) {
  state.user = session.user
  authStatusEl.textContent = JSON.stringify(session.user, null, 2)
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

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    const session = await request(routes.register(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    await finishAuth(session, 'Firm admin account created.')
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    const session = await request(routes.login(), { method: 'POST', body: JSON.stringify(payload) })
    if (session.mfaRequired) {
      setPendingMfaLogin(session, payload)
      await renderCurrentView()
      return
    }
    event.target.reset()
    await finishAuth(session, 'Signed in successfully.')
  } catch (error) {
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
    setFormFeedback(formEl, isConflictError(error) ? normalizeConflictMessage(error) : error.message)
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

document.querySelector('#household-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    await request(routes.households(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    reportActionSuccess('Households', 'Household created.')
    await renderCurrentView()
  } catch (error) {
    reportActionError('Households', error)
    await renderCurrentView()
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
