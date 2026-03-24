import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateTemplateState, normalizeFormDefinition } from '../store.mjs';

test('normalizeFormDefinition builds canonical sections, fields, repeatable groups, validation, and conditional metadata', () => {
  const definition = normalizeFormDefinition(null, [
    {
      title: 'Household Goals',
      helpText: 'Tell us the why',
      fields: [
        { key: 'goal', label: 'Primary Goal', type: 'text', placeholder: 'Retire by 60', validation: { required: true, minLength: 3 } }
      ]
    },
    {
      title: 'Accounts',
      repeatable: true,
      groupKey: 'accounts',
      groupLabel: 'Account List',
      fields: [
        { key: 'institution', label: 'Institution', type: 'text', conditionalLogic: { dependsOn: ['goal'], expression: 'goal != ""' } },
        { key: 'balance', label: 'Balance', type: 'number', validation: { min: 0 } }
      ]
    }
  ]);

  assert.equal(definition.schemaVersion, 1);
  assert.equal(definition.sections.length, 2);
  assert.equal(definition.fields.length, 3);
  assert.equal(definition.repeatableGroups.length, 1);

  const goalField = definition.fields.find((field) => field.key === 'goal');
  assert.equal(goalField.validation.required, true);
  assert.equal(goalField.validation.minLength, 3);
  assert.equal(goalField.placeholder, 'Retire by 60');

  const institution = definition.fields.find((field) => field.key === 'institution');
  assert.equal(institution.repeatableGroupId, definition.repeatableGroups[0].id);
  assert.deepEqual(institution.conditionalLogic.dependsOn, ['goal']);
});

test('migrateTemplateState upgrades legacy manual and pdf-derived templates with version/publish metadata', () => {
  const state = {
    formTemplates: [
      {
        id: 'form-1',
        firmId: 'firm-1',
        name: 'Legacy Form',
        sections: [{ title: 'Intro', fields: [{ key: 'name', label: 'Name', type: 'text' }] }],
        createdAt: '2026-03-20T00:00:00.000Z',
        updatedAt: '2026-03-20T00:00:00.000Z'
      }
    ],
    documentTemplates: [
      {
        id: 'doc-1',
        firmId: 'firm-1',
        name: 'Legacy PDF',
        status: 'published',
        mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }],
        blueprint: {
          sections: [{ title: 'Client', fields: [{ key: 'client_name', label: 'Client Name', type: 'text' }] }]
        },
        versions: [{ version: 1, blueprint: { sections: [{ title: 'Client', fields: [{ key: 'client_name', label: 'Client Name', type: 'text' }] }] }, mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }], createdAt: '2026-03-20T00:00:00.000Z' }],
        createdAt: '2026-03-20T00:00:00.000Z',
        updatedAt: '2026-03-20T00:00:00.000Z'
      }
    ]
  };

  const migrated = migrateTemplateState(state);

  assert.equal(migrated.formTemplates[0].formDefinition.schemaVersion, 1);
  assert.equal(migrated.formTemplates[0].versions.length, 1);
  assert.equal(migrated.formTemplates[0].versions[0].versionNumber, 1);

  assert.equal(migrated.documentTemplates[0].status, 'published');
  assert.ok(migrated.documentTemplates[0].publishedVersionId);
  assert.equal(migrated.documentTemplates[0].versions[0].sourceKind, 'pdf-derived');
  assert.equal(migrated.documentTemplates[0].formDefinition.fields[0].key, 'client_name');
});
