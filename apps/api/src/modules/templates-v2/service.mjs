function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function normalizeExtraction(extraction = {}) {
  return {
    status: extraction?.status === 'failed' ? 'failed' : 'completed',
    reasonCode: extraction?.reasonCode || null,
    error: extraction?.error || null,
    diagnostics: Array.isArray(extraction?.diagnostics) ? clone(extraction.diagnostics) : [],
    fields: Array.isArray(extraction?.fields) ? clone(extraction.fields) : []
  }
}

function toLegacyDocument(template) {
  const documentMetadata = clone(template.documentMetadata || { fileName: template.fileName || 'template.pdf' })
  const sourceArtifact = clone(template.sourceArtifact || template.documentMetadata?.sourceArtifact || null)
  const extraction = normalizeExtraction(template.extraction || {})
  return {
    id: template.id,
    firmId: template.firmId,
    name: template.name,
    description: template.description || '',
    fileName: template.documentMetadata?.fileName || 'template.pdf',
    documentMetadata,
    blueprint: clone(template.blueprint || { sections: [] }),
    mappings: clone(template.mappings || []),
    mappingRules: clone(template.mappingRules || template.mappings || []),
    versions: clone(template.versions || []),
    status: template.publishState || 'draft',
    publishState: template.publishState || 'draft',
    extractedFields: clone(template.extractedFields || extraction.fields || []),
    extraction,
    sourceArtifact,
    linkedFormTemplateId: template.linkedFormTemplateId || template.autoBuildSummary?.linkedFormTemplateId || null,
    autoBuildSummary: clone(template.autoBuildSummary || null),
    exportReadiness: clone(template.exportReadiness || null),
    pdfLayout: clone(template.pdfLayout || null),
    versionHash: template.versionHash || null,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  }
}

function toLegacyForm(template) {
  const formSchema = clone(template.formSchema || { sections: template.sections || [] })
  return {
    id: template.id,
    firmId: template.firmId,
    name: template.name,
    description: template.description || '',
    formSchema,
    sections: clone(formSchema.sections || []),
    generatedFromDocumentTemplateId: template.generatedFromDocumentTemplateId || null,
    generation: clone(template.generation || null),
    status: template.publishState || 'draft',
    publishState: template.publishState || 'draft',
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  }
}

export function createTemplatesV2Service({ templatesV2Repository, policy }) {
  return {
    listDocuments(user) {
      policy.requireGuard(user, 'canReadTemplate')
      return templatesV2Repository.listCanonicalTemplates(user, { kind: 'document' }).map(toLegacyDocument)
    },
    listForms(user) {
      policy.requireGuard(user, 'canReadForms')
      return templatesV2Repository.listCanonicalTemplates(user, { kind: 'form' }).map(toLegacyForm)
    },
    createDocument(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      const created = templatesV2Repository.createCanonicalTemplate(user, {
        kind: 'document',
        name: input.name,
        description: input.description || '',
        documentMetadata: { fileName: input.fileName || 'template.pdf' },
        blueprint: input.blueprint || { sections: [] },
        mappings: input.mappings || [],
        extractedFields: input.extractedFields || []
      })
      return toLegacyDocument(created)
    },
    createForm(user, input) {
      policy.requireGuard(user, 'canWriteForms')
      const created = templatesV2Repository.createCanonicalTemplate(user, {
        kind: 'form',
        name: input.name,
        description: input.description || '',
        formSchema: input.formSchema || { sections: input.sections || [] },
        generatedFromDocumentTemplateId: input.generatedFromDocumentTemplateId || null,
        generation: input.generation || null
      })
      return toLegacyForm(created)
    },
    updateDocumentMappings(user, templateId, mappings) {
      policy.requireGuard(user, 'canEditTemplate')
      const updated = templatesV2Repository.updateCanonicalTemplate(user, templateId, { mappings: mappings || [] })
      return toLegacyDocument(updated)
    },
    publishDocument(user, templateId) {
      policy.requireGuard(user, 'canPublishTemplate')
      const updated = templatesV2Repository.transitionLifecycle(user, templateId, 'published')
      return toLegacyDocument(updated)
    },
    archiveDocument(user, templateId) {
      policy.requireGuard(user, 'canPublishTemplate')
      const updated = templatesV2Repository.transitionLifecycle(user, templateId, 'archived')
      return toLegacyDocument(updated)
    }
  }
}
