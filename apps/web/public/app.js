const state = { token: localStorage.getItem('klient-token') || '', view: 'dashboard', selectedProfileId: null, user: null };

const view = document.querySelector('#view');
const authStatus = document.querySelector('#auth-status');
const householdPrimary = document.querySelector('select[name="primaryClientId"]');
const portalProfileSelect = document.querySelector('select[name="profileId"]');

const headers = () => state.token ? { Authorization: `Bearer ${state.token}` } : {};

const ROLE_OPTIONS = ['admin', 'advisor', 'readonly', 'client'];

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
  if (!response.ok) throw new Error(data.message || 'Request failed');
  return data;
}

function renderItems(items, render) {
  return `<div class="list">${items.map(render).join('')}</div>`;
}

async function syncSession() {
  if (!state.token) {
    state.user = null;
    authStatus.textContent = '';
    return;
  }
  try {
    const session = await api('/api/session');
    state.user = session.user;
    authStatus.textContent = JSON.stringify(session.user, null, 2);
  } catch {
    state.user = null;
    state.token = '';
    localStorage.removeItem('klient-token');
    authStatus.textContent = '';
  }
}

async function refreshPrimaryClientOptions() {
  try {
    const clients = await api('/api/profiles?kind=client');
    const allProfiles = await api('/api/profiles');
    householdPrimary.innerHTML = clients.map((profile) => `<option value="${profile.id}">${profile.firstName} ${profile.lastName}</option>`).join('');
    portalProfileSelect.innerHTML = allProfiles.map((profile) => `<option value="${profile.id}">${profile.firstName} ${profile.lastName}</option>`).join('');
  } catch {
    householdPrimary.innerHTML = '<option value="">Login first</option>';
    portalProfileSelect.innerHTML = '<option value="">Login first</option>';
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

async function renderDashboard() {
  const data = await api('/api/dashboard');
  view.innerHTML = `
    <h2>Dashboard</h2>
    <div class="stat-grid">
      ${Object.entries(data.stats).map(([key, value]) => `<div class="stat"><strong>${value}</strong><div class="muted">${key}</div></div>`).join('')}
    </div>
    <h3>Recent Profiles</h3>
    ${renderItems(data.recentProfiles, (profile) => `<div class="item"><strong>${profile.firstName} ${profile.lastName}</strong> <span class="badge">${profile.kind}</span><div class="muted">${profile.source?.displayValue || 'No source'}</div><button data-profile-id="${profile.id}">Open Profile</button></div>`)}
  `;
  wireProfileButtons();
}

async function renderProfiles(kind) {
  const profiles = await api(`/api/profiles?kind=${kind}`);
  view.innerHTML = `<h2>${kind === 'prospect' ? 'Prospects' : 'Clients'}</h2>` + renderItems(profiles, (profile) => `
    <div class="item">
      <strong>${profile.firstName} ${profile.lastName}</strong> <span class="badge">${profile.kind}</span>
      <div class="muted">${profile.email || ''}</div>
      <div>Source: ${profile.source?.displayValue || '—'}</div>
      <div>Stage: ${profile.stage || '—'}</div>
      <button data-profile-id="${profile.id}">Open Profile</button>
      ${kind === 'prospect' ? `<select data-stage-id="${profile.id}">
        ${['discovery','gather_oi','analysis','advisor_proposal_meeting','intake','on_boarding','investment_strategy','completed','drop_dead_lead','drop_nurture'].map((stage) => `<option value="${stage}" ${profile.stage === stage ? 'selected' : ''}>${stage}</option>`).join('')}
      </select>` : ''}
    </div>`);

  document.querySelectorAll('[data-stage-id]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      await api(`/api/profiles/${event.target.dataset.stageId}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: event.target.value }) });
      await renderCurrentView();
    });
  });
  wireProfileButtons();
}

async function renderProfileDetail() {
  if (!state.selectedProfileId) {
    state.view = 'dashboard';
    return renderCurrentView();
  }

  const detail = await api(`/api/profiles/${state.selectedProfileId}`);
  view.innerHTML = `
    <div class="detail-header">
      <button id="back-to-dashboard">← Back</button>
      <h2>${detail.profile.firstName} ${detail.profile.lastName}</h2>
      <div class="muted">${detail.profile.kind} • ${detail.profile.email || 'No email'} • ${detail.profile.stage || 'No stage'}</div>
    </div>
    <div class="grid two">
      <div class="item">
        <h3>Profile Summary</h3>
        <pre>${JSON.stringify(detail.profile, null, 2)}</pre>
      </div>
      <div class="item">
        <h3>Household</h3>
        <pre>${JSON.stringify({ household: detail.household, members: detail.householdMembers }, null, 2)}</pre>
      </div>
      <div class="item">
        <h3>Stage History</h3>
        <pre>${JSON.stringify(detail.stageHistory, null, 2)}</pre>
      </div>
      <div class="item">
        <h3>Form Submissions</h3>
        <pre>${JSON.stringify(detail.submissions, null, 2)}</pre>
      </div>
    </div>
    <div class="item">
      <h3>Notes</h3>
      <form id="note-form">
        <textarea name="body" rows="3" placeholder="Add a note"></textarea>
        <button type="submit">Add Note</button>
      </form>
      ${renderItems(detail.notes, (note) => `<div class="item"><div class="muted">${note.createdAt}</div><div>${note.body}</div></div>`)}
    </div>
  `;

  document.querySelector('#back-to-dashboard').addEventListener('click', async () => {
    state.view = 'dashboard';
    await renderCurrentView();
  });

  document.querySelector('#note-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api(`/api/profiles/${state.selectedProfileId}/notes`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
    await renderProfileDetail();
  });
}

async function renderHouseholds() {
  const households = await api('/api/households');
  view.innerHTML = '<h2>Households</h2>' + renderItems(households, (household) => `
    <div class="item">
      <strong>${household.name}</strong>
      <div class="muted">Members: ${household.members.length}</div>
      <ul>${household.members.map((member) => `<li>${member.clientId} — ${member.role}</li>`).join('')}</ul>
    </div>
  `);
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
    ${renderItems(templates, (item) => `<div class="item"><strong>${item.name}</strong><div class="muted">${item.description || ''}</div><div class="muted">Sections: ${(item.sections || []).length}</div></div>`)}
    <h3>Drafts</h3>
    ${drafts.length ? renderItems(drafts, (item) => `<div class="item"><div class="row between"><strong>${item.templateId}</strong><span class="badge subtle">draft</span></div><div class="muted">Client ${item.clientId}</div><div class="muted">Source ${item.source || 'advisor'}</div><pre>${JSON.stringify(item.data, null, 2)}</pre></div>`) : '<div class="item compact muted">No drafts yet.</div>'}
    <h3>Submitted</h3>
    ${submitted.length ? renderItems(submitted, (item) => `<div class="item"><div class="row between"><strong>${item.templateId}</strong><span class="badge">${item.status}</span></div><div class="muted">Client ${item.clientId}</div><div class="muted">Source ${item.source || 'advisor'}</div><pre>${JSON.stringify(item.data, null, 2)}</pre></div>`) : '<div class="item compact muted">No submitted forms yet.</div>'}
  `;
}

async function renderTemplates() {
  const templates = await api('/api/templates');
  view.innerHTML = '<h2>Templates</h2>' + renderItems(templates, (item) => `<div class="item"><strong>${item.name}</strong><div class="muted">${item.fileName}</div><pre>${JSON.stringify(item.mappings, null, 2)}</pre></div>`);
}

async function renderExports() {
  const exportsList = await api('/api/exports');
  view.innerHTML = '<h2>Exports</h2>' + renderItems(exportsList, (item) => `<div class="item"><strong>${item.type.toUpperCase()}</strong><div class="muted">${item.status}</div><pre>${JSON.stringify(item.output, null, 2)}</pre></div>`);
}

async function renderAudit() {
  const events = await api('/api/audit');
  view.innerHTML = '<h2>Audit</h2>' + renderItems(events, (event) => `<div class="item"><strong>${event.action}</strong><div class="muted">${event.occurredAt}</div><pre>${JSON.stringify(event.metadata, null, 2)}</pre></div>`);
}

async function renderAnalytics() {
  const analytics = await api('/api/analytics');
  view.innerHTML = `<h2>Analytics</h2><pre>${JSON.stringify(analytics, null, 2)}</pre>`;
}

async function renderAdmin() {
  if (state.user?.role !== 'admin') {
    view.innerHTML = '<h2>Admin</h2><div class="item">Admin access is required.</div>';
    return;
  }

  const [users, settings] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/firm-settings')
  ]);

  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Firm Admin</h2>
        <p class="muted">Manage firm users and review firm settings.</p>
      </div>
    </div>
    <div class="grid two">
      <form id="admin-create-user-form" class="item">
        <h3>Create User</h3>
        <input name="firstName" placeholder="First name" required />
        <input name="lastName" placeholder="Last name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Temporary password" required />
        <select name="role">${ROLE_OPTIONS.map((role) => `<option value="${role}">${role}</option>`).join('')}</select>
        <button type="submit">Create User</button>
      </form>
      <form id="admin-invite-user-form" class="item">
        <h3>Invite User</h3>
        <input name="email" type="email" placeholder="Email" required />
        <select name="role">${ROLE_OPTIONS.map((role) => `<option value="${role}">${role}</option>`).join('')}</select>
        <button type="submit">Create Invite</button>
      </form>
    </div>
    <div class="item">
      <h3>Firm Settings</h3>
      <pre>${JSON.stringify(settings, null, 2)}</pre>
    </div>
    <div class="item">
      <h3>Firm Users</h3>
      <div class="list">
        ${users.map((user) => `
          <div class="item">
            <div class="row between">
              <div>
                <strong>${user.firstName} ${user.lastName}</strong>
                <div class="muted">${user.email}</div>
              </div>
              <span class="badge ${user.isActive ? '' : 'subtle'}">${user.isActive ? 'active' : 'inactive'}</span>
            </div>
            <div class="row between">
              <select data-admin-role-user-id="${user.id}">
                ${ROLE_OPTIONS.map((role) => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${role}</option>`).join('')}
              </select>
              <button data-admin-status-user-id="${user.id}" data-next-status="${user.isActive ? 'false' : 'true'}">${user.isActive ? 'Deactivate' : 'Reactivate'}</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  document.querySelector('#admin-create-user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    await renderAdmin();
  });

  document.querySelector('#admin-invite-user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const invite = await api('/api/admin/users/invite', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    alert(`Invite token: ${invite.token}`);
    await renderAdmin();
  });

  document.querySelectorAll('[data-admin-role-user-id]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      await api(`/api/admin/users/${event.target.dataset.adminRoleUserId}/role`, { method: 'PATCH', body: JSON.stringify({ role: event.target.value }) });
      await renderAdmin();
    });
  });

  document.querySelectorAll('[data-admin-status-user-id]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      await api(`/api/admin/users/${event.target.dataset.adminStatusUserId}/status`, { method: 'PATCH', body: JSON.stringify({ isActive: event.target.dataset.nextStatus === 'true' }) });
      await renderAdmin();
    });
  });
}

async function renderBoard() {
  const columns = await api('/api/board');
  view.innerHTML = `<h2>Prospect Board</h2><div class="columns">${columns.map((column) => `<div class="column"><h3>${column.stage}</h3>${column.cards.map((card) => `<div class="item"><strong>${card.firstName} ${card.lastName}</strong><div class="muted">#${card.stageOrderIndex}</div><button data-profile-id="${card.id}">Open Profile</button></div>`).join('')}</div>`).join('')}</div>`;
  wireProfileButtons();
}

async function renderCurrentView() {
  if (!state.token) {
    view.innerHTML = '<h2>Sign in to continue</h2>';
    return;
  }
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'prospects') return renderBoard();
  if (state.view === 'clients') return renderProfiles('client');
  if (state.view === 'profile-detail') return renderProfileDetail();
  if (state.view === 'households') return renderHouseholds();
  if (state.view === 'forms') return renderForms();
  if (state.view === 'templates') return renderTemplates();
  if (state.view === 'exports') return renderExports();
  if (state.view === 'analytics') return renderAnalytics();
  if (state.view === 'audit') return renderAudit();
  if (state.view === 'admin') return renderAdmin();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
    state.view = button.dataset.view;
    await renderCurrentView();
  });
});

document.querySelector('#demo-login').addEventListener('click', async () => {
  const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' }) });
  state.token = session.token;
  localStorage.setItem('klient-token', state.token);
  await syncSession();
  await refreshPrimaryClientOptions();
  await renderCurrentView();
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  const session = await api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
  state.token = session.token;
  localStorage.setItem('klient-token', state.token);
  await syncSession();
  await refreshPrimaryClientOptions();
  await renderCurrentView();
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  state.token = session.token;
  localStorage.setItem('klient-token', state.token);
  await syncSession();
  await refreshPrimaryClientOptions();
  await renderCurrentView();
});

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const source = form.get('cityOrLocation') ? { cityOrLocation: form.get('cityOrLocation'), venue: form.get('venue'), occurredOn: form.get('occurredOn') } : null;
  await api('/api/profiles', { method: 'POST', body: JSON.stringify({ kind: form.get('kind'), firstName: form.get('firstName'), lastName: form.get('lastName'), email: form.get('email'), phone: form.get('phone'), stage: form.get('stage'), source }) });
  event.target.reset();
  await refreshPrimaryClientOptions();
  await renderCurrentView();
});

document.querySelector('#household-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await api('/api/households', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  event.target.reset();
  await renderCurrentView();
});

document.querySelector('#form-template-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await api('/api/forms/templates', { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(form.entries()), sections: [] }) });
  event.target.reset();
  state.view = 'forms';
  await renderCurrentView();
});

document.querySelector('#doc-template-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await api('/api/templates', { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(form.entries()), blueprint: { sections: [] }, mappings: [] }) });
  event.target.reset();
  state.view = 'templates';
  await renderCurrentView();
});

syncSession().then(() => refreshPrimaryClientOptions()).then(() => renderCurrentView());


document.querySelector('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const invite = await api('/api/admin/users/invite', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  alert(`Invite token: ${invite.token}`);
  event.target.reset();
});

document.querySelector('#portal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const link = await api('/api/portal-links', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  alert(`Portal token: ${link.token}`);
});
