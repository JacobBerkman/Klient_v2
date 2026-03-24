export async function handleExportsRoute(ctx) {
  const { pathname, method, req, store, requireUser, parseBody, json, finalizeLog, requestId } = ctx;

  if (pathname === '/api/exports' && method === 'GET') { const result = store.listExports(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/exports' && method === 'POST') { const result = store.createExport(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/exports/process' && method === 'POST') { const result = store.processQueuedExports(); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && method === 'POST') { const id = pathname.split('/')[3]; const result = store.retryExport(requireUser(req), id); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }

  return false;
}
