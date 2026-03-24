export async function handleProfilesRoute(ctx) {
  const { pathname, method, url, req, store, reads, requireUser, parseBody, json, finalizeLog, requestId } = ctx;

  if (pathname === '/api/profiles' && method === 'GET') {
    const user = requireUser(req);
    const result = reads.listProfiles(user.firmId, { kind: url.searchParams.get('kind'), search: url.searchParams.get('search') || '' });
    finalizeLog(200, { firmId: user.firmId });
    json(ctx.res, 200, result, { 'X-Request-Id': requestId });
    return true;
  }
  if (pathname === '/api/profiles' && method === 'POST') { const result = store.createProfile(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage-history') && method === 'GET') { const id = pathname.split('/')[3]; const result = store.listStageHistory(requireUser(req), id); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && method === 'GET') { const id = pathname.split('/')[3]; const result = store.listNotes(requireUser(req), id); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.addNote(requireUser(req), id, body.body || ''); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/profiles/') && pathname.split('/').length === 4 && method === 'GET') {
    const id = pathname.split('/')[3];
    const user = requireUser(req);
    const result = { ...store.getProfileDetail(user, id), profileRecord: reads.getProfileDetail(user.firmId, id) };
    finalizeLog(200);
    json(ctx.res, 200, result, { 'X-Request-Id': requestId });
    return true;
  }
  if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && method === 'PATCH') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.moveProfileStage(requireUser(req), id, body.stage, body.beforeProfileId || null); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && method === 'GET') { const id = pathname.split('/')[3]; const result = store.getMaskedSensitiveData(requireUser(req), id); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/profiles/') && method === 'PATCH') { const id = pathname.split('/')[3]; const result = store.updateProfile(requireUser(req), id, await parseBody(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/board' && method === 'GET') { const result = store.getBoard(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }

  return false;
}
