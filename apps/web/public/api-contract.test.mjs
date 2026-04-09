import test from 'node:test'
import assert from 'node:assert/strict'
import { routes } from './api-contract.js'

test('template builder routes expose auto-build and publish workflow endpoints', () => {
  assert.equal(routes.documentTemplates(), '/api/templates')
  assert.equal(routes.documentTemplateAutoBuild(), '/api/templates/auto-build')
  assert.equal(routes.documentTemplateMappings('tpl-1'), '/api/templates/tpl-1/mappings')
  assert.equal(routes.documentTemplateMappingsPreview('tpl-1'), '/api/templates/tpl-1/mappings/preview')
  assert.equal(routes.documentTemplatePublish('tpl-1'), '/api/templates/tpl-1/publish')
  assert.equal(routes.documentTemplateVersions('tpl-1'), '/api/templates/tpl-1/versions')
  assert.equal(routes.documentTemplatePublishTransitions('tpl-1'), '/api/templates/tpl-1/publish-transitions')
  assert.equal(routes.documentTemplateCompare('tpl-1', { baseVersion: 1, targetVersion: 2 }), '/api/templates/tpl-1/compare?baseVersion=1&targetVersion=2')
  assert.equal(routes.documentTemplateRevert('tpl-1'), '/api/templates/tpl-1/revert')
})
