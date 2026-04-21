import { assert, createTestContext } from './test-harness.mjs'
import { PDFDocument } from 'pdf-lib'

async function createTemplateIngestionPdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  form.createTextField('client_name').addToPage(page, { x: 72, y: 700, width: 240, height: 24 })
  form.createTextField('dependent_1_name').addToPage(page, { x: 72, y: 660, width: 240, height: 24 })
  form.createTextField('dependent_2_name').addToPage(page, { x: 72, y: 620, width: 240, height: 24 })
  return pdf.save()
}

const context = await createTestContext('templates')

try {
  await context.login('admin@demo.test', 'ChangeMe123!', 'admin')
  const headers = context.authHeaders('admin')

  const sourcePdf = await createTemplateIngestionPdf()
  const generated = await context.requestAs('admin', '/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'PDF Auto Generated Intake',
      fileName: 'pdf-auto-generated-intake.pdf',
      fileBytes: Array.from(sourcePdf)
    })
  })
  const formTemplatesAfterAutoBuild = await context.requestAs('admin', '/api/forms/templates', { headers })
  const generatedForm = formTemplatesAfterAutoBuild.find((entry) => entry.id === generated.linkedFormTemplateId)
  assert(generated.extraction?.status === 'success', 'PDF auto-build should report successful extraction')
  assert(
    Array.isArray(generated.extraction?.fields) && generated.extraction.fields.length >= 3,
    'PDF extracted fields missing'
  )
  assert(generated.sourceArtifact?.objectKey, 'PDF auto-build should persist source artifact metadata')
  assert(generated.linkedFormTemplateId, 'PDF auto-build should create a linked form template')
  assert(
    generatedForm?.generatedFromDocumentTemplateId === generated.id,
    'Linked generated form should reference document template'
  )
  assert(
    generatedForm?.sections?.some((section) => section.repeatable === true),
    'Indexed PDF fields should generate a repeatable form section'
  )
  assert(
    Number(
      generated.autoBuildSummary?.repeatableSectionCount ||
        generatedForm?.generation?.summary?.repeatableSectionCount ||
        0
    ) >= 1,
    'PDF auto-build summary should include repeatable section count'
  )

  const template = await context.requestAs('admin', '/api/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Estate Intake',
      fileName: 'estate-intake.pdf',
      blueprint: { sections: [{ title: 'Client', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  })

  const mapped = await context.requestAs('admin', `/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mappings: [{ key: 'client.address.city', source: 'profile.address.city' }] })
  })
  const guardedPublishError = await context.requestExpectErrorAs(
    'admin',
    `/api/templates/${template.id}/publish`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        versionBump: '1.0.0',
        changelog: 'Guard should block publish',
        enforceKnownSourcePaths: true
      })
    },
    400
  )

  const previewProfile = await context.requestAs('admin', '/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'client',
      firstName: 'Template',
      lastName: 'Preview',
      email: `preview-${Date.now()}@demo.test`
    })
  })
  const previewFormTemplate = await context.requestAs('admin', '/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Template Mapping Assist Form',
      sections: [{ key: 'goal', label: 'Goal', type: 'text' }]
    })
  })
  const previewSubmission = await context.requestAs('admin', '/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: previewProfile.id,
      templateId: previewFormTemplate.id,
      status: 'submitted',
      data: { goal: 'Assist mapping suggestions' }
    })
  })

  await context.requestAs('admin', `/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mappings: [{ pdfField: 'client_name', sourcePath: 'profile.first_name_typo' }],
      requiredPdfFields: ['client_name']
    })
  })
  const suggestionPreview = await context.requestAs('admin', `/api/templates/${template.id}/mappings/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: previewProfile.id, submissionId: previewSubmission.id })
  })
  const suggestedPath = suggestionPreview.issues?.[0]?.suggestedSourcePaths?.[0]?.path || 'profile.firstName'
  const suggestedMappingsUpdate = await context.requestAs('admin', `/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mappings: [{ pdfField: 'client_name', sourcePath: suggestedPath }],
      requiredPdfFields: ['client_name']
    })
  })
  const preflightSuccess = await context.requestAs('admin', `/api/templates/${template.id}/mappings/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: previewProfile.id, submissionId: previewSubmission.id })
  })

  const published = await context.requestAs('admin', `/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Initial publication' })
  })

  const versions = await context.requestAs('admin', `/api/templates/${template.id}/versions`, {
    headers
  })
  const transitions = await context.requestAs('admin', `/api/templates/${template.id}/publish-transitions`, {
    headers
  })
  const compared = await context.requestAs(
    'admin',
    `/api/templates/${template.id}/compare?baseVersion=1&targetVersion=2`,
    {
      headers
    }
  )
  const reverted = await context.requestAs('admin', `/api/templates/${template.id}/revert`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ targetVersion: 1, changelog: 'Rollback for deterministic check' })
  })
  const templates = await context.requestAs('admin', '/api/templates', { headers })

  assert(mapped.mappings.length === 1, 'Template mappings update failed')
  assert(
    suggestionPreview.issues?.[0]?.code === 'unknown_source_path',
    'Suggestion preview should flag unknown source path'
  )
  assert(
    Array.isArray(suggestionPreview.issues?.[0]?.suggestedSourcePaths),
    'Suggestion preview should include suggested source paths'
  )
  assert(
    suggestionPreview.issues?.[0]?.action?.field === 'sourcePath',
    'Suggestion preview should include actionable issue metadata'
  )
  assert(
    suggestionPreview.publishReadiness?.summary?.status === 'blocked',
    'Suggestion preview readiness should be blocked'
  )
  assert(
    Number(suggestionPreview.publishReadiness?.summary?.missingMappingsCount || 0) >= 1,
    'Suggestion preview readiness should count missing mappings'
  )
  assert(
    suggestionPreview.publishReadiness?.quickLinks?.[0]?.anchor === '#mapping-row-0',
    'Suggestion preview readiness should provide quick-link anchors'
  )
  assert(
    suggestedMappingsUpdate.mappings?.[0]?.sourcePath === suggestedPath,
    'Suggestion-assisted mapping update failed'
  )
  assert(
    !Array.isArray(preflightSuccess.issues) || preflightSuccess.issues.length === 0,
    'Publish preflight should pass after suggestion-assisted mapping update'
  )
  assert(
    preflightSuccess.publishReadiness?.summary?.status === 'ready',
    'Publish preflight readiness should be ready after remediation'
  )
  assert(
    preflightSuccess.publishReadiness?.summary?.blockersCount === 0,
    'Publish preflight readiness blockers should be zero after remediation'
  )
  assert(
    guardedPublishError.error?.code === 'SCHEMA_VALIDATION_FAILED',
    'Publish guard should reject unknown mapping path'
  )
  assert(Array.isArray(guardedPublishError.error?.details?.issues), 'Publish guard should return detailed issues array')
  assert(
    guardedPublishError.error?.details?.issues?.[0]?.code === 'unknown_source_path',
    'Publish guard issue code mismatch'
  )
  assert(guardedPublishError.error?.details?.issues?.[0]?.field === 'sourcePath', 'Publish guard issue field mismatch')
  assert(
    guardedPublishError.error?.details?.issues?.[0]?.meta?.issueId,
    'Publish guard issue metadata missing stable issueId'
  )
  assert(published.status === 'published', 'Template publish failed')
  assert(
    templates.some((entry) => entry.id === template.id && entry.status === 'draft'),
    'Reverted template missing'
  )
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

  const readonlyEmail = 'readonly.templates@demo.test'
  const readonlyInvite = await context.requestAs('admin', '/api/invites', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: readonlyEmail, role: 'readonly' })
  })
  const readonlyAccepted = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: readonlyInvite.token,
      firstName: 'Read',
      lastName: 'Only',
      password: 'ReadonlyPass123!'
    })
  })

  await context.login(readonlyAccepted.user.email, 'ReadonlyPass123!', 'readonly')
  const readonlyVersions = await context.requestAs('readonly', `/api/templates/${template.id}/versions`, {
    headers: context.authHeaders('readonly')
  })
  const readonlyTransitions = await context.requestAs('readonly', `/api/templates/${template.id}/publish-transitions`, {
    headers: context.authHeaders('readonly')
  })
  assert(Array.isArray(readonlyVersions) && readonlyVersions.length >= 3, 'Readonly role cannot read template versions')
  assert(
    readonlyTransitions.some((entry) => entry.from === 'draft' && entry.to === 'published'),
    'Readonly role cannot read publish transitions'
  )

  const outsider = await context.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firmName: 'Firm Isolation Templates',
      firstName: 'Other',
      lastName: 'Admin',
      email: `outside.templates.${Date.now()}@demo.test`,
      password: 'OutsidePass123!'
    })
  })
  await context.login(outsider.user.email, 'OutsidePass123!', 'outsider')
  await context.requestExpectErrorAs(
    'outsider',
    `/api/templates/${template.id}/versions`,
    { headers: context.authHeaders('outsider') },
    [400, 404]
  )
  await context.requestExpectErrorAs(
    'outsider',
    `/api/templates/${template.id}/publish-transitions`,
    { headers: context.authHeaders('outsider') },
    [400, 404]
  )

  console.log(
    JSON.stringify(
      {
        suite: 'integration-templates',
        templateId: template.id,
        status: published.status,
        versionCount: versions.length,
        readonlyVersionCount: readonlyVersions.length,
        preflightSuccess: !Array.isArray(preflightSuccess.issues) || preflightSuccess.issues.length === 0
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
