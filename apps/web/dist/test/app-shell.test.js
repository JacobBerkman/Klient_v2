import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseADeliveryPlan } from '../app-shell.js';
test('phase A delivery plan prioritizes internal advisor workflows', () => {
    assert.deepEqual(phaseADeliveryPlan.modules.map((module) => module.key), ['auth', 'crm', 'pipeline', 'households']);
});
