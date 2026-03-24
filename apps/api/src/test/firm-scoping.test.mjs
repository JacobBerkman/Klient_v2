import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../store.mjs';
import { SqliteReadRepository } from '../repositories/sqlite-read-repository.mjs';

function userFromSession(session) {
  return session.user;
}

test('firm scoping blocks cross-firm reads and writes across major record types', () => {
  const store = createStore();
  const reads = new SqliteReadRepository();

  const firmASession = store.register({
    firmName: `Firm A ${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    firstName: 'Alex',
    lastName: 'Advisor',
    email: `alex.${Date.now()}@firma.test`,
    password: 'SecurePass123!'
  });
  const firmBSession = store.register({
    firmName: `Firm B ${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    firstName: 'Blake',
    lastName: 'Builder',
    email: `blake.${Date.now()}@firmb.test`,
    password: 'SecurePass123!'
  });

  const userA = userFromSession(firmASession);
  const userB = userFromSession(firmBSession);

  const profileA = store.createProfile(userA, {
    kind: 'client',
    firstName: 'Alice',
    lastName: 'Client',
    email: 'alice@firma.test'
  });
  const profileB = store.createProfile(userB, {
    kind: 'client',
    firstName: 'Bob',
    lastName: 'Client',
    email: 'bob@firmb.test'
  });

  const householdB = store.createHousehold(userB, { name: 'B Household', primaryClientId: profileB.id });

  const formTemplateA = store.createFormTemplate(userA, { name: 'A Discovery', sections: [] });
  const formTemplateB = store.createFormTemplate(userB, { name: 'B Discovery', sections: [] });

  const submissionA = store.createFormSubmission(userA, {
    clientId: profileA.id,
    templateId: formTemplateA.id,
    status: 'draft',
    data: { from: 'A' }
  });
  const submissionB = store.createFormSubmission(userB, {
    clientId: profileB.id,
    templateId: formTemplateB.id,
    status: 'draft',
    data: { from: 'B' }
  });

  const documentTemplateA = store.createDocumentTemplate(userA, { name: 'A Doc', fileName: 'a.pdf' });
  const documentTemplateB = store.createDocumentTemplate(userB, { name: 'B Doc', fileName: 'b.pdf' });

  const exportA = store.createExport(userA, { clientId: profileA.id, templateId: documentTemplateA.id, type: 'pdf' });
  const exportB = store.createExport(userB, { clientId: profileB.id, templateId: documentTemplateB.id, type: 'pdf' });

  const portalLinkB = store.createPortalLink(userB, profileB.id);

  assert.equal(store.listProfiles(userA).some((entry) => entry.id === profileB.id), false);
  assert.equal(reads.listProfiles(userA.firmId).some((entry) => entry.id === profileB.id), false);
  assert.equal(reads.getProfileDetail(userA.firmId, profileB.id), null);

  assert.throws(() => store.getProfileDetail(userA, profileB.id), /Profile not found/);
  assert.throws(() => store.updateProfile(userA, profileB.id, { lastName: 'Nope' }), /Profile not found/);

  assert.equal(store.listHouseholds(userA).some((entry) => entry.id === householdB.id), false);
  assert.throws(() => store.createHousehold(userA, { name: 'Cross Household', primaryClientId: profileB.id }), /Primary client profile not found/);
  assert.throws(() => store.addHouseholdMember(userA, householdB.id, { clientId: profileA.id, role: 'spouse' }), /Household not found/);

  assert.equal(store.listFormTemplates(userA).some((entry) => entry.id === formTemplateB.id), false);
  assert.equal(store.listFormSubmissions(userA).some((entry) => entry.id === submissionB.id), false);
  assert.throws(() => store.createFormSubmission(userA, { clientId: profileB.id, templateId: formTemplateA.id, status: 'draft' }), /Client profile not found/);
  assert.throws(() => store.createFormSubmission(userA, { clientId: profileA.id, templateId: formTemplateB.id, status: 'draft' }), /Form template not found/);

  assert.equal(store.listDocumentTemplates(userA).some((entry) => entry.id === documentTemplateB.id), false);
  assert.throws(() => store.publishTemplate(userA, documentTemplateB.id), /Template not found/);
  assert.throws(() => store.updateTemplateMappings(userA, documentTemplateB.id, []), /Template not found/);

  assert.equal(store.listExports(userA).some((entry) => entry.id === exportB.id), false);
  assert.equal(reads.getQueuedExports(userA.firmId).some((entry) => entry.id === exportB.id), false);
  assert.throws(() => store.retryExport(userA, exportB.id), /Export not found/);
  assert.throws(() => store.createExport(userA, { clientId: profileB.id, templateId: documentTemplateA.id, type: 'pdf' }), /Client profile not found/);
  assert.throws(() => store.createExport(userA, { clientId: profileA.id, templateId: documentTemplateB.id, type: 'pdf' }), /Document template not found/);

  assert.equal(store.listAudit(userA).every((entry) => entry.firmId === userA.firmId), true);
  assert.equal(store.listAudit(userA).some((entry) => entry.entityId === profileB.id || entry.entityId === householdB.id), false);

  assert.throws(() => store.createPortalLink(userA, profileB.id), /Profile not found/);
  const portalData = store.getPortalData(portalLinkB.token);
  assert.equal(portalData.profile?.id, profileB.id);
  assert.equal(portalData.firm?.id, userB.firmId);

  assert.equal(submissionA.firmId, userA.firmId);
  assert.equal(submissionB.firmId, userB.firmId);
  assert.equal(exportA.firmId, userA.firmId);
});
