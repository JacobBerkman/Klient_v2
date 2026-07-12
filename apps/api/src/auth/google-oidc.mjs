// Real Google OIDC interactive sign-in (Authorization Code flow + PKCE/S256).
//
// This module is a self-contained, dependency-free implementation of the
// standards-correct Google sign-in flow, built only on node:crypto + fetch. It
// lives ALONGSIDE the local email+password provider — it never replaces it. The
// whole feature is config-gated: it is inert unless GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET are set (see resolveGoogleOidcConfig).
//
// Security model (why each piece exists):
//   - state:  opaque one-time value round-tripped through Google. Because the
//             callback is a GET (no CSRF token/header), the single-use, unexpired
//             state row IS the CSRF/forgery defense for the callback.
//   - PKCE:   an S256 code_challenge is sent on the authorization request; the
//             matching code_verifier (kept server-side, never logged, never sent
//             to the browser) is presented at token exchange. This binds the code
//             to this login even if the code leaks.
//   - nonce:  bound into the authorization request and asserted against the
//             id_token `nonce` claim to defeat id_token replay.
//   - id_token is validated locally: RS256 signature via Google's JWKS (kid
//             lookup, cached with expiry), issuer, audience (our client id),
//             exp/iat with small clock skew, nonce match, and
//             email_verified === true (hard requirement).
//
// MFA interaction (documented + implemented here):
//   A successful Google sign-in with a verified Google identity establishes the
//   session directly and SKIPS the local TOTP/MFA step, even for users who have
//   TOTP enrolled locally. This is standard federated-IdP behavior: Google is the
//   asserting identity provider for this login, so the local second factor is not
//   re-challenged. Local password logins are unaffected and still enforce MFA.
//
// No id_token / access_token is ever persisted; only the transient verified
// claims are used to look up the pilot user, then discarded.
import { createHash, createSign, createVerify, createPublicKey, randomBytes } from 'node:crypto'

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
// Google issues id_tokens with either of these two issuer spellings.
export const GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com'])

export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000
const DEFAULT_CLOCK_SKEW_SECONDS = 60
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000
const CALLBACK_PATH = '/api/auth/google/callback'

// --- small helpers ----------------------------------------------------------

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function base64UrlDecodeToBuffer(value) {
  return Buffer.from(String(value), 'base64url')
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function stripTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '')
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// A typed error whose `.code` the HTTP layer maps to a login redirect param.
export class GoogleOidcError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GoogleOidcError'
    this.code = code
  }
}

// --- configuration (config-gating) ------------------------------------------

// Pure, testable resolution of the Google config from an env-like object.
// enabled requires BOTH client id and secret. The redirect URI is taken from
// GOOGLE_REDIRECT_URI, else derived from APP_BASE_URL (the app's own origin).
export function resolveGoogleOidcConfig(env = {}) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim()
  const explicitRedirectUri = String(env.GOOGLE_REDIRECT_URI || '').trim()
  const appBaseUrl = stripTrailingSlashes(String(env.APP_BASE_URL || '').trim())

  const enabled = Boolean(clientId && clientSecret)
  const partial = Boolean((clientId || clientSecret) && !enabled)

  let redirectUri = explicitRedirectUri
  if (!redirectUri && appBaseUrl) redirectUri = `${appBaseUrl}${CALLBACK_PATH}`

  const issues = []
  const warnings = []

  if (partial) {
    warnings.push(
      'Google sign-in is partially configured: set BOTH GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither. Google sign-in stays disabled.'
    )
  }
  if (appBaseUrl && !isHttpUrl(appBaseUrl)) {
    warnings.push('APP_BASE_URL must be an http(s) URL; it is ignored for Google redirect derivation.')
  }
  if (enabled && !redirectUri) {
    issues.push('Google sign-in requires GOOGLE_REDIRECT_URI, or APP_BASE_URL to derive the callback URL.')
  }
  if (enabled && redirectUri && !isHttpUrl(redirectUri)) {
    issues.push('GOOGLE_REDIRECT_URI must be an http(s) URL.')
  }

  return {
    enabled,
    partial,
    clientId,
    clientSecret,
    redirectUri: redirectUri || null,
    appBaseUrl: appBaseUrl || null,
    issues,
    warnings
  }
}

// Startup diagnostics: escalate config issues to hard failures in production.
export function evaluateGoogleOidcRuntime(env = {}, { strict = false } = {}) {
  const config = resolveGoogleOidcConfig(env)
  const issues = []
  const warnings = [...config.warnings]
  for (const issue of config.issues) {
    if (strict) issues.push(issue)
    else warnings.push(issue)
  }
  if (strict && config.enabled && config.redirectUri && !/^https:\/\//i.test(config.redirectUri)) {
    issues.push('GOOGLE_REDIRECT_URI must use https:// in production.')
  }
  return { config, issues, warnings }
}

// --- PKCE + authorization URL ------------------------------------------------

export function generatePkcePair() {
  const codeVerifier = base64UrlEncode(randomBytes(32))
  const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

export function generateOpaqueToken(bytes = 32) {
  return base64UrlEncode(randomBytes(bytes))
}

export function buildGoogleAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  nonce,
  codeChallenge,
  scope = 'openid email profile',
  prompt = 'select_account'
}) {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', scope)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'online')
  if (prompt) url.searchParams.set('prompt', prompt)
  return url.toString()
}

// --- id_token validation (the security-critical core) ------------------------

function decodeJwt(idToken) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new GoogleOidcError('oidc_token_invalid', 'Malformed id_token.')
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  let header
  let payload
  try {
    header = JSON.parse(base64UrlDecodeToBuffer(encodedHeader).toString('utf8'))
    payload = JSON.parse(base64UrlDecodeToBuffer(encodedPayload).toString('utf8'))
  } catch {
    throw new GoogleOidcError('oidc_token_invalid', 'Unparseable id_token segments.')
  }
  return {
    header,
    payload,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: base64UrlDecodeToBuffer(encodedSignature)
  }
}

function jwkToPublicKey(jwk) {
  return createPublicKey({ key: jwk, format: 'jwk' })
}

function verifyRs256(signingInput, signature, jwk) {
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signingInput)
  verifier.end()
  return verifier.verify(jwkToPublicKey(jwk), signature)
}

// Validate a Google id_token against a set of JWKs. Returns normalized claims or
// throws a GoogleOidcError. `now` is injectable for deterministic tests.
export function validateGoogleIdToken({
  idToken,
  clientId,
  nonce,
  jwks,
  now = Date.now(),
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS
}) {
  const { header, payload, signingInput, signature } = decodeJwt(idToken)

  if (header.alg !== 'RS256') {
    throw new GoogleOidcError('oidc_token_invalid', `Unsupported id_token alg: ${header.alg}.`)
  }
  const keys = Array.isArray(jwks) ? jwks : Array.isArray(jwks?.keys) ? jwks.keys : []
  const matchingKey = header.kid ? keys.find((key) => key.kid === header.kid) : null
  // Strict kid lookup: when the header names a kid, it MUST resolve to a JWKS key
  // (Google always sets kid). Only tokens without a kid fall back to trying all keys.
  if (header.kid && !matchingKey) {
    throw new GoogleOidcError('oidc_token_invalid', 'No matching JWKS key for id_token kid.')
  }
  const candidateKeys = matchingKey ? [matchingKey] : keys
  if (candidateKeys.length === 0) {
    throw new GoogleOidcError('oidc_token_invalid', 'No JWKS key available to verify the id_token.')
  }
  const signatureValid = candidateKeys.some((key) => {
    try {
      return verifyRs256(signingInput, signature, key)
    } catch {
      return false
    }
  })
  if (!signatureValid) {
    throw new GoogleOidcError('oidc_token_invalid', 'id_token signature verification failed.')
  }

  if (!GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new GoogleOidcError('oidc_token_invalid', `Unexpected id_token issuer: ${payload.iss}.`)
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(clientId)) {
    throw new GoogleOidcError('oidc_token_invalid', 'id_token audience does not match the configured client id.')
  }

  const nowSeconds = Math.floor(now / 1000)
  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSeconds < nowSeconds) {
    throw new GoogleOidcError('oidc_token_invalid', 'id_token has expired.')
  }
  if (typeof payload.iat !== 'number' || payload.iat - clockSkewSeconds > nowSeconds) {
    throw new GoogleOidcError('oidc_token_invalid', 'id_token iat is in the future.')
  }

  if (!nonce || payload.nonce !== nonce) {
    throw new GoogleOidcError('oidc_token_invalid', 'id_token nonce mismatch.')
  }

  const email = normalizeEmail(payload.email)
  if (!email) {
    throw new GoogleOidcError('oidc_token_invalid', 'id_token is missing an email claim.')
  }
  if (payload.email_verified !== true) {
    throw new GoogleOidcError('oidc_email_unverified', 'Google email is not verified.')
  }

  return {
    subject: String(payload.sub || ''),
    email,
    emailVerified: true,
    firstName: String(payload.given_name || '').trim(),
    lastName: String(payload.family_name || '').trim(),
    name: String(payload.name || '').trim()
  }
}

// --- JWKS cache (kid lookup, cache with expiry) ------------------------------

export function createJwksCache({ fetchImpl = fetch, jwksUri = GOOGLE_JWKS_URI, now = () => Date.now() } = {}) {
  let cachedKeys = null
  let expiresAtMs = 0

  function parseMaxAgeMs(response) {
    const header = response?.headers?.get?.('cache-control') || ''
    const match = /max-age=(\d+)/i.exec(header)
    if (!match) return DEFAULT_JWKS_TTL_MS
    const seconds = Number(match[1])
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_JWKS_TTL_MS
  }

  async function getKeys({ forceRefresh = false } = {}) {
    if (!forceRefresh && cachedKeys && now() < expiresAtMs) return cachedKeys
    const response = await fetchImpl(jwksUri, { method: 'GET' })
    if (!response || !response.ok) {
      throw new GoogleOidcError('oidc_jwks_unavailable', 'Unable to fetch Google JWKS.')
    }
    const body = await response.json()
    const keys = Array.isArray(body?.keys) ? body.keys : []
    if (keys.length === 0) throw new GoogleOidcError('oidc_jwks_unavailable', 'Google JWKS response contained no keys.')
    cachedKeys = keys
    expiresAtMs = now() + parseMaxAgeMs(response)
    return cachedKeys
  }

  return { getKeys, clear: () => { cachedKeys = null; expiresAtMs = 0 } }
}

// --- token exchange ----------------------------------------------------------

export async function exchangeAuthorizationCode({
  fetchImpl = fetch,
  tokenEndpoint = GOOGLE_TOKEN_ENDPOINT,
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  })
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  })
  if (!response || !response.ok) {
    throw new GoogleOidcError('oidc_exchange_failed', 'Google token exchange failed.')
  }
  const payload = await response.json()
  if (!payload || typeof payload.id_token !== 'string' || !payload.id_token) {
    throw new GoogleOidcError('oidc_exchange_failed', 'Google token response did not include an id_token.')
  }
  return payload
}

// --- service factory ---------------------------------------------------------

// Wires the pure protocol pieces to injected persistence + session helpers.
// storage: { insertLoginState({ state, codeVerifier, nonce, createdAt, expiresAt }),
//            findLoginStateByState(state) -> row|null,
//            markLoginStateUsed(state, usedAtIso) -> changesCount }
export function createGoogleOidcProvider({
  config,
  storage,
  createSession,
  addAudit = () => {},
  getUserByEmail,
  fetchImpl = fetch,
  now = () => Date.now(),
  jwksCache,
  stateTtlMs = LOGIN_STATE_TTL_MS
}) {
  const enabled = Boolean(config?.enabled && config?.redirectUri)
  const cache = jwksCache || createJwksCache({ fetchImpl, now })

  function assertEnabled() {
    if (!enabled) throw new GoogleOidcError('oidc_disabled', 'Google sign-in is not configured.')
  }

  async function startLogin() {
    assertEnabled()
    const state = generateOpaqueToken(32)
    const nonce = generateOpaqueToken(32)
    const { codeVerifier, codeChallenge } = generatePkcePair()
    const createdAt = new Date(now()).toISOString()
    const expiresAt = new Date(now() + stateTtlMs).toISOString()
    // Prune-on-insert (expired or already-used rows) bounds table growth.
    storage.insertLoginState(
      { state, codeVerifier, nonce, createdAt, expiresAt },
      { pruneCutoff: createdAt }
    )
    const authorizationUrl = buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      nonce,
      codeChallenge
    })
    return { authorizationUrl, state }
  }

  // Consumes the state row (single-use, unexpired), exchanges the code, validates
  // the id_token, and matches the verified email to an existing pilot user. On a
  // verified identity it establishes the session directly (MFA skipped — see the
  // module header). No auto-provisioning: an unknown email throws oidc_no_account.
  async function completeLogin({ state, code, error } = {}) {
    assertEnabled()
    if (error) {
      // Google returned an error (e.g. access_denied) instead of a code.
      throw new GoogleOidcError('oidc_provider_error', `Google returned an error: ${error}.`)
    }
    if (!state || !code) {
      throw new GoogleOidcError('oidc_invalid_request', 'Missing state or code on the Google callback.')
    }

    const row = storage.findLoginStateByState(state)
    if (!row) throw new GoogleOidcError('oidc_state_invalid', 'Unknown or expired sign-in state.')
    if (new Date(row.expiresAt).getTime() <= now()) {
      throw new GoogleOidcError('oidc_state_invalid', 'Sign-in state has expired.')
    }
    // Single-use: the first consume flips used_at; a replay sees changes === 0.
    const consumed = storage.markLoginStateUsed(state, new Date(now()).toISOString())
    if (!consumed) throw new GoogleOidcError('oidc_state_invalid', 'Sign-in state was already used.')

    const tokenResponse = await exchangeAuthorizationCode({
      fetchImpl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: row.codeVerifier,
      redirectUri: config.redirectUri
    })

    const jwks = await cache.getKeys()
    let claims
    try {
      claims = validateGoogleIdToken({
        idToken: tokenResponse.id_token,
        clientId: config.clientId,
        nonce: row.nonce,
        jwks,
        now: now()
      })
    } catch (validationError) {
      // A kid we don't have cached yet: refresh JWKS once and retry (key rotation).
      if (validationError?.code === 'oidc_token_invalid' && /kid/i.test(validationError.message)) {
        const refreshed = await cache.getKeys({ forceRefresh: true })
        claims = validateGoogleIdToken({
          idToken: tokenResponse.id_token,
          clientId: config.clientId,
          nonce: row.nonce,
          jwks: refreshed,
          now: now()
        })
      } else {
        throw validationError
      }
    }

    const user = getUserByEmail(claims.email)
    if (!user) {
      throw new GoogleOidcError(
        'oidc_no_account',
        'No account exists for this Google email — ask your administrator for an invite.'
      )
    }

    const session = createSession(user)
    addAudit(user.firmId, user.id, 'user', user.id, 'auth.login', {
      after: { email: user.email, method: 'google_oidc', emailVerified: true, mfaSkipped: true }
    })
    return { session, user, email: claims.email }
  }

  return {
    isEnabled: () => enabled,
    getPublicConfig: () => ({ enabled }),
    startLogin,
    completeLogin
  }
}
