const state = { token: localStorage.getItem('klient-token') || '', view: 'dashboard', selectedProfileId: null };

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

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || !Array.isArray(rule.conditions) || !rule.conditions.length) return null;
  return { match: rule.match === 'any' ? 'any' : 'all', conditions: rule.conditions };
}

function evaluateCondition(condition, answers) {
  const actual = answers?.[condition.field];
  const operator = condition.operator || 'equals';
  if (operator === 'exists') return actual !== undefined && actual !== null && String(actual).trim() !== '';
  if (operator === 'not_exists') return actual === undefined || actual === null || String(actual).trim() === '';
  if (operator === 'not_equals') return actual !== condition.value;
  if (operator === 'in') return Array.isArray(condition.value) ? condition.value.includes(actual) : false;
  if (operator === 'not_in') return Array.isArray(condition.value) ? !condition.value.includes(actual) : true;
  if (operator === 'gt') return Number(actual) > Number(condition.value);
  if (operator === 'gte') return Number(actual) >= Number(condition.value);
  if (operator === 'lt') return Number(actual) < Number(condition.value);
  if (operator === 'lte') return Number(actual) <= Number(condition.value);
  return actual === condition.value;
}

function isVisibleByRule(showWhen, answers) {
  const rule = normalizeRule(showWhen);
  if (!rule) return true;
  if (rule.match === 'any') return rule.conditions.some((condition) => evaluateCondition(condition, answers));
  return rule.conditions.every((condition) => evaluateCondition(condition, answers));
}

function sectionDataKey(section, sectionIndex) {
  return (section.title || `section_${sectionIndex + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '_');
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
  const [templates, submissions, drafts, clients] = await Promise.all([
    api('/api/forms/templates'),
    api('/api/forms/submissions'),
    api('/api/forms/drafts'),
    api('/api/profiles?kind=client')
  ]);
  const submitted = submissions.filter((item) => item.status !== 'draft');

  let selectedTemplateId = templates[0]?.id || '';
  let sectionRepeats = new Map();
  let workingData = drafts.find((entry) => entry.templateId === selectedTemplateId)?.data || {};

  function selectedTemplate() {
    return templates.find((template) => template.id === selectedTemplateId) || null;
  }

  function fieldName(sectionIndex, fieldKey, rowIndex = null) {
    return rowIndex === null ? `section-${sectionIndex}::${fieldKey}` : `section-${sectionIndex}::${rowIndex}::${fieldKey}`;
  }

  function repeatCountFor(sectionIndex) {
    return sectionRepeats.get(sectionIndex) || 1;
  }

  function collectData(formElement) {
    const template = selectedTemplate();
    if (!template || !formElement) return {};
    const formData = new FormData(formElement);
    const payload = {};
    template.sections.forEach((section, sectionIndex) => {
      if (section.repeatable) {
        const rows = [];
        for (let rowIndex = 0; rowIndex < repeatCountFor(sectionIndex); rowIndex += 1) {
          const row = {};
          let hasValue = false;
          for (const field of section.fields || []) {
            const value = String(formData.get(fieldName(sectionIndex, field.key, rowIndex)) || '').trim();
            if (value) hasValue = true;
            row[field.key] = value;
          }
          if (hasValue) rows.push(row);
        }
        payload[sectionDataKey(section, sectionIndex)] = rows;
        return;
      }

      for (const field of section.fields || []) {
        payload[field.key] = String(formData.get(fieldName(sectionIndex, field.key)) || '').trim();
      }
    });
    return payload;
  }

  function renderComposer() {
    const template = selectedTemplate();
    const fieldsHtml = !template ? '<div class="item compact muted">No template selected.</div>' : (() => {
      const answers = {};
      return template.sections.map((section, sectionIndex) => {
        if (!isVisibleByRule(section.showWhen, answers)) return '';
        const repeatable = Boolean(section.repeatable);
        const dataKey = sectionDataKey(section, sectionIndex);
        const seedRows = repeatable && Array.isArray(workingData[dataKey]) ? workingData[dataKey] : [];
        const repeatCount = repeatable ? Math.max(repeatCountFor(sectionIndex), seedRows.length || 1) : 1;
        const rowsMarkup = Array.from({ length: repeatCount }, (_, rowIndex) => {
          const rowData = repeatable ? (seedRows[rowIndex] || {}) : workingData;
          const scopedAnswers = repeatable ? { ...answers, ...rowData } : answers;
          const fieldMarkup = (section.fields || []).map((field) => {
            if (!isVisibleByRule(field.showWhen, scopedAnswers)) return '';
            const value = rowData[field.key] || '';
            if (repeatable) {
              answers[dataKey] ||= [];
              answers[dataKey][rowIndex] ||= {};
              answers[dataKey][rowIndex][field.key] = value;
            } else {
              answers[field.key] = value;
            }
            const name = fieldName(sectionIndex, field.key, repeatable ? rowIndex : null);
            if (field.type === 'textarea') return `<label><span>${field.label || field.key}</span><textarea name="${name}" rows="3">${value}</textarea></label>`;
            if (field.type === 'select') return `<label><span>${field.label || field.key}</span><select name="${name}"><option value="">Select…</option>${(field.options || []).map((option) => `<option value="${option}" ${String(option) === String(value) ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
            const type = { text: 'text', number: 'number', date: 'date', email: 'email' }[field.type] || 'text';
            return `<label><span>${field.label || field.key}</span><input type="${type}" name="${name}" value="${value}" /></label>`;
          }).join('');
          return `<div class="repeat-block">${repeatable ? `<div class="muted">Entry ${rowIndex + 1}</div>` : ''}<div class="grid two compact-grid">${fieldMarkup}</div></div>`;
        }).join('');
        return `<section class="item section-card"><div class="row between"><h4>${section.title || `Section ${sectionIndex + 1}`}</h4>${repeatable ? `<button type="button" data-advisor-add-repeat="${sectionIndex}">Add entry</button>` : ''}</div>${rowsMarkup}</section>`;
      }).join('');
    })();

    return `
      <section class="card">
        <h3>Advisor Form Composer</h3>
        <p class="muted">Conditional sections/fields evaluate live while you complete a form on behalf of a client.</p>
        <form id="advisor-form-composer" class="stack gap-md">
          <div class="grid two compact-grid">
            <label><span>Template</span><select id="advisor-template-picker">${templates.map((template) => `<option value="${template.id}" ${template.id === selectedTemplateId ? 'selected' : ''}>${template.name}</option>`).join('')}</select></label>
            <label><span>Client</span><select id="advisor-client-picker">${clients.map((profile) => `<option value="${profile.id}">${profile.firstName} ${profile.lastName}</option>`).join('')}</select></label>
          </div>
          <div id="advisor-form-fields" class="stack gap-md">${fieldsHtml}</div>
          <div class="actions-row">
            <button type="submit" data-status="submitted">Submit Form</button>
            <button type="button" data-status="draft">Save Draft</button>
          </div>
        </form>
      </section>
    `;
  }

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
    ${templates.length && clients.length ? renderComposer() : '<div class="item compact muted">Create at least one template and one client to use advisor form composer.</div>'}
  `;

  const composer = document.querySelector('#advisor-form-composer');
  if (!composer) return;
  const templatePicker = document.querySelector('#advisor-template-picker');
  const rerenderComposer = async () => {
    const currentComposer = document.querySelector('#advisor-form-composer');
    workingData = collectData(currentComposer);
    const template = selectedTemplate();
    if (template) {
      template.sections.forEach((section, sectionIndex) => {
        if (section.repeatable) {
          const count = Array.isArray(workingData[sectionDataKey(section, sectionIndex)]) ? workingData[sectionDataKey(section, sectionIndex)].length : 0;
          if (count > repeatCountFor(sectionIndex)) sectionRepeats.set(sectionIndex, count);
        }
      });
    }
    const formFields = document.querySelector('#advisor-form-fields');
    if (formFields) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderComposer();
      const next = wrapper.querySelector('#advisor-form-fields');
      if (next) formFields.innerHTML = next.innerHTML;
    }
    bindComposerEvents();
  };

  const submitComposer = async (status) => {
    const formElement = document.querySelector('#advisor-form-composer');
    const clientId = document.querySelector('#advisor-client-picker')?.value;
    const payload = collectData(formElement);
    await api('/api/forms/submissions', {
      method: 'POST',
      body: JSON.stringify({
        clientId,
        templateId: selectedTemplateId,
        status,
        data: payload
      })
    });
    await renderForms();
  };

  function bindComposerEvents() {
    document.querySelectorAll('[data-advisor-add-repeat]').forEach((button) => {
      button.addEventListener('click', async () => {
        const sectionIndex = Number(button.dataset.advisorAddRepeat);
        sectionRepeats.set(sectionIndex, repeatCountFor(sectionIndex) + 1);
        await rerenderComposer();
      });
    });
    document.querySelectorAll('#advisor-form-fields input, #advisor-form-fields select, #advisor-form-fields textarea').forEach((input) => {
      input.addEventListener('change', async () => {
        await rerenderComposer();
      });
    });
  }

  templatePicker?.addEventListener('change', async () => {
    selectedTemplateId = templatePicker.value;
    sectionRepeats = new Map();
    workingData = drafts.find((entry) => entry.templateId === selectedTemplateId)?.data || {};
    await renderForms();
  });

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitComposer('submitted');
  });
  composer.querySelector('[data-status="draft"]')?.addEventListener('click', async () => {
    await submitComposer('draft');
  });
  bindComposerEvents();
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
  authStatus.textContent = JSON.stringify(session.user, null, 2);
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
  authStatus.textContent = JSON.stringify(session.user, null, 2);
  await refreshPrimaryClientOptions();
  await renderCurrentView();
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  state.token = session.token;
  localStorage.setItem('klient-token', state.token);
  authStatus.textContent = JSON.stringify(session.user, null, 2);
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

refreshPrimaryClientOptions();
renderCurrentView();


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
