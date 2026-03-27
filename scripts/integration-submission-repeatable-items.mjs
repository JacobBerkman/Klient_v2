import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('submission-repeatable-items')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const clients = await context.request('/api/profiles?kind=client', { headers })
  const client = clients[0]
  assert(client?.id, 'Expected a client profile.')
  const template = await context.request('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Repeatable Asset Test',
      sections: [
        {
          title: 'Assets',
          key: 'assets',
          repeatable: true,
          fields: [
            { key: 'accountName', label: 'Account Name', type: 'text' },
            { key: 'value', label: 'Value', type: 'number' }
          ]
        }
      ]
    })
  })
  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: client.id, templateId: template.id, status: 'draft', data: { assets: [] } })
  })
  const detail = await context.request(`/api/profiles/${submission.clientId}`, { headers })

  const createdItem = { id: 'asset-1', accountName: 'Brokerage', value: 125000 }
  await context.request(`/api/forms/submissions/${submission.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ data: { assets: [createdItem] } })
  })

  const updated = await context.request(
    `/api/forms/submissions/${submission.id}/sections/assets/items/${createdItem.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 150000, accountName: 'Brokerage Joint' })
    }
  )
  assert(updated.data.assets?.[0]?.value === 150000, 'Repeatable item value did not update.')
  assert(updated.data.assets?.[0]?.accountName === 'Brokerage Joint', 'Repeatable item name did not update.')

  const identityPatchError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/${createdItem.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: 'asset-2' })
    },
    400
  )
  assert(
    String(identityPatchError?.error?.message || identityPatchError?.message || '').includes('identity fields'),
    'Expected identity field conflict error when patching id/key.'
  )

  const missingItemError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/missing-item`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 1 })
    },
    404
  )
  assert(
    String(missingItemError?.error?.message || missingItemError?.message || '').includes('not found'),
    'Expected missing item error for unknown repeater item update.'
  )

  await context.request(`/api/forms/submissions/${submission.id}/sections/assets/items/${createdItem.id}`, {
    method: 'DELETE',
    headers
  })

  const staleDeleteError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/${createdItem.id}`,
    {
      method: 'DELETE',
      headers
    },
    404
  )
  assert(
    String(staleDeleteError?.error?.message || staleDeleteError?.message || '').includes('not found'),
    'Expected stale delete conflict/error for already removed repeater item.'
  )

  const staleUpdateError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/${createdItem.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ accountName: 'Stale Update Attempt' })
    },
    404
  )
  assert(
    String(staleUpdateError?.error?.message || staleUpdateError?.message || '').includes('not found'),
    'Expected stale update error for already removed repeater item.'
  )

  const malformedPatchArrayError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/0`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify([1, 2, 3])
    },
    400
  )
  assert(
    String(malformedPatchArrayError?.error?.message || malformedPatchArrayError?.message || '').includes('Patch'),
    'Expected invalid patch payload error when patch body is an array.'
  )

  const malformedPatchEmptyError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/0`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({})
    },
    400
  )
  assert(
    Array.isArray(malformedPatchEmptyError?.error?.details?.issues),
    'Expected issues array for empty patch payload validation.'
  )

  const invalidSectionSelectorError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/%20%20/items/0`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 1 })
    },
    400
  )
  assert(
    String(invalidSectionSelectorError?.error?.message || invalidSectionSelectorError?.message || '').includes(
      'Section key is required'
    ),
    'Expected section key selector validation error.'
  )

  const invalidItemSelectorError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/assets/items/%20%20`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 1 })
    },
    400
  )
  assert(
    String(invalidItemSelectorError?.error?.message || invalidItemSelectorError?.message || '').includes(
      'Item key is required'
    ),
    'Expected item key selector validation error.'
  )

  const nonRepeaterError = await context.requestExpectError(
    `/api/forms/submissions/${submission.id}/sections/nonRepeater/items/0`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 1 })
    },
    400
  )
  assert(
    String(nonRepeaterError?.error?.message || nonRepeaterError?.message || '').includes('not a repeater section'),
    'Expected non-repeater section validation error.'
  )

  await context.request(`/api/forms/submissions/${submission.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ data: { assets: [createdItem] } })
  })

  const finalDetail = await context.request(`/api/profiles/${submission.clientId}`, { headers })
  const finalSubmission = finalDetail.submissions.find((entry) => entry.id === submission.id)
  const assets = finalSubmission.data.assets || []
  assert(assets.some((item) => item.id === createdItem.id), 'Repeatable item create path failed.')

  const audit = await context.request('/api/audit', { headers })
  const related = audit.filter((event) => event.entityId === submission.id)

  console.log(
    JSON.stringify(
      {
        suite: 'integration-submission-repeatable-items',
        submissionId: submission.id,
        auditEvents: related.length,
        repeaterEvents: related
          .filter((event) =>
            ['form_submission.repeater_item_updated', 'form_submission.repeater_item_deleted'].includes(event.action)
          )
          .length
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
