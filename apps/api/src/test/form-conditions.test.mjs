import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisibleByRule, sanitizeTemplateSubmissionData } from '../store.mjs';

test('isVisibleByRule evaluates all/any conditions', () => {
  const allRule = {
    match: 'all',
    conditions: [
      { field: 'married', operator: 'equals', value: 'yes' },
      { field: 'dependents', operator: 'gt', value: 0 }
    ]
  };
  assert.equal(isVisibleByRule(allRule, { married: 'yes', dependents: 2 }), true);
  assert.equal(isVisibleByRule(allRule, { married: 'yes', dependents: 0 }), false);

  const anyRule = {
    match: 'any',
    conditions: [
      { field: 'riskTolerance', operator: 'equals', value: 'Aggressive' },
      { field: 'investmentExperience', operator: 'equals', value: 'Advanced' }
    ]
  };
  assert.equal(isVisibleByRule(anyRule, { riskTolerance: 'Moderate', investmentExperience: 'Advanced' }), true);
  assert.equal(isVisibleByRule(anyRule, { riskTolerance: 'Moderate', investmentExperience: 'Beginner' }), false);
});

test('sanitizeTemplateSubmissionData removes hidden field values and preserves visible draft rows', () => {
  const template = {
    sections: [
      {
        title: 'Household',
        fields: [
          { key: 'married', type: 'select' },
          { key: 'spouseName', type: 'text', showWhen: { conditions: [{ field: 'married', operator: 'equals', value: 'yes' }] } }
        ]
      },
      {
        title: 'Assets',
        repeatable: true,
        showWhen: { conditions: [{ field: 'married', operator: 'equals', value: 'yes' }] },
        fields: [
          { key: 'accountName', type: 'text' },
          { key: 'value', type: 'number' }
        ]
      }
    ]
  };

  const hidden = sanitizeTemplateSubmissionData(template, {
    married: 'no',
    spouseName: 'Should Be Dropped',
    assets: [{ accountName: '401k', value: '1000' }]
  }, 'draft');

  assert.deepEqual(hidden, { married: 'no' });

  const visible = sanitizeTemplateSubmissionData(template, {
    married: 'yes',
    spouseName: 'Jamie',
    assets: [{ accountName: '401k', value: '1000' }, { accountName: '', value: '' }]
  }, 'draft');

  assert.deepEqual(visible, {
    married: 'yes',
    spouseName: 'Jamie',
    assets: [{ accountName: '401k', value: '1000' }]
  });
});

test('sanitizeTemplateSubmissionData enforces required visible fields for submitted status', () => {
  const template = {
    sections: [
      {
        title: 'Goals',
        fields: [
          { key: 'primaryGoal', type: 'text', required: true },
          { key: 'timeHorizon', type: 'number', showWhen: { conditions: [{ field: 'primaryGoal', operator: 'exists' }] } }
        ]
      }
    ]
  };

  assert.throws(() => {
    sanitizeTemplateSubmissionData(template, { primaryGoal: '' }, 'submitted');
  }, /Missing required field: primaryGoal/);

  const submitted = sanitizeTemplateSubmissionData(template, { primaryGoal: 'Retire at 60', timeHorizon: 20 }, 'submitted');
  assert.deepEqual(submitted, { primaryGoal: 'Retire at 60', timeHorizon: 20 });
});
