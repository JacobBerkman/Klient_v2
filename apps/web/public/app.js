import { appRoutes, routes } from './api-contract.js'

const state = {
  user: null,
  view: 'dashboard',
  flash: null,
  board: null,
  clientBoard: null,
  mfa: {
    login: null,
    enrollment: null
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
const householdPrimaryEl = document.querySelector('select[name="primaryClientId"]')
const portalProfileEl = document.querySelector('select[name="profileId"]')

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
let csrfToken = ''
const BOARD_STAGES = [
  'discovery',
  'gather_oi',
  'analysis',
  'advisor_proposal_meeting',
  'intake',
  'on_boarding',
  'investment_strategy',
  'completed',
  'drop_dead_lead',
  'drop_nurture'
]

const STAGE_LABELS = {
  discovery: 'Discovery',
  gather_oi: 'Gather OI',
  analysis: 'Analysis',
  advisor_proposal_meeting: 'Advisor Proposal Meeting',
  intake: 'Intake',
  on_boarding: 'On Boarding',
  investment_strategy: 'Investment Strategy',
  completed: 'Completed',
  drop_dead_lead: 'Drop / Dead Lead',
  drop_nurture: 'Drop / Nurture'
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

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || 'Unassigned'
}

function findBoardColumn(board, stage) {
  return board?.columns?.find((column) => column.stage === stage) || null
}

function buildBoardFromProfiles(profiles = []) {
  return {
    boardVersion: null,
    columns: BOARD_STAGES.map((stage) => ({
      stage,
      cards: profiles
        .filter((profile) => (profile.stage || 'discovery') === stage)
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
    const runtimeConfig = await request(routes.runtime());
    state.enableDemoMode = Boolean(runtimeConfig.enableDemoMode);
  } catch {
    state.enableDemoMode = false;
  }
  document.querySelector('#demo-login').hidden = !state.enableDemoMode;
  document.querySelector('#demo-credentials').hidden = !state.enableDemoMode;
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

function updateRoleVisibility() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.hidden = !roleAllowed(button.dataset.roles || '')
  })
  document.querySelectorAll('[data-requires-role]').forEach((section) => {
    const roles = section.dataset.requiresRole || ''
    section.hidden = !roleAllowed(roles)
  })
}

async function refreshSelects() {
  if (!state.user || state.user.role === 'client') return
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
  const funnelRows = (summary.funnel || [])
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.stage)}</td><td>${entry.count}</td><td>${Math.round((entry.conversionRate || 0) * 100)}%</td></tr>`
    )
    .join('')
  const agingRows = Object.entries(summary.stageAging || {})
    .map(
      ([stage, value]) =>
        `<tr><td>${escapeHtml(stage)}</td><td>${value.count || 0}</td><td>${value.avgDays || 0}</td></tr>`
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
    .map((entry) => `<tr><td>${escapeHtml(entry.stage)}</td><td>${entry.count}</td><td>${entry.avgDays}</td></tr>`)
    .join('')
  const latencyRows = (dashboard.formCompletionLatency || [])
    .map((entry) => `<tr><td>${escapeHtml(entry.templateId)}</td><td>${entry.submissions}</td><td>${entry.avgHours}</td></tr>`)
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
    ${analyticsPanel('Funnel Conversion', `<table><thead><tr><th>Stage</th><th>Count</th><th>Conversion</th></tr></thead><tbody>${funnelRows || '<tr><td colspan="3">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Stage Aging', `<table><thead><tr><th>Stage</th><th>Prospects</th><th>Avg days</th></tr></thead><tbody>${agingRows || '<tr><td colspan="3">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Form Completion Rates', `<table><thead><tr><th>Template</th><th>Drafts</th><th>Submitted</th><th>Completion</th></tr></thead><tbody>${completionRows || '<tr><td colspan="4">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Form Completion Latency', `<table><thead><tr><th>Template</th><th>Submissions</th><th>Avg hours</th></tr></thead><tbody>${latencyRows || '<tr><td colspan="3">No data</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Advisor Productivity', `<table><thead><tr><th>Advisor</th><th>Managed</th><th>Notes</th><th>Stage moves</th><th>Score</th></tr></thead><tbody>${productivityRows || '<tr><td colspan="5">No advisor events yet</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Stage Bottlenecks', `<table><thead><tr><th>Stage</th><th>Prospects</th><th>Avg days</th></tr></thead><tbody>${bottleneckRows || '<tr><td colspan="3">No data</td></tr>'}</tbody></table>`)}
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
        <button data-lock="${draft.id}">Acquire lock</button>
        <button data-save="${draft.id}">Save revision</button>
      </td>
    </tr>
  `
    )
    .join('')

  viewEl.innerHTML = `
    ${flashMarkup()}
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
      try {
        const result = await request(routes.formDraftLock(button.dataset.lock), {
          method: 'POST',
          body: JSON.stringify({ leaseMs: 30000 })
        })
        setFlash('success', `Lock acquired. Lease ${result.lock.leaseId.slice(0, 8)}…`)
      } catch (error) {
        setFlash('error', error.message)
      }
      await renderForms()
    })
  })

  document.querySelectorAll('[data-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const draftId = button.dataset.save
      const draft = drafts.find((item) => item.id === draftId)
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
          setFlash('error', response.mergePrompt?.suggestion || 'Draft conflict.')
        } else {
          setFlash('success', `Draft saved at revision ${response.submission.revisionId}.`)
        }
      } catch (error) {
        setFlash('error', error.message)
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
  const sourcePath = String(mapping.sourcePath || '').trim()
  const targetType = String(mapping.targetType || '').trim()
  if (sourcePath && !knownPaths.has(sourcePath)) issues.push('Unknown source path')
  const sourceType = sourcePath ? knownPaths.get(sourcePath) : ''
  if (sourceType && targetType && sourceType !== targetType) issues.push(`Type mismatch (${sourceType} → ${targetType})`)
  return issues
}

async function renderTemplates() {
  const [templates, clients, submissions] = await Promise.all([
    request(routes.documentTemplates()),
    request(routes.profiles({ kind: 'client' })),
    request(routes.formSubmissions())
  ])
  if (!state.selectedTemplateId && templates[0]?.id) state.selectedTemplateId = templates[0].id
  const template = templates.find((entry) => entry.id === state.selectedTemplateId) || templates[0] || null
  const knownPaths = knownProfileSourcePaths()
  ;(template?.formSchema?.sections || []).forEach((section) => collectTemplateSchemaPaths(section.fields || [], '', knownPaths))
  const mappingIssuesByIndex = new Map((template?.mappings || []).map((mapping, index) => [index, mappingLocalIssues(mapping, knownPaths)]))
  const hasLocalMappingErrors = [...mappingIssuesByIndex.values()].some((issues) => issues.length > 0)

  viewEl.innerHTML = `
    ${flashMarkup()}
    <div class="section-header"><h2>Template Detail</h2></div>
    <label>Template
      <select id="template-select">${templates.map((entry) => `<option value="${entry.id}" ${entry.id === template?.id ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select>
    </label>
    ${template ? `
      <section class="item">
        <h3>Extracted Fields</h3>
        <ul>${(template.extractedFields || []).map((field, index) => `<li>${escapeHtml(field)} <button data-remove-extracted="${index}" class="secondary tiny">Remove</button></li>`).join('') || '<li class="muted">No extracted fields yet.</li>'}</ul>
        <div class="row gap-sm">
          <input id="new-extracted-field" placeholder="pdf_field_name" />
          <button id="add-extracted-field" class="tiny">Add</button>
        </div>
      </section>
      <section class="item">
        <h3>Source Path Discovery</h3>
        <div class="muted">Known paths from profile + form schema: ${[...knownPaths.keys()].map((path) => `<code>${escapeHtml(path)}</code>`).join(', ')}</div>
      </section>
      <section class="item">
        <h3>Mapping Rows</h3>
        <table><thead><tr><th>PDF Field</th><th>Source Path</th><th>Type</th><th>Validation</th><th>Actions</th></tr></thead><tbody>
          ${(template.mappings || []).map((mapping, index) => {
            const issues = mappingIssuesByIndex.get(index) || []
            return `<tr>
              <td>${escapeHtml(mapping.pdfField || '')}</td>
              <td>${escapeHtml(mapping.sourcePath || '')}</td>
              <td>${escapeHtml(mapping.targetType || '')}</td>
              <td>${issues.length ? `<span class="badge">${escapeHtml(issues.join('; '))}</span>` : '<span class="muted">OK</span>'}</td>
              <td><button data-edit-mapping="${index}" class="tiny secondary">Edit</button> <button data-remove-mapping="${index}" class="tiny secondary">Remove</button></td>
            </tr>`
          }).join('')}
        </tbody></table>
        <button id="add-mapping-row" class="tiny">Add Mapping</button>
        <button id="save-mappings" class="tiny">Save Mappings</button>
      </section>
      <section class="item">
        <h3>Mapping Preview</h3>
        <div class="row gap-sm wrap">
          <select id="preview-client">${clients.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`).join('')}</select>
          <select id="preview-submission">${submissions.map((entry) => `<option value="${entry.id}">${escapeHtml(entry.id)} · ${escapeHtml(entry.templateId)}</option>`).join('')}</select>
          <button id="run-preview" class="tiny">Run Preview</button>
        </div>
        <div id="preview-results" class="muted"></div>
      </section>
      <section class="item">
        <h3>Publish</h3>
        <button id="publish-template" class="tiny" ${hasLocalMappingErrors ? 'disabled' : ''}>Publish</button>
        ${hasLocalMappingErrors ? '<p class="muted">Publish is blocked until local mapping errors are resolved.</p>' : ''}
      </section>` : '<p class="muted">No document templates found.</p>'}
  `

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
        body: JSON.stringify({ mappings: template.mappings || [], requiredPdfFields: next })
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
      body: JSON.stringify({ mappings: template.mappings || [], requiredPdfFields: next })
    })
    setFlash('success', 'Extracted field added.')
    await renderTemplates()
  })
  document.querySelectorAll('[data-remove-mapping]').forEach((button) => {
    button.addEventListener('click', async () => {
      const next = [...(template.mappings || [])]
      next.splice(Number(button.dataset.removeMapping), 1)
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings: next, requiredPdfFields: template.extractedFields || [] })
      })
      setFlash('success', 'Mapping removed.')
      await renderTemplates()
    })
  })
  document.querySelectorAll('[data-edit-mapping]').forEach((button) => {
    button.addEventListener('click', async () => {
      const index = Number(button.dataset.editMapping)
      const current = template.mappings[index] || {}
      const pdfField = window.prompt('PDF field', current.pdfField || '')
      if (!pdfField) return
      const sourcePath = window.prompt('Source path', current.sourcePath || '')
      if (!sourcePath) return
      const targetType = window.prompt('Target type (optional)', current.targetType || '') || ''
      const next = [...(template.mappings || [])]
      next[index] = { ...current, pdfField, sourcePath, targetType }
      await request(routes.documentTemplateMappings(template.id), {
        method: 'POST',
        body: JSON.stringify({ mappings: next, requiredPdfFields: template.extractedFields || [] })
      })
      setFlash('success', 'Mapping updated.')
      await renderTemplates()
    })
  })
  document.querySelector('#add-mapping-row')?.addEventListener('click', async () => {
    const pdfField = window.prompt('PDF field')
    if (!pdfField) return
    const sourcePath = window.prompt('Source path')
    if (!sourcePath) return
    const targetType = window.prompt('Target type (optional)') || ''
    const next = [...(template.mappings || []), { pdfField, sourcePath, targetType }]
    await request(routes.documentTemplateMappings(template.id), {
      method: 'POST',
      body: JSON.stringify({ mappings: next, requiredPdfFields: template.extractedFields || [] })
    })
    setFlash('success', 'Mapping added.')
    await renderTemplates()
  })
  document.querySelector('#save-mappings')?.addEventListener('click', async () => {
    await request(routes.documentTemplateMappings(template.id), {
      method: 'POST',
      body: JSON.stringify({ mappings: template.mappings || [], requiredPdfFields: template.extractedFields || [] })
    })
    setFlash('success', 'Mappings saved.')
    await renderTemplates()
  })
  document.querySelector('#run-preview')?.addEventListener('click', async () => {
    try {
      const clientId = document.querySelector('#preview-client')?.value
      const submissionId = document.querySelector('#preview-submission')?.value
      const preview = await request(routes.documentTemplateMappingsPreview(template.id), {
        method: 'POST',
        body: JSON.stringify({ clientId, submissionId })
      })
      const resultEl = document.querySelector('#preview-results')
      resultEl.innerHTML = `<pre>${escapeHtml(JSON.stringify(preview.rows, null, 2))}</pre>`
    } catch (error) {
      setFlash('error', error.message)
      await renderTemplates()
    }
  })
  document.querySelector('#publish-template')?.addEventListener('click', async () => {
    try {
      await request(routes.documentTemplatePublish(template.id), {
        method: 'POST',
        body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Publish template mapping updates.' })
      })
      setFlash('success', 'Template published.')
    } catch (error) {
      const issues = error.details?.issues || []
      setFlash('error', issues.length ? issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | ') : error.message)
    }
    await renderTemplates()
  })
}

function boardCardMarkup(card, kind) {
  const displayName = `${card.firstName || ''} ${card.lastName || ''}`.trim() || card.id
  return `
    <article class="board-card" draggable="true" data-card-id="${card.id}" data-stage="${card.stage || 'discovery'}">
      <header class="row between wrap">
        <strong>${escapeHtml(displayName)}</strong>
        <button type="button" class="secondary tiny" data-edit-profile="${card.id}" aria-expanded="false">Edit</button>
      </header>
      <div class="muted compact-meta">${escapeHtml(card.email || 'No email')} · ${escapeHtml(card.phone || 'No phone')}</div>
      <div class="muted compact-meta">Stage: ${escapeHtml(stageLabel(card.stage || 'discovery'))}</div>
      <div class="row gap-sm wrap top-gap">
        <label class="sr-only" for="stage-${card.id}">Move ${escapeHtml(displayName)} to stage</label>
        <select id="stage-${card.id}" data-stage-select="${card.id}">
          ${BOARD_STAGES.map((stage) => `<option value="${stage}" ${stage === (card.stage || 'discovery') ? 'selected' : ''}>${escapeHtml(stageLabel(stage))}</option>`).join('')}
        </select>
      </div>
      <form class="inline-edit hidden top-gap" data-edit-form="${card.id}">
        <div class="grid two">
          <input name="firstName" value="${escapeHtml(card.firstName || '')}" placeholder="First name" required />
          <input name="lastName" value="${escapeHtml(card.lastName || '')}" placeholder="Last name" required />
        </div>
        <input name="email" type="email" value="${escapeHtml(card.email || '')}" placeholder="Email" />
        <input name="phone" value="${escapeHtml(card.phone || '')}" placeholder="Phone" />
        <div class="actions-row">
          <button type="submit" class="tiny">Save</button>
          <button type="button" class="secondary tiny" data-cancel-edit="${card.id}">Cancel</button>
        </div>
      </form>
      <div class="muted compact-meta">Type: ${escapeHtml(kind)}</div>
    </article>
  `
}

function boardMarkup(kind, board) {
  return `
    ${flashMarkup()}
    <div class="section-header">
      <div>
        <h2>${escapeHtml(kind === 'prospect' ? 'Prospects' : 'Clients')} Board</h2>
        <p class="muted">Drag cards to reorder or move across stages. Inline edits save optimistically.</p>
      </div>
    </div>
    <div class="kanban-board" data-board-kind="${kind}">
      ${board.columns
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
    const previousCard = previousBoard?.columns?.flatMap((column) => column.cards).find((entry) => entry.id === move.profileId)
    if (previousCard?.updatedAt && latest?.profile?.updatedAt && previousCard.updatedAt !== latest.profile.updatedAt) {
      throw new Error('This client changed on the server. Reloaded latest board.')
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

async function saveInlineProfile(kind, profileId, patch) {
  const boardKey = kind === 'prospect' ? 'board' : 'clientBoard'
  const previousBoard = state[boardKey] ? structuredClone(state[boardKey]) : null
  if (previousBoard) state[boardKey] = updateCardInBoard(previousBoard, profileId, patch)
  try {
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
  document.querySelectorAll('[data-card-id]').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
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
      try {
        await saveInlineProfile(kind, profileId, payload)
        setFlash('success', 'Profile updated.')
      } catch (error) {
        setFlash('error', `Failed to save profile: ${error.message}`)
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
    state.board = await request('/api/board')
    viewEl.innerHTML = boardMarkup(kind, state.board)
    wireBoardInteractions(kind)
    return
  }
  const clients = await request('/api/profiles?kind=client')
  state.clientBoard = buildBoardFromProfiles(clients)
  viewEl.innerHTML = boardMarkup(kind, state.clientBoard)
  wireBoardInteractions(kind)
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

const demoLoginButton = document.querySelector('#demo-login');
demoLoginButton.addEventListener('click', async () => {
  if (!state.enableDemoMode) return;
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

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const form = new FormData(event.target)
    const source = form.get('cityOrLocation')
      ? { cityOrLocation: form.get('cityOrLocation'), venue: form.get('venue'), occurredOn: form.get('occurredOn') }
      : null
    await request(routes.profiles(), {
      method: 'POST',
      body: JSON.stringify({
        kind: form.get('kind'),
        firstName: form.get('firstName'),
        lastName: form.get('lastName'),
        email: form.get('email'),
        phone: form.get('phone'),
        stage: form.get('stage'),
        source
      })
    })
    event.target.reset()
    setFlash('success', 'Profile created.')
    await refreshSelects()
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

document.querySelector('#household-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    await request(routes.households(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    setFlash('success', 'Household created.')
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

document.querySelector('#form-template-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = { ...Object.fromEntries(new FormData(event.target).entries()), sections: [] }
    await request(routes.formTemplates(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    state.view = 'forms'
    setFlash('success', 'Form template created.')
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

document.querySelector('#doc-template-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = {
      ...Object.fromEntries(new FormData(event.target).entries()),
      blueprint: { sections: [] },
      mappings: []
    }
    await request(routes.documentTemplates(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    setFlash('success', 'Document template created.')
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

document.querySelector('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    const invite = await request(routes.invites(), { method: 'POST', body: JSON.stringify(payload) })
    event.target.reset()
    setFlash('success', `Invite created (${invite.token}).`)
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
  }
})

document.querySelector('#portal-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries())
    const link = await request(routes.portalLinks(), { method: 'POST', body: JSON.stringify(payload) })
    setFlash('success', `Portal link created: /portal?token=${link.token}`)
    await renderCurrentView()
  } catch (error) {
    setFlash('error', error.message)
    await renderCurrentView()
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
