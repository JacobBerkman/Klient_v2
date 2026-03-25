const state = {
  token: localStorage.getItem('klient-token') || '',
  user: null,
  view: 'dashboard',
  flash: null,
  enableDemoMode: false
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


async function hydrateRuntime() {
  try {
    const runtimeConfig = await request('/api/runtime');
    state.enableDemoMode = Boolean(runtimeConfig.enableDemoMode);
  } catch {
    state.enableDemoMode = false;
  }
  document.querySelector('#demo-login').hidden = !state.enableDemoMode;
  document.querySelector('#demo-credentials').hidden = !state.enableDemoMode;
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

const demoLoginButton = document.querySelector('#demo-login');
demoLoginButton.addEventListener('click', async () => {
  if (!state.enableDemoMode) return;
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

await hydrateRuntime();
await hydrateSession();
await renderCurrentView();
