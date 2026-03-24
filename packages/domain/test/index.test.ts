import test from 'node:test';
import assert from 'node:assert/strict';

import { can, formatSourceAttribution, initialStageOrderIndex } from '../src/index.js';

test('advisors can write profiles but cannot administer firms', () => {
  assert.equal(can('advisor', 'profiles:write'), true);
  assert.equal(can('advisor', 'firms:admin'), false);
});

test('formats source attribution using the expected display pattern', () => {
  assert.equal(
    formatSourceAttribution({
      cityOrLocation: 'Denver',
      venue: 'Client Dinner',
      occurredOn: '2026-03-23'
    }).displayValue,
    'Denver X Client Dinner X 2026-03-23'
  );
});

test('assigns incremental stage ordering indexes', () => {
  assert.equal(initialStageOrderIndex(0), 1);
  assert.equal(initialStageOrderIndex(3), 4);
});
