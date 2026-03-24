import { routes } from './api-contract.js';

const state = {
  token: localStorage.getItem('klient-token') || '',
  user: null,
  view: 'dashboard',
  selectedProfileId: null,
  flash: null,
  profileDetail: null,
  templatesById: new Map()
};

const view = document.querySelector('#view');
const authStatus = document.querySelector('#auth-status');
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let csrfToken = '';

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function setFlash(type, message) { state.flash = { type, message }; }
function clearFlash() { state.flash = null; }
function profileName(p) { return `${p.firstName} ${p.lastName}`; }
function authHeaders() { return state.token ? { Authorization: `Bearer ${state.token}` } : {}; }

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (MUTATING_METHODS.has(method) && !csrfToken) {
    const csrf = await fetch('/api/csrf');
    const body = await csrf.json();
    if (!csrf.ok || !body.csrfToken) throw new Error('Unable to initialize CSRF protection.');
    csrfToken = body.csrfToken;
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
  `;

  document.querySelector('#back-profiles').addEventListener('click', async () => {
    state.view = 'clients';
    await renderCurrentView();
  });

  document.querySelectorAll('[data-edit-repeatable]').forEach((button) => {
    button.addEventListener('click', () => {
      const submission = detail.submissions.find((entry) => entry.id === button.dataset.editRepeatable);
      if (submission) installRepeatableModal(detail.profile, submission);
    });
  });
}

async function renderCurrentView() {
  if (!state.user) {
    view.innerHTML = `${renderFlash()}<h2>Sign in to continue</h2>`;
    return;
  }
  if (state.view === 'clients' || state.view === 'profiles' || state.view === 'prospects') return renderProfiles();
  if (state.view === 'profile-detail') return renderProfileDetail();
  return renderDashboard();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
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
  } catch (error) {
    setFlash('error', error.message);
    await renderCurrentView();
  }
});

await hydrateSession();
await renderCurrentView();
