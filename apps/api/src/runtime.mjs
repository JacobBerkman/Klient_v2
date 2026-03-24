import { hostname } from 'node:os';

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

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}

function resolveObjectStorage(nodeEnv) {
  const backend = (process.env.OBJECT_STORAGE_BACKEND || (nodeEnv === 'production' ? 's3' : 'local')).toLowerCase();
  if (!['local', 's3'].includes(backend)) {
    throw new Error('OBJECT_STORAGE_BACKEND must be either local or s3.');
  }

  const objectStorage = {
    backend,
    localStoragePath: process.env.OBJECT_STORAGE_LOCAL_PATH || 'data/storage',
    bucket: process.env.OBJECT_STORAGE_BUCKET || '',
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT || '',
    region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '',
    forcePathStyle: readBoolean('OBJECT_STORAGE_FORCE_PATH_STYLE', false)
  };

  if (backend === 's3') {
    const required = ['OBJECT_STORAGE_BUCKET', 'OBJECT_STORAGE_ACCESS_KEY_ID', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required object storage env vars for s3 backend: ${missing.join(', ')}`);
    }
  }

  return objectStorage;
}

const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV || 'development');
const appSecret = process.env.APP_SECRET || 'kinetic-klient-dev-secret';

if (nodeEnv === 'production' && appSecret === 'kinetic-klient-dev-secret') {
  throw new Error('APP_SECRET must be set in production.');
}

export const runtime = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  host: process.env.HOST || '0.0.0.0',
  port: readNumber('PORT', 3000),
  appSecret,
  logLevel: process.env.LOG_LEVEL || (nodeEnv === 'production' ? 'info' : 'debug'),
  serviceName: process.env.SERVICE_NAME || 'kinetic-klient-api',
  instanceId: process.env.INSTANCE_ID || hostname(),
  objectStorage: resolveObjectStorage(nodeEnv)
};

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
