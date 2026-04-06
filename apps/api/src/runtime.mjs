import { hostname } from 'node:os'

const DEFAULT_APP_SECRET = 'kinetic-klient-dev-secret'
const MIN_APP_SECRET_LENGTH = 24
const MIN_APP_SECRET_ENTROPY_BITS = 80

function normalizeNodeEnv(value) {
  return ['development', 'test', 'production'].includes(value) ? value : 'development'
}

function readNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}: expected a positive number.`)
  return parsed
}

function readLogLevel(value, fallback) {
  const normalized = String(value || fallback).toLowerCase()
  return ['debug', 'info', 'warn', 'error'].includes(normalized) ? normalized : fallback
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const normalized = String(raw).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`Invalid ${name}: expected boolean value.`)
}

function readStorageProvider(value) {
  const normalized = String(value || 'local').toLowerCase()
  if (!['local', 's3'].includes(normalized)) {
    throw new Error(`Invalid STORAGE_PROVIDER: ${normalized}.`)
  }
  return normalized
}

const acceptedAuthProviders = ['local', 'oidc', 'saml']

function readAuthProvider(value) {
  const raw = value === undefined || value === null || value === '' ? 'local' : String(value)
  const normalized = raw.toLowerCase()
  if (!acceptedAuthProviders.includes(normalized)) {
    throw new Error(
      `Invalid AUTH_PROVIDER: received "${raw}". Accepted values: ${acceptedAuthProviders.join(', ')}.`
    )
  }
  return normalized
}


function readNonEmptyString(name, fallback = '') {
  const raw = process.env[name]
  if (raw === undefined || raw === null) return fallback
  const normalized = String(raw).trim()
  return normalized || fallback
}

function readList(name) {
  const raw = process.env[name]
  if (!raw) return []
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function readOpsTokenSet() {
  const entries = []
  const push = (token, slot) => {
    const normalized = String(token || '').trim()
    if (!normalized) return
    entries.push({ token: normalized, slot })
  }

  push(process.env.KLIENT_OPS_TOKEN_ACTIVE, 'active')
  push(process.env.KLIENT_OPS_TOKEN_PREVIOUS, 'previous')
  for (const token of readList('KLIENT_OPS_TOKENS')) push(token, 'set')
  push(process.env.KLIENT_OPS_TOKEN, 'legacy')

  const deduped = []
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.token)) continue
    seen.add(entry.token)
    deduped.push(entry)
  }
  return deduped
}

function providerRuntimeDiagnostics(authProvider, { strict = false } = {}) {
  const issues = []
  const warnings = []
  const pushMissing = (message) => {
    if (strict) issues.push(message)
    else warnings.push(message)
  }

  if (authProvider === 'local') {
    warnings.push('AUTH_PROVIDER=local enables built-in password authentication flows.')
    return { issues, warnings }
  }

  if (authProvider === 'oidc') {
    const issuerUrl = readNonEmptyString('OIDC_ISSUER_URL')
    const clientId = readNonEmptyString('OIDC_CLIENT_ID')
    const clientSecret = readNonEmptyString('OIDC_CLIENT_SECRET')
    const redirectUri = readNonEmptyString('OIDC_REDIRECT_URI')

    if (!issuerUrl) pushMissing('OIDC provider requires OIDC_ISSUER_URL.')
    if (!clientId) pushMissing('OIDC provider requires OIDC_CLIENT_ID.')
    if (!clientSecret) pushMissing('OIDC provider requires OIDC_CLIENT_SECRET.')
    if (!redirectUri) pushMissing('OIDC provider requires OIDC_REDIRECT_URI.')
    if (strict && issuerUrl && !/^https:\/\//i.test(issuerUrl)) {
      issues.push('OIDC_ISSUER_URL must use https:// in production.')
    }
    if (strict && redirectUri && !/^https:\/\//i.test(redirectUri)) {
      issues.push('OIDC_REDIRECT_URI must use https:// in production.')
    }
    if (strict && clientSecret && clientSecret.length < 16) {
      issues.push('OIDC_CLIENT_SECRET must be at least 16 characters in production.')
    }

    const allowedAlgs = readList('OIDC_ALLOWED_ALGS')
    if (allowedAlgs.length === 0) warnings.push('OIDC_ALLOWED_ALGS is unset; provider defaults will be used.')
    return { issues, warnings }
  }

  if (authProvider === 'saml') {
    const entryPoint = readNonEmptyString('SAML_ENTRY_POINT')
    const issuer = readNonEmptyString('SAML_ISSUER')
    const cert = readNonEmptyString('SAML_CERT')

    if (!entryPoint) pushMissing('SAML provider requires SAML_ENTRY_POINT.')
    if (!issuer) pushMissing('SAML provider requires SAML_ISSUER.')
    if (!cert) pushMissing('SAML provider requires SAML_CERT.')
    if (strict && entryPoint && !/^https:\/\//i.test(entryPoint)) {
      issues.push('SAML_ENTRY_POINT must use https:// in production.')
    }
    if (strict && cert && !cert.includes('BEGIN CERTIFICATE')) {
      issues.push('SAML_CERT must contain a PEM certificate block in production.')
    }

    const clockSkewSeconds = Number(process.env.SAML_CLOCK_SKEW_SECONDS || 0)
    if (!Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0) {
      issues.push('SAML_CLOCK_SKEW_SECONDS must be a non-negative number when provided.')
    }
    return { issues, warnings }
  }

  issues.push(`Unsupported AUTH_PROVIDER runtime diagnostics for provider "${authProvider}".`)
  return { issues, warnings }
}
function readPiiKeyProvider(value) {
  const normalized = String(value || 'env').toLowerCase()
  if (!['env', 'kms'].includes(normalized)) {
    throw new Error(`Invalid PII_KEY_PROVIDER: ${normalized}.`)
  }
  return normalized
}

function parseJsonObjectEnv(name) {
  const raw = readNonEmptyString(name)
  if (!raw) return { raw, parsed: null, parseError: null }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw, parsed: null, parseError: `${name} must be a JSON object.` }
    }
    return { raw, parsed, parseError: null }
  } catch {
    return { raw, parsed: null, parseError: `${name} must contain valid JSON.` }
  }
}

function estimateAppSecretEntropyBits(secret) {
  const pools = [
    { regex: /[a-z]/, size: 26 },
    { regex: /[A-Z]/, size: 26 },
    { regex: /[0-9]/, size: 10 },
    { regex: /[^a-zA-Z0-9]/, size: 33 }
  ]
  const alphabetSize = pools.reduce((size, pool) => (pool.regex.test(secret) ? size + pool.size : size), 0)
  if (alphabetSize === 0) return 0
  return Math.log2(alphabetSize) * secret.length
}

const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV || 'development')
const allowDevFallbackSecret = readBoolean('ALLOW_DEV_FALLBACK_APP_SECRET', false)
const allowUnsafeAppSecret = readBoolean('UNSAFE_ALLOW_WEAK_APP_SECRET', false)
const enableTestCsrfBypass = readBoolean('ENABLE_TEST_CSRF_BYPASS', false)
const appSecret = process.env.APP_SECRET || DEFAULT_APP_SECRET
const authProviderRaw = readNonEmptyString('AUTH_PROVIDER')
const authProvider = readAuthProvider(authProviderRaw || undefined)
const allowProductionLocalAuthBreakglass = readBoolean('ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS', false)
const piiKeyProvider = readPiiKeyProvider(process.env.PII_KEY_PROVIDER)
const klientOpsTokens = readOpsTokenSet()
const klientOpsToken = klientOpsTokens[0]?.token || ''

if (nodeEnv === 'production' && enableTestCsrfBypass) {
  throw new Error('ENABLE_TEST_CSRF_BYPASS cannot be enabled in production.')
}
if (nodeEnv === 'production' && allowUnsafeAppSecret) {
  throw new Error('UNSAFE_ALLOW_WEAK_APP_SECRET cannot be enabled in production.')
}
if (nodeEnv === 'production' && allowDevFallbackSecret) {
  throw new Error('ALLOW_DEV_FALLBACK_APP_SECRET cannot be enabled in production.')
}

const appSecretHealth = {
  usingFallback: appSecret === DEFAULT_APP_SECRET,
  length: appSecret.length,
  entropyBits: Math.round(estimateAppSecretEntropyBits(appSecret)),
  meetsLengthRequirement: appSecret.length >= MIN_APP_SECRET_LENGTH,
  meetsEntropyRequirement: estimateAppSecretEntropyBits(appSecret) >= MIN_APP_SECRET_ENTROPY_BITS
}

if (appSecretHealth.usingFallback) {
  if (nodeEnv === 'production') {
    throw new Error('APP_SECRET must be set in production.')
  }
  if (nodeEnv === 'development' && !allowDevFallbackSecret) {
    throw new Error(
      'APP_SECRET is using development fallback secret. Set APP_SECRET or ALLOW_DEV_FALLBACK_APP_SECRET=true for local-only runs.'
    )
  }
}

if (
  nodeEnv === 'production' &&
  (!appSecretHealth.meetsLengthRequirement || !appSecretHealth.meetsEntropyRequirement) &&
  !allowUnsafeAppSecret
) {
  throw new Error(
    'APP_SECRET does not meet minimum security requirements for production.'
  )
}

export const runtime = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  host: process.env.HOST || '0.0.0.0',
  port: readNumber('PORT', 3000),
  appSecret,
  appSecretHealth,
  allowDevFallbackSecret,
  allowUnsafeAppSecret,
  enableTestCsrfBypass: nodeEnv === 'test' && enableTestCsrfBypass,
  authProvider,
  authStartupDiagnostics: providerRuntimeDiagnostics(authProvider, {
    strict: nodeEnv === 'production'
  }),
  piiKeyProvider,
  klientOpsTokens,
  klientOpsToken,
  opsTokenAuthEnabled: klientOpsTokens.length > 0,
  logLevel: readLogLevel(process.env.LOG_LEVEL, nodeEnv === 'production' ? 'info' : 'debug'),
  serviceName: process.env.SERVICE_NAME || 'kinetic-klient-api',
  instanceId: process.env.INSTANCE_ID || hostname(),
  storageProvider: readStorageProvider(process.env.STORAGE_PROVIDER),
  storageLocalDir: process.env.STORAGE_LOCAL_DIR || '',
  storageBucketDocuments: process.env.STORAGE_BUCKET_DOCUMENTS || 'klient-documents',
  storageBucketExports: process.env.STORAGE_BUCKET_EXPORTS || 'klient-exports',
  storageEndpoint: process.env.STORAGE_ENDPOINT || '',
  storageRegion: process.env.STORAGE_REGION || '',
  storageAccessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
  storageSecretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
  storageForcePathStyle: readBoolean('STORAGE_FORCE_PATH_STYLE', true),
  storageExportTtlDays: readNumber('STORAGE_EXPORT_TTL_DAYS', 14),
  storageExportArchiveAfterDays: readNumber('STORAGE_EXPORT_ARCHIVE_AFTER_DAYS', 3),
  storageExportPurgeAfterDays: readNumber('STORAGE_EXPORT_PURGE_AFTER_DAYS', 30),
  storageUploadTtlDays: readNumber('STORAGE_UPLOAD_TTL_DAYS', 365),
  storageUploadArchiveAfterDays: readNumber('STORAGE_UPLOAD_ARCHIVE_AFTER_DAYS', 90),
  storageUploadPurgeAfterDays: readNumber('STORAGE_UPLOAD_PURGE_AFTER_DAYS', 730)
}

export function validateRuntimeConfig() {
  const issues = []
  const warnings = []

  if (!runtime.host) issues.push('HOST must be provided.')
  if (!runtime.serviceName) issues.push('SERVICE_NAME must be provided.')
  if (runtime.port < 1 || runtime.port > 65535) issues.push('PORT must be between 1 and 65535.')

  if (runtime.storageProvider === 's3') {
    const missingS3Config =
      !runtime.storageEndpoint ||
      !runtime.storageRegion ||
      !runtime.storageAccessKeyId ||
      !runtime.storageSecretAccessKey
    if (missingS3Config) {
      const message =
        'S3 storage provider requires STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.'
      if (runtime.nodeEnv === 'production') issues.push(message)
      else warnings.push(message)
    }
  }

  if (runtime.authStartupDiagnostics.issues.length) {
    issues.push(...runtime.authStartupDiagnostics.issues)
  }
  if (runtime.authStartupDiagnostics.warnings.length) {
    warnings.push(...runtime.authStartupDiagnostics.warnings)
  }
  if (runtime.nodeEnv === 'production' && !authProviderRaw) {
    issues.push(
      'AUTH_PROVIDER must be explicitly set in production (local, oidc, or saml); implicit local fallback is blocked.'
    )
  }
  if (runtime.nodeEnv === 'production' && runtime.authProvider === 'local') {
    if (!allowProductionLocalAuthBreakglass) {
      issues.push(
        'AUTH_PROVIDER=local is blocked in production. Set AUTH_PROVIDER=oidc or AUTH_PROVIDER=saml, or temporarily set ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true with recorded approval.'
      )
    } else {
      warnings.push(
        'BREAK-GLASS ACTIVE: ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true permits AUTH_PROVIDER=local in production. Ensure approval is recorded and remove override immediately after incident mitigation.'
      )
    }
  }

  if (runtime.piiKeyProvider === 'kms') {
    if (!process.env.PII_KMS_KEYRING) {
      if (runtime.nodeEnv === 'production') issues.push('KMS PII key provider requires PII_KMS_KEYRING.')
      else warnings.push('KMS PII key provider requires PII_KMS_KEYRING.')
    }
    if (!(process.env.PII_KMS_ACTIVE_KEY_ID || process.env.PII_ACTIVE_KEY_ID)) {
      if (runtime.nodeEnv === 'production') {
        issues.push('KMS PII key provider requires PII_KMS_ACTIVE_KEY_ID (or PII_ACTIVE_KEY_ID).')
      } else {
        warnings.push('KMS PII key provider requires PII_KMS_ACTIVE_KEY_ID (or PII_ACTIVE_KEY_ID).')
      }
    }
    const keyringMeta = parseJsonObjectEnv('PII_KMS_KEYRING')
    if (keyringMeta.parseError) {
      if (runtime.nodeEnv === 'production') issues.push(keyringMeta.parseError)
      else warnings.push(keyringMeta.parseError)
    }
  }

  if (runtime.piiKeyProvider === 'env') {
    const activeKeyId = readNonEmptyString('PII_ACTIVE_KEY_ID')
    const keyringMeta = parseJsonObjectEnv('PII_KEYRING')

    if (!activeKeyId) {
      if (runtime.nodeEnv === 'production') {
        issues.push('PII_ACTIVE_KEY_ID must be set when PII_KEY_PROVIDER=env in production.')
      } else {
        warnings.push('PII_ACTIVE_KEY_ID is unset; env key provider falls back to app-secret-v1.')
      }
    }

    if (!keyringMeta.raw) {
      if (runtime.nodeEnv === 'production') {
        issues.push(
          'PII_KEYRING must be set when PII_KEY_PROVIDER=env in production; APP_SECRET fallback key material is not allowed.'
        )
      } else {
        warnings.push('PII_KEYRING is unset; env key provider derives key material from APP_SECRET.')
      }
    } else if (keyringMeta.parseError) {
      if (runtime.nodeEnv === 'production') issues.push(keyringMeta.parseError)
      else warnings.push(keyringMeta.parseError)
    } else if (activeKeyId && !keyringMeta.parsed[activeKeyId]) {
      const message = `PII_KEYRING must include active key "${activeKeyId}".`
      if (runtime.nodeEnv === 'production') issues.push(message)
      else warnings.push(message)
    }
  }

  if (runtime.nodeEnv === 'production' && !runtime.opsTokenAuthEnabled) {
    issues.push(
      'At least one ops token must be set in production (KLIENT_OPS_TOKEN_ACTIVE/KLIENT_OPS_TOKEN_PREVIOUS/KLIENT_OPS_TOKENS or legacy KLIENT_OPS_TOKEN) for /api/ops/* token auth.'
    )
  }
  const weakOpsTokens = runtime.klientOpsTokens.filter((entry) => entry.token.length < 24)
  if (weakOpsTokens.length > 0) {
    const slots = weakOpsTokens.map((entry) => entry.slot).join(', ')
    const message = `Ops tokens should be at least 24 characters to reduce brute-force risk (weak slots: ${slots}).`
    if (runtime.nodeEnv === 'production') issues.push(message)
    else warnings.push(message)
  }

  if (runtime.nodeEnv === 'production' && runtime.logLevel === 'debug') {
    warnings.push('LOG_LEVEL=debug in production may emit sensitive operational details.')
  }

  if (runtime.appSecretHealth.usingFallback) {
    if (runtime.nodeEnv === 'test') {
      warnings.push('APP_SECRET is using fallback development secret under NODE_ENV=test.')
    } else if (runtime.nodeEnv === 'development' && runtime.allowDevFallbackSecret) {
      warnings.push(
        'APP_SECRET is using fallback development secret because ALLOW_DEV_FALLBACK_APP_SECRET=true.'
      )
    }
  }

  if (runtime.nodeEnv === 'production' && readBoolean('ENABLE_DEMO_MODE', false)) {
    warnings.push('ENABLE_DEMO_MODE is ignored in production and forced off.')
  }
  if (readBoolean('ENABLE_TEST_CSRF_BYPASS', false) && runtime.nodeEnv !== 'test') {
    warnings.push('ENABLE_TEST_CSRF_BYPASS is only honored when NODE_ENV=test.')
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    config: {
      nodeEnv: runtime.nodeEnv,
      host: runtime.host,
      port: runtime.port,
      logLevel: runtime.logLevel,
      authProvider: runtime.authProvider,
      authDiagnostics: runtime.authStartupDiagnostics,
      piiKeyProvider: runtime.piiKeyProvider,
      opsTokenAuthEnabled: runtime.opsTokenAuthEnabled,
      serviceName: runtime.serviceName,
      instanceId: runtime.instanceId,
      storageProvider: runtime.storageProvider,
      storageBuckets: {
        documents: runtime.storageBucketDocuments,
        exports: runtime.storageBucketExports
      }
    }
  }
}

function shouldLog(level) {
  const priorities = { debug: 10, info: 20, warn: 30, error: 40 }
  return (priorities[level] || 20) >= (priorities[runtime.logLevel] || 20)
}

export function log(level, message, metadata = {}) {
  if (!shouldLog(level)) return
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: runtime.serviceName,
    instanceId: runtime.instanceId,
    nodeEnv: runtime.nodeEnv,
    message,
    ...metadata
  }
  const line = JSON.stringify(entry)
  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warn') {
    console.warn(line)
    return
  }
  console.log(line)
}
