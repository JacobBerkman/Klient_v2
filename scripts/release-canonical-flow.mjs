import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { assert, createTestContext } from './test-harness.mjs'

const workerScript = resolve(new URL('./export-worker.mjs', import.meta.url).pathname)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function runWorkerTick(context) {
  const result = spawnSync(process.execPath, [workerScript], {
    cwd: context.testCwd,
    env: {
      ...process.env,
      EXPORT_WORKER_ONCE: '1',
      EXPORT_WORKER_POLL_MS: '25',
      EXPORT_WORKER_LEASE_MS: '5000',
      EXPORT_WORKER_BATCH_SIZE: '10',
      NODE_ENV: 'test',
      ALLOW_DEV_FALLBACK_APP_SECRET: 'true'
    },
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`Export worker tick failed (${result.status}): ${result.stderr || result.stdout}`)
  }
}

const steps = []

async function runStep(name, fn) {
  const startedAt = Date.now()
  try {
    const details = await fn()
    steps.push({ name, status: 'passed', durationMs: Date.now() - startedAt, details: details || null })
    return details
  } catch (error) {
    const details = { error: error?.message || String(error) }
    steps.push({ name, status: 'failed', durationMs: Date.now() - startedAt, details })
    throw new Error(`[release-flow] ${name} failed: ${details.error}`)
  }
}

function summarizeAndExit(error = null) {
  const passed = steps.filter((step) => step.status === 'passed').length
  const failed = steps.filter((step) => step.status === 'failed').length
  const summary = {
    flow: 'canonical-release-readiness',
    status: error ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(),
    checks: {
      total: steps.length,
      passed,
      failed
    },
    steps
  }

  if (error) {
    summary.failure = {
      message: error?.message || String(error)
    }
  }

  console.log(JSON.stringify(summary, null, 2))

  if (error) {
    process.exitCode = 1
  }
}

async function main() {
  const context = await createTestContext('release-canonical-flow')

  try {
    let advisorHeaders = null
    let activeProfile = null

    await runStep('login/session init', async () => {
      await context.login()
      advisorHeaders = context.authHeaders()
      assert(Boolean(context.sessionCookie), 'Expected session cookie after login.')
      return { sessionCookieReady: true }
    })

    await runStep('create or load profile', async () => {
      const created = await context.request('/api/profiles', {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({
          kind: 'prospect',
          firstName: 'Release',
          lastName: 'Candidate',
          email: `release.candidate+${Date.now()}@example.com`
        })
      })
      activeProfile = created
      assert(Boolean(activeProfile?.id), 'Expected profile id from create profile API.')
      return { profileId: activeProfile.id, initialKind: activeProfile.kind }
    })

    await runStep('toggle prospect/client', async () => {
      const toggledToClient = await context.request(`/api/profiles/${activeProfile.id}`, {
        method: 'PATCH',
        headers: advisorHeaders,
        body: JSON.stringify({ kind: 'client' })
      })
      assert(toggledToClient.kind === 'client', 'Expected profile kind to toggle to client.')

      const toggledBack = await context.request(`/api/profiles/${activeProfile.id}`, {
        method: 'PATCH',
        headers: advisorHeaders,
        body: JSON.stringify({ kind: 'prospect' })
      })
      assert(toggledBack.kind === 'prospect', 'Expected profile kind to toggle back to prospect.')

      return { profileId: activeProfile.id, toggledKinds: ['client', 'prospect'] }
    })

    await runStep('move stage on pipeline board', async () => {
      const moved = await context.request(`/api/profiles/${activeProfile.id}/stage`, {
        method: 'PATCH',
        headers: advisorHeaders,
        body: JSON.stringify({ stage: 'analysis' })
      })
      assert(moved?.moved?.stage === 'analysis', 'Expected pipeline stage move to persist.')
      return { profileId: activeProfile.id, stage: moved.moved.stage }
    })

    await runStep('create or update household', async () => {
      const household = await context.request('/api/households', {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({ name: 'Release Readiness Household', primaryClientId: activeProfile.id })
      })
      assert(Boolean(household?.id), 'Expected household id.')

      const profileAfterLink = await context.request(`/api/profiles/${activeProfile.id}`, { headers: advisorHeaders })
      assert(profileAfterLink?.profile?.householdId === household.id, 'Expected profile household link to be persisted.')

      return { householdId: household.id, primaryClientId: activeProfile.id }
    })

    const flowData = await runStep('run form/template flow', async () => {
      const formTemplate = await context.request('/api/forms/templates', {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({
          name: 'Release Canonical Intake',
          sections: [
            {
              title: 'Client Goals',
              fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text', required: true }]
            }
          ]
        })
      })
      const submission = await context.request('/api/forms/submissions', {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({
          clientId: activeProfile.id,
          templateId: formTemplate.id,
          status: 'submitted',
          data: { primaryGoal: 'Deployment readiness proof' }
        })
      })
      const exportTemplate = await context.request('/api/templates/auto-build', {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({ name: 'Release Canonical Export Template', fields: ['client.name', 'client.email'] })
      })
      await context.request(`/api/templates/${exportTemplate.id}/publish`, {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Canonical release flow proof template.' })
      })

      return {
        formTemplateId: formTemplate.id,
        submissionId: submission.id,
        exportTemplateId: exportTemplate.id
      }
    })

    const exportJob = await runStep('trigger export', async () => {
      const created = await context.request('/api/exports', {
        method: 'POST',
        headers: advisorHeaders,
        body: JSON.stringify({
          clientId: activeProfile.id,
          submissionId: flowData.submissionId,
          templateId: flowData.exportTemplateId,
          type: 'pdf'
        })
      })
      assert(Boolean(created?.id), 'Expected export job id from create export API.')
      return { exportJobId: created.id }
    })

    await runStep('verify export artifact is ready and retrievable', async () => {
      let settled = null
      for (let attempt = 0; attempt < 40; attempt += 1) {
        runWorkerTick(context)
        const list = await context.request('/api/exports?sort=updatedAt_desc', { headers: advisorHeaders })
        settled = list.find((entry) => entry.id === exportJob.exportJobId) || null
        if (settled?.status === 'completed') break
        await wait(100)
      }

      assert(settled?.status === 'completed', 'Expected export job to reach completed status.')
      assert(settled?.artifactAvailable === true, 'Expected completed export to report artifactAvailable=true.')
      assert(settled?.artifactReady === true, 'Expected completed export to report artifactReady=true.')

      const download = await context.rawRequest(`/api/exports/${exportJob.exportJobId}/download`, {
        headers: { Cookie: context.sessionCookie }
      })
      const contentType = download.headers.get('content-type') || ''
      const disposition = download.headers.get('content-disposition') || ''
      const bytes = (await download.arrayBuffer()).byteLength
      assert(download.status === 200, 'Expected export download endpoint to return HTTP 200.')
      assert(contentType.includes('application/pdf'), 'Expected export download content type to be application/pdf.')
      assert(disposition.includes('.pdf'), 'Expected export download filename to have .pdf extension.')
      assert(bytes > 0, 'Expected export download payload to contain bytes.')

      return { exportJobId: exportJob.exportJobId, downloadedBytes: bytes }
    })
  } finally {
    await context.shutdown()
  }
}

main()
  .then(() => summarizeAndExit(null))
  .catch((error) => summarizeAndExit(error))
