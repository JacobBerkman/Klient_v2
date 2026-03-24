import test from 'node:test';
import assert from 'node:assert/strict';

import { createPiiService, maskSsn, maskTaxId } from '../services/pii-service.mjs';

test('masking helpers hide all but trailing digits', () => {
  assert.equal(maskSsn('123-45-6789'), '***-**-6789');
  assert.equal(maskTaxId('12-3456789'), '**-6789');
  assert.equal(maskSsn(''), null);
  assert.equal(maskTaxId(''), null);
});

test('sensitive reads are audited and return masked values', () => {
  const events = [];
  const piiService = createPiiService({
    secret: 'test-secret',
    audit: (actor, event) => events.push({ actor, event })
  });

  const actor = { id: 'user-1', firmId: 'firm-1' };
  const profile = { id: 'profile-1', pii: {} };
  profile.pii = piiService.applySensitiveWrite({
    actor,
    profile,
    input: { ssn: '123-45-6789', taxId: '12-3456789' },
    reason: 'test.setup'
  });

  const masked = piiService.getMaskedSensitiveData({ actor, profile, reason: 'test.read' });
  assert.deepEqual(masked, { ssnMasked: '***-**-6789', taxIdMasked: '**-6789' });

  const sensitiveRead = events.find((entry) => entry.event.action === 'profile.sensitive.read');
  assert.ok(sensitiveRead);
  assert.equal(sensitiveRead.actor.id, actor.id);
  assert.deepEqual(sensitiveRead.event.metadata, { reason: 'test.read', fields: ['ssn', 'taxId'] });
});
