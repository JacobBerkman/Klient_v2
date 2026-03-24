import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const port = 3011;
const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${path}: ${payload.message || 'Request failed'}`);
  }
  return payload;
}

async function run() {
  await wait(700);
  const login = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const headers = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };

  const autoBuilt = await jsonFetch('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Blueprint QA Template',
      fileName: 'qa-template.pdf',
      pdfFields: [
        'client.first_name',
        'client.last_name',
        'household.address_line_1',
        'asset_1_name',
        'asset_2_name',
        'asset_1_value',
        'asset_2_value'
      ]
    })
  });

  assert.equal(autoBuilt.status, 'in_review');
  assert.ok(autoBuilt.blueprint?.sections?.length >= 2);
  assert.ok((autoBuilt.blueprint?.repeatableGroups || []).length >= 1);
  assert.ok((autoBuilt.mappings || []).length >= 4);
  assert.ok((autoBuilt.extractedFields || []).length >= 6);
  assert.equal(autoBuilt.versions.at(-1)?.source, 'auto_build');

  const firstSection = autoBuilt.blueprint.sections[0];
  firstSection.fields.push({
    key: 'compliance_review_note',
    label: 'Compliance Review Note',
    type: 'text',
    order: firstSection.fields.length + 1,
    pdfFieldName: 'compliance_review_note'
  });

  const reviewed = await jsonFetch(`/api/templates/${autoBuilt.id}/blueprint`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ blueprint: autoBuilt.blueprint })
  });
  assert.equal(reviewed.status, 'in_review');
  assert.equal(reviewed.versions.at(-1)?.source, 'manual_edit');

  const approved = await jsonFetch(`/api/templates/${autoBuilt.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` }
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.versions.at(-1)?.status, 'approved');
  assert.ok(approved.versions.length >= 3);

  const templates = await jsonFetch('/api/templates', { headers: { Authorization: `Bearer ${login.token}` } });
  const canonical = templates.find((entry) => entry.id === autoBuilt.id);
  assert.ok(canonical, 'template should exist in canonical model');
  assert.equal(canonical.status, 'approved');

  const appJs = await readFile(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const indexHtml = await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  assert.ok(appJs.includes('data-approve-template'), 'templates UI should include approval affordance');
  assert.ok(appJs.includes('data-add-review-field'), 'templates UI should include review edit affordance');
  assert.ok(indexHtml.includes('id="auto-build-form"'), 'index should expose auto build form');

  console.log(JSON.stringify({
    autoBuiltTemplateId: autoBuilt.id,
    sectionCount: autoBuilt.blueprint.sections.length,
    repeatableGroupCount: autoBuilt.blueprint.repeatableGroups.length,
    versionCount: approved.versions.length,
    status: approved.status
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
