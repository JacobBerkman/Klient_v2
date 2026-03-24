export async function handleAuthUsersFirmsRoute(ctx) {
  const { pathname, method, req, store, requireUser, parseBody, json, finalizeLog, requestId, getToken } = ctx;

  if (pathname === '/api/register' && method === 'POST') { const result = store.register(await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/login' && method === 'POST') { const result = store.login(await parseBody(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/invites' && method === 'POST') { const result = store.inviteUser(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/invites/accept' && method === 'POST') { const result = store.acceptInvite(await parseBody(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/password-resets' && method === 'POST') { const result = store.requestPasswordReset((await parseBody(req)).email || ''); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/password-resets/confirm' && method === 'POST') { const result = store.resetPassword(await parseBody(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/users' && method === 'GET') { const result = store.listUsers(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/session' && method === 'GET') { const result = { user: requireUser(req) }; finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/logout' && method === 'POST') { const result = store.logout(getToken(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/dashboard' && method === 'GET') { const result = store.getDashboard(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }

  return false;
}
