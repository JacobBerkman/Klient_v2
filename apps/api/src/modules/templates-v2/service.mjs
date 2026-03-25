function toLegacyDocument(template) {
  return {
    id: template.id,
    firmId: template.firmId,
    name: template.name,
    fileName: template.documentMetadata?.fileName || 'template.pdf',
    blueprint: template.blueprint || { sections: [] },
    mappings: template.mappings || [],
    versions: template.versions || [],
    status: template.publishState || 'draft',
    publishState: template.publishState || 'draft',
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  }
}

function toLegacyForm(template) {
  return {
    id: template.id,
    firmId: template.firmId,
    name: template.name,
    description: template.description || '',
    sections: template.formSchema?.sections || [],
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
        formSchema: { sections: input.sections || [] }
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
