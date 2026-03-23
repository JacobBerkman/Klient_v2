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
  instanceId: process.env.INSTANCE_ID || hostname()
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
