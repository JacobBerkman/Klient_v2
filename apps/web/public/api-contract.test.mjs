import test from 'node:test'
import assert from 'node:assert/strict'
import { routes } from './api-contract.js'

test('profile custom field schema route helpers expose collection + item paths', () => {
  assert.equal(routes.profileCustomFieldSchema(), '/api/profiles/custom-fields/schema')
  assert.equal(routes.profileCustomFieldSchemaField('risk_tolerance'), '/api/profiles/custom-fields/schema/risk_tolerance')
})
