export async function handleFormsRoute(ctx) {
  const { pathname, method, req, store, requireUser, parseBody, json, finalizeLog, requestId } = ctx;

  if (pathname === '/api/forms/templates' && method === 'GET') { const result = store.listFormTemplates(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/forms/templates' && method === 'POST') { const result = store.createFormTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/forms/submissions' && method === 'GET') { const result = store.listFormSubmissions(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/forms/drafts' && method === 'GET') { const result = store.listFormDrafts(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/forms/submissions' && method === 'POST') { const result = store.createFormSubmission(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/forms/submissions/') && method === 'PATCH') { const id = pathname.split('/')[4]; const result = store.updateSubmission(requireUser(req), id, await parseBody(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/forms/submissions/') && method === 'DELETE') { const id = pathname.split('/')[4]; const result = store.deleteSubmission(requireUser(req), id); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }

  return false;
}
