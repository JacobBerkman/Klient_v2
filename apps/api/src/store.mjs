import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { runtime } from './runtime.mjs';
import { loadState, saveState } from './storage.mjs';

const APP_SECRET = createHash('sha256').update(runtime.appSecret).digest();
const PERMISSIONS = {
  admin: ['*'],
  advisor: ['profiles:read', 'profiles:write', 'pipeline:write', 'households:write', 'forms:write', 'templates:write', 'exports:write', 'analytics:read'],
  readonly: ['profiles:read', 'analytics:read'],
  client: ['portal:read']
};

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

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex');
}

function sourceDisplay(source) {
  return `${source.cityOrLocation} X ${source.venue} X ${source.occurredOn}`;
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
    notes: [{ id: randomUUID(), firmId, profileId: prospectOneId, body: 'Follow up after workshop and confirm beneficiary details.', createdByUserId: adminId, createdAt }],
    invites: [],
    passwordResets: [],
    portalLinks: []
  };
}

export function createStore() {
  const state = loadState(seedState);

  function persist() {
    saveState(state);
  }

  function createSession(user) {
    const token = randomUUID();
    state.sessions.push({ token, userId: user.id, firmId: user.firmId, createdAt: now(), expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 8).toISOString() });
    persist();
    return { token, user: publicUser(user) };
  }

  function publicUser(user) {
    return { id: user.id, firmId: user.firmId, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
  }

  function requireUser(token) {
    const session = state.sessions.find((entry) => entry.token === token);
    if (!session) throw new Error('Authentication required.');
    const user = state.users.find((entry) => entry.id === session.userId && entry.firmId === session.firmId);
    if (!user) throw new Error('Authentication required.');
    return publicUser(user);
  }

  function addAudit(firmId, actorUserId, entityType, entityId, action, metadata = {}) {
    state.auditEvents.push({ id: randomUUID(), firmId, actorUserId, entityType, entityId, action, occurredAt: now(), metadata });
    persist();
  }

  function requireHousehold(user, householdId) {
    const household = state.households.find((entry) => entry.id === householdId && entry.firmId === user.firmId);
    if (!household) throw new Error('Household not found.');
    return household;
  }

  function requireProfile(user, profileId) {
    const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
    if (!profile) throw new Error('Profile not found.');
    return profile;
  }

  function getHouseholdMembers(firmId, householdId) {
    return state.householdMembers.filter((entry) => entry.firmId === firmId && entry.householdId === householdId);
  }

  function removeMemberRecords(firmId, householdId, clientId) {
    state.householdMembers = state.householdMembers.filter((entry) => !(entry.firmId === firmId && entry.householdId === householdId && entry.clientId === clientId));
  }

  function upsertHouseholdMember(firmId, householdId, clientId, role) {
    removeMemberRecords(firmId, householdId, clientId);
    const member = { householdId, clientId, role, firmId, createdAt: now() };
    state.householdMembers.push(member);
    return member;
  }

  function assignProfileHousehold(firmId, clientId, householdId) {
    const profile = state.profiles.find((entry) => entry.id === clientId && entry.firmId === firmId);
    if (profile) {
      profile.householdId = householdId;
      profile.updatedAt = now();
    }
    return profile;
  }

  function enforcePrimaryConsistency(firmId, householdId) {
    const household = state.households.find((entry) => entry.id === householdId && entry.firmId === firmId);
    if (!household) return;
    const members = getHouseholdMembers(firmId, householdId);
    const primaryMember = members.find((entry) => entry.role === 'primary');
    if (primaryMember) {
      household.primaryClientId = primaryMember.clientId;
      return;
    }
    if (!members.length) return;
    const fallback = members[0];
    fallback.role = 'primary';
    household.primaryClientId = fallback.clientId;
  }

  return {
    state,
    register({ firmName, firstName, lastName, email, password }) {
      const normalizedEmail = email.toLowerCase();
      if (state.users.some((user) => user.email === normalizedEmail)) throw new Error('An account with this email already exists.');
      const firm = { id: randomUUID(), name: firmName, slug: slugify(firmName), createdAt: now() };
      const user = { id: randomUUID(), firmId: firm.id, email: normalizedEmail, passwordHash: hash(password), firstName, lastName, role: 'admin', createdAt: now() };
      state.firms.push(firm);
      state.users.push(user);
      addAudit(firm.id, user.id, 'firm', firm.id, 'firm.created', { name: firm.name });
      return createSession(user);
    },
    login({ email, password }) {
      const normalizedEmail = email.toLowerCase();
      const user = state.users.find((entry) => entry.email === normalizedEmail && entry.passwordHash === hash(password));
      if (!user) throw new Error('Invalid email or password.');
      return createSession(user);
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
      requirePermission(user, 'pipeline:write');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const sameStage = state.profiles.filter((entry) => entry.firmId === user.firmId && entry.kind === 'prospect' && entry.stage === stage && entry.id !== profileId).sort((a,b)=>(a.stageOrderIndex||0)-(b.stageOrderIndex||0));
      const previousStage = profile.stage || null;
      let nextIndex = sameStage.length + 1;
      if (beforeProfileId) {
        const before = sameStage.find((entry) => entry.id === beforeProfileId);
        if (before) {
          nextIndex = before.stageOrderIndex || 1;
          sameStage.filter((entry) => (entry.stageOrderIndex || 0) >= nextIndex).forEach((entry) => { entry.stageOrderIndex = (entry.stageOrderIndex || 0) + 1; });
        }
      }
      profile.kind = 'prospect';
      profile.stage = stage;
      profile.stageOrderIndex = nextIndex;
      profile.updatedAt = now();
      state.stageChanges.push({ id: randomUUID(), firmId: user.firmId, clientId: profile.id, fromStage: previousStage, toStage: stage, changedByUserId: user.id, changedAt: profile.updatedAt });
      addAudit(user.firmId, user.id, 'profile', profile.id, 'pipeline.stage_changed', { fromStage: previousStage, toStage: stage });
      persist();
      return profile;
    },
    getBoard(user) {
      const columns = ['discovery','gather_oi','analysis','advisor_proposal_meeting','intake','on_boarding','investment_strategy','completed','drop_dead_lead','drop_nurture'];
      return columns.map((stage) => ({
        stage,
        cards: state.profiles
          .filter((profile) => profile.firmId === user.firmId && profile.kind === 'prospect' && profile.stage === stage)
          .sort((a, b) => (a.stageOrderIndex || 0) - (b.stageOrderIndex || 0))
      }));
    },
    listStageHistory(user, profileId) {
      return state.stageChanges.filter((entry) => entry.firmId === user.firmId && entry.clientId === profileId);
    },
    createHousehold(user, input) {
      requirePermission(user, 'households:write');
      requireProfile(user, input.primaryClientId);
      const household = { id: randomUUID(), firmId: user.firmId, name: input.name, primaryClientId: input.primaryClientId, createdAt: now() };
      state.households.push(household);
      upsertHouseholdMember(user.firmId, household.id, input.primaryClientId, 'primary');
      assignProfileHousehold(user.firmId, input.primaryClientId, household.id);
      addAudit(user.firmId, user.id, 'household', household.id, 'household.created', { name: household.name });
      persist();
      return household;
    },
    addHouseholdMember(user, householdId, input) {
      requirePermission(user, 'households:write');
      const household = requireHousehold(user, householdId);
      requireProfile(user, input.clientId);
      const existingPrimary = getHouseholdMembers(user.firmId, householdId).find((entry) => entry.role === 'primary');
      if (input.role === 'primary' && existingPrimary && existingPrimary.clientId !== input.clientId) {
        existingPrimary.role = 'other';
      }
      const member = upsertHouseholdMember(user.firmId, householdId, input.clientId, input.role);
      assignProfileHousehold(user.firmId, input.clientId, householdId);
      if (input.role === 'primary') {
        household.primaryClientId = input.clientId;
      }
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_added', input);
      persist();
      return member;
    },
    updateHouseholdMemberRole(user, householdId, clientId, role) {
      requirePermission(user, 'households:write');
      const household = requireHousehold(user, householdId);
      const member = state.householdMembers.find((entry) => entry.householdId === householdId && entry.clientId === clientId && entry.firmId === user.firmId);
      if (!member) throw new Error('Household member not found.');
      const previousRole = member.role;
      if (role === 'primary') {
        getHouseholdMembers(user.firmId, householdId)
          .filter((entry) => entry.role === 'primary' && entry.clientId !== clientId)
          .forEach((entry) => {
            entry.role = 'other';
          });
        household.primaryClientId = clientId;
      } else if (member.role === 'primary') {
        throw new Error('Primary household member must be reassigned via /reassign-primary.');
      }
      member.role = role;
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_role_changed', { clientId, fromRole: previousRole, toRole: role });
      persist();
      return member;
    },
    reassignHouseholdPrimary(user, householdId, nextPrimaryClientId) {
      requirePermission(user, 'households:write');
      const household = requireHousehold(user, householdId);
      const nextPrimary = state.householdMembers.find((entry) => entry.householdId === householdId && entry.clientId === nextPrimaryClientId && entry.firmId === user.firmId);
      if (!nextPrimary) throw new Error('Household member not found.');
      getHouseholdMembers(user.firmId, householdId)
        .filter((entry) => entry.role === 'primary' && entry.clientId !== nextPrimaryClientId)
        .forEach((entry) => {
          entry.role = 'other';
        });
      const previousPrimaryClientId = household.primaryClientId;
      nextPrimary.role = 'primary';
      household.primaryClientId = nextPrimaryClientId;
      addAudit(user.firmId, user.id, 'household', householdId, 'household.primary_reassigned', { fromClientId: previousPrimaryClientId, toClientId: nextPrimaryClientId });
      persist();
      return household;
    },
    unlinkSpouse(user, clientId) {
      requirePermission(user, 'households:write');
      const profile = requireProfile(user, clientId);
      if (!profile.spouseClientId) throw new Error('Spouse link not found.');
      const spouse = requireProfile(user, profile.spouseClientId);
      const firstId = profile.id;
      const secondId = spouse.id;
      profile.spouseClientId = null;
      spouse.spouseClientId = null;
      const householdId = profile.householdId || spouse.householdId || null;
      if (householdId) {
        const spouseMember = state.householdMembers.find((entry) => entry.firmId === user.firmId && entry.householdId === householdId && entry.clientId === secondId);
        if (spouseMember?.role === 'spouse') spouseMember.role = 'other';
      }
      addAudit(user.firmId, user.id, 'household', householdId || profile.id, 'household.spouse_unlinked', { clientId: firstId, spouseClientId: secondId });
      persist();
      return { clientId: firstId, spouseClientId: secondId };
    },
    mergeHouseholds(user, sourceHouseholdId, targetHouseholdId) {
      requirePermission(user, 'households:write');
      if (sourceHouseholdId === targetHouseholdId) throw new Error('Cannot merge household into itself.');
      const source = requireHousehold(user, sourceHouseholdId);
      const target = requireHousehold(user, targetHouseholdId);
      const sourceMembers = getHouseholdMembers(user.firmId, source.id);
      for (const member of sourceMembers) {
        const desiredRole = member.role === 'primary' ? 'other' : member.role;
        upsertHouseholdMember(user.firmId, target.id, member.clientId, desiredRole);
        assignProfileHousehold(user.firmId, member.clientId, target.id);
      }
      state.householdMembers = state.householdMembers.filter((entry) => !(entry.firmId === user.firmId && entry.householdId === source.id));
      state.households = state.households.filter((entry) => !(entry.firmId === user.firmId && entry.id === source.id));
      enforcePrimaryConsistency(user.firmId, target.id);
      addAudit(user.firmId, user.id, 'household', target.id, 'household.merged', {
        sourceHouseholdId: source.id,
        sourceMemberCount: sourceMembers.length,
        targetHouseholdId: target.id
      });
      persist();
      return target;
    },
    splitHouseholdMember(user, householdId, clientId, target = {}) {
      requirePermission(user, 'households:write');
      const sourceHousehold = requireHousehold(user, householdId);
      const member = state.householdMembers.find((entry) => entry.firmId === user.firmId && entry.householdId === householdId && entry.clientId === clientId);
      if (!member) throw new Error('Household member not found.');
      if (member.role === 'primary') throw new Error('Cannot split the primary member. Reassign primary first.');

      let destinationHouseholdId;
      if (target.targetHouseholdId) {
        destinationHouseholdId = requireHousehold(user, target.targetHouseholdId).id;
      } else {
        const profile = requireProfile(user, clientId);
        const created = this.createHousehold(user, {
          name: target.name || `${profile.lastName || profile.firstName} Household`,
          primaryClientId: clientId
        });
        destinationHouseholdId = created.id;
      }

      removeMemberRecords(user.firmId, householdId, clientId);
      const destinationMembers = getHouseholdMembers(user.firmId, destinationHouseholdId);
      const destinationRole = destinationMembers.length === 0 ? 'primary' : target.role || member.role || 'other';
      if (destinationRole === 'primary') {
        destinationMembers
          .filter((entry) => entry.role === 'primary')
          .forEach((entry) => {
            entry.role = 'other';
          });
      }
      upsertHouseholdMember(user.firmId, destinationHouseholdId, clientId, destinationRole);
      assignProfileHousehold(user.firmId, clientId, destinationHouseholdId);
      enforcePrimaryConsistency(user.firmId, householdId);
      enforcePrimaryConsistency(user.firmId, destinationHouseholdId);
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_split', {
        clientId,
        fromHouseholdId: householdId,
        toHouseholdId: destinationHouseholdId,
        destinationRole
      });
      persist();
      return {
        sourceHousehold,
        destinationHousehold: requireHousehold(user, destinationHouseholdId)
      };
    },
    listHouseholds(user) {
      requirePermission(user, 'profiles:read');
      return state.households.filter((entry) => entry.firmId === user.firmId).map((household) => ({
        ...household,
        members: state.householdMembers.filter((member) => member.firmId === user.firmId && member.householdId === household.id)
      }));
    },
    listNotes(user, profileId) {
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
      return state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => !status || entry.status === status)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
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
      return state.exportJobs.filter((entry) => entry.firmId === user.firmId);
    },
    createExport(user, input) {
      requirePermission(user, 'exports:write');
      const job = { id: randomUUID(), firmId: user.firmId, clientId: input.clientId, templateId: input.templateId, type: input.type || 'pdf', status: 'queued', output: null, createdAt: now(), updatedAt: now() };
      state.exportJobs.push(job);
      addAudit(user.firmId, user.id, 'export_job', job.id, 'export_job.created', { clientId: input.clientId, templateId: input.templateId, type: job.type });
      persist();
      return job;
    },
    retryExport(user, exportId) {
      requirePermission(user, 'exports:write');
      const job = state.exportJobs.find((entry) => entry.id === exportId && entry.firmId === user.firmId);
      if (!job) throw new Error('Export not found.');
      job.status = 'queued';
      job.updatedAt = now();
      persist();
      return job;
    },
    processQueuedExports() {
      let processed = 0;
      for (const job of state.exportJobs) {
        if (job.status === 'queued') {
          job.status = 'completed';
          job.output = { fileName: `${job.type}-${Date.now()}.json`, preview: { clientId: job.clientId, templateId: job.templateId } };
          job.updatedAt = now();
          processed += 1;
        }
      }
      persist();
      return { processed };
    },
    listAudit(user) {
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
      const invite = state.invites.find((entry) => entry.token === input.token);
      if (!invite) throw new Error('Invite not found.');
      const user = { id: randomUUID(), firmId: invite.firmId, email: invite.email, passwordHash: hash(input.password), firstName: input.firstName, lastName: input.lastName, role: invite.role, createdAt: now() };
      state.users.push(user);
      state.invites = state.invites.filter((entry) => entry.id !== invite.id);
      persist();
      return createSession(user);
    },
    requestPasswordReset(email) {
      const user = state.users.find((entry) => entry.email === email.toLowerCase());
      if (!user) return { ok: true };
      const reset = { id: randomUUID(), userId: user.id, token: randomUUID(), createdAt: now() };
      state.passwordResets.push(reset);
      persist();
      return reset;
    },
    resetPassword(input) {
      const reset = state.passwordResets.find((entry) => entry.token === input.token);
      if (!reset) throw new Error('Reset token not found.');
      const user = state.users.find((entry) => entry.id === reset.userId);
      if (!user) throw new Error('User not found.');
      user.passwordHash = hash(input.password);
      state.passwordResets = state.passwordResets.filter((entry) => entry.id !== reset.id);
      persist();
      return { ok: true };
    },
    removeHouseholdMember(user, householdId, clientId) {
      requirePermission(user, 'households:write');
      const member = state.householdMembers.find((entry) => entry.householdId === householdId && entry.clientId === clientId && entry.firmId === user.firmId);
      if (!member) throw new Error('Household member not found.');
      if (member.role === 'primary') throw new Error('Cannot remove primary household member. Reassign primary first.');
      removeMemberRecords(user.firmId, householdId, clientId);
      assignProfileHousehold(user.firmId, clientId, null);
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_removed', { clientId });
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
      assignProfileHousehold(user.firmId, spouse.id, householdId);
      upsertHouseholdMember(user.firmId, householdId, spouse.id, 'spouse');
      addAudit(user.firmId, user.id, 'household', householdId, 'household.spouse_linked', { primaryClientId, spouseClientId });
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
      return { firm, profile, submissions, availableTemplates };
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
    }
  };
}
