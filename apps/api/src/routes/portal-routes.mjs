export async function handlePortalRoute(ctx) {
  const { pathname, method, req, store, requireUser, parseBody, json, finalizeLog, requestId, serveStatic } = ctx;

  if (pathname === '/api/portal-links' && method === 'POST') { const body = await parseBody(req); const result = store.createPortalLink(requireUser(req), body.profileId); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/portal/') && pathname.split('/').length === 4 && method === 'GET') { const token = pathname.split('/')[3]; const result = store.getPortalData(token); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/portal/') && pathname.endsWith('/submissions') && method === 'POST') { const token = pathname.split('/')[3]; const result = store.portalSubmit(token, await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/portal' && method === 'GET') { finalizeLog(200); serveStatic('portal.html', ctx.res, requestId); return true; }

  return false;
}
