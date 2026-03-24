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

function fieldTemplate() {
  return {
    id: crypto.randomUUID(),
    key: '',
    label: '',
    type: 'text',
    helperText: '',
    defaultValue: '',
    repeatableGroup: false,
    options: [],
    validation: { required: false, min: '', max: '', pattern: '', minLength: '', maxLength: '', message: '' }
  };
}

function sectionTemplate() {
  return { id: crypto.randomUUID(), title: '', description: '', repeatable: false, repeatableGroup: '', fields: [fieldTemplate()] };
}

function getEditorState(template) {
  return {
    id: template?.id || null,
    name: template?.name || '',
    description: template?.description || '',
    status: template?.status || 'draft',
    sections: (template?.sections || [sectionTemplate()]).map((section) => ({
      id: section.id || crypto.randomUUID(),
      title: section.title || '',
      description: section.description || '',
      repeatable: Boolean(section.repeatable),
      repeatableGroup: section.repeatableGroup || '',
      fields: (section.fields || [fieldTemplate()]).map((field) => ({
        ...fieldTemplate(),
        ...field,
        id: field.id || crypto.randomUUID(),
        options: Array.isArray(field.options) ? field.options : [],
        validation: {
          ...fieldTemplate().validation,
          ...(field.validation || {})
        }
      }))
    }))
  };
}

function renderFieldEditor(sectionIndex, field, fieldIndex) {
  const fieldType = field.type || 'text';
  return `
    <div class="item stack gap-sm">
      <div class="row between">
        <strong>Field ${fieldIndex + 1}</strong>
        <button type="button" data-field-remove="${sectionIndex}:${fieldIndex}">Remove Field</button>
      </div>
      <div class="grid two compact-grid">
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.label" value="${field.label || ''}" placeholder="Field label" />
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.key" value="${field.key || ''}" placeholder="Field key (unique)" />
      </div>
      <div class="grid two compact-grid">
        <select data-bind="sections.${sectionIndex}.fields.${fieldIndex}.type">
          ${['text', 'textarea', 'number', 'date', 'email', 'phone', 'checkbox', 'select'].map((type) => `<option value="${type}" ${fieldType === type ? 'selected' : ''}>${type}</option>`).join('')}
        </select>
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.helperText" value="${field.helperText || ''}" placeholder="Helper text" />
      </div>
      <div class="grid two compact-grid">
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.defaultValue" value="${field.defaultValue ?? ''}" placeholder="Default value" />
        <label class="row"><input type="checkbox" data-bind="sections.${sectionIndex}.fields.${fieldIndex}.repeatableGroup" ${field.repeatableGroup ? 'checked' : ''} /> Repeatable group field</label>
      </div>
      ${fieldType === 'select' ? `<textarea data-bind="sections.${sectionIndex}.fields.${fieldIndex}.options" placeholder="One select option per line">${(field.options || []).join('\n')}</textarea>` : ''}
      <div class="grid two compact-grid">
        <label class="row"><input type="checkbox" data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.required" ${field.validation?.required ? 'checked' : ''} /> Required</label>
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.pattern" value="${field.validation?.pattern || ''}" placeholder="Validation regex pattern" />
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.min" value="${field.validation?.min ?? ''}" placeholder="Min value" />
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.max" value="${field.validation?.max ?? ''}" placeholder="Max value" />
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.minLength" value="${field.validation?.minLength ?? ''}" placeholder="Min length" />
        <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.maxLength" value="${field.validation?.maxLength ?? ''}" placeholder="Max length" />
      </div>
      <input data-bind="sections.${sectionIndex}.fields.${fieldIndex}.validation.message" value="${field.validation?.message || ''}" placeholder="Validation error message" />
    </div>
  `;
}

function buildTemplatePayload(editor) {
  return {
    name: editor.name,
    description: editor.description,
    status: editor.status === 'published' ? 'published' : 'draft',
    sections: editor.sections.map((section) => ({
      id: section.id,
      title: section.title || 'Untitled Section',
      description: section.description || '',
      repeatable: Boolean(section.repeatable),
      repeatableGroup: section.repeatableGroup || '',
      fields: section.fields.map((field) => ({
        id: field.id,
        key: field.key || field.label?.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: field.label || field.key || 'Untitled Field',
        type: field.type || 'text',
        helperText: field.helperText || '',
        defaultValue: field.defaultValue || '',
        repeatableGroup: Boolean(field.repeatableGroup),
        options: String(field.options || '')
          .split('\n')
          .map((option) => option.trim())
          .filter(Boolean),
        validation: {
          required: Boolean(field.validation?.required),
          min: field.validation?.min === '' ? null : field.validation?.min,
          max: field.validation?.max === '' ? null : field.validation?.max,
          pattern: field.validation?.pattern || '',
          minLength: field.validation?.minLength === '' ? null : field.validation?.minLength,
          maxLength: field.validation?.maxLength === '' ? null : field.validation?.maxLength,
          message: field.validation?.message || ''
        }
      }))
    }))
  };
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
    ${renderItems(templates, (item) => `<div class="item"><div class="row between"><strong>${item.name}</strong><span class="badge ${item.status === 'published' ? '' : 'subtle'}">${item.status || 'draft'}</span></div><div class="muted">${item.description || ''}</div><div class="muted">Sections: ${(item.sections || []).length}</div><button data-template-edit="${item.id}">Edit Definition</button></div>`)}
    <h3>Drafts</h3>
    ${drafts.length ? renderItems(drafts, (item) => `<div class="item"><div class="row between"><strong>${item.templateId}</strong><span class="badge subtle">draft</span></div><div class="muted">Client ${item.clientId}</div><div class="muted">Source ${item.source || 'advisor'}</div><pre>${JSON.stringify(item.data, null, 2)}</pre></div>`) : '<div class="item compact muted">No drafts yet.</div>'}
    <h3>Submitted</h3>
    ${submitted.length ? renderItems(submitted, (item) => `<div class="item"><div class="row between"><strong>${item.templateId}</strong><span class="badge">${item.status}</span></div><div class="muted">Client ${item.clientId}</div><div class="muted">Source ${item.source || 'advisor'}</div><pre>${JSON.stringify(item.data, null, 2)}</pre></div>`) : '<div class="item compact muted">No submitted forms yet.</div>'}
    <div id="form-template-editor" class="item stack gap-md"></div>
  `;

  const editorRoot = document.querySelector('#form-template-editor');
  const editorState = getEditorState();

  function pathSet(path, value) {
    const steps = path.split('.');
    let target = editorState;
    while (steps.length > 1) {
      target = target[steps.shift()];
    }
    target[steps[0]] = value;
  }

  function renderEditor() {
    editorRoot.innerHTML = `
      <div class="row between">
        <h3>${editorState.id ? 'Edit Form Definition' : 'Create Form Definition'}</h3>
        <div class="actions-row">
          <button type="button" data-template-new>New Template</button>
          <button type="button" data-template-save>Save Draft</button>
          <button type="button" data-template-publish>Publish</button>
        </div>
      </div>
      <div class="grid two compact-grid">
        <input data-bind="name" value="${editorState.name}" placeholder="Template name" />
        <select data-bind="status">
          <option value="draft" ${editorState.status === 'draft' ? 'selected' : ''}>draft</option>
          <option value="published" ${editorState.status === 'published' ? 'selected' : ''}>published</option>
        </select>
      </div>
      <textarea data-bind="description" placeholder="Template description">${editorState.description || ''}</textarea>
      <div class="stack gap-md">
        ${editorState.sections.map((section, sectionIndex) => `
          <div class="item stack gap-sm">
            <div class="row between">
              <strong>Section ${sectionIndex + 1}</strong>
              <div class="actions-row">
                <button type="button" data-field-add="${sectionIndex}">Add Field</button>
                <button type="button" data-section-remove="${sectionIndex}">Remove Section</button>
              </div>
            </div>
            <div class="grid two compact-grid">
              <input data-bind="sections.${sectionIndex}.title" value="${section.title || ''}" placeholder="Section title" />
              <input data-bind="sections.${sectionIndex}.repeatableGroup" value="${section.repeatableGroup || ''}" placeholder="Repeatable group key (optional)" />
            </div>
            <textarea data-bind="sections.${sectionIndex}.description" placeholder="Section description">${section.description || ''}</textarea>
            <label class="row"><input type="checkbox" data-bind="sections.${sectionIndex}.repeatable" ${section.repeatable ? 'checked' : ''} /> Repeatable group section</label>
            <div class="stack gap-sm">
              ${section.fields.map((field, fieldIndex) => renderFieldEditor(sectionIndex, field, fieldIndex)).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      <button type="button" data-section-add>Add Section</button>
    `;

    editorRoot.querySelectorAll('[data-bind]').forEach((input) => {
      input.addEventListener('input', () => {
        const bindPath = input.dataset.bind;
        const value = input.type === 'checkbox' ? input.checked : input.value;
        pathSet(bindPath, value);
      });
    });

    editorRoot.querySelector('[data-section-add]').addEventListener('click', () => {
      editorState.sections.push(sectionTemplate());
      renderEditor();
    });
    editorRoot.querySelector('[data-template-new]').addEventListener('click', () => {
      Object.assign(editorState, getEditorState());
      renderEditor();
    });
    editorRoot.querySelector('[data-template-save]').addEventListener('click', async () => {
      const payload = buildTemplatePayload({ ...editorState, status: 'draft' });
      if (editorState.id) {
        await api(`/api/forms/templates/${editorState.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        const created = await api('/api/forms/templates', { method: 'POST', body: JSON.stringify(payload) });
        editorState.id = created.id;
      }
      await renderForms();
    });
    editorRoot.querySelector('[data-template-publish]').addEventListener('click', async () => {
      const payload = buildTemplatePayload({ ...editorState, status: 'published' });
      let templateId = editorState.id;
      if (!templateId) {
        const created = await api('/api/forms/templates', { method: 'POST', body: JSON.stringify(payload) });
        templateId = created.id;
      } else {
        await api(`/api/forms/templates/${templateId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      await api(`/api/forms/templates/${templateId}/publish`, { method: 'POST' });
      await renderForms();
    });

    editorRoot.querySelectorAll('[data-section-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        editorState.sections.splice(Number(button.dataset.sectionRemove), 1);
        if (!editorState.sections.length) editorState.sections.push(sectionTemplate());
        renderEditor();
      });
    });
    editorRoot.querySelectorAll('[data-field-add]').forEach((button) => {
      button.addEventListener('click', () => {
        editorState.sections[Number(button.dataset.fieldAdd)].fields.push(fieldTemplate());
        renderEditor();
      });
    });
    editorRoot.querySelectorAll('[data-field-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const [sectionIndex, fieldIndex] = button.dataset.fieldRemove.split(':').map(Number);
        editorState.sections[sectionIndex].fields.splice(fieldIndex, 1);
        if (!editorState.sections[sectionIndex].fields.length) editorState.sections[sectionIndex].fields.push(fieldTemplate());
        renderEditor();
      });
    });
  }

  document.querySelectorAll('[data-template-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      Object.assign(editorState, getEditorState(templates.find((template) => template.id === button.dataset.templateEdit)));
      renderEditor();
    });
  });

  renderEditor();
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
  await api('/api/forms/templates', { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(form.entries()), status: 'draft', sections: [] }) });
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
