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

// --- visibleIf (conditional field) validation ------------------------------

function assertVisibleIfError(definition, pattern) {
  assert.throws(
    () => validateFormDefinitionSchema(definition),
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.match(JSON.stringify(error.details?.issues || []), pattern)
      return true
    }
  )
}

test('accepts a valid visibleIf condition referencing a sibling field', () => {
  const result = validateFormDefinitionSchema({
    sections: [
      {
        key: 'main',
        fields: [
          { key: 'hasSpouse', type: 'select', options: ['yes', 'no'] },
          { key: 'spouseName', type: 'text', visibleIf: { field: 'hasSpouse', op: 'equals', value: 'yes' } }
        ]
      }
    ]
  })
  assert.ok(result.schema)
})

test('accepts in / notEmpty operators', () => {
  const result = validateFormDefinitionSchema({
    sections: [
      {
        key: 'main',
        fields: [
          { key: 'kind', type: 'select', options: ['a', 'b', 'c'] },
          { key: 'note', type: 'text', visibleIf: { field: 'kind', op: 'in', value: ['a', 'b'] } },
          { key: 'detail', type: 'text', visibleIf: { field: 'note', op: 'notEmpty' } }
        ]
      }
    ]
  })
  assert.ok(result.schema)
})

test('rejects visibleIf referencing an unknown field key', () => {
  assertVisibleIfError(
    {
      sections: [
        {
          key: 'main',
          fields: [{ key: 'spouseName', type: 'text', visibleIf: { field: 'nope', op: 'equals', value: 'yes' } }]
        }
      ]
    },
    /must reference an existing field key in the same section/
  )
})

test('rejects visibleIf referencing a field in a different section (cross-section)', () => {
  assertVisibleIfError(
    {
      sections: [
        { key: 'one', fields: [{ key: 'hasSpouse', type: 'select', options: ['yes', 'no'] }] },
        {
          key: 'two',
          fields: [{ key: 'spouseName', type: 'text', visibleIf: { field: 'hasSpouse', op: 'equals', value: 'yes' } }]
        }
      ]
    },
    /cross-section references are not allowed/
  )
})

test('rejects an unknown operator', () => {
  assertVisibleIfError(
    {
      sections: [
        {
          key: 'main',
          fields: [
            { key: 'a', type: 'text' },
            { key: 'b', type: 'text', visibleIf: { field: 'a', op: 'startsWith', value: 'x' } }
          ]
        }
      ]
    },
    /is not supported/
  )
})

test('rejects a missing value for equals', () => {
  assertVisibleIfError(
    {
      sections: [
        {
          key: 'main',
          fields: [
            { key: 'a', type: 'text' },
            { key: 'b', type: 'text', visibleIf: { field: 'a', op: 'equals' } }
          ]
        }
      ]
    },
    /value is required and must be a string/
  )
})

test('rejects a non-array value for in', () => {
  assertVisibleIfError(
    {
      sections: [
        {
          key: 'main',
          fields: [
            { key: 'a', type: 'text' },
            { key: 'b', type: 'text', visibleIf: { field: 'a', op: 'in', value: 'a' } }
          ]
        }
      ]
    },
    /must be a non-empty array/
  )
})

test('rejects a self-referencing visibleIf', () => {
  assertVisibleIfError(
    {
      sections: [
        {
          key: 'main',
          fields: [{ key: 'a', type: 'text', visibleIf: { field: 'a', op: 'notEmpty' } }]
        }
      ]
    },
    /cannot reference the field itself/
  )
})

test('rejects circular visibleIf references within a section', () => {
  assertVisibleIfError(
    {
      sections: [
        {
          key: 'main',
          fields: [
            { key: 'a', type: 'text', visibleIf: { field: 'b', op: 'notEmpty' } },
            { key: 'b', type: 'text', visibleIf: { field: 'a', op: 'notEmpty' } }
          ]
        }
      ]
    },
    /Circular visibleIf reference detected/
  )
})

test('allows a visibleIf target to itself be conditional (non-circular chain)', () => {
  const result = validateFormDefinitionSchema({
    sections: [
      {
        key: 'main',
        fields: [
          { key: 'a', type: 'text' },
          { key: 'b', type: 'text', visibleIf: { field: 'a', op: 'notEmpty' } },
          { key: 'c', type: 'text', visibleIf: { field: 'b', op: 'notEmpty' } }
        ]
      }
    ]
  })
  assert.ok(result.schema)
})

test('validates visibleIf inside repeatable section row scope', () => {
  const result = validateFormDefinitionSchema({
    sections: [
      {
        key: 'assets',
        repeatable: true,
        fields: [
          { key: 'kind', type: 'select', options: ['cash', 'property'] },
          { key: 'address', type: 'text', visibleIf: { field: 'kind', op: 'equals', value: 'property' } }
        ]
      }
    ]
  })
  assert.ok(result.repeaterPaths.has('assets'))
})
