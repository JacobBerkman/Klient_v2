import { ensureDatabaseReady, readQuerySummary } from '../storage.mjs';

export function handleSystemRoute(ctx) {
  const { pathname, method, runtime, json, finalizeLog, requestId } = ctx;

  if (pathname === '/health' && method === 'GET') {
    finalizeLog(200);
    json(ctx.res, 200, { status: 'ok', service: runtime.serviceName, uptimeSeconds: Math.round(process.uptime()) }, { 'X-Request-Id': requestId });
    return true;
  }
  if (pathname === '/ready' && method === 'GET') {
    const database = ensureDatabaseReady();
    finalizeLog(200);
    json(ctx.res, 200, { status: 'ready', querySummary: readQuerySummary(), database }, { 'X-Request-Id': requestId });
    return true;
  }

  return false;
}
