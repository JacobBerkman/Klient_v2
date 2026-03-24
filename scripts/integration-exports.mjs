import { spawn } from 'node:child_process';
import { assert, createTestContext } from './test-harness.mjs';

function runWorkerOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/export-worker.mjs'], {
      env: { ...process.env, EXPORT_WORKER_ONCE: '1', EXPORT_WORKER_BATCH_SIZE: '10', EXPORT_WORKER_POLL_MS: '50' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`worker exit code ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const context = await createTestContext('exports');

try {
  const admin = await context.login();
  const headers = context.authHeaders(admin.token);

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'client', firstName: 'Export', lastName: 'Client', email: `export.client+${Date.now()}@example.com` })
  });
  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Export Template', fields: ['client.name', 'client.email'] })
  });
  await context.request(`/api/templates/${template.id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` } });

  const completedJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  });

  const flakyJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf', metadata: { simulateFailuresRemaining: 1 }, maxAttempts: 3 })
  });

  await runWorkerOnce();
  await context.shutdown();

  const restartContext = await createTestContext('exports-restart');
  const restartAdmin = await restartContext.login();
  await runWorkerOnce();
  const exportsList = await restartContext.request('/api/exports', { headers: { Authorization: `Bearer ${restartAdmin.token}` } });
  const diagnostics = await restartContext.request('/api/ops/diagnostics', { headers: { Authorization: `Bearer ${restartAdmin.token}` } });

  const completed = exportsList.find((entry) => entry.id === completedJob.id);
  const flaky = exportsList.find((entry) => entry.id === flakyJob.id);
  assert(completed?.status === 'completed', 'Expected queued export processing to complete');
  assert(flaky?.status === 'completed', 'Expected retrying export to complete after worker restart');
  assert((flaky?.attempts || 0) >= 1, 'Expected retrying export attempts to increment');
  assert(diagnostics?.data?.queue?.activeLeases >= 0, 'Expected queue lease diagnostics');

  console.log(JSON.stringify({ suite: 'integration-exports', completedId: completedJob.id, flakyId: flakyJob.id, flakyAttempts: flaky.attempts, finalStatus: flaky.status }, null, 2));
  await restartContext.shutdown();
} finally {
  await context.shutdown();
}
