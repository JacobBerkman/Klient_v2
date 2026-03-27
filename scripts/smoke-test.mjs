import { assert, createTestContext } from './test-harness.mjs'
import { createEvidenceRecorder } from './release-evidence.mjs'

const evidence = createEvidenceRecorder({
  gate: 'smoke',
  defaultFile: 'smoke-summary.json',
  envVarName: 'RELEASE_EVIDENCE_SMOKE_FILE',
  command: 'npm run test:smoke'
})

const context = await createTestContext('smoke')

try {
  await context.request('/health')
  const ready = await context.request('/ready')
  assert(ready.status === 'ready', 'Readiness endpoint did not report ready state.')

  const login = await context.login()
  const headers = context.authHeaders(login.token)

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Smoke',
      lastName: 'Path',
      email: `smoke.path+${Date.now()}@example.com`,
      stage: 'discovery'
    })
  })

  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Auto Build Test', fields: ['client.name', 'client.address', 'assets.account'] })
  })

  const publishResult = await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Smoke publish validation' })
  })

  const exportJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })

  await context.request('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } })
  const exportsList = await context.request('/api/exports', { headers: { Authorization: `Bearer ${login.token}` } })

  assert(exportsList.some((entry) => entry.id === exportJob.id), 'Export job missing from export list.')
  assert(publishResult.status === 'published', 'Template publish failed.')

  const summary = {
    ok: true,
    profileId: profile.id,
    templateId: template.id,
    exportJobId: exportJob.id,
    exportStatus: exportsList.find((entry) => entry.id === exportJob.id)?.status
  }

  evidence.finalize({ status: 'passed', details: summary })
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  evidence.finalize({ status: 'failed', error })
  throw error
} finally {
  await context.shutdown()
}
