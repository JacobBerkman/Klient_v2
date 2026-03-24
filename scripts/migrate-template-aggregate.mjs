import { backupState, loadState, saveState } from '../apps/api/src/storage.mjs';

function toKey(item) {
  return JSON.stringify(item ?? null);
}

function makeVersions(template, createdAtFallback) {
  const versions = template.versions || [];
  if (versions.length > 0) return versions;
  return [{
    version: 1,
    event: 'created',
    blueprint: template.blueprint || { sections: [] },
    mappings: template.mappings || [],
    formSchema: template.formSchema || { sections: template.sections || [] },
    publishState: template.publishState || template.status || 'draft',
    createdAt: template.createdAt || createdAtFallback
  }];
}

function normalize(entry, kind) {
  const createdAt = entry.createdAt || new Date().toISOString();
  const mappings = entry.mappings || entry.mappingRules || [];
  return {
    id: entry.id,
    firmId: entry.firmId,
    kind,
    name: entry.name,
    description: entry.description || '',
    documentMetadata: { fileName: entry.fileName || null },
    extractedFields: entry.extractedFields || [],
    formSchema: entry.formSchema || { sections: entry.sections || [] },
    blueprint: entry.blueprint || { sections: [] },
    mappings,
    mappingRules: mappings,
    publishState: entry.publishState || entry.status || 'draft',
    status: entry.publishState || entry.status || 'draft',
    versions: makeVersions(entry, createdAt),
    publishTransitions: entry.publishTransitions || [],
    createdAt,
    updatedAt: entry.updatedAt || createdAt,
    legacy: entry.legacy || null
  };
}

function migrate(state) {
  if (Array.isArray(state.templateAggregates) && state.templateAggregates.length > 0) {
    return {
      migrated: false,
      reason: 'templateAggregates already present',
      templateAggregateCount: state.templateAggregates.length
    };
  }
  const formTemplates = (state.formTemplates || []).map((template) => normalize({
    ...template,
    blueprint: { sections: [] },
    mappings: [],
    publishState: 'draft',
    legacy: { source: 'formTemplates', id: template.id }
  }, 'form'));
  const documentTemplates = (state.documentTemplates || []).map((template) => normalize({
    ...template,
    legacy: { source: 'documentTemplates', id: template.id }
  }, 'document'));
  state.templateAggregates = [...formTemplates, ...documentTemplates];
  return {
    migrated: true,
    formTemplateCount: formTemplates.length,
    documentTemplateCount: documentTemplates.length,
    templateAggregateCount: state.templateAggregates.length,
    checksum: toKey(state.templateAggregates.map((entry) => entry.id).sort())
  };
}

const backup = backupState();
const state = loadState(() => ({}));
const result = migrate(state);
if (result.migrated) saveState(state);

console.log(JSON.stringify({ backup, ...result }, null, 2));
