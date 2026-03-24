export async function handleAuditAnalyticsRoute(ctx) {
  const { pathname, method, req, store, reads, requireUser, json, finalizeLog, requestId } = ctx;

  if (pathname === '/api/audit' && method === 'GET') { const result = store.listAudit(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/analytics' && method === 'GET') {
    const user = requireUser(req);
    const result = { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) };
    finalizeLog(200);
    json(ctx.res, 200, result, { 'X-Request-Id': requestId });
    return true;
  }

  return false;
}
