import test from 'node:test'
import assert from 'node:assert/strict'

import { validateFormDefinitionSchema } from '../modules/forms/schema/form-definition-validator.mjs'

test('normalizes repeatable section metadata into repeater paths', () => {
  const result = validateFormDefinitionSchema({
    sections: [
      {
        key: 'assets',
        repeatable: true,
        fields: [
          { path: 'name', type: 'text' },
          { path: 'holdings', type: 'repeater', fields: [{ path: 'ticker', type: 'text' }] }
        ]
      }
    ]
  })

  assert.ok(result.repeaterPaths.has('assets'))
  assert.ok(result.repeaterPaths.has('assets.holdings'))
})

test('repeatable section requires key/path/id metadata', () => {
  assert.throws(
    () =>
      validateFormDefinitionSchema({
        sections: [{ repeatable: true, fields: [{ path: 'name', type: 'text' }] }]
      }),
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.match(JSON.stringify(error.details?.issues || []), /Repeatable sections require key\/path\/id metadata\./)
      return true
    }
  )
})
