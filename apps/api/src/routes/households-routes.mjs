export async function handleHouseholdsRoute(ctx) {
  const { pathname, method, req, store, requireUser, parseBody, json, finalizeLog, requestId } = ctx;

  if (pathname === '/api/households' && method === 'GET') { const result = store.listHouseholds(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/households' && method === 'POST') { const result = store.createHousehold(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && method === 'POST') { const id = pathname.split('/')[3]; const result = store.addHouseholdMember(requireUser(req), id, await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && method === 'DELETE') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.removeHouseholdMember(requireUser(req), id, body.clientId); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/households/link-spouse' && method === 'POST') { const body = await parseBody(req); const result = store.linkSpouse(requireUser(req), body.primaryClientId, body.spouseClientId); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/households/create-spouse' && method === 'POST') { const body = await parseBody(req); const result = store.createSpouse(requireUser(req), body.primaryClientId, body.spouse); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }

  return false;
}
