const state = {
  token: localStorage.getItem('klient-token') || '',
  user: null,
  view: 'dashboard',
  flash: null
};

const viewEl = document.querySelector('#view');
const authStatusEl = document.querySelector('#auth-status');
const householdPrimaryEl = document.querySelector('select[name="primaryClientId"]');
const portalProfileEl = document.querySelector('select[name="profileId"]');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let csrfToken = '';

function escapeHtml(value) {
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
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(MUTATING_METHODS.has(method) && path.startsWith('/api/') ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || data?.message || 'Request failed');
  return data;
}

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
  const analytics = await api('/api/analytics');
  view.innerHTML = `<h2>Analytics</h2><pre>${escapeHtml(JSON.stringify(analytics, null, 2))}</pre>`;
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
