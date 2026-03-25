import { hostname } from 'node:os';

const DEFAULT_APP_SECRET = 'kinetic-klient-dev-secret';
const MIN_APP_SECRET_LENGTH = 24;
const MIN_APP_SECRET_ENTROPY_BITS = 80;

function normalizeNodeEnv(value) {
  return ['development', 'test', 'production'].includes(value) ? value : 'development';
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}: expected a positive number.`);
  return parsed;
}

function readLogLevel(value, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  return ['debug', 'info', 'warn', 'error'].includes(normalized) ? normalized : fallback;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: expected boolean value.`);
}

function readStorageProvider(value) {
  const normalized = String(value || 'local').toLowerCase();
  if (!['local', 's3'].includes(normalized)) {
    throw new Error(`Invalid STORAGE_PROVIDER: ${normalized}.`);
  }
  return normalized;
}

function readAuthProvider(value) {
  const normalized = String(value || 'local').toLowerCase();
  if (!['local', 'oidc', 'saml'].includes(normalized)) {
    return 'local';
  }
  return normalized;
}

function readPiiKeyProvider(value) {
  const normalized = String(value || 'env').toLowerCase();
  if (!['env', 'kms'].includes(normalized)) {
    throw new Error(`Invalid PII_KEY_PROVIDER: ${normalized}.`);
  }
  return normalized;
}

function estimateShannonEntropyBits(secret) {
  if (!secret) return 0;
  const counts = new Map();
  for (const char of secret) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  let entropyPerChar = 0;
  for (const count of counts.values()) {
    const p = count / secret.length;
    entropyPerChar -= p * Math.log2(p);
  }
  return entropyPerChar * secret.length;
}

function evaluateAppSecret(secret, { source, nodeEnv }) {
  const reasons = [];
  const entropyBits = estimateShannonEntropyBits(secret);
  const length = secret.length;
  const usingFallback = source === 'fallback';

  if (!secret) reasons.push('missing');
  if (usingFallback && nodeEnv !== 'test') reasons.push('fallback-not-allowed');
  if (length < MIN_APP_SECRET_LENGTH) reasons.push(`too-short(<${MIN_APP_SECRET_LENGTH})`);
  if (entropyBits < MIN_APP_SECRET_ENTROPY_BITS) reasons.push(`low-entropy(<${MIN_APP_SECRET_ENTROPY_BITS.toFixed(0)} bits)`);

  return {
    source,
    usingFallback,
    length,
    entropyBits,
    isStrong: length >= MIN_APP_SECRET_LENGTH && entropyBits >= MIN_APP_SECRET_ENTROPY_BITS,
    reasons
  };
}

const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV || 'development');
const allowDevFallbackSecret = readBoolean('ALLOW_DEV_FALLBACK_APP_SECRET', false);
const allowUnsafeAppSecret = readBoolean('UNSAFE_ALLOW_WEAK_APP_SECRET', false);
const hasAppSecret = Boolean(process.env.APP_SECRET);
const appSecret = process.env.APP_SECRET || DEFAULT_APP_SECRET;
const appSecretSource = hasAppSecret ? 'env' : 'fallback';
const appSecretHealth = evaluateAppSecret(appSecret, { source: appSecretSource, nodeEnv });

const isDevFallbackAllowed = nodeEnv === 'development' && allowDevFallbackSecret;
const isFallbackAllowed = nodeEnv === 'test' || isDevFallbackAllowed;

if (appSecretHealth.usingFallback && !isFallbackAllowed) {
  appSecretHealth.reasons.push('fallback-blocked');
}

const shouldRejectAppSecret =
  (nodeEnv === 'production' || nodeEnv === 'development') &&
  (appSecretHealth.usingFallback ? !isFallbackAllowed : !appSecretHealth.isStrong);

if (shouldRejectAppSecret && !allowUnsafeAppSecret) {
  const guidance = appSecretHealth.usingFallback
    ? 'Set APP_SECRET to a strong value. For local development only, set ALLOW_DEV_FALLBACK_APP_SECRET=true to permit the built-in fallback secret.'
    : 'Set APP_SECRET to a stronger value (longer and less predictable), or set UNSAFE_ALLOW_WEAK_APP_SECRET=true only for temporary local debugging.';
  throw new Error(`Invalid APP_SECRET for NODE_ENV=${nodeEnv} (${appSecretHealth.reasons.join(', ')}). ${guidance}`);
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
};

export function validateRuntimeConfig() {
  const issues = [];
  const warnings = [];
  if (!runtime.host) issues.push('HOST must be provided.');
  if (!runtime.serviceName) issues.push('SERVICE_NAME must be provided.');
  if (runtime.port < 1 || runtime.port > 65535) issues.push('PORT must be between 1 and 65535.');
  if (runtime.storageProvider === 's3' && (!runtime.storageEndpoint || !runtime.storageRegion || !runtime.storageAccessKeyId || !runtime.storageSecretAccessKey)) {
    issues.push('S3 storage provider requires STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.');
  }
  if (runtime.nodeEnv === 'production' && runtime.logLevel === 'debug') {
    warnings.push('LOG_LEVEL=debug in production may emit sensitive operational details.');
  }
  if (runtime.appSecretHealth.usingFallback) {
    if (runtime.nodeEnv === 'test') {
      warnings.push('APP_SECRET fallback is active because NODE_ENV=test.');
    } else if (runtime.nodeEnv === 'development' && runtime.allowDevFallbackSecret) {
      warnings.push('APP_SECRET fallback enabled by ALLOW_DEV_FALLBACK_APP_SECRET=true (development only).');
    } else {
      issues.push('APP_SECRET fallback is not allowed outside NODE_ENV=test unless ALLOW_DEV_FALLBACK_APP_SECRET=true in development.');
    }
  } else if (!runtime.appSecretHealth.isStrong) {
    const details = `length=${runtime.appSecretHealth.length}, entropy≈${runtime.appSecretHealth.entropyBits.toFixed(1)} bits`;
    if (runtime.allowUnsafeAppSecret) {
      warnings.push(`APP_SECRET failed strength checks (${details}) but UNSAFE_ALLOW_WEAK_APP_SECRET=true is set.`);
    } else {
      issues.push(`APP_SECRET failed strength checks (${details}).`);
    }
  }
  if (runtime.allowUnsafeAppSecret) {
    warnings.push('UNSAFE_ALLOW_WEAK_APP_SECRET=true bypasses APP_SECRET enforcement and should not be enabled in production.');
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
  };
}

function shouldLog(level) {
  const priorities = { debug: 10, info: 20, warn: 30, error: 40 };
  return (priorities[level] || 20) >= (priorities[runtime.logLevel] || 20);
}

export function log(level, message, metadata = {}) {
  if (!shouldLog(level)) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: runtime.serviceName,
    instanceId: runtime.instanceId,
    nodeEnv: runtime.nodeEnv,
    message,
    ...metadata
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}
