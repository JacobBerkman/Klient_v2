import test from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'

import {
  resolveGoogleOidcConfig,
  evaluateGoogleOidcRuntime,
  generatePkcePair,
  buildGoogleAuthorizationUrl,
  validateGoogleIdToken,
  createGoogleOidcProvider,
  createJwksCache,
  GoogleOidcError,
  GOOGLE_JWKS_URI,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_AUTHORIZATION_ENDPOINT
} from '../auth/google-oidc.mjs'

// --- test key material -------------------------------------------------------

function makeRsaKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
  return { publicKey, privateKey, jwk }
}

const KEY = makeRsaKey('kid-primary')
const OTHER_KEY = makeRsaKey('kid-primary') // same kid, different key -> bad signature

const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

function signIdToken({ privateKey = KEY.privateKey, kid = 'kid-primary', alg = 'RS256', claims }) {
  const header = base64url(JSON.stringify({ alg, kid, typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  const signingInput = `${header}.${payload}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

function baseClaims(overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-subject-1',
    email: 'advisor@pilotfirm.test',
    email_verified: true,
    given_name: 'Ada',
    family_name: 'Advisor',
    iat: Math.floor(FIXED_NOW / 1000) - 30,
    exp: Math.floor(FIXED_NOW / 1000) + 3600,
    nonce: 'nonce-abc',
    ...overrides
  }
}

// --- config gating -----------------------------------------------------------

test('resolveGoogleOidcConfig: disabled when unset', () => {
  const config = resolveGoogleOidcConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.redirectUri, null)
})

test('resolveGoogleOidcConfig: enabled with both id+secret and explicit redirect', () => {
  const config = resolveGoogleOidcConfig({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'shhh',
    GOOGLE_REDIRECT_URI: 'https://app.example.com/api/auth/google/callback'
  })
  assert.equal(config.enabled, true)
  assert.equal(config.redirectUri, 'https://app.example.com/api/auth/google/callback')
  assert.equal(config.issues.length, 0)
})

test('resolveGoogleOidcConfig: derives redirect from APP_BASE_URL', () => {
  const config = resolveGoogleOidcConfig({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'shhh',
    APP_BASE_URL: 'https://klient.example.com/'
  })
  assert.equal(config.redirectUri, 'https://klient.example.com/api/auth/google/callback')
})

test('resolveGoogleOidcConfig: partial config disables and warns', () => {
  const config = resolveGoogleOidcConfig({ GOOGLE_CLIENT_ID: CLIENT_ID })
  assert.equal(config.enabled, false)
  assert.equal(config.partial, true)
  assert.ok(config.warnings.some((w) => /BOTH GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/.test(w)))
})

test('resolveGoogleOidcConfig: enabled without derivable redirect raises an issue', () => {
  const config = resolveGoogleOidcConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'shhh' })
  assert.equal(config.redirectUri, null)
  assert.ok(config.issues.some((i) => /GOOGLE_REDIRECT_URI/.test(i)))
})

test('evaluateGoogleOidcRuntime: strict mode escalates non-https redirect to an issue', () => {
  const result = evaluateGoogleOidcRuntime(
    {
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'shhh',
      GOOGLE_REDIRECT_URI: 'http://insecure.example.com/api/auth/google/callback'
    },
    { strict: true }
  )
  assert.ok(result.issues.some((i) => /https/i.test(i)))
})

// --- PKCE + authorization URL ------------------------------------------------

test('generatePkcePair: challenge is S256 of the verifier and both are base64url', () => {
  const { codeVerifier, codeChallenge } = generatePkcePair()
  assert.match(codeVerifier, /^[A-Za-z0-9_-]+$/)
  assert.match(codeChallenge, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(codeVerifier, codeChallenge)
})

test('buildGoogleAuthorizationUrl: includes PKCE S256, state, nonce, and redirect', () => {
  const url = new URL(
    buildGoogleAuthorizationUrl({
      clientId: CLIENT_ID,
      redirectUri: 'https://app.example.com/api/auth/google/callback',
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1'
    })
  )
  assert.ok(`${url.origin}${url.pathname}` === GOOGLE_AUTHORIZATION_ENDPOINT)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1')
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.equal(url.searchParams.get('nonce'), 'nonce-1')
})

// --- id_token validation -----------------------------------------------------

const validateArgs = (idToken, overrides = {}) => ({
  idToken,
  clientId: CLIENT_ID,
  nonce: 'nonce-abc',
  jwks: [KEY.jwk],
  now: FIXED_NOW,
  ...overrides
})

test('validateGoogleIdToken: accepts a well-formed token', () => {
  const token = signIdToken({ claims: baseClaims() })
  const claims = validateGoogleIdToken(validateArgs(token))
  assert.equal(claims.email, 'advisor@pilotfirm.test')
  assert.equal(claims.emailVerified, true)
  assert.equal(claims.subject, 'google-subject-1')
  assert.equal(claims.firstName, 'Ada')
})

test('validateGoogleIdToken: rejects wrong audience', () => {
  const token = signIdToken({ claims: baseClaims({ aud: 'someone-else.apps.googleusercontent.com' }) })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => err.code === 'oidc_token_invalid' && /audience/.test(err.message))
})

test('validateGoogleIdToken: rejects wrong issuer', () => {
  const token = signIdToken({ claims: baseClaims({ iss: 'https://evil.example.com' }) })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => /issuer/.test(err.message))
})

test('validateGoogleIdToken: rejects an expired token', () => {
  const token = signIdToken({ claims: baseClaims({ exp: Math.floor(FIXED_NOW / 1000) - 3600 }) })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => /expired/.test(err.message))
})

test('validateGoogleIdToken: rejects a nonce mismatch', () => {
  const token = signIdToken({ claims: baseClaims({ nonce: 'a-different-nonce' }) })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => /nonce/.test(err.message))
})

test('validateGoogleIdToken: rejects unverified email', () => {
  const token = signIdToken({ claims: baseClaims({ email_verified: false }) })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => err.code === 'oidc_email_unverified')
})

test('validateGoogleIdToken: rejects a bad signature (kid matches, key differs)', () => {
  const token = signIdToken({ privateKey: OTHER_KEY.privateKey, claims: baseClaims() })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => /signature/.test(err.message))
})

test('validateGoogleIdToken: rejects a non-RS256 alg', () => {
  const token = signIdToken({ alg: 'none', claims: baseClaims() })
  assert.throws(() => validateGoogleIdToken(validateArgs(token)), (err) => /alg/.test(err.message))
})

test('validateGoogleIdToken: rejects when no JWKS key matches the kid', () => {
  const token = signIdToken({ claims: baseClaims() })
  assert.throws(
    () => validateGoogleIdToken(validateArgs(token, { jwks: [{ ...KEY.jwk, kid: 'other-kid' }] })),
    (err) => /kid/i.test(err.message)
  )
})

// --- JWKS cache --------------------------------------------------------------

test('createJwksCache: caches keys and refetches after expiry', async () => {
  let calls = 0
  let clock = 1000
  const cache = createJwksCache({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1
      return { ok: true, headers: { get: () => 'max-age=1' }, json: async () => ({ keys: [KEY.jwk] }) }
    }
  })
  await cache.getKeys()
  await cache.getKeys()
  assert.equal(calls, 1) // second read served from cache
  clock += 5000 // advance past the 1s max-age
  await cache.getKeys()
  assert.equal(calls, 2)
})

// --- provider: state lifecycle + completeLogin -------------------------------

function createMemoryStateStore() {
  const rows = new Map()
  return {
    rows,
    insertLoginState(row) {
      rows.set(row.state, { ...row, usedAt: null })
    },
    findLoginStateByState(state) {
      return rows.get(state) || null
    },
    markLoginStateUsed(state, usedAt) {
      const row = rows.get(state)
      if (!row || row.usedAt) return 0
      row.usedAt = usedAt
      return 1
    }
  }
}

function tokenFetch({ idToken, tokenOk = true } = {}) {
  return async (urlArg, options = {}) => {
    const target = String(urlArg)
    if (target === GOOGLE_JWKS_URI) {
      return { ok: true, headers: { get: () => 'max-age=3600' }, json: async () => ({ keys: [KEY.jwk] }) }
    }
    if (target === GOOGLE_TOKEN_ENDPOINT) {
      assert.equal(options.method, 'POST')
      assert.match(String(options.body), /grant_type=authorization_code/)
      assert.match(String(options.body), /code_verifier=/)
      return { ok: tokenOk, headers: { get: () => null }, json: async () => ({ id_token: idToken }) }
    }
    throw new Error(`unexpected fetch: ${target}`)
  }
}

const ENABLED_CONFIG = {
  enabled: true,
  clientId: CLIENT_ID,
  clientSecret: 'shhh',
  redirectUri: 'https://app.example.com/api/auth/google/callback'
}

function buildProvider({ storage, fetchImpl, getUserByEmail, sessions = [], now = () => FIXED_NOW }) {
  return createGoogleOidcProvider({
    config: ENABLED_CONFIG,
    storage,
    fetchImpl,
    now,
    getUserByEmail,
    createSession(user) {
      const session = { token: `session-${sessions.length + 1}`, user: { id: user.id, firmId: user.firmId } }
      sessions.push(session)
      return session
    }
  })
}

test('provider is inert when config is disabled (routes would 404)', async () => {
  const provider = createGoogleOidcProvider({
    config: { enabled: false },
    storage: createMemoryStateStore(),
    createSession: () => ({ token: 'x', user: {} }),
    getUserByEmail: () => null
  })
  assert.equal(provider.isEnabled(), false)
  assert.deepEqual(provider.getPublicConfig(), { enabled: false })
  await assert.rejects(() => provider.startLogin(), (err) => err.code === 'oidc_disabled')
  await assert.rejects(() => provider.completeLogin({ state: 's', code: 'c' }), (err) => err.code === 'oidc_disabled')
})

test('startLogin persists a single-use state row and returns a Google URL', async () => {
  const storage = createMemoryStateStore()
  const provider = buildProvider({ storage, fetchImpl: tokenFetch(), getUserByEmail: () => null })
  const { authorizationUrl, state } = await provider.startLogin()
  assert.ok(authorizationUrl.startsWith(GOOGLE_AUTHORIZATION_ENDPOINT))
  const row = storage.rows.get(state)
  assert.ok(row.codeVerifier)
  assert.ok(row.nonce)
  assert.equal(row.usedAt, null)
})

test('completeLogin establishes a session for a matching pilot user (MFA skipped)', async () => {
  const storage = createMemoryStateStore()
  const sessions = []
  const audits = []
  const user = { id: 'user-1', firmId: 'firm-1', email: 'advisor@pilotfirm.test', mfa: { enabled: true } }

  const provider = createGoogleOidcProvider({
    config: ENABLED_CONFIG,
    storage,
    now: () => FIXED_NOW,
    getUserByEmail: (email) => (email === 'advisor@pilotfirm.test' ? user : null),
    createSession(u) {
      const session = { token: 'session-token', user: { id: u.id, firmId: u.firmId } }
      sessions.push(session)
      return session
    },
    addAudit: (firmId, actorId, entityType, entityId, action, changeSet) =>
      audits.push({ firmId, action, changeSet }),
    fetchImpl: null // set below
  })

  const { state } = await provider.startLogin()
  const nonce = storage.rows.get(state).nonce
  const idToken = signIdToken({ claims: baseClaims({ nonce }) })
  // Re-create with a fetch bound to this id_token (provider closes over fetchImpl).
  const provider2 = createGoogleOidcProvider({
    config: ENABLED_CONFIG,
    storage,
    now: () => FIXED_NOW,
    getUserByEmail: (email) => (email === 'advisor@pilotfirm.test' ? user : null),
    createSession(u) {
      const session = { token: 'session-token', user: { id: u.id, firmId: u.firmId } }
      sessions.push(session)
      return session
    },
    addAudit: (firmId, actorId, entityType, entityId, action, changeSet) =>
      audits.push({ firmId, action, changeSet }),
    fetchImpl: tokenFetch({ idToken })
  })

  const result = await provider2.completeLogin({ state, code: 'auth-code' })
  assert.equal(result.session.token, 'session-token')
  assert.equal(result.email, 'advisor@pilotfirm.test')
  assert.equal(sessions.length, 1)
  const loginAudit = audits.find((a) => a.action === 'auth.login')
  assert.ok(loginAudit)
  assert.equal(loginAudit.changeSet.after.method, 'google_oidc')
  assert.equal(loginAudit.changeSet.after.mfaSkipped, true)
})

test('completeLogin refuses an unknown email (no auto-provisioning)', async () => {
  const storage = createMemoryStateStore()
  const provider = buildProvider({ storage, fetchImpl: tokenFetch(), getUserByEmail: () => null })
  const { state } = await provider.startLogin()
  const nonce = storage.rows.get(state).nonce
  const idToken = signIdToken({ claims: baseClaims({ nonce }) })
  const provider2 = buildProvider({ storage, fetchImpl: tokenFetch({ idToken }), getUserByEmail: () => null })
  await assert.rejects(
    () => provider2.completeLogin({ state, code: 'auth-code' }),
    (err) => err.code === 'oidc_no_account'
  )
})

test('completeLogin rejects a replayed (already-used) state', async () => {
  const storage = createMemoryStateStore()
  const user = { id: 'user-1', firmId: 'firm-1', email: 'advisor@pilotfirm.test' }
  const provider = buildProvider({ storage, fetchImpl: tokenFetch(), getUserByEmail: () => user })
  const { state } = await provider.startLogin()
  const nonce = storage.rows.get(state).nonce
  const idToken = signIdToken({ claims: baseClaims({ nonce }) })
  const provider2 = buildProvider({ storage, fetchImpl: tokenFetch({ idToken }), getUserByEmail: () => user })

  await provider2.completeLogin({ state, code: 'auth-code' }) // first use consumes it
  await assert.rejects(
    () => provider2.completeLogin({ state, code: 'auth-code' }),
    (err) => err.code === 'oidc_state_invalid'
  )
})

test('completeLogin rejects an expired state', async () => {
  const storage = createMemoryStateStore()
  const user = { id: 'user-1', firmId: 'firm-1', email: 'advisor@pilotfirm.test' }
  let clock = FIXED_NOW
  const provider = createGoogleOidcProvider({
    config: ENABLED_CONFIG,
    storage,
    now: () => clock,
    getUserByEmail: () => user,
    createSession: (u) => ({ token: 't', user: { id: u.id, firmId: u.firmId } }),
    fetchImpl: tokenFetch()
  })
  const { state } = await provider.startLogin()
  clock += 20 * 60 * 1000 // 20 minutes later, past the 10-minute TTL
  await assert.rejects(
    () => provider.completeLogin({ state, code: 'auth-code' }),
    (err) => err.code === 'oidc_state_invalid'
  )
})

test('completeLogin rejects a missing state/code', async () => {
  const storage = createMemoryStateStore()
  const provider = buildProvider({ storage, fetchImpl: tokenFetch(), getUserByEmail: () => null })
  await assert.rejects(
    () => provider.completeLogin({ state: '', code: '' }),
    (err) => err.code === 'oidc_invalid_request'
  )
})

test('completeLogin surfaces a provider error param from Google', async () => {
  const storage = createMemoryStateStore()
  const provider = buildProvider({ storage, fetchImpl: tokenFetch(), getUserByEmail: () => null })
  await assert.rejects(
    () => provider.completeLogin({ state: 's', code: '', error: 'access_denied' }),
    (err) => err.code === 'oidc_provider_error'
  )
})

test('GoogleOidcError carries a machine-readable code', () => {
  const err = new GoogleOidcError('oidc_no_account', 'nope')
  assert.equal(err.code, 'oidc_no_account')
  assert.equal(err.name, 'GoogleOidcError')
})
