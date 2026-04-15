#!/usr/bin/env node

const baseUrl = String(process.env.LOAD_CHECK_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const sessionCookie = String(process.env.LOAD_CHECK_SESSION_COOKIE || '').trim()
const profileIds = String(process.env.LOAD_CHECK_PROFILE_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const templateId = String(process.env.LOAD_CHECK_TEMPLATE_ID || '').trim()
const clientId = String(process.env.LOAD_CHECK_CLIENT_ID || profileIds[0] || '').trim()
const concurrency = Math.max(1, Number(process.env.LOAD_CHECK_CONCURRENCY || 5))
const exportJobs = Math.max(1, Number(process.env.LOAD_CHECK_EXPORT_JOBS || 8))

function assertConfigured() {
  if (!sessionCookie) throw new Error('LOAD_CHECK_SESSION_COOKIE is required.')
  if (profileIds.length === 0) throw new Error('LOAD_CHECK_PROFILE_IDS must include at least one profile id.')
  if (!templateId) throw new Error('LOAD_CHECK_TEMPLATE_ID is required.')
  if (!clientId) throw new Error('LOAD_CHECK_CLIENT_ID or LOAD_CHECK_PROFILE_IDS is required.')
}

async function readCsrfToken() {
  const response = await fetch(`${baseUrl}/api/csrf`, {
    headers: { cookie: sessionCookie }
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to bootstrap CSRF token (${response.status}): ${text}`)
  }
  const payload = await response.json()
  return payload.csrfToken
}

async function jsonFetch(path, { method = 'GET', body = null, csrfToken = null } = {}) {
  const headers = {
    cookie: sessionCookie,
    origin: baseUrl,
    referer: `${baseUrl}/`
  }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  if (body) headers['content-type'] = 'application/json'

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function runConcurrent(items, worker) {
  const queue = items.slice()
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      await worker(next)
    }
  })
  await Promise.all(runners)
}

async function main() {
  assertConfigured()
  const csrfToken = await readCsrfToken()

  const profileTasks = profileIds.map((profileId, index) => ({ profileId, index }))
  let profileFailures = 0
  await runConcurrent(profileTasks, async ({ profileId, index }) => {
    const { response } = await jsonFetch(`/api/profiles/${profileId}`, {
      method: 'PATCH',
      csrfToken,
      body: { source: `load-check-${index}` }
    })
    if (!response.ok) profileFailures += 1
  })

  const exportTaskEntries = Array.from({ length: exportJobs }, (_, index) => ({ index }))
  let exportFailures = 0
  await runConcurrent(exportTaskEntries, async ({ index }) => {
    const { response } = await jsonFetch('/api/exports', {
      method: 'POST',
      csrfToken,
      body: {
        templateId,
        clientId,
        type: 'pdf',
        metadata: { loadCheck: true, sequence: index }
      }
    })
    if (!response.ok) exportFailures += 1
  })

  const processResult = await jsonFetch('/api/exports/process', { method: 'POST', csrfToken })
  const queueResult = await jsonFetch('/api/ops/exports/queue')

  const output = {
    generatedAt: new Date().toISOString(),
    profileUpdates: { attempted: profileIds.length, failed: profileFailures },
    exports: { attempted: exportJobs, failed: exportFailures },
    processing: { status: processResult.response.status, result: processResult.payload },
    queue: { status: queueResult.response.status, result: queueResult.payload }
  }
  console.log(JSON.stringify(output, null, 2))
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: 'failed',
        message: error?.message || String(error)
      },
      null,
      2
    )
  )
  process.exitCode = 1
})
