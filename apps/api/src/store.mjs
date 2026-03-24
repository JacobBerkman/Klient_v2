import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { runtime } from './runtime.mjs';
import { enqueueExportJob, listExportQueueJobs, loadState, processExportQueueTick, requeueExportJob, saveState } from './storage.mjs';
import { createAuthService } from './auth/service.mjs';
import { createLocalAuthProvider } from './auth/local-provider.mjs';

const APP_SECRET = createHash('sha256').update(runtime.appSecret).digest();
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const PERMISSIONS = {
  admin: ['*'],
  advisor: ['profiles:read', 'profiles:write', 'pipeline:write', 'households:write', 'forms:write', 'templates:write', 'exports:write', 'analytics:read'],
  readonly: ['profiles:read', 'analytics:read'],
  client: ['portal:read', 'client:write']
};
const BOARD_COLUMNS = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed', 'drop_dead_lead', 'drop_nurture'];

function can(role, permission) {
  return PERMISSIONS[role]?.includes('*') || PERMISSIONS[role]?.includes(permission);
}

function requirePermission(user, permission) {
  if (!can(user.role, permission)) {
    throw new Error(`Missing permission: ${permission}`);
  }
}

function encryptValue(value) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', APP_SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptValue(payload) {
  if (!payload) return null;
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const decipher = createDecipheriv('aes-256-gcm', APP_SECRET, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

function now() {
  return new Date().toISOString();
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex');
}

function assertStrongPassword(password) {
  const value = String(password || '');
  if (value.length < 12) throw new Error('Password must be at least 12 characters long.');
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.');
  }
}

function sourceDisplay(source) {
  return `${source.cityOrLocation} X ${source.venue} X ${source.occurredOn}`;
}

function pipelineConflict(message, details = {}) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'PIPELINE_ORDER_CONFLICT';
  error.details = details;
  return error;
}

function seedState() {
  const createdAt = now();
  const firmId = randomUUID();
  const adminId = randomUUID();
  const householdId = randomUUID();
  const clientId = randomUUID();
  const spouseId = randomUUID();
  const prospectOneId = randomUUID();
  const prospectTwoId = randomUUID();
  const templateId = randomUUID();
  const formTemplateId = randomUUID();
  const submissionId = randomUUID();
  const exportId = randomUUID();
  const documentUploadId = randomUUID();

  return {
    firms: [{ id: firmId, name: 'Demo Advisory Group', slug: 'demo-advisory-group', createdAt }],
    users: [{
      id: adminId,
      firmId,
      email: 'admin@demo.test',
      passwordHash: hash('ChangeMe123!'),
      firstName: 'Demo',
      lastName: 'Admin',
      role: 'admin',
      createdAt
    }],
    sessions: [],
    profiles: [
      {
        id: clientId,
        firmId,
        advisorUserId: adminId,
        kind: 'client',
        firstName: 'Morgan',
        lastName: 'Taylor',
        email: 'morgan@example.com',
        phone: '555-000-1111',
        dateOfBirth: '1981-04-12',
        source: { cityOrLocation: 'Dallas', venue: 'Referral', occurredOn: '2026-03-01', displayValue: sourceDisplay({ cityOrLocation: 'Dallas', venue: 'Referral', occurredOn: '2026-03-01' }) },
        address: { city: 'Dallas', state: 'TX' },
        customProfile: { investableAssets: 850000 },
        householdId,
        spouseClientId: spouseId,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: spouseId,
        firmId,
        advisorUserId: adminId,
        kind: 'client',
        firstName: 'Jamie',
        lastName: 'Taylor',
        email: 'jamie@example.com',
        phone: '555-000-2222',
        dateOfBirth: '1982-10-21',
        address: { city: 'Dallas', state: 'TX' },
        customProfile: {},
        householdId,
        spouseClientId: clientId,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: prospectOneId,
        firmId,
        advisorUserId: adminId,
        kind: 'prospect',
        firstName: 'Casey',
        lastName: 'Jordan',
        email: 'casey@example.com',
        phone: '555-111-3333',
        stage: 'discovery',
        stageOrderIndex: 1,
        pipelineVersion: 1,
        source: { cityOrLocation: 'Austin', venue: 'Seminar', occurredOn: '2026-03-10', displayValue: sourceDisplay({ cityOrLocation: 'Austin', venue: 'Seminar', occurredOn: '2026-03-10' }) },
        address: { city: 'Austin', state: 'TX' },
        customProfile: {},
        createdAt,
        updatedAt: createdAt
      },
      {
        id: prospectTwoId,
        firmId,
        advisorUserId: adminId,
        kind: 'prospect',
        firstName: 'Riley',
        lastName: 'Carter',
        email: 'riley@example.com',
        phone: '555-111-4444',
        stage: 'analysis',
        stageOrderIndex: 1,
        pipelineVersion: 1,
        source: { cityOrLocation: 'Houston', venue: 'CPA Referral', occurredOn: '2026-03-15', displayValue: sourceDisplay({ cityOrLocation: 'Houston', venue: 'CPA Referral', occurredOn: '2026-03-15' }) },
        address: { city: 'Houston', state: 'TX' },
        customProfile: {},
        createdAt,
        updatedAt: createdAt
      }
    ],
    households: [{ id: householdId, firmId, name: 'Taylor Household', primaryClientId: clientId, createdAt }],
    householdMembers: [
      { householdId, clientId, role: 'primary', firmId, createdAt },
      { householdId, clientId: spouseId, role: 'spouse', firmId, createdAt }
    ],
    stageChanges: [
      { id: randomUUID(), firmId, clientId: prospectOneId, toStage: 'discovery', changedByUserId: adminId, changedAt: createdAt },
      { id: randomUUID(), firmId, clientId: prospectTwoId, toStage: 'analysis', changedByUserId: adminId, changedAt: createdAt }
    ],
    auditEvents: [
      { id: randomUUID(), firmId, actorUserId: adminId, entityType: 'seed', entityId: 'initial', action: 'seed.created', occurredAt: createdAt, metadata: {} }
    ],
    formTemplates: [{
      id: formTemplateId,
      firmId,
      name: 'Financial Discovery',
      description: 'Core onboarding discovery form',
      sections: [
        { id: randomUUID(), title: 'Household', fields: [{ key: 'goals', label: 'Goals', type: 'textarea' }, { key: 'riskTolerance', label: 'Risk Tolerance', type: 'select', options: ['Conservative','Moderate','Aggressive'] }] },
        { id: randomUUID(), title: 'Assets', repeatable: true, fields: [{ key: 'accountName', label: 'Account Name', type: 'text' }, { key: 'value', label: 'Value', type: 'number' }] }
      ],
      createdAt,
      updatedAt: createdAt
    }],
    formSubmissions: [{
      id: submissionId,
      firmId,
      clientId,
      templateId: formTemplateId,
      status: 'submitted',
      data: { goals: 'Retire at 60', riskTolerance: 'Moderate', assets: [{ accountName: '401k', value: 450000 }] },
      createdAt,
      updatedAt: createdAt
    }],
    documentTemplates: [{
      id: templateId,
      firmId,
      name: 'Client Intake PDF Template',
      fileName: 'client-intake.pdf',
      blueprint: { sections: ['client', 'household', 'assets'] },
      mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }],
      createdAt,
      updatedAt: createdAt
    }],
    exportJobs: [{ id: exportId, firmId, clientId, templateId, type: 'pdf', status: 'completed', output: { fileName: 'client-intake-demo.json' }, createdAt, updatedAt: createdAt }],
    documentUploads: [{
      id: documentUploadId,
      firmId,
      clientId,
      name: 'Driver License - Morgan',
      category: 'identification',
      visibility: 'shared',
      status: 'uploaded',
      uploadedBy: 'advisor',
      createdAt,
      updatedAt: createdAt
    }],
    notes: [{ id: randomUUID(), firmId, profileId: prospectOneId, body: 'Follow up after workshop and confirm beneficiary details.', createdByUserId: adminId, createdAt }],
    invites: [],
    passwordResets: [],
    portalLinks: [],
    authAttempts: [],
    boardVersions: { [firmId]: 1 }
  };
}

export function createStore() {
  const state = loadState(seedState);
  let testHooks = {};

  function persist() {
    if (typeof testHooks.beforePersist === 'function') {
      testHooks.beforePersist(state);
    }
    saveState(state);
  }

  function getBoardVersion(firmId) {
    if (!state.boardVersions || typeof state.boardVersions !== 'object') {
      state.boardVersions = {};
    }
    if (!state.boardVersions[firmId]) {
      state.boardVersions[firmId] = 1;
    }
    return state.boardVersions[firmId];
  }

  function bumpBoardVersion(firmId) {
    const current = getBoardVersion(firmId);
    state.boardVersions[firmId] = current + 1;
    return state.boardVersions[firmId];
  }

  function listProspectsByStage(firmId, stage, excludedProfileId = null) {
    return state.profiles
      .filter((profile) => profile.firmId === firmId && profile.kind === 'prospect' && profile.stage === stage && profile.id !== excludedProfileId)
      .sort((a, b) => {
        const indexDiff = (a.stageOrderIndex || Number.MAX_SAFE_INTEGER) - (b.stageOrderIndex || Number.MAX_SAFE_INTEGER);
        if (indexDiff !== 0) return indexDiff;
        const updatedDiff = new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime();
        if (updatedDiff !== 0) return updatedDiff;
        return a.id.localeCompare(b.id);
      });
  }

  function compactStageIndices(firmId, stage) {
    const cards = listProspectsByStage(firmId, stage);
    let changed = false;
    cards.forEach((card, index) => {
      const nextIndex = index + 1;
      if (card.stageOrderIndex !== nextIndex) {
        card.stageOrderIndex = nextIndex;
        changed = true;
      }
    });
    return changed;
  }

  function normalizePipelineIndices(firmId, stage = null) {
    const stages = stage ? [stage] : BOARD_COLUMNS;
    const normalizedStages = [];
    for (const currentStage of stages) {
      if (compactStageIndices(firmId, currentStage)) {
        normalizedStages.push(currentStage);
      }
    }
    return normalizedStages;
  }

  function buildBoardPayload(user, conflict = null) {
    const columns = BOARD_COLUMNS.map((stage) => ({
      stage,
      orderingVersion: getBoardVersion(user.firmId),
      cards: listProspectsByStage(user.firmId, stage)
    }));
    return {
      boardVersion: getBoardVersion(user.firmId),
      generatedAt: now(),
      ordering: {
        mode: 'sequential_stage_index',
        normalized: true
      },
      conflict,
      columns
    };
  }

  function executePipelineTransaction(mutator) {
    const snapshot = {
      profiles: state.profiles.map((profile) => ({ ...profile })),
      stageChangesLength: state.stageChanges.length,
      auditEventsLength: state.auditEvents.length,
      boardVersions: { ...(state.boardVersions || {}) }
    };
    try {
      const result = mutator();
      persist();
      return result;
    } catch (error) {
      state.profiles = snapshot.profiles;
      state.stageChanges = state.stageChanges.slice(0, snapshot.stageChangesLength);
      state.auditEvents = state.auditEvents.slice(0, snapshot.auditEventsLength);
      state.boardVersions = snapshot.boardVersions;
      throw error;
    }
  }

  function createSession(user) {
    const token = randomUUID();
    state.sessions.push({ token, userId: user.id, firmId: user.firmId, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    persist();
    return { token, user: publicUser(user) };
  }

  function pruneExpiredSessions() {
    const cutoff = Date.now();
    const nextSessions = state.sessions.filter((entry) => new Date(entry.expiresAt).getTime() > cutoff);
    if (nextSessions.length !== state.sessions.length) {
      state.sessions = nextSessions;
      persist();
    }
  }

  function publicUser(user) {
    return { id: user.id, firmId: user.firmId, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
  }

  function requireUser(token) {
    pruneExpiredSessions();
    const session = state.sessions.find((entry) => entry.token === token);
    if (!session) throw new Error('Authentication required.');
    const user = state.users.find((entry) => entry.id === session.userId && entry.firmId === session.firmId);
    if (!user) throw new Error('Authentication required.');
    return publicUser(user);
  }

  function addAudit(firmId, actorUserId, entityType, entityId, action, metadata = {}, options = {}) {
    state.auditEvents.push({ id: randomUUID(), firmId, actorUserId, entityType, entityId, action, occurredAt: now(), metadata });
    if (options.persist !== false) {
      persist();
    }
  }

  function requireClientProfile(user) {
    requirePermission(user, 'portal:read');
    const profile = state.profiles.find((entry) =>
      entry.firmId === user.firmId
      && entry.kind === 'client'
      && entry.email
      && entry.email.toLowerCase() === user.email.toLowerCase()
    );
    if (!profile) throw new Error('Client profile not found.');
    return profile;
  }

  function createAuthProvider() {
    if (runtime.authProvider === 'local') {
      return createLocalAuthProvider({ state, persist, createSession, addAudit });
    }
    throw new Error(`Unsupported auth provider: ${runtime.authProvider}.`);
  }

  const auth = createAuthService({ provider: createAuthProvider() });

  return {
    state,
    assertPermission(user, permission) {
      requirePermission(user, permission);
      return true;
    },
    auth,
    register(input) {
      return auth.register(input);
    },
    login(input) {
      return auth.login(input);
    },
    requireUser,
    getDashboard(user) {
      requirePermission(user, 'profiles:read');
      const profiles = state.profiles.filter((profile) => profile.firmId === user.firmId);
      const prospects = profiles.filter((profile) => profile.kind === 'prospect');
      const clients = profiles.filter((profile) => profile.kind === 'client');
      return {
        firm: state.firms.find((firm) => firm.id === user.firmId),
        stats: {
          totalProfiles: profiles.length,
          prospects: prospects.length,
          clients: clients.length,
          households: state.households.filter((household) => household.firmId === user.firmId).length,
          forms: state.formSubmissions.filter((submission) => submission.firmId === user.firmId).length,
          exports: state.exportJobs.filter((job) => job.firmId === user.firmId).length
        },
        recentProfiles: profiles.slice(-5).reverse(),
        recentAuditEvents: state.auditEvents.filter((event) => event.firmId === user.firmId).slice(-10).reverse()
      };
    },
    listProfiles(user, kind, search = '') {
      requirePermission(user, 'profiles:read');
      const q = String(search || '').toLowerCase();
      return state.profiles
        .filter((profile) => profile.firmId === user.firmId)
        .filter((profile) => !kind || profile.kind === kind)
        .filter((profile) => !q || `${profile.firstName} ${profile.lastName} ${profile.email || ''}`.toLowerCase().includes(q))
        .sort((a, b) => (a.stage === b.stage ? (a.stageOrderIndex || 0) - (b.stageOrderIndex || 0) : a.lastName.localeCompare(b.lastName)));
    },
    getProfileDetail(user, profileId) {
      requirePermission(user, 'profiles:read');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const household = profile.householdId ? state.households.find((entry) => entry.id === profile.householdId && entry.firmId === user.firmId) : null;
      const householdMembers = household ? state.householdMembers.filter((entry) => entry.householdId === household.id && entry.firmId === user.firmId) : [];
      const submissions = state.formSubmissions.filter((entry) => entry.clientId === profile.id && entry.firmId === user.firmId);
      const stageHistory = state.stageChanges.filter((entry) => entry.clientId === profile.id && entry.firmId === user.firmId);
      const notes = state.notes.filter((entry) => entry.profileId === profile.id && entry.firmId === user.firmId).slice().reverse();
      return { profile, household, householdMembers, submissions, stageHistory, notes };
    },
    createProfile(user, input) {
      requirePermission(user, 'profiles:write');
      const createdAt = now();
      const inStage = state.profiles.filter((profile) => profile.firmId === user.firmId && profile.kind === 'prospect' && profile.stage === (input.stage || 'discovery')).length;
      const profile = {
        pii: { maskingPolicy: 'role_based', ssnCiphertext: encryptValue(input.ssn), taxIdCiphertext: encryptValue(input.taxId) },
        id: randomUUID(),
        firmId: user.firmId,
        advisorUserId: user.id,
        kind: input.kind,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email || '',
        phone: input.phone || '',
        dateOfBirth: input.dateOfBirth || '',
        source: input.source ? { ...input.source, displayValue: sourceDisplay(input.source) } : null,
        stage: input.kind === 'prospect' ? input.stage || 'discovery' : null,
        stageOrderIndex: input.kind === 'prospect' ? inStage + 1 : null,
        pipelineVersion: input.kind === 'prospect' ? 1 : null,
        address: input.address || {},
        customProfile: input.customProfile || {},
        householdId: input.householdId || null,
        spouseClientId: input.spouseClientId || null,
        createdAt,
        updatedAt: createdAt
      };
      state.profiles.push(profile);
      if (profile.stage) {
        state.stageChanges.push({ id: randomUUID(), firmId: user.firmId, clientId: profile.id, toStage: profile.stage, changedByUserId: user.id, changedAt: createdAt });
      }
      addAudit(user.firmId, user.id, 'profile', profile.id, 'profile.created', { kind: profile.kind });
      persist();
      return profile;
    },
    updateProfile(user, profileId, patch) {
      requirePermission(user, 'profiles:write');
      if (patch.kind === 'client') { patch.stage = null; patch.stageOrderIndex = null; }
      if (patch.kind === 'prospect' && !patch.stage) { patch.stage = 'discovery'; }
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const nextPatch = { ...patch };
      if ('ssn' in nextPatch) {
        profile.pii = { ...(profile.pii || { maskingPolicy: 'role_based' }), ssnCiphertext: encryptValue(nextPatch.ssn), taxIdCiphertext: profile.pii?.taxIdCiphertext || null };
        delete nextPatch.ssn;
      }
      if ('taxId' in nextPatch) {
        profile.pii = { ...(profile.pii || { maskingPolicy: 'role_based' }), ssnCiphertext: profile.pii?.ssnCiphertext || null, taxIdCiphertext: encryptValue(nextPatch.taxId) };
        delete nextPatch.taxId;
      }
      Object.assign(profile, nextPatch, { updatedAt: now() });
      addAudit(user.firmId, user.id, 'profile', profileId, 'profile.updated', { fields: Object.keys(patch) });
      persist();
      return profile;
    },
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      return this.reorderBoard(user, { profileId, toStage: stage, beforeProfileId });
    },
    reorderBoard(user, input) {
      requirePermission(user, 'pipeline:write');
      const { profileId, toStage, beforeProfileId = null, expectedVersion = null, expectedUpdatedAt = null, expectedBoardVersion = null } = input || {};
      if (!profileId || !toStage) {
        throw new Error('Reorder payload must include profileId and toStage.');
      }
      if (!BOARD_COLUMNS.includes(toStage)) {
        throw new Error(`Unknown stage: ${toStage}.`);
      }

      try {
        return executePipelineTransaction(() => {
          const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
          if (!profile) throw new Error('Profile not found.');

          const currentVersion = Number(profile.pipelineVersion || 1);
          if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
            throw pipelineConflict('Profile ordering version mismatch.', {
              profileId,
              expectedVersion: Number(expectedVersion),
              actualVersion: currentVersion,
              profileUpdatedAt: profile.updatedAt
            });
          }
          if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(profile.updatedAt)) {
            throw pipelineConflict('Profile updatedAt mismatch.', {
              profileId,
              expectedUpdatedAt,
              actualUpdatedAt: profile.updatedAt
            });
          }
          const boardVersion = getBoardVersion(user.firmId);
          if (expectedBoardVersion !== null && Number(expectedBoardVersion) !== Number(boardVersion)) {
            throw pipelineConflict('Board version mismatch.', {
              expectedBoardVersion: Number(expectedBoardVersion),
              actualBoardVersion: Number(boardVersion)
            });
          }

          const destinationCards = listProspectsByStage(user.firmId, toStage, profile.id);
          let insertIndex = destinationCards.length;
          if (beforeProfileId) {
            insertIndex = destinationCards.findIndex((entry) => entry.id === beforeProfileId);
            if (insertIndex < 0) {
              throw new Error('beforeProfileId was not found in the destination stage.');
            }
          }

          const previousStage = profile.stage || null;
          const movedAt = now();
          profile.kind = 'prospect';
          profile.stage = toStage;
          profile.updatedAt = movedAt;
          profile.pipelineVersion = currentVersion + 1;

          destinationCards.splice(insertIndex, 0, profile);
          destinationCards.forEach((card, index) => {
            card.stageOrderIndex = index + 1;
          });

          if (previousStage && previousStage !== toStage) {
            compactStageIndices(user.firmId, previousStage);
          }

          normalizePipelineIndices(user.firmId, toStage);
          const normalized = normalizePipelineIndices(user.firmId, previousStage);
          if (normalized.length > 0) {
            addAudit(user.firmId, user.id, 'pipeline', profile.id, 'pipeline.indices_normalized', { stages: normalized }, { persist: false });
          }
          bumpBoardVersion(user.firmId);
          state.stageChanges.push({ id: randomUUID(), firmId: user.firmId, clientId: profile.id, fromStage: previousStage, toStage, changedByUserId: user.id, changedAt: movedAt });
          addAudit(user.firmId, user.id, 'profile', profile.id, 'pipeline.stage_changed', { fromStage: previousStage, toStage, beforeProfileId }, { persist: false });
          return {
            moved: profile,
            board: buildBoardPayload(user),
            conflict: null
          };
        });
      } catch (error) {
        if (error?.code === 'PIPELINE_ORDER_CONFLICT') {
          error.details = {
            ...(error.details || {}),
            serverBoard: buildBoardPayload(user, {
              code: error.code,
              message: error.message
            })
          };
        }
        throw error;
      }
    },
    normalizeBoardOrdering(user) {
      requirePermission(user, 'pipeline:write');
      return executePipelineTransaction(() => {
        const normalizedStages = normalizePipelineIndices(user.firmId);
        if (normalizedStages.length > 0) {
          bumpBoardVersion(user.firmId);
          addAudit(user.firmId, user.id, 'pipeline', user.firmId, 'pipeline.indices_normalized', { stages: normalizedStages }, { persist: false });
        }
        return {
          normalizedStages,
          board: buildBoardPayload(user),
          changed: normalizedStages.length > 0
        };
      });
    },
    getBoard(user) {
      requirePermission(user, 'profiles:read');
      normalizePipelineIndices(user.firmId);
      return buildBoardPayload(user);
    },
    listStageHistory(user, profileId) {
      requirePermission(user, 'profiles:read');
      return state.stageChanges.filter((entry) => entry.firmId === user.firmId && entry.clientId === profileId);
    },
    createHousehold(user, input) {
      requirePermission(user, 'households:write');
      const household = { id: randomUUID(), firmId: user.firmId, name: input.name, primaryClientId: input.primaryClientId, createdAt: now() };
      state.households.push(household);
      state.householdMembers.push({ householdId: household.id, clientId: input.primaryClientId, role: 'primary', firmId: user.firmId, createdAt: household.createdAt });
      const profile = state.profiles.find((entry) => entry.id === input.primaryClientId && entry.firmId === user.firmId);
      if (profile) profile.householdId = household.id;
      addAudit(user.firmId, user.id, 'household', household.id, 'household.created', { name: household.name });
      persist();
      return household;
    },
    addHouseholdMember(user, householdId, input) {
      requirePermission(user, 'households:write');
      const household = state.households.find((entry) => entry.id === householdId && entry.firmId === user.firmId);
      if (!household) throw new Error('Household not found.');
      const member = { householdId, clientId: input.clientId, role: input.role, firmId: user.firmId, createdAt: now() };
      state.householdMembers.push(member);
      const profile = state.profiles.find((entry) => entry.id === input.clientId && entry.firmId === user.firmId);
      if (profile) profile.householdId = householdId;
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_added', input);
      persist();
      return member;
    },
    listHouseholds(user) {
      requirePermission(user, 'profiles:read');
      return state.households.filter((entry) => entry.firmId === user.firmId).map((household) => ({
        ...household,
        members: state.householdMembers.filter((member) => member.firmId === user.firmId && member.householdId === household.id)
      }));
    },
    listNotes(user, profileId) {
      requirePermission(user, 'profiles:read');
      return state.notes.filter((entry) => entry.firmId === user.firmId && entry.profileId === profileId).slice().reverse();
    },
    addNote(user, profileId, body) {
      requirePermission(user, 'profiles:write');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const note = { id: randomUUID(), firmId: user.firmId, profileId, body, createdByUserId: user.id, createdAt: now() };
      state.notes.push(note);
      addAudit(user.firmId, user.id, 'profile_note', note.id, 'profile.note_added', { profileId });
      persist();
      return note;
    },
    listFormTemplates(user) {
      requirePermission(user, 'profiles:read');
      return state.formTemplates.filter((entry) => entry.firmId === user.firmId);
    },
    createFormTemplate(user, input) {
      requirePermission(user, 'forms:write');
      const template = { id: randomUUID(), firmId: user.firmId, name: input.name, description: input.description || '', sections: input.sections || [], createdAt: now(), updatedAt: now() };
      state.formTemplates.push(template);
      addAudit(user.firmId, user.id, 'form_template', template.id, 'form_template.created', { name: template.name });
      persist();
      return template;
    },
    listFormSubmissions(user, status = null) {
      requirePermission(user, 'profiles:read');
      return state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => !status || entry.status === status)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
    },
    getClientWorkspace(user) {
      const profile = requireClientProfile(user);
      const submissions = state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId && entry.clientId === profile.id)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      const templates = state.formTemplates
        .filter((entry) => entry.firmId === user.firmId)
        .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description || '', sections: entry.sections || [] }));
      const uploads = state.documentUploads
        .filter((entry) => entry.firmId === user.firmId && entry.clientId === profile.id)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      const submissionByTemplate = new Map();
      submissions.forEach((submission) => {
        if (!submissionByTemplate.has(submission.templateId)) submissionByTemplate.set(submission.templateId, submission.status);
      });
      const templateProgress = templates.map((template) => ({
        templateId: template.id,
        templateName: template.name,
        status: submissionByTemplate.get(template.id) || 'not_started'
      }));
      return { profile, submissions, templates, templateProgress, uploads };
    },
    submitClientForm(user, input) {
      requirePermission(user, 'client:write');
      const profile = requireClientProfile(user);
      const template = state.formTemplates.find((entry) => entry.id === input.templateId && entry.firmId === user.firmId);
      if (!template) throw new Error('Form template not found.');
      const status = input.status === 'draft' ? 'draft' : 'submitted';
      const submission = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        templateId: input.templateId,
        status,
        data: input.data && typeof input.data === 'object' ? input.data : {},
        source: 'client_portal',
        createdAt: now(),
        updatedAt: now()
      };
      state.formSubmissions.push(submission);
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'client.form_submission.created', { templateId: input.templateId, status });
      persist();
      return submission;
    },
    submitClientUpload(user, input) {
      requirePermission(user, 'client:write');
      const profile = requireClientProfile(user);
      const upload = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        name: input.name || 'Client upload',
        category: input.category || 'general',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'client',
        notes: input.notes || '',
        createdAt: now(),
        updatedAt: now()
      };
      state.documentUploads.push(upload);
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'client.document_upload.created', { category: upload.category });
      persist();
      return upload;
    },
    listFormDrafts(user) {
      return this.listFormSubmissions(user, 'draft');
    },
    createFormSubmission(user, input) {
      requirePermission(user, 'forms:write');
      const submission = { id: randomUUID(), firmId: user.firmId, clientId: input.clientId, templateId: input.templateId, status: input.status || 'draft', data: input.data || {}, createdAt: now(), updatedAt: now() };
      state.formSubmissions.push(submission);
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.created', { templateId: input.templateId, clientId: input.clientId });
      persist();
      return submission;
    },
    listDocumentTemplates(user) {
      requirePermission(user, 'templates:write');
      return state.documentTemplates.filter((entry) => entry.firmId === user.firmId);
    },
    createDocumentTemplate(user, input) {
      requirePermission(user, 'templates:write');
      const template = { id: randomUUID(), firmId: user.firmId, name: input.name, fileName: input.fileName || 'template.pdf', blueprint: input.blueprint || { sections: [] }, mappings: input.mappings || [], versions: [{ version: 1, blueprint: input.blueprint || { sections: [] }, mappings: input.mappings || [], createdAt: now() }], status: 'draft', createdAt: now(), updatedAt: now() };
      state.documentTemplates.push(template);
      addAudit(user.firmId, user.id, 'document_template', template.id, 'document_template.created', { name: template.name });
      persist();
      return template;
    },
    updateTemplateMappings(user, templateId, mappings) {
      requirePermission(user, 'templates:write');
      const template = state.documentTemplates.find((entry) => entry.id === templateId && entry.firmId === user.firmId);
      if (!template) throw new Error('Template not found.');
      template.mappings = mappings;
      template.versions.push({ version: template.versions.length + 1, blueprint: template.blueprint, mappings, createdAt: now() });
      template.updatedAt = now();
      addAudit(user.firmId, user.id, 'document_template', template.id, 'document_template.mappings_updated', { count: mappings.length });
      persist();
      return template;
    },
    publishTemplate(user, templateId) {
      requirePermission(user, 'templates:write');
      const template = state.documentTemplates.find((entry) => entry.id === templateId && entry.firmId === user.firmId);
      if (!template) throw new Error('Template not found.');
      template.status = 'published';
      template.updatedAt = now();
      persist();
      return template;
    },
    listExports(user) {
      requirePermission(user, 'exports:write');
      state.exportJobs = listExportQueueJobs();
      return state.exportJobs.filter((entry) => entry.firmId === user.firmId);
    },
    createExport(user, input) {
      requirePermission(user, 'exports:write');
      const queued = enqueueExportJob({
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        templateId: input.templateId,
        type: input.type || 'pdf',
        maxAttempts: Number(input.maxAttempts || 3),
        metadata: input.metadata || {}
      });
      addAudit(user.firmId, user.id, 'export_job', queued.id, 'export_job.created', { clientId: input.clientId, templateId: input.templateId, type: queued.type });
      state.exportJobs = state.exportJobs.filter((entry) => entry.id !== queued.id);
      state.exportJobs.push(queued);
      persist();
      return queued;
    },
    retryExport(user, exportId) {
      requirePermission(user, 'exports:write');
      const job = state.exportJobs.find((entry) => entry.id === exportId && entry.firmId === user.firmId);
      if (!job) throw new Error('Export not found.');
      const updated = requeueExportJob(exportId);
      if (!updated) throw new Error('Export not found.');
      state.exportJobs = state.exportJobs.map((entry) => (entry.id === exportId ? updated : entry));
      persist();
      return updated;
    },
    processQueuedExports() {
      const result = processExportQueueTick({
        workerId: 'api-process-endpoint',
        limit: 10,
        leaseMs: 15_000,
        processor(job) {
          const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0);
          if (failCount > 0) {
            job.metadata.simulateFailuresRemaining = failCount - 1;
            throw new Error(`Simulated export failure for ${job.id}`);
          }
          return { fileName: `${job.type}-${Date.now()}.json`, preview: { clientId: job.clientId, templateId: job.templateId } };
        }
      });
      return { processed: result.processed, leased: result.leased, failed: result.failed };
    },
    listAudit(user) {
      requirePermission(user, 'profiles:read');
      return state.auditEvents.filter((entry) => entry.firmId === user.firmId).slice().reverse();
    },
    logout(token) {
      state.sessions = state.sessions.filter((entry) => entry.token !== token);
      persist();
      return { ok: true };
    },
    listUsers(user) {
      requirePermission(user, 'analytics:read');
      return state.users.filter((entry) => entry.firmId === user.firmId).map(publicUser);
    },
    inviteUser(user, input) {
      requirePermission(user, 'profiles:write');
      const invite = { id: randomUUID(), firmId: user.firmId, email: input.email.toLowerCase(), role: input.role || 'advisor', invitedByUserId: user.id, token: randomUUID(), createdAt: now() };
      state.invites.push(invite);
      addAudit(user.firmId, user.id, 'invite', invite.id, 'invite.created', { email: invite.email, role: invite.role });
      persist();
      return invite;
    },
    acceptInvite(input) {
      assertStrongPassword(input.password);
      const invite = state.invites.find((entry) => entry.token === input.token);
      if (!invite) throw new Error('Invite not found.');
      const user = { id: randomUUID(), firmId: invite.firmId, email: invite.email, passwordHash: hash(input.password), firstName: input.firstName, lastName: input.lastName, role: invite.role, createdAt: now() };
      state.users.push(user);
      state.invites = state.invites.filter((entry) => entry.id !== invite.id);
      persist();
      return createSession(user);
    },
    requestPasswordReset(email) {
      return auth.requestReset({ email });
    },
    resetPassword(input) {
      return auth.resetPassword(input);
    },
    removeHouseholdMember(user, householdId, clientId) {
      requirePermission(user, 'households:write');
      state.householdMembers = state.householdMembers.filter((entry) => !(entry.householdId === householdId && entry.clientId === clientId && entry.firmId === user.firmId));
      const profile = state.profiles.find((entry) => entry.id === clientId && entry.firmId === user.firmId);
      if (profile) profile.householdId = null;
      persist();
      return { ok: true };
    },
    linkSpouse(user, primaryClientId, spouseClientId) {
      requirePermission(user, 'households:write');
      const primary = state.profiles.find((entry) => entry.id === primaryClientId && entry.firmId === user.firmId);
      const spouse = state.profiles.find((entry) => entry.id === spouseClientId && entry.firmId === user.firmId);
      if (!primary || !spouse) throw new Error('Profile not found.');
      primary.spouseClientId = spouse.id;
      spouse.spouseClientId = primary.id;
      let householdId = primary.householdId;
      if (!householdId) {
        householdId = this.createHousehold(user, { name: `${primary.lastName} Household`, primaryClientId: primary.id }).id;
      }
      spouse.householdId = householdId;
      state.householdMembers.push({ householdId, clientId: spouse.id, role: 'spouse', firmId: user.firmId, createdAt: now() });
      persist();
      return { primary, spouse };
    },
    createSpouse(user, primaryClientId, input) {
      const spouse = this.createProfile(user, { ...input, kind: 'client' });
      this.linkSpouse(user, primaryClientId, spouse.id);
      return spouse;
    },
    updateSubmission(user, submissionId, patch) {
      requirePermission(user, 'forms:write');
      const submission = state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === user.firmId);
      if (!submission) throw new Error('Submission not found.');
      Object.assign(submission, patch, { updatedAt: now() });
      persist();
      return submission;
    },
    deleteSubmission(user, submissionId) {
      requirePermission(user, 'forms:write');
      state.formSubmissions = state.formSubmissions.filter((entry) => !(entry.id === submissionId && entry.firmId === user.firmId));
      persist();
      return { ok: true };
    },
    autoBuildTemplate(user, input) {
      requirePermission(user, 'templates:write');
      const sections = (input.fields || []).reduce((acc, field) => {
        const sectionKey = field.split('.')[0] || 'general';
        acc[sectionKey] ||= [];
        acc[sectionKey].push(field);
        return acc;
      }, {});
      return this.createDocumentTemplate(user, { name: input.name, fileName: input.fileName || 'uploaded.pdf', blueprint: { sections }, mappings: (input.fields || []).map((field) => ({ pdfField: field, sourcePath: field.replace(/\s+/g, '_').toLowerCase() })) });
    },
    createPortalLink(user, profileId) {
      requirePermission(user, 'profiles:read');
      const link = { id: randomUUID(), firmId: user.firmId, profileId, token: randomUUID(), createdAt: now() };
      state.portalLinks.push(link);
      persist();
      return link;
    },
    getPortalData(token) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const firm = state.firms.find((entry) => entry.id === link.firmId) || null;
      const profile = state.profiles.find((entry) => entry.id === link.profileId && entry.firmId === link.firmId);
      const submissions = state.formSubmissions
        .filter((entry) => entry.clientId === link.profileId && entry.firmId === link.firmId)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      const availableTemplates = state.formTemplates
        .filter((entry) => entry.firmId === link.firmId)
        .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description || '', sections: entry.sections || [] }));
      const uploads = state.documentUploads
        .filter((entry) => entry.firmId === link.firmId && entry.clientId === link.profileId)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      return { firm, profile, submissions, availableTemplates, uploads };
    },
    portalSubmit(token, input) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const templateId = input.templateId || 'portal';
      const template = templateId === 'portal' ? null : state.formTemplates.find((entry) => entry.id === templateId && entry.firmId === link.firmId);
      if (templateId !== 'portal' && !template) throw new Error('Form template not found.');
      const status = input.status === 'draft' ? 'draft' : 'submitted';
      const submission = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        templateId,
        status,
        data: input.data && typeof input.data === 'object' ? input.data : {},
        createdAt: now(),
        updatedAt: now(),
        source: 'portal'
      };
      state.formSubmissions.push(submission);
      persist();
      return submission;
    },
    portalUpload(token, input) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const upload = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        name: input.name || 'Portal upload',
        category: input.category || 'general',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'portal',
        notes: input.notes || '',
        createdAt: now(),
        updatedAt: now()
      };
      state.documentUploads.push(upload);
      persist();
      return upload;
    },
    getAnalytics(user) {
      requirePermission(user, 'analytics:read');
      const prospects = state.profiles.filter((entry) => entry.firmId === user.firmId && entry.kind === 'prospect');
      const stageCounts = prospects.reduce((acc, profile) => {
        acc[profile.stage || 'unassigned'] = (acc[profile.stage || 'unassigned'] || 0) + 1;
        return acc;
      }, {});
      return {
        stageCounts,
        profileCount: state.profiles.filter((entry) => entry.firmId === user.firmId).length,
        householdCount: state.households.filter((entry) => entry.firmId === user.firmId).length,
        exportCount: state.exportJobs.filter((entry) => entry.firmId === user.firmId).length,
        templateCount: state.documentTemplates.filter((entry) => entry.firmId === user.firmId).length
      };
    },
    getMaskedSensitiveData(user, profileId) {
      requirePermission(user, 'profiles:read');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const ssn = decryptValue(profile.pii?.ssnCiphertext);
      const taxId = decryptValue(profile.pii?.taxIdCiphertext);
      return {
        ssnMasked: ssn ? `***-**-${ssn.slice(-4)}` : null,
        taxIdMasked: taxId ? `**-${taxId.slice(-4)}` : null
      };
    },
    __setTestHooks(hooks = {}) {
      testHooks = { ...hooks };
    },
    __clearTestHooks() {
      testHooks = {};
    }
  };
}
