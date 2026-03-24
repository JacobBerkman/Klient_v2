import { spawn } from 'node:child_process';

const port = 3011;
const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: '.data-version-test' },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path}: ${data.message || 'Request failed'}`);
  }
  return data;
}

async function run() {
  await wait(700);
  await jsonFetch('/ready');

  const login = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

  const formTemplate = await jsonFetch('/api/forms/templates', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Risk Profile',
      description: 'Initial form definition',
      sections: [{ title: 'Profile', fields: [{ key: 'riskTolerance', label: 'Risk tolerance', type: 'select', options: ['Low', 'High'] }] }]
    })
  });

  await jsonFetch(`/api/forms/templates/${formTemplate.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ description: 'Edited draft', sections: [{ title: 'Profile', fields: [{ key: 'riskTolerance', label: 'Risk tolerance', type: 'select', options: ['Low', 'Medium', 'High'] }] }] })
  });

  const publishedForm = await jsonFetch(`/api/forms/templates/${formTemplate.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` }
  });

  const formVersions = await jsonFetch(`/api/forms/templates/${formTemplate.id}/versions`, {
    headers: { Authorization: `Bearer ${login.token}` }
  });

  await jsonFetch(`/api/forms/templates/${formTemplate.id}/versions/1/revert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` }
  });

  const formVersionsAfterRevert = await jsonFetch(`/api/forms/templates/${formTemplate.id}/versions`, {
    headers: { Authorization: `Bearer ${login.token}` }
  });

  const documentTemplate = await jsonFetch('/api/templates', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Plan Summary',
      fileName: 'plan-summary.pdf',
      blueprint: { sections: ['profile'] },
      mappings: [{ pdfField: 'full_name', sourcePath: 'profile.fullName' }]
    })
  });

  await jsonFetch(`/api/templates/${documentTemplate.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ blueprint: { sections: ['profile', 'goals'] }, mappings: [{ pdfField: 'full_name', sourcePath: 'profile.fullName' }, { pdfField: 'goal_1', sourcePath: 'goals.primary' }] })
  });

  await jsonFetch(`/api/templates/${documentTemplate.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` }
  });

  const docVersions = await jsonFetch(`/api/templates/${documentTemplate.id}/versions`, {
    headers: { Authorization: `Bearer ${login.token}` }
  });

  const revertedDocument = await jsonFetch(`/api/templates/${documentTemplate.id}/versions/1/revert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` }
  });

  const docVersionsAfterRevert = await jsonFetch(`/api/templates/${documentTemplate.id}/versions`, {
    headers: { Authorization: `Bearer ${login.token}` }
  });

  if (publishedForm.publishedVersion !== 3) {
    throw new Error(`Expected form published version 3, got ${publishedForm.publishedVersion}`);
  }
  if (formVersions.length < 3 || formVersions[0].status !== 'published') {
    throw new Error('Form versions did not include published revision');
  }
  if (formVersionsAfterRevert[0].revertedFromVersion !== 1) {
    throw new Error('Form revert did not create a safe draft from version 1');
  }
  if (docVersions.length < 3 || docVersions[0].status !== 'published') {
    throw new Error('Document versions did not include published revision');
  }
  if (revertedDocument.status !== 'draft') {
    throw new Error('Document revert should move active template to draft');
  }
  if (docVersionsAfterRevert[0].revertedFromVersion !== 1) {
    throw new Error('Document revert did not create a safe draft from version 1');
  }

  console.log(JSON.stringify({
    formTemplateId: formTemplate.id,
    formVersions: formVersionsAfterRevert.length,
    documentTemplateId: documentTemplate.id,
    documentVersions: docVersionsAfterRevert.length,
    revertedFormVersion: formVersionsAfterRevert[0].version,
    revertedDocumentVersion: docVersionsAfterRevert[0].version
  }, null, 2));
}

run()
  .finally(() => {
    server.kill('SIGTERM');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
