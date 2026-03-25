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

function readPiiKeyProvider(value) {
  const normalized = String(value || 'env').toLowerCase()
  if (!['env', 'kms'].includes(normalized)) {
    throw new Error(`Invalid PII_KEY_PROVIDER: ${normalized}.`)
  }
  return normalized
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

if (nodeEnv === 'production' && enableTestCsrfBypass) {
  throw new Error('ENABLE_TEST_CSRF_BYPASS cannot be enabled in production.')
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
    'APP_SECRET does not meet minimum security requirements. If you must bypass temporarily, set UNSAFE_ALLOW_WEAK_APP_SECRET=true.'
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
  authProvider: readAuthProvider(process.env.AUTH_PROVIDER),
  piiKeyProvider: readPiiKeyProvider(process.env.PII_KEY_PROVIDER),
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

  if (
    runtime.storageProvider === 's3' &&
    (!runtime.storageEndpoint ||
      !runtime.storageRegion ||
      !runtime.storageAccessKeyId ||
      !runtime.storageSecretAccessKey)
  ) {
    issues.push(
      'S3 storage provider requires STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.'
    )
  }

  if (runtime.piiKeyProvider === 'kms') {
    if (!process.env.PII_KMS_KEYRING) {
      issues.push('KMS PII key provider requires PII_KMS_KEYRING.')
    }
    if (!(process.env.PII_KMS_ACTIVE_KEY_ID || process.env.PII_ACTIVE_KEY_ID)) {
      issues.push('KMS PII key provider requires PII_KMS_ACTIVE_KEY_ID (or PII_ACTIVE_KEY_ID).')
    }
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

  if (
    runtime.nodeEnv === 'production' &&
    (!runtime.appSecretHealth.meetsLengthRequirement || !runtime.appSecretHealth.meetsEntropyRequirement) &&
    runtime.allowUnsafeAppSecret
  ) {
    warnings.push('Weak APP_SECRET accepted because UNSAFE_ALLOW_WEAK_APP_SECRET=true.')
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
      piiKeyProvider: runtime.piiKeyProvider,
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
