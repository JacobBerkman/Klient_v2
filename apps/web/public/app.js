const STAGES = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed', 'drop_dead_lead', 'drop_nurture'];

const state = {
  token: localStorage.getItem('klient-token') || '',
  view: 'dashboard',
  selectedProfileId: null,
  profileFilter: 'all',
  search: '',
  clients: [],
  profiles: [],
  activeSession: null,
  flash: null
};

const view = document.querySelector('#view');
const authStatus = document.querySelector('#auth-status');
const householdPrimary = document.querySelector('select[name="primaryClientId"]');
const portalProfileSelect = document.querySelector('select[name="profileId"]');

const headers = () => state.token ? { Authorization: `Bearer ${state.token}` } : {};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setFlash(type, message) {
  state.flash = { type, message };
}

function clearFlash() {
  state.flash = null;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...headers(),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      state.token = '';
      state.activeSession = null;
      localStorage.removeItem('klient-token');
      authStatus.textContent = 'Session expired. Sign in again.';
    }
    throw new Error(data.message || 'Request failed');
  }
  return data;
}

function renderItems(items, render, emptyMessage = 'Nothing to show yet.') {
  if (!items.length) {
    return `<div class="item compact muted">${escapeHtml(emptyMessage)}</div>`;
  }
  return `<div class="list">${items.map(render).join('')}</div>`;
}

function profileName(profile) {
  return `${profile.firstName} ${profile.lastName}`;
}

function syncAuthStatus() {
  authStatus.textContent = state.activeSession ? JSON.stringify(state.activeSession, null, 2) : 'Not signed in.';
}

async function refreshPrimaryClientOptions() {
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
  }
  try {
    const session = await api('/api/session');
    state.activeSession = session.user;
    syncAuthStatus();
    await refreshPrimaryClientOptions();
  } catch (error) {
    setFlash('error', error.message);
    syncAuthStatus();
  }
}

function wireProfileButtons() {
  document.querySelectorAll('[data-profile-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedProfileId = button.dataset.profileId;
      state.view = 'profile-detail';
      await renderCurrentView();
    });
  });
}

function wireStageSelectors() {
  document.querySelectorAll('[data-stage-id]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      try {
        clearFlash();
        await api(`/api/profiles/${event.target.dataset.stageId}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: event.target.value }) });
        setFlash('success', 'Stage updated.');
        await renderCurrentView();
      } catch (error) {
        setFlash('error', error.message);
        await renderCurrentView();
      }
    });
  });
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Dashboard</h2>
        <p class="muted">${escapeHtml(data.firm?.name || 'Firm')} overview, pipeline health, and recent activity.</p>
      </div>
      <div class="row gap-sm">
        <button id="refresh-dashboard">Refresh</button>
        <button id="logout-button" class="secondary">Sign Out</button>
      </div>
    </div>
    ${state.flash ? `<div class="item compact ${state.flash.type === 'error' ? 'error-banner' : 'success-banner'}">${escapeHtml(state.flash.message)}</div>` : ''}
    <div class="stat-grid">
      ${Object.entries(data.stats).map(([key, value]) => `<div class="stat"><strong>${value}</strong><div class="muted">${escapeHtml(key)}</div></div>`).join('')}
    </div>
    <div class="grid two">
      <div>
        <h3>Recent Profiles</h3>
        ${renderItems(data.recentProfiles, (profile) => `<div class="item"><strong>${escapeHtml(profileName(profile))}</strong> <span class="badge">${escapeHtml(profile.kind)}</span><div class="muted">${escapeHtml(profile.source?.displayValue || 'No source')}</div><button data-profile-id="${profile.id}">Open Profile</button></div>`, 'No profiles yet.')}
      </div>
      <div>
        <h3>Recent Audit Events</h3>
        ${renderItems(data.recentAuditEvents, (event) => `<div class="item compact"><strong>${escapeHtml(event.action)}</strong><div class="muted">${new Date(event.occurredAt).toLocaleString()}</div></div>`, 'No audit events yet.')}
      </div>
    </div>
  `;

  document.querySelector('#refresh-dashboard').addEventListener('click', async () => renderCurrentView());
  document.querySelector('#logout-button').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {}
    state.token = '';
    state.activeSession = null;
    localStorage.removeItem('klient-token');
    await refreshPrimaryClientOptions();
    syncAuthStatus();
    setFlash('success', 'Signed out successfully.');
    await renderCurrentView();
  });
  wireProfileButtons();
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

  document.querySelector('#profile-search-button').addEventListener('click', async () => {
    state.search = document.querySelector('#profile-search').value.trim();
    state.profileFilter = document.querySelector('#profile-kind-filter').value;
    state.view = state.profileFilter === 'all' ? 'profiles' : state.profileFilter;
    await renderCurrentView();
  });
  document.querySelector('#profile-kind-filter').addEventListener('change', async (event) => {
    state.profileFilter = event.target.value;
    state.view = event.target.value === 'all' ? 'profiles' : event.target.value;
    await renderCurrentView();
  });
  wireStageSelectors();
  wireProfileButtons();
}

function householdMemberOptions(profileId) {
  return state.clients
    .filter((client) => client.id !== profileId)
    .map((client) => `<option value="${client.id}">${escapeHtml(profileName(client))}</option>`)
    .join('');
}

async function renderProfileDetail() {
  if (!state.selectedProfileId) {
    state.view = 'dashboard';
    return renderCurrentView();
  }

  const detail = await api(`/api/profiles/${state.selectedProfileId}`);
  const sensitive = await api(`/api/profiles/${state.selectedProfileId}/sensitive`);
  const householdMembers = detail.householdMembers.map((member) => {
    const profile = state.profiles.find((entry) => entry.id === member.clientId) || { firstName: member.clientId, lastName: '' };
    return { ...member, label: profileName(profile) };
  });

  view.innerHTML = `
    <div class="detail-header">
      <button id="back-to-list">← Back</button>
      <div>
        <h2>${escapeHtml(profileName(detail.profile))}</h2>
        <div class="muted">${escapeHtml(detail.profile.kind)} • ${escapeHtml(detail.profile.email || 'No email')} • ${escapeHtml(detail.profile.stage || 'No stage')}</div>
      </div>
    </div>
    ${state.flash ? `<div class="item compact ${state.flash.type === 'error' ? 'error-banner' : 'success-banner'}">${escapeHtml(state.flash.message)}</div>` : ''}
    <div class="grid two">
      <div class="item">
        <h3>Profile Summary</h3>
        <div class="stack gap-sm">
          <div><strong>Phone:</strong> ${escapeHtml(detail.profile.phone || 'Not provided')}</div>
          <div><strong>Date of birth:</strong> ${escapeHtml(detail.profile.dateOfBirth || 'Not provided')}</div>
          <div><strong>Source:</strong> ${escapeHtml(detail.profile.source?.displayValue || 'Not provided')}</div>
          <div><strong>SSN:</strong> ${escapeHtml(sensitive.ssnMasked || 'Not stored')}</div>
          <div><strong>Tax ID:</strong> ${escapeHtml(sensitive.taxIdMasked || 'Not stored')}</div>
        </div>
      </div>
      <div class="item">
        <h3>Household</h3>
        ${detail.household ? `<div class="stack gap-sm"><strong>${escapeHtml(detail.household.name)}</strong><div class="muted">Primary client: ${escapeHtml(detail.household.primaryClientId)}</div><ul>${householdMembers.map((member) => `<li>${escapeHtml(member.label)} — ${escapeHtml(member.role)} <button data-remove-member="${member.clientId}">Remove</button></li>`).join('')}</ul></div>` : '<div class="muted">No household linked yet.</div>'}
        <form id="household-link-form" class="stack gap-sm top-gap">
          ${detail.household ? `<input type="hidden" name="householdId" value="${detail.household.id}" />` : '<input name="householdName" placeholder="New household name" required />'}
          <select name="clientId" ${state.clients.length <= 1 ? 'disabled' : ''}>
            ${householdMemberOptions(detail.profile.id) || '<option value="">No additional clients available</option>'}
          </select>
          <div class="row gap-sm wrap">
            <select name="role"><option value="member">Member</option><option value="spouse">Spouse</option></select>
            <button type="submit">${detail.household ? 'Add to Household' : 'Create Household + Add Member'}</button>
          </div>
        </form>
        <form id="create-spouse-form" class="stack gap-sm top-gap">
          <h4>Create spouse profile</h4>
          <div class="grid two compact-grid">
            <input name="firstName" placeholder="First name" required />
            <input name="lastName" placeholder="Last name" required />
            <input name="email" type="email" placeholder="Email" />
            <input name="phone" placeholder="Phone" />
          </div>
          <button type="submit">Create spouse and link</button>
        </form>
      </div>
      <div class="item">
        <h3>Stage History</h3>
        ${renderItems(detail.stageHistory, (event) => `<div class="item compact"><strong>${escapeHtml(event.toStage || 'updated')}</strong><div class="muted">${new Date(event.changedAt).toLocaleString()}</div></div>`, 'No stage history yet.')}
      </div>
      <div class="item">
        <h3>Form Submissions</h3>
        ${renderItems(detail.submissions, (submission) => `<div class="item compact"><strong>${escapeHtml(submission.templateId)}</strong><div class="muted">${escapeHtml(submission.status)}</div><pre>${escapeHtml(JSON.stringify(submission.data, null, 2))}</pre></div>`, 'No form submissions yet.')}
      </div>
    </div>
    <div class="item">
      <h3>Notes</h3>
      <form id="note-form" class="stack gap-sm">
        <textarea name="body" rows="3" placeholder="Add a note" required></textarea>
        <button type="submit">Add Note</button>
      </form>
      ${renderItems(detail.notes, (note) => `<div class="item"><div class="muted">${new Date(note.createdAt).toLocaleString()}</div><div>${escapeHtml(note.body)}</div></div>`, 'No notes yet.')}
    </div>
  `;

  document.querySelector('#back-to-list').addEventListener('click', async () => {
    state.view = detail.profile.kind === 'prospect' ? 'prospects' : 'clients';
    await renderCurrentView();
  });

  document.querySelector('#note-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      clearFlash();
      const form = new FormData(event.target);
      await api(`/api/profiles/${state.selectedProfileId}/notes`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
      setFlash('success', 'Note added.');
      await renderProfileDetail();
    } catch (error) {
      setFlash('error', error.message);
      await renderProfileDetail();
    }
  });

  document.querySelector('#household-link-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      clearFlash();
      const form = new FormData(event.target);
      let householdId = detail.household?.id || null;
      const clientId = String(form.get('clientId') || '').trim();
      if (!householdId) {
        const household = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: form.get('householdName'), primaryClientId: detail.profile.id }) });
        householdId = household.id;
      }
      if (clientId) {
        await api(`/api/households/${householdId}/members`, { method: 'POST', body: JSON.stringify({ clientId, role: form.get('role') }) });
      }
      setFlash('success', 'Household updated.');
      await refreshPrimaryClientOptions();
      await renderProfileDetail();
    } catch (error) {
      setFlash('error', error.message);
      await renderProfileDetail();
    }
  });

  document.querySelector('#create-spouse-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      clearFlash();
      const form = new FormData(event.target);
      await api('/api/households/create-spouse', {
        method: 'POST',
        body: JSON.stringify({
          primaryClientId: detail.profile.id,
          spouse: Object.fromEntries(form.entries())
        })
      });
      setFlash('success', 'Spouse profile created and linked.');
      await refreshPrimaryClientOptions();
      await renderProfileDetail();
    } catch (error) {
      setFlash('error', error.message);
      await renderProfileDetail();
    }
  });

  document.querySelectorAll('[data-remove-member]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        clearFlash();
        await api(`/api/households/${detail.household.id}/members`, { method: 'DELETE', body: JSON.stringify({ clientId: button.dataset.removeMember }) });
        setFlash('success', 'Household member removed.');
        await refreshPrimaryClientOptions();
        await renderProfileDetail();
      } catch (error) {
        setFlash('error', error.message);
        await renderProfileDetail();
      }
    });
  });
}

async function renderHouseholds() {
  const households = await api('/api/households');
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Households</h2>
        <p class="muted">Review household composition and jump to the related profile records.</p>
      </div>
      <button id="refresh-households">Refresh</button>
    </div>
    ${renderItems(households, (household) => `
      <div class="item">
        <div class="row between wrap gap-sm">
          <div>
            <strong>${escapeHtml(household.name)}</strong>
            <div class="muted">Primary client: ${escapeHtml(household.primaryClientId)}</div>
          </div>
          <span class="badge">${household.members.length} members</span>
        </div>
        <ul>
          ${household.members.map((member) => {
            const profile = state.profiles.find((entry) => entry.id === member.clientId);
            return `<li>${escapeHtml(profile ? profileName(profile) : member.clientId)} — ${escapeHtml(member.role)} ${profile ? `<button data-profile-id="${profile.id}">Open Profile</button>` : ''}</li>`;
          }).join('')}
        </ul>
      </div>
    `, 'No households yet.')}
  `;
  document.querySelector('#refresh-households').addEventListener('click', async () => renderCurrentView());
  wireProfileButtons();
}

async function renderForms() {
  const [templates, submissions, drafts] = await Promise.all([
    api('/api/forms/templates'),
    api('/api/forms/submissions'),
    api('/api/forms/drafts')
  ]);
  const submitted = submissions.filter((item) => item.status !== 'draft');
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Forms</h2>
        <p class="muted">Monitor shared templates plus saved drafts and submitted client responses.</p>
      </div>
      <div class="stat-grid compact-stats">
        <div class="stat"><strong>${templates.length}</strong><div class="muted">templates</div></div>
        <div class="stat"><strong>${drafts.length}</strong><div class="muted">drafts</div></div>
        <div class="stat"><strong>${submitted.length}</strong><div class="muted">submitted</div></div>
      </div>
    </div>
    <h3>Templates</h3>
    ${renderItems(templates, (item) => `<div class="item"><strong>${escapeHtml(item.name)}</strong><div class="muted">${escapeHtml(item.description || '')}</div><div class="muted">Sections: ${(item.sections || []).length}</div></div>`, 'No form templates yet.')}
    <h3>Drafts</h3>
    ${renderItems(drafts, (item) => `<div class="item"><div class="row between"><strong>${escapeHtml(item.templateId)}</strong><span class="badge subtle">draft</span></div><div class="muted">Client ${escapeHtml(item.clientId)}</div><div class="muted">Source ${escapeHtml(item.source || 'advisor')}</div><pre>${escapeHtml(JSON.stringify(item.data, null, 2))}</pre></div>`, 'No drafts yet.')}
    <h3>Submitted</h3>
    ${renderItems(submitted, (item) => `<div class="item"><div class="row between"><strong>${escapeHtml(item.templateId)}</strong><span class="badge">${escapeHtml(item.status)}</span></div><div class="muted">Client ${escapeHtml(item.clientId)}</div><div class="muted">Source ${escapeHtml(item.source || 'advisor')}</div><pre>${escapeHtml(JSON.stringify(item.data, null, 2))}</pre></div>`, 'No submitted forms yet.')}
  `;
}

async function renderTemplates() {
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
  const analytics = await api('/api/analytics');
  view.innerHTML = `<h2>Analytics</h2><pre>${escapeHtml(JSON.stringify(analytics, null, 2))}</pre>`;
}

async function renderBoard() {
  const columns = await api('/api/board');
  view.innerHTML = `<div class="section-header"><div><h2>Prospect Board</h2><p class="muted">Track persisted per-stage ordering and quickly open prospect details.</p></div><button id="open-all-profiles">Open searchable list</button></div><div class="columns">${columns.map((column) => `<div class="column"><h3>${escapeHtml(column.stage)}</h3>${column.cards.length ? column.cards.map((card) => `<div class="item"><strong>${escapeHtml(profileName(card))}</strong><div class="muted">#${card.stageOrderIndex}</div><button data-profile-id="${card.id}">Open Profile</button></div>`).join('') : '<div class="item compact muted">No cards</div>'}</div>`).join('')}</div>`;
  document.querySelector('#open-all-profiles').addEventListener('click', async () => {
    state.view = 'profiles';
    state.profileFilter = 'prospect';
    await renderProfiles('prospect');
  });
  wireProfileButtons();
}

async function renderCurrentView() {
  if (!state.token) {
    view.innerHTML = `${state.flash ? `<div class="item compact ${state.flash.type === 'error' ? 'error-banner' : 'success-banner'}">${escapeHtml(state.flash.message)}</div>` : ''}<h2>Sign in to continue</h2><p class="muted">Use the demo account or register a new firm admin with a strong password.</p>`;
    return;
  }
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'prospects') return renderBoard();
  if (state.view === 'clients') return renderProfiles('client');
  if (state.view === 'profiles') return renderProfiles(state.profileFilter || 'all');
  if (state.view === 'profile-detail') return renderProfileDetail();
  if (state.view === 'households') return renderHouseholds();
  if (state.view === 'forms') return renderForms();
  if (state.view === 'templates') return renderTemplates();
  if (state.view === 'exports') return renderExports();
  if (state.view === 'analytics') return renderAnalytics();
  if (state.view === 'audit') return renderAudit();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
    state.view = button.dataset.view;
    if (button.dataset.view === 'clients') state.profileFilter = 'client';
    await renderCurrentView();
  });
});

async function finishAuthentication(session, successMessage) {
  state.token = session.token;
  state.activeSession = session.user;
  localStorage.setItem('klient-token', state.token);
  syncAuthStatus();
  setFlash('success', successMessage);
  await refreshPrimaryClientOptions();
  await renderCurrentView();
}

document.querySelector('#demo-login').addEventListener('click', async () => {
  try {
    clearFlash();
    const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' }) });
    await finishAuthentication(session, 'Signed in with the demo account.');
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    clearFlash();
    const form = new FormData(event.target);
    const payload = Object.fromEntries(form.entries());
    const session = await api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    await finishAuthentication(session, 'Firm admin account created.');
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    clearFlash();
    const form = new FormData(event.target);
    const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    event.target.reset();
    await finishAuthentication(session, 'Signed in successfully.');
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    clearFlash();
    const form = new FormData(event.target);
    const source = form.get('cityOrLocation') ? { cityOrLocation: form.get('cityOrLocation'), venue: form.get('venue'), occurredOn: form.get('occurredOn') } : null;
    const created = await api('/api/profiles', { method: 'POST', body: JSON.stringify({ kind: form.get('kind'), firstName: form.get('firstName'), lastName: form.get('lastName'), email: form.get('email'), phone: form.get('phone'), stage: form.get('stage'), source }) });
    event.target.reset();
    await refreshPrimaryClientOptions();
    state.selectedProfileId = created.id;
    state.view = 'profile-detail';
    setFlash('success', `${created.kind === 'prospect' ? 'Prospect' : 'Client'} created.`);
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#household-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    clearFlash();
    const form = new FormData(event.target);
    await api('/api/households', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    event.target.reset();
    await refreshPrimaryClientOptions();
    state.view = 'households';
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
    clearFlash();
    const form = new FormData(event.target);
    await api('/api/forms/templates', { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(form.entries()), sections: [] }) });
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
    clearFlash();
    const form = new FormData(event.target);
    await api('/api/templates', { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(form.entries()), blueprint: { sections: [] }, mappings: [] }) });
    event.target.reset();
    state.view = 'templates';
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
    clearFlash();
    const form = new FormData(event.target);
    const invite = await api('/api/invites', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    setFlash('success', `Invite created for ${invite.email}. Token: ${invite.token}`);
    event.target.reset();
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

document.querySelector('#portal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    clearFlash();
    const form = new FormData(event.target);
    const link = await api('/api/portal-links', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    setFlash('success', `Portal link created. Open /portal?token=${link.token}`);
    await renderCurrentView();
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

await hydrateSession();
await renderCurrentView();
