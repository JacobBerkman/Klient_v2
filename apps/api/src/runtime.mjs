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

function readLogLevel(value, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  return ['debug', 'info', 'warn', 'error'].includes(normalized) ? normalized : fallback;
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
  logLevel: readLogLevel(process.env.LOG_LEVEL, nodeEnv === 'production' ? 'info' : 'debug'),
  serviceName: process.env.SERVICE_NAME || 'kinetic-klient-api',
  instanceId: process.env.INSTANCE_ID || hostname()
};

export function validateRuntimeConfig() {
  const issues = [];
  const warnings = [];
  if (!runtime.host) issues.push('HOST must be provided.');
  if (!runtime.serviceName) issues.push('SERVICE_NAME must be provided.');
  if (runtime.port < 1 || runtime.port > 65535) issues.push('PORT must be between 1 and 65535.');
  if (runtime.nodeEnv === 'production' && runtime.logLevel === 'debug') {
    warnings.push('LOG_LEVEL=debug in production may emit sensitive operational details.');
  }
  if (!process.env.APP_SECRET) {
    warnings.push('APP_SECRET is using fallback development secret.');
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
      serviceName: runtime.serviceName,
      instanceId: runtime.instanceId
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
