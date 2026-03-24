import { routes } from './api-contract.js';

const STAGES = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed', 'drop_dead_lead', 'drop_nurture'];

const state = {
  token: localStorage.getItem('klient-token') || '',
  user: null,
  view: 'dashboard',
  selectedProfileId: null,
  user: null,
  profileFilter: 'all',
  search: '',
  clients: [],
  profiles: [],
  activeSession: null,
  flash: null
  flash: null,
  profileDetail: null,
  templatesById: new Map()
};

const view = document.querySelector('#view');
const authStatus = document.querySelector('#auth-status');
  flash: null
};

const viewEl = document.querySelector('#view');
const authStatusEl = document.querySelector('#auth-status');
const householdPrimaryEl = document.querySelector('select[name="primaryClientId"]');
const portalProfileEl = document.querySelector('select[name="profileId"]');

const headers = () => state.token ? { Authorization: `Bearer ${state.token}` } : {};
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let csrfToken = '';

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function setFlash(type, message) { state.flash = { type, message }; }
function clearFlash() { state.flash = null; }
function profileName(p) { return `${p.firstName} ${p.lastName}`; }
function authHeaders() { return state.token ? { Authorization: `Bearer ${state.token}` } : {}; }
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function setFlash(type, message) {
  state.flash = { type, message };
}

function flashMarkup() {
  if (!state.flash) return '';
  const cls = state.flash.type === 'error' ? 'error-banner' : 'success-banner';
  return `<div class="item compact ${cls}">${escapeHtml(state.flash.message)}</div>`;
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (MUTATING_METHODS.has(method) && !csrfToken) {
    const csrf = await fetch('/api/csrf');
    const body = await csrf.json();
    if (!csrf.ok || !body.csrfToken) throw new Error('Unable to initialize CSRF protection.');
    csrfToken = body.csrfToken;
  if (MUTATING_METHODS.has(method) && path.startsWith('/api/') && !csrfToken) {
    const boot = await fetch('/api/csrf');
    const data = await boot.json();
    if (!boot.ok) throw new Error(data.message || 'CSRF bootstrap failed');
    csrfToken = data.csrfToken;
  }
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(MUTATING_METHODS.has(method) ? { 'X-CSRF-Token': csrfToken } : {}),
      ...authHeaders(),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || 'Request failed');
    error.details = body?.error?.details || null;
    throw error;
  }
  return body;
}

async function hydrateSession() {
  if (!state.token) return;
  try {
    const session = await api('/api/session');
    state.user = session.user;
    authStatus.textContent = JSON.stringify(session.user, null, 2);
  } catch {
    state.token = '';
    localStorage.removeItem('klient-token');
    state.user = null;
  }
}

async function ensureTemplates() {
  if (!state.token || state.templatesById.size) return;
  const templates = await api(routes.formTemplates());
  state.templatesById = new Map(templates.map((entry) => [entry.id, entry]));
}

const ROLE_POLICY_MATRIX = {
  admin: new Set(['dashboard:view', 'profiles:view', 'households:view', 'forms:view', 'templates:view', 'exports:view', 'analytics:view', 'audit:view', 'users:view', 'portal-links:view', 'client-workspace:view']),
  advisor: new Set(['dashboard:view', 'profiles:view', 'households:view', 'forms:view', 'templates:view', 'exports:view', 'analytics:view', 'audit:view', 'portal-links:view']),
  readonly: new Set(['dashboard:view', 'profiles:view', 'households:view', 'forms:view', 'analytics:view', 'audit:view']),
  client: new Set(['client-workspace:view'])
};

const VIEW_POLICIES = {
  dashboard: 'dashboard:view',
  prospects: 'profiles:view',
  clients: 'profiles:view',
  board: 'profiles:view',
  'profile-detail': 'profiles:view',
  households: 'households:view',
  forms: 'forms:view',
  templates: 'templates:view',
  exports: 'exports:view',
  analytics: 'analytics:view',
  audit: 'audit:view',
  settings: 'users:view',
  portal: 'portal-links:view',
  'client-workspace': 'client-workspace:view'
};

function canAccessView(nextView) {
  const role = activeRole();
  if (!role) return false;
  const policy = VIEW_POLICIES[nextView];
  return policy ? ROLE_POLICY_MATRIX[role]?.has(policy) : false;
}

function updateRoleVisibility() {
  const role = activeRole();
  const navButtons = document.querySelectorAll('[data-view]');
  navButtons.forEach((button) => {
    const targetView = button.dataset.view;
    button.hidden = !role || !canAccessView(targetView);
  });
function renderFlash() {
  if (!state.flash) return '';
  return `<div class="item compact ${state.flash.type === 'error' ? 'error-banner' : 'success-banner'}">${escapeHtml(state.flash.message)}</div>`;
}

async function renderDashboard() {
  const data = await api(routes.dashboard());
  view.innerHTML = `${renderFlash()}<h2>Dashboard</h2><pre>${escapeHtml(JSON.stringify(data.stats, null, 2))}</pre>`;
}

async function renderProfiles() {
  const profiles = await api(routes.profiles());
  view.innerHTML = `${renderFlash()}<h2>Profiles</h2>${profiles.map((p) => `<div class="item"><strong>${escapeHtml(profileName(p))}</strong> <span class="badge">${escapeHtml(p.kind)}</span><button data-open-profile="${p.id}">Open Profile</button></div>`).join('')}`;
  document.querySelectorAll('[data-open-profile]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedProfileId = button.dataset.openProfile;
      state.view = 'profile-detail';
      await renderCurrentView();
    });
  });
}

function profileName(profile) {
  return `${profile.firstName} ${profile.lastName}`;
}

function getRepeatableSections(template) {
  return (template?.sections || []).filter((section) => section.repeatable).map((section) => ({
    ...section,
    sectionKey: String(section.key || section.title || section.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  }));
}

function installRepeatableModal(profile, submission) {
  const template = state.templatesById.get(submission.templateId);
  const sections = getRepeatableSections(template);
  if (!sections.length) {
    setFlash('error', 'No repeatable sections are configured for this submission template.');
    renderCurrentView();
    return;
  }

  try {
    const clients = await api('/api/profiles?kind=client');
    const allProfiles = await api('/api/profiles');
    state.clients = clients;
    state.profiles = allProfiles;
    householdPrimary.innerHTML = clients.map((profile) => `<option value="${profile.id}">${escapeHtml(profileName(profile))}</option>`).join('');
    portalProfileSelect.innerHTML = allProfiles.map((profile) => `<option value="${profile.id}">${escapeHtml(profileName(profile))}</option>`).join('');
  } catch {
    state.clients = [];
    state.profiles = [];
    householdPrimary.innerHTML = '<option value="">Login first</option>';
    portalProfileSelect.innerHTML = '<option value="">Login first</option>';
  }
}

async function hydrateSession() {
  if (!state.token) {
    syncAuthStatus();
    return;
  const modal = document.createElement('dialog');
  modal.innerHTML = `
    <form method="dialog" class="stack gap-sm" style="min-width:520px">
      <h3>Edit Repeatable Items</h3>
      <div class="muted">${escapeHtml(profileName(profile))} • ${escapeHtml(template?.name || submission.templateId)}</div>
      <label>Section
        <select id="repeatable-section">${sections.map((section) => `<option value="${section.sectionKey}">${escapeHtml(section.title || section.sectionKey)}</option>`).join('')}</select>
      </label>
      <div id="repeatable-error" class="error-banner" style="display:none"></div>
      <div id="repeatable-items"></div>
      <button id="repeatable-add" type="button">Add Item</button>
      <menu><button value="cancel" class="secondary">Close</button></menu>
    </form>`;
  document.body.appendChild(modal);

  const sectionSelect = modal.querySelector('#repeatable-section');
  const itemContainer = modal.querySelector('#repeatable-items');
  const errorBanner = modal.querySelector('#repeatable-error');

  const dataPathForSection = (sectionKey) => sectionKey;

  function showError(error) {
    const details = error?.details ? ` ${JSON.stringify(error.details)}` : '';
    errorBanner.textContent = `${error.message || 'Request failed.'}${details}`;
    errorBanner.style.display = 'block';
  }

  function renderItemRows() {
    errorBanner.style.display = 'none';
    const section = sections.find((entry) => entry.sectionKey === sectionSelect.value) || sections[0];
    const dataPath = dataPathForSection(section.sectionKey);
    const items = submission.data[dataPath] || [];
    itemContainer.innerHTML = items.length
      ? items.map((item) => `<div class="item compact"><div class="grid two compact-grid">${(section.fields || []).map((field) => `<label>${escapeHtml(field.label)}<input data-item-key="${escapeHtml(item._itemKey || '')}" data-field-key="${escapeHtml(field.key)}" value="${escapeHtml(item[field.key] ?? '')}" /></label>`).join('')}</div><div class="row gap-sm"><button type="button" data-save-item="${escapeHtml(item._itemKey || '')}">Save</button><button type="button" data-delete-item="${escapeHtml(item._itemKey || '')}" class="secondary">Delete</button></div></div>`).join('')
      : '<div class="item compact muted">No items yet.</div>';

    itemContainer.querySelectorAll('[data-save-item]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemKey = button.dataset.saveItem;
        const fields = itemContainer.querySelectorAll(`[data-item-key="${itemKey}"]`);
        const patch = {};
        fields.forEach((field) => { patch[field.dataset.fieldKey] = field.value; });
        const previous = structuredClone(submission.data[dataPath] || []);
        const next = (submission.data[dataPath] || []).map((item) => item._itemKey === itemKey ? { ...item, ...patch } : item);
        submission.data[dataPath] = next;
        renderItemRows();
        try {
          await api(routes.submissionSectionItem(submission.id, section.sectionKey, itemKey), { method: 'PATCH', body: JSON.stringify({ item: patch }) });
        } catch (error) {
          submission.data[dataPath] = previous;
          renderItemRows();
          showError(error);
        }
      });
    });

    itemContainer.querySelectorAll('[data-delete-item]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemKey = button.dataset.deleteItem;
        const previous = structuredClone(submission.data[dataPath] || []);
        submission.data[dataPath] = (submission.data[dataPath] || []).filter((item) => item._itemKey !== itemKey);
        renderItemRows();
        try {
          await api(routes.submissionSectionItem(submission.id, section.sectionKey, itemKey), { method: 'DELETE' });
        } catch (error) {
          submission.data[dataPath] = previous;
          renderItemRows();
          showError(error);
        }
      });
    });
  }

  modal.querySelector('#repeatable-add').addEventListener('click', async () => {
    const section = sections.find((entry) => entry.sectionKey === sectionSelect.value) || sections[0];
    const dataPath = dataPathForSection(section.sectionKey);
    const previous = structuredClone(submission.data[dataPath] || []);
    const optimisticKey = `optimistic-${Date.now()}`;
    const optimisticItem = Object.fromEntries((section.fields || []).map((field) => [field.key, '']));
    optimisticItem._itemKey = optimisticKey;
    submission.data[dataPath] = [...(submission.data[dataPath] || []), optimisticItem];
    renderItemRows();
    try {
      const result = await api(routes.submissionSectionItems(submission.id, section.sectionKey), { method: 'POST', body: JSON.stringify({ item: Object.fromEntries((section.fields || []).map((field) => [field.key, ''])) }) });
      const created = result.item;
      submission.data[dataPath] = (submission.data[dataPath] || []).map((item) => item._itemKey === optimisticKey ? created : item);
      renderItemRows();
    } catch (error) {
      submission.data[dataPath] = previous;
      renderItemRows();
      showError(error);
    }
  });

  sectionSelect.addEventListener('change', renderItemRows);
  modal.addEventListener('close', () => modal.remove());
  renderItemRows();
  modal.showModal();
}

async function renderProfileDetail() {
  const detail = await api(routes.profileDetail(state.selectedProfileId));
  state.profileDetail = detail;
  await ensureTemplates();
  view.innerHTML = `
    ${renderFlash()}
    <button id="back-profiles">← Back</button>
    <h2>${escapeHtml(profileName(detail.profile))}</h2>
    <h3>Submissions</h3>
    ${(detail.submissions || []).map((submission) => `<div class="item compact"><strong>${escapeHtml(submission.templateId)}</strong><div class="muted">${escapeHtml(submission.status)}</div><button data-edit-repeatable="${submission.id}">Edit repeatable items</button><pre>${escapeHtml(JSON.stringify(submission.data, null, 2))}</pre></div>`).join('') || '<div class="item compact muted">No submissions yet.</div>'}
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(MUTATING_METHODS.has(method) && path.startsWith('/api/') ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || data?.message || 'Request failed');
  return data;
}

async function renderProfiles(kind) {
  const params = new URLSearchParams();
  if (kind !== 'all') params.set('kind', kind);
  if (state.search) params.set('search', state.search);
  const profiles = await api(`/api/profiles${params.toString() ? `?${params.toString()}` : ''}`);
  const title = kind === 'prospect' ? 'Prospects' : kind === 'client' ? 'Clients' : 'Profiles';
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>${title}</h2>
        <p class="muted">Search, open details, and manage pipeline stages from one place.</p>
      </div>
      <div class="row gap-sm wrap">
        <input id="profile-search" placeholder="Search by name or email" value="${escapeHtml(state.search)}" />
        <select id="profile-kind-filter">
          <option value="all" ${kind === 'all' ? 'selected' : ''}>All</option>
          <option value="prospect" ${kind === 'prospect' ? 'selected' : ''}>Prospects</option>
          <option value="client" ${kind === 'client' ? 'selected' : ''}>Clients</option>
        </select>
        <button id="profile-search-button">Search</button>
      </div>
    </div>
    ${renderItems(profiles, (profile) => `
      <div class="item">
        <div class="row between wrap gap-sm">
          <div>
            <strong>${escapeHtml(profileName(profile))}</strong> <span class="badge">${escapeHtml(profile.kind)}</span>
            <div class="muted">${escapeHtml(profile.email || 'No email')}</div>
            <div class="muted">Source: ${escapeHtml(profile.source?.displayValue || '—')}</div>
            <div class="muted">Stage: ${escapeHtml(profile.stage || '—')}</div>
          </div>
          <div class="row gap-sm wrap">
            <button data-profile-id="${profile.id}">Open Profile</button>
            ${profile.kind === 'prospect' ? `<select data-stage-id="${profile.id}">${STAGES.map((stage) => `<option value="${stage}" ${profile.stage === stage ? 'selected' : ''}>${stage}</option>`).join('')}</select>` : ''}
          </div>
        </div>
      </div>`, 'No profiles matched your filters.')}
  `;

  document.querySelectorAll('[data-stage-id]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      await api(routes.profileStage(event.target.dataset.stageId), { method: 'PATCH', body: JSON.stringify({ stage: event.target.value }) });
      await renderCurrentView();
    });
  });
  document.querySelector('#profile-search-button').addEventListener('click', async () => {
    state.search = document.querySelector('#profile-search').value.trim();
    state.profileFilter = document.querySelector('#profile-kind-filter').value;
    state.view = state.profileFilter === 'all' ? 'profiles' : state.profileFilter;
    await renderCurrentView();
function roleAllowed(buttonRoleCsv = '') {
  if (!buttonRoleCsv) return true;
  if (!state.user?.role) return false;
  return buttonRoleCsv.split(',').includes(state.user.role);
}

function updateRoleVisibility() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.hidden = !roleAllowed(button.dataset.roles || '');
  });
  document.querySelectorAll('[data-requires-role]').forEach((section) => {
    const roles = section.dataset.requiresRole || '';
    section.hidden = !roleAllowed(roles);
  });
}

async function refreshSelects() {
  if (!state.token || !state.user || state.user.role === 'client') return;
  const clients = await request('/api/profiles?kind=client');
  const profiles = await request('/api/profiles');
  householdPrimaryEl.innerHTML = clients.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`).join('');
  portalProfileEl.innerHTML = profiles.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</option>`).join('');
}

function metricCard(label, value) {
  return `<div class="stat"><strong>${escapeHtml(value)}</strong><div class="muted">${escapeHtml(label)}</div></div>`;
}

async function renderDashboard() {
  const data = await request('/api/dashboard');
  viewEl.innerHTML = `
    ${flashMarkup()}
    <div class="section-header"><h2>Dashboard</h2></div>
    <div class="stat-grid">
      ${Object.entries(data.stats).map(([key, value]) => metricCard(key, value)).join('')}
    </div>
    <div class="item compact muted">Recent activity and profile management remain available in their dedicated tabs.</div>
  `;
}

function analyticsPanel(title, body) {
  return `<section class="item"><h3>${escapeHtml(title)}</h3>${body}</section>`;
}

async function renderAnalytics() {
  const analytics = await request('/api/analytics');
  const summary = analytics.summary || {};
  const funnelRows = (summary.funnel || []).map((entry) => `<tr><td>${escapeHtml(entry.stage)}</td><td>${entry.count}</td><td>${Math.round((entry.conversionRate || 0) * 100)}%</td></tr>`).join('');
  const agingRows = Object.entries(summary.stageAging || {}).map(([stage, value]) => `<tr><td>${escapeHtml(stage)}</td><td>${value.count || 0}</td><td>${value.avgDays || 0}</td></tr>`).join('');
  const completionRows = (summary.formCompletionRates || []).map((item) => `<tr><td>${escapeHtml(item.templateId)}</td><td>${item.drafts}</td><td>${item.submitted}</td><td>${Math.round((item.completionRate || 0) * 100)}%</td></tr>`).join('');
  const productivityRows = (summary.advisorProductivity || []).map((item) => `<tr><td>${escapeHtml(item.advisorName)}</td><td>${item.profilesManaged}</td><td>${item.notesAuthored}</td><td>${item.stageMoves}</td><td>${item.productivityScore}</td></tr>`).join('');
  const mat = analytics.materialized;

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
    ${analyticsPanel('Advisor Productivity', `<table><thead><tr><th>Advisor</th><th>Managed</th><th>Notes</th><th>Stage moves</th><th>Score</th></tr></thead><tbody>${productivityRows || '<tr><td colspan="5">No advisor events yet</td></tr>'}</tbody></table>`)}
    ${analyticsPanel('Materialized Summary Health', `<div class="muted">${mat ? `Refreshed ${new Date(mat.updatedAt).toLocaleString()} for firm ${escapeHtml(mat.firmId)}` : 'Materialized summary unavailable.'}</div>`)}
  `;
}

async function renderForms() {
  const [templates, drafts] = await Promise.all([request('/api/forms/templates'), request('/api/forms/drafts')]);
  const rows = drafts.map((draft) => `
    <tr>
      <td>${escapeHtml(draft.id)}</td>
      <td>${escapeHtml(draft.templateId)}</td>
      <td>${draft.revisionId || 1}</td>
      <td>${draft.lock ? `Locked (${escapeHtml(draft.lock.holderUserId)})` : 'Unlocked'}</td>
      <td>
        <button data-lock="${draft.id}">Acquire lock</button>
        <button data-save="${draft.id}">Save revision</button>
      </td>
    </tr>
  `).join('');

  viewEl.innerHTML = `
    ${flashMarkup()}
    <h2>Forms + Collaboration</h2>
    <p class="muted">Draft editing now uses revision IDs, short leases, and conflict-aware save prompts.</p>
    <div class="stat-grid compact-stats">
      ${metricCard('templates', templates.length)}
      ${metricCard('drafts', drafts.length)}
    </div>
    <table><thead><tr><th>Draft ID</th><th>Template</th><th>Revision</th><th>Lock</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No drafts</td></tr>'}</tbody></table>
  `;

  document.querySelectorAll('[data-lock]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const result = await request(`/api/forms/drafts/${button.dataset.lock}/lock`, { method: 'POST', body: JSON.stringify({ leaseMs: 30000 }) });
        setFlash('success', `Lock acquired. Lease ${result.lock.leaseId.slice(0, 8)}…`);
      } catch (error) {
        setFlash('error', error.message);
      }
      await renderForms();
    });
  });

  document.querySelectorAll('[data-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const draftId = button.dataset.save;
      const draft = drafts.find((item) => item.id === draftId);
      try {
        const response = await request(`/api/forms/drafts/${draftId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            leaseId: draft?.lock?.leaseId,
            expectedRevisionId: draft?.revisionId || 1,
            data: { ...(draft?.data || {}), uiSavedAt: new Date().toISOString() }
          })
        });
        if (!response.ok) {
          setFlash('error', response.mergePrompt?.suggestion || 'Draft conflict.');
        } else {
          setFlash('success', `Draft saved at revision ${response.submission.revisionId}.`);
        }
      } catch (error) {
        setFlash('error', error.message);
      }
      await renderForms();
    });
  });
}

async function renderFallback(title) {
  viewEl.innerHTML = `${flashMarkup()}<h2>${escapeHtml(title)}</h2><p class="muted">This view remains functional in API workflows and can be expanded with richer cards later.</p>`;
}

async function renderBoard() {
  const board = await api(routes.board());
  const columns = board.columns || [];
  view.innerHTML = `<h2>Prospect Board</h2><div class="muted">Board version: ${board.boardVersion || 'n/a'}</div><div class="columns">${columns.map((column) => `<div class="column"><h3>${column.stage}</h3>${column.cards.map((card) => `<div class="item"><strong>${card.firstName} ${card.lastName}</strong><div class="muted">#${card.stageOrderIndex}</div><button data-profile-id="${card.id}">Open Profile</button></div>`).join('')}</div>`).join('')}</div>`;
  const templates = await api('/api/templates');
  view.innerHTML = `<h2>Templates</h2>${renderItems(templates, (item) => `<div class="item"><strong>${escapeHtml(item.name)}</strong><div class="muted">${escapeHtml(item.fileName)}</div><pre>${escapeHtml(JSON.stringify(item.mappings, null, 2))}</pre></div>`, 'No document templates yet.')}`;
}

async function renderExports() {
  const exportsList = await api('/api/exports');
  view.innerHTML = `<h2>Exports</h2>${renderItems(exportsList, (item) => `<div class="item"><strong>${escapeHtml(item.type.toUpperCase())}</strong><div class="muted">${escapeHtml(item.status)}</div><pre>${escapeHtml(JSON.stringify(item.output, null, 2))}</pre></div>`, 'No export jobs yet.')}`;
}

async function renderAudit() {
  const events = await api('/api/audit');
  view.innerHTML = `<h2>Audit</h2>${renderItems(events, (event) => `<div class="item"><strong>${escapeHtml(event.action)}</strong><div class="muted">${new Date(event.occurredAt).toLocaleString()}</div><pre>${escapeHtml(JSON.stringify(event.metadata, null, 2))}</pre></div>`, 'No audit events yet.')}`;
}

async function renderAnalytics() {
  const endDate = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(start.getDate() - 30);
  const startDate = start.toISOString().slice(0, 10);
  const filters = {
    startDate,
    endDate,
    cohortBy: state.analyticsCohortBy || 'sourceVenue',
    cohortValue: state.analyticsCohortValue || '',
    slaTargetDays: state.analyticsSlaDays || 14
  };
  const analytics = await api(routes.analytics(filters));
  const summary = analytics.summary || {};
  const funnelRows = (summary.funnel || []).map((entry) => `
    <tr>
      <td>${escapeHtml(entry.stage)}</td>
      <td>${entry.count}</td>
      <td>${Math.round((entry.conversionRate || 0) * 100)}%</td>
      <td>${Math.round((entry.stageToStageRate || 0) * 100)}%</td>
    </tr>
  `).join('');
  const agingRows = Object.entries(summary.stageAging || {}).map(([stage, value]) => `
    <tr>
      <td>${escapeHtml(stage)}</td>
      <td>${value.count || 0}</td>
      <td>${value.p50Days || 0}</td>
      <td>${value.p90Days || 0}</td>
      <td>${value.p95Days || 0}</td>
    </tr>
  `).join('');
  const throughputRows = (summary.advisorThroughput || []).map((entry) => `
    <tr>
      <td>${escapeHtml(entry.advisorName)}</td>
      <td>${entry.assignedProspects}</td>
      <td>${entry.completedProspects}</td>
      <td>${entry.stageMoves}</td>
      <td>${entry.notesAuthored}</td>
      <td>${entry.throughput}</td>
    </tr>
  `).join('');
  const cohorts = Object.entries(summary.cohortSegments || {}).sort((a, b) => b[1] - a[1]);
  const cohortBars = cohorts.map(([label, count]) => {
    const pct = cohorts[0]?.[1] ? Math.round((count / cohorts[0][1]) * 100) : 0;
    return `<div class="item compact"><div class="row between"><strong>${escapeHtml(label)}</strong><span>${count}</span></div><div style="height:8px;background:#e8e8ef;border-radius:999px;overflow:hidden"><div style="height:8px;width:${pct}%;background:#4f46e5"></div></div></div>`;
  }).join('');

  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Analytics</h2>
        <p class="muted">Operational reporting with date range filters, cohorting, reconciliation, and advisor throughput.</p>
      </div>
      <button id="analytics-export">Export Snapshot</button>
    </div>
    <section class="item">
      <h3>Filters</h3>
      <div class="row">
        <label>Start <input id="analytics-start" type="date" value="${startDate}"></label>
        <label>End <input id="analytics-end" type="date" value="${endDate}"></label>
        <label>Cohort
          <select id="analytics-cohort-by">
            <option value="sourceVenue" ${filters.cohortBy === 'sourceVenue' ? 'selected' : ''}>Source venue</option>
            <option value="sourceCity" ${filters.cohortBy === 'sourceCity' ? 'selected' : ''}>Source city</option>
            <option value="advisor" ${filters.cohortBy === 'advisor' ? 'selected' : ''}>Advisor</option>
            <option value="stage" ${filters.cohortBy === 'stage' ? 'selected' : ''}>Stage</option>
          </select>
        </label>
        <label>Cohort value <input id="analytics-cohort-value" value="${escapeHtml(filters.cohortValue)}" placeholder="optional"></label>
        <label>SLA days <input id="analytics-sla-days" type="number" min="1" value="${filters.slaTargetDays}"></label>
        <button id="analytics-apply">Apply</button>
      </div>
    </section>
    <div class="stat-grid compact-stats">
      ${metricCard('Profiles', summary.profileCount || 0)}
      ${metricCard('Overall conversion', `${Math.round((summary.overallConversionRate || 0) * 100)}%`)}
      ${metricCard('SLA met', `${Math.round((summary.completionSla?.completionRate || 0) * 100)}%`)}
      ${metricCard('Reconciliation', summary.reconciliation?.matches ? '✓ Matched' : '⚠ Drift')}
    </div>
    <section class="item">
      <h3>Funnel Conversion</h3>
      <table><thead><tr><th>Stage</th><th>Count</th><th>From top</th><th>Stage-to-stage</th></tr></thead><tbody>${funnelRows || '<tr><td colspan=\"4\">No data</td></tr>'}</tbody></table>
    </section>
    <section class="item">
      <h3>Stage Aging Percentiles (days)</h3>
      <table><thead><tr><th>Stage</th><th>Prospects</th><th>P50</th><th>P90</th><th>P95</th></tr></thead><tbody>${agingRows || '<tr><td colspan=\"5\">No data</td></tr>'}</tbody></table>
    </section>
    <section class="item">
      <h3>Completion SLA</h3>
      <div class="row">
        <div class="item compact">Submitted within target: <strong>${summary.completionSla?.submittedWithinTarget || 0}</strong></div>
        <div class="item compact">Submitted outside target: <strong>${summary.completionSla?.submittedOutsideTarget || 0}</strong></div>
        <div class="item compact">Drafts beyond target: <strong>${summary.completionSla?.draftOpenBeyondTarget || 0}</strong></div>
      </div>
    </section>
    <section class="item">
      <h3>Advisor Throughput</h3>
      <table><thead><tr><th>Advisor</th><th>Assigned</th><th>Completed</th><th>Moves</th><th>Notes</th><th>Throughput</th></tr></thead><tbody>${throughputRows || '<tr><td colspan=\"6\">No advisor activity</td></tr>'}</tbody></table>
    </section>
    <section class="item">
      <h3>Cohort Mix</h3>
      ${cohortBars || '<div class="item compact muted">No cohorts in range.</div>'}
    </section>
  `;

  document.querySelector('#analytics-apply')?.addEventListener('click', async () => {
    state.analyticsCohortBy = document.querySelector('#analytics-cohort-by')?.value || 'sourceVenue';
    state.analyticsCohortValue = document.querySelector('#analytics-cohort-value')?.value || '';
    state.analyticsSlaDays = Number(document.querySelector('#analytics-sla-days')?.value || 14);
    await renderAnalytics();
  });
  document.querySelector('#analytics-export')?.addEventListener('click', async () => {
    const payload = await api(routes.analyticsExport(filters));
    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = payload.fileName || 'analytics-snapshot.json';
    link.click();
    URL.revokeObjectURL(url);
  });
}

async function renderBoard() {
  const board = await api('/api/board');
  const columns = board.columns || [];
  const conflictBanner = board.conflict ? `<div class="item"><strong>Ordering conflict:</strong> ${escapeHtml(board.conflict.message || 'refresh required')}</div>` : '';
  view.innerHTML = `<div class="section-header"><div><h2>Prospect Board</h2><p class="muted">Track persisted per-stage ordering and quickly open prospect details.</p><p class="muted">Board version ${escapeHtml(String(board.boardVersion || 'n/a'))}</p></div><button id="open-all-profiles">Open searchable list</button></div>${conflictBanner}<div class="columns">${columns.map((column) => `<div class="column"><h3>${escapeHtml(column.stage)}</h3>${column.cards.length ? column.cards.map((card) => `<div class="item"><strong>${escapeHtml(profileName(card))}</strong><div class="muted">#${card.stageOrderIndex} • v${card.pipelineVersion || 1}</div><button data-profile-id="${card.id}">Open Profile</button></div>`).join('') : '<div class="item compact muted">No cards</div>'}</div>`).join('')}</div>`;
  document.querySelector('#open-all-profiles').addEventListener('click', async () => {
    state.view = 'profiles';
    state.profileFilter = 'prospect';
    await renderProfiles('prospect');
  });
  wireProfileButtons();
}

function workspaceTemplateSection(templates, progress) {
  if (!templates.length) return '<div class="item compact muted">Your advisor has not shared any forms yet.</div>';
  const progressMap = new Map(progress.map((entry) => [entry.templateId, entry.status]));
  return renderItems(templates, (template) => `<div class="item"><div class="row between"><strong>${template.name}</strong><span class="badge ${progressMap.get(template.id) === 'submitted' ? '' : 'subtle'}">${progressMap.get(template.id) || 'not_started'}</span></div><div class="muted">${template.description || ''}</div></div>`);
}

async function renderClientWorkspace() {
  const workspace = await api('/api/client/workspace');
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>My Client Workspace</h2>
        <p class="muted">Secure, client-only portal experience. Advisor/admin operations are intentionally hidden.</p>
      </div>
      <span class="badge">${workspace.profile.firstName} ${workspace.profile.lastName}</span>
    </div>
    <section class="grid two">
      <article class="item">
        <h3>Profile</h3>
        <div class="muted">${workspace.profile.email || 'No email'}</div>
        <div class="muted">${workspace.profile.phone || 'No phone'}</div>
      </article>
      <article class="item">
        <h3>Document Upload Visibility</h3>
        ${workspace.uploads.length ? renderItems(workspace.uploads, (upload) => `<div class="item compact"><div class="row between"><strong>${upload.name}</strong><span class="badge">${upload.status}</span></div><div class="muted">${upload.category} • ${upload.uploadedBy}</div></div>`) : '<div class="item compact muted">No documents uploaded yet.</div>'}
      </article>
    </section>
    <h3>Form Completion Visibility</h3>
    ${workspaceTemplateSection(workspace.templates, workspace.templateProgress)}
    <section class="grid two">
      <form id="client-form-submission" class="card inner">
        <h3>Submit Form</h3>
        <select name="templateId" required>
          <option value="">Select template</option>
          ${workspace.templates.map((template) => `<option value="${template.id}">${template.name}</option>`).join('')}
        </select>
        <select name="status"><option value="draft">Save draft</option><option value="submitted">Submit</option></select>
        <textarea name="data" rows="4" placeholder='JSON payload, e.g. {"goals":"Retire"}' required></textarea>
        <button type="submit">Save Form</button>
      </form>
      <form id="client-upload" class="card inner">
        <h3>Upload Document (Presigned)</h3>
        <input type="file" name="file" required />
        <input name="name" placeholder="Document name (optional)" />
        <input name="category" placeholder="Category (tax, ID, etc.)" value="general" />
        <textarea name="notes" rows="4" placeholder="Optional notes"></textarea>
        <button type="submit">Upload File</button>
      </form>
    </section>
    <h3>Recent Submission History</h3>
    ${workspace.submissions.length ? renderItems(workspace.submissions, (submission) => `<div class="item"><div class="row between"><strong>${submission.templateId}</strong><span class="badge ${submission.status === 'submitted' ? '' : 'subtle'}">${submission.status}</span></div><pre>${JSON.stringify(submission.data, null, 2)}</pre></div>`) : '<div class="item compact muted">No submissions yet.</div>'}
  `;

  document.querySelector('#back-profiles').addEventListener('click', async () => {
    state.view = 'clients';
    await renderCurrentView();
  });

  document.querySelectorAll('[data-edit-repeatable]').forEach((button) => {
    button.addEventListener('click', () => {
      const submission = detail.submissions.find((entry) => entry.id === button.dataset.editRepeatable);
      if (submission) installRepeatableModal(detail.profile, submission);
  document.querySelector('#client-upload')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) {
      alert('Choose a file first.');
      return;
    }
    const presign = await api('/api/client/uploads/presign', {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        category: form.get('category') || 'general'
      })
    });
    await fetch(presign.presigned.url, {
      method: presign.presigned.method || 'PUT',
      headers: presign.presigned.headers || { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    await api('/api/client/uploads', {
      method: 'POST',
      body: JSON.stringify({
        uploadId: presign.uploadId,
        name: form.get('name') || file.name,
        category: form.get('category') || 'general',
        notes: form.get('notes') || '',
        object: presign.object
      })
    });
  });
async function renderCurrentView() {
  if (!state.user) {
    viewEl.innerHTML = `${flashMarkup()}<h2>Sign in to continue</h2>`;
    return;
  }
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'analytics') return renderAnalytics();
  if (state.view === 'forms') return renderForms();
  return renderFallback(state.view);
}

async function renderCurrentView() {
  if (!state.user) {
    view.innerHTML = `${renderFlash()}<h2>Sign in to continue</h2>`;
    return;
  }
  if (state.view === 'clients' || state.view === 'profiles' || state.view === 'prospects') return renderProfiles();
  if (state.view === 'profile-detail') return renderProfileDetail();
  return renderDashboard();
async function hydrateSession() {
  if (!state.token) {
    state.user = null;
    authStatusEl.textContent = 'Not signed in';
    updateRoleVisibility();
    return;
  }
  try {
    const session = await request('/api/session');
    state.user = session.user;
    authStatusEl.textContent = JSON.stringify(session.user, null, 2);
    updateRoleVisibility();
    await refreshSelects();
  } catch {
    state.token = '';
    localStorage.removeItem('klient-token');
    state.user = null;
    authStatusEl.textContent = 'Not signed in';
    updateRoleVisibility();
  }
}

async function finishAuth(session, message) {
  state.token = session.token;
  localStorage.setItem('klient-token', session.token);
  state.user = session.user;
  authStatusEl.textContent = JSON.stringify(session.user, null, 2);
  state.view = session.user.role === 'client' ? 'forms' : 'dashboard';
  updateRoleVisibility();
  await refreshSelects();
  setFlash('success', message);
  await renderCurrentView();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!roleAllowed(button.dataset.roles || '')) return;
    state.view = button.dataset.view;
    await renderCurrentView();
  });
});

async function finishAuthentication(session, message) {
  state.token = session.token;
  state.user = session.user;
  localStorage.setItem('klient-token', state.token);
  authStatus.textContent = JSON.stringify(session.user, null, 2);
  setFlash('success', message);
  state.view = session.user.role === 'client' ? 'client-workspace' : 'dashboard';
  await renderCurrentView();
}

document.querySelector('#demo-login').addEventListener('click', async () => {
  try {
    clearFlash();
    const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' }) });
    await finishAuthentication(session, 'Signed in with demo account.');
document.querySelector('#demo-login').addEventListener('click', async () => {
  try {
    const session = await request('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' }) });
    await finishAuth(session, 'Signed in with demo account.');
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    const session = await request('/api/register', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    await finishAuth(session, 'Firm admin account created.');
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    clearFlash();
    const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    await finishAuthentication(session, 'Signed in successfully.');
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    const session = await request('/api/login', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    await finishAuth(session, 'Signed in successfully.');
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    clearFlash();
    const session = await api('/api/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    await finishAuthentication(session, 'Firm admin created.');
document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(event.target);
    const source = form.get('cityOrLocation') ? { cityOrLocation: form.get('cityOrLocation'), venue: form.get('venue'), occurredOn: form.get('occurredOn') } : null;
    await request('/api/profiles', { method: 'POST', body: JSON.stringify({ kind: form.get('kind'), firstName: form.get('firstName'), lastName: form.get('lastName'), email: form.get('email'), phone: form.get('phone'), stage: form.get('stage'), source }) });
    event.target.reset();
    setFlash('success', 'Profile created.');
    await refreshSelects();
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#household-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    await request('/api/households', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    setFlash('success', 'Household created.');
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#form-template-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = { ...Object.fromEntries(new FormData(event.target).entries()), sections: [] };
    await request('/api/forms/templates', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    state.view = 'forms';
    setFlash('success', 'Form template created.');
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#doc-template-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = { ...Object.fromEntries(new FormData(event.target).entries()), blueprint: { sections: [] }, mappings: [] };
    await request('/api/templates', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    setFlash('success', 'Document template created.');
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    const invite = await request('/api/invites', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    setFlash('success', `Invite created (${invite.token}).`);
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#portal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    const link = await request('/api/portal-links', { method: 'POST', body: JSON.stringify(payload) });
    setFlash('success', `Portal link created: /portal?token=${link.token}`);
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

await hydrateSession();
await renderCurrentView();
