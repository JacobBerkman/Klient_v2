const state = {
  token: localStorage.getItem('klient-token') || '',
  view: 'dashboard',
  selectedProfileId: null,
  user: null
};

const view = document.querySelector('#view');
const authStatus = document.querySelector('#auth-status');
const householdPrimary = document.querySelector('select[name="primaryClientId"]');
const portalProfileSelect = document.querySelector('select[name="profileId"]');

const headers = () => state.token ? { Authorization: `Bearer ${state.token}` } : {};

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

function activeRole() {
  return state.user?.role || null;
}

function canAccessView(nextView) {
  const role = activeRole();
  if (!role) return false;
  const allowedRoles = document.querySelector(`[data-view="${nextView}"]`)?.dataset.roles?.split(',') || [];
  return allowedRoles.length ? allowedRoles.includes(role) : true;
}

function updateRoleVisibility() {
  const role = activeRole();
  const navButtons = document.querySelectorAll('[data-view]');
  navButtons.forEach((button) => {
    const allowed = (button.dataset.roles || '').split(',').filter(Boolean);
    button.hidden = !role || (allowed.length > 0 && !allowed.includes(role));
  });

  document.querySelectorAll('[data-requires-role]').forEach((section) => {
    const allowed = section.dataset.requiresRole.split(',').filter(Boolean);
    section.hidden = !role || !allowed.includes(role);
  });
}

async function refreshPrimaryClientOptions() {
  if (!state.token || activeRole() === 'client') {
    householdPrimary.innerHTML = '<option value="">Advisor sign-in required</option>';
    portalProfileSelect.innerHTML = '<option value="">Advisor sign-in required</option>';
    return;
  }

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
      ${kind === 'prospect' && ['admin', 'advisor'].includes(activeRole()) ? `<select data-stage-id="${profile.id}">
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
      ${['admin', 'advisor'].includes(activeRole()) ? `<form id="note-form">
        <textarea name="body" rows="3" placeholder="Add a note"></textarea>
        <button type="submit">Add Note</button>
      </form>` : '<div class="muted">Read-only access.</div>'}
      ${renderItems(detail.notes, (note) => `<div class="item"><div class="muted">${note.createdAt}</div><div>${note.body}</div></div>`)}
    </div>
  `;

  document.querySelector('#back-to-dashboard').addEventListener('click', async () => {
    state.view = 'dashboard';
    await renderCurrentView();
  });

  const noteForm = document.querySelector('#note-form');
  if (noteForm) {
    noteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      await api(`/api/profiles/${state.selectedProfileId}/notes`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
      await renderProfileDetail();
    });
  }
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

async function renderBoard() {
  const columns = await api('/api/board');
  view.innerHTML = `<h2>Prospect Board</h2><div class="columns">${columns.map((column) => `<div class="column"><h3>${column.stage}</h3>${column.cards.map((card) => `<div class="item"><strong>${card.firstName} ${card.lastName}</strong><div class="muted">#${card.stageOrderIndex}</div><button data-profile-id="${card.id}">Open Profile</button></div>`).join('')}</div>`).join('')}</div>`;
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
        <h3>Log Document Upload</h3>
        <input name="name" placeholder="Document name" required />
        <input name="category" placeholder="Category (tax, ID, etc.)" value="general" />
        <textarea name="notes" rows="4" placeholder="Optional notes"></textarea>
        <button type="submit">Log Upload</button>
      </form>
    </section>
    <h3>Recent Submission History</h3>
    ${workspace.submissions.length ? renderItems(workspace.submissions, (submission) => `<div class="item"><div class="row between"><strong>${submission.templateId}</strong><span class="badge ${submission.status === 'submitted' ? '' : 'subtle'}">${submission.status}</span></div><pre>${JSON.stringify(submission.data, null, 2)}</pre></div>`) : '<div class="item compact muted">No submissions yet.</div>'}
  `;

  document.querySelector('#client-form-submission')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const raw = String(form.get('data') || '{}').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      alert('Submission data must be valid JSON.');
      return;
    }
    await api('/api/client/forms/submissions', {
      method: 'POST',
      body: JSON.stringify({ templateId: form.get('templateId'), status: form.get('status'), data: parsed })
    });
    await renderClientWorkspace();
  });

  document.querySelector('#client-upload')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api('/api/client/uploads', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    await renderClientWorkspace();
  });
}

async function hydrateSession() {
  if (!state.token) {
    state.user = null;
    authStatus.textContent = '';
    updateRoleVisibility();
    return;
  }

  try {
    const session = await api('/api/session');
    state.user = session.user;
    authStatus.textContent = JSON.stringify(session.user, null, 2);
    updateRoleVisibility();
    if (!canAccessView(state.view)) {
      state.view = state.user.role === 'client' ? 'client-workspace' : 'dashboard';
    }
  } catch {
    state.user = null;
    state.token = '';
    localStorage.removeItem('klient-token');
    authStatus.textContent = '';
    updateRoleVisibility();
  }
}

async function renderCurrentView() {
  if (!state.token || !state.user) {
    view.innerHTML = '<h2>Sign in to continue</h2>';
    return;
  }
  if (!canAccessView(state.view)) {
    state.view = state.user.role === 'client' ? 'client-workspace' : 'dashboard';
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
  if (state.view === 'client-workspace') return renderClientWorkspace();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
    state.view = button.dataset.view;
    await renderCurrentView();
  });
});

async function storeSession(session) {
  state.token = session.token;
  localStorage.setItem('klient-token', state.token);
  state.user = session.user;
  authStatus.textContent = JSON.stringify(session.user, null, 2);
  updateRoleVisibility();
  state.view = session.user.role === 'client' ? 'client-workspace' : 'dashboard';
  await refreshPrimaryClientOptions();
  await renderCurrentView();
}

document.querySelector('#demo-login').addEventListener('click', async () => {
  const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' }) });
  await storeSession(session);
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  const session = await api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
  await storeSession(session);
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  await storeSession(session);
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

document.querySelector('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const invite = await api('/api/invites', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  alert(`Invite token: ${invite.token}`);
  event.target.reset();
});

document.querySelector('#portal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const link = await api('/api/portal-links', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  alert(`Portal token: ${link.token}`);
});

hydrateSession().then(refreshPrimaryClientOptions).then(renderCurrentView);
