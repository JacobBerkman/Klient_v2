import test from 'node:test';
import assert from 'node:assert/strict';

import { createOidcAuthProvider } from '../auth/oidc-provider.mjs';
import { createSamlAuthProvider } from '../auth/saml-provider.mjs';

function createHarness(createProvider, hooks) {
  const state = { users: [], firms: [], sessions: [], externalIdentities: [] };
  const provider = createProvider({
    state,
    hooks,
    persist: () => {},
    addAudit: () => {},
    createSession(user) {
      const session = { token: `token-${state.sessions.length + 1}`, userId: user.id };
      state.sessions.push(session);
      return session;
    }
  });
  return { provider, state };
}

const cases = [
  {
    name: 'oidc',
    createProvider: createOidcAuthProvider,
    claims: {
      sub: 'oidc-sub-1',
      email: 'alex@example.com',
      given_name: 'Alex',
      family_name: 'Stone',
      organization: 'Secure Wealth',
      amr: ['pwd', 'mfa']
    }
  },
  {
    name: 'saml',
    createProvider: createSamlAuthProvider,
    claims: {
      nameID: 'saml-sub-1',
      email: 'alex@example.com',
      firstName: 'Alex',
      lastName: 'Stone',
      organization: 'Secure Wealth',
      amr: ['mfa']
    }
  }
];

for (const entry of cases) {
  test(`${entry.name} provider preserves register/login behavior`, () => {
    const { provider, state } = createHarness(entry.createProvider, {
      register: () => ({ claims: entry.claims }),
      authenticate: () => ({ claims: entry.claims })
    });

    const registration = provider.register({ firmName: 'Secure Wealth' });
    assert.ok(registration.token);
    assert.equal(state.users[0].email, 'alex@example.com');
    assert.equal(state.users[0].authProvider, entry.name);
    assert.equal(state.users[0].mfa.enabled, true);

    const login = provider.authenticate({ token: 'id-token' });
    assert.ok(login.token);
    assert.equal(state.users.length, 1);
    assert.equal(state.externalIdentities.length, 1);
  });

  test(`${entry.name} provider request/reset defaults to provider-managed`, () => {
    const { provider } = createHarness(entry.createProvider, {});
    assert.deepEqual(provider.requestReset({ email: 'alex@example.com' }), {
      ok: true,
      providerManaged: true,
      provider: entry.name
    });
    assert.deepEqual(provider.resetPassword({ token: 'abc', password: 'anything' }), {
      ok: true,
      providerManaged: true,
      provider: entry.name
    });
  });

  test(`${entry.name} provider supports MFA challenge hooks`, () => {
    const { provider } = createHarness(entry.createProvider, {
      createMfaChallenge: () => ({ challengeToken: 'challenge-1', methods: ['webauthn'] }),
      verifyMfaChallenge: () => ({ ok: true })
    });

    assert.deepEqual(provider.createMfaChallenge({ id: 'user-1' }), { challengeToken: 'challenge-1', methods: ['webauthn'] });
    assert.deepEqual(provider.verifyMfaChallenge({ id: 'user-1' }, { challengeToken: 'challenge-1' }), { ok: true });
  });

  test(`${entry.name} provider enforces invite email match`, () => {
    const { provider } = createHarness(entry.createProvider, {
      register: () => ({ claims: entry.claims })
    });

    assert.throws(() => provider.register({
      invite: {
        firmId: 'firm-1',
        role: 'advisor',
        email: 'other@example.com'
      }
    }), /Invite email does not match/);
  });
}
