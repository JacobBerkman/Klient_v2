import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('submission-repeatable-items');

try {
  const admin = await context.login();
  const headers = context.authHeaders(admin.token);

  const clients = await context.request('/api/profiles?kind=client', { headers });
  const client = clients[0];
  assert(client?.id, 'Expected a client profile.');
  const template = await context.request('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Repeatable Asset Test',
      sections: [
        { title: 'Assets', key: 'assets', repeatable: true, fields: [{ key: 'accountName', label: 'Account Name', type: 'text' }, { key: 'value', label: 'Value', type: 'number' }] }
      ]
    })
  });
  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: client.id, templateId: template.id, status: 'draft', data: { assets: [] } })
  });
  const detail = await context.request(`/api/profiles/${submission.clientId}`, { headers });

  const created = await context.request(`/api/forms/submissions/${submission.id}/sections/assets/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ item: { accountName: 'Brokerage', value: 125000 } })
  });
  assert(created.item._itemKey, 'Created repeatable item key missing.');

  await context.requestExpectError(`/api/forms/submissions/${submission.id}/sections/assets/items/${created.item._itemKey}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ item: { unexpected: 'bad' } })
  }, 400);

  const updated = await context.request(`/api/forms/submissions/${submission.id}/sections/assets/items/${created.item._itemKey}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ item: { value: 150000 } })
  });
  assert(updated.item.value === 150000, 'Repeatable item value did not update.');

  await context.request(`/api/forms/submissions/${submission.id}/sections/assets/items/${created.item._itemKey}`, {
    method: 'DELETE',
    headers
  });

  const finalDetail = await context.request(`/api/profiles/${submission.clientId}`, { headers });
  const finalSubmission = finalDetail.submissions.find((entry) => entry.id === submission.id);
  const assets = finalSubmission.data.assets || [];
  assert(!assets.some((item) => item._itemKey === created.item._itemKey), 'Repeatable item still present after delete.');

  const audit = await context.request('/api/audit', { headers });
  const related = audit.filter((event) => event.entityId === submission.id && event.action.startsWith('form_submission.item_'));
  assert(related.some((event) => event.action === 'form_submission.item_created' && event.metadata.path), 'Create audit event missing changed path metadata.');
  assert(related.some((event) => event.action === 'form_submission.item_updated' && event.metadata.path), 'Update audit event missing changed path metadata.');
  assert(related.some((event) => event.action === 'form_submission.item_deleted' && event.metadata.path), 'Delete audit event missing changed path metadata.');

  console.log(JSON.stringify({ suite: 'integration-submission-repeatable-items', submissionId: submission.id, auditEvents: related.length }, null, 2));
} finally {
  await context.shutdown();
}
