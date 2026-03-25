import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('templates')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const template = await context.request('/api/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Estate Intake',
      fileName: 'estate-intake.pdf',
      blueprint: { sections: [{ title: 'Client', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  })

  const mapped = await context.request(`/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mappings: [{ key: 'client.address.city', source: 'profile.address.city' }] })
  })

  const published = await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Initial publication' })
  })

  const versions = await context.request(`/api/templates/${template.id}/versions`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const transitions = await context.request(`/api/templates/${template.id}/publish-transitions`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const compared = await context.request(`/api/templates/${template.id}/compare?baseVersion=1&targetVersion=2`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const reverted = await context.request(`/api/templates/${template.id}/revert`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ targetVersion: 1, changelog: 'Rollback for deterministic check' })
  })
  const templates = await context.request('/api/templates', { headers: { Authorization: `Bearer ${admin.token}` } })

  assert(mapped.mappings.length === 1, 'Template mappings update failed')
  assert(published.status === 'published', 'Template publish failed')
  assert(templates.some((entry) => entry.id === template.id && entry.status === 'draft'), 'Reverted template missing')
  assert(Array.isArray(versions) && versions.length >= 3, 'Template versions history missing')
  const mappingVersion = versions.find((entry) => entry.event === 'mappings_updated')
  assert(mappingVersion?.diff?.mappings?.changed === true, 'Template mapping diff missing')
  const publishVersion = versions.find((entry) => entry.event === 'published')
  assert(publishVersion?.diff?.publishTransition?.to === 'published', 'Template publish transition diff missing')
  assert(compared.diff?.mappingsChanged === true, 'Template compare endpoint did not detect mapping change')
  assert(reverted.revertedToVersion === 1, 'Template revert endpoint failed')
  assert(
    Array.isArray(transitions) && transitions.some((entry) => entry.from === 'draft' && entry.to === 'published'),
    'Publish transitions history missing'
  )

  console.log(
    JSON.stringify(
      {
        suite: 'integration-templates',
        templateId: template.id,
        status: published.status,
        versionCount: versions.length
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
