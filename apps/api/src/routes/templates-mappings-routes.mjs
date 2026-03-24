export async function handleTemplatesMappingsRoute(ctx) {
  const { pathname, method, req, store, requireUser, parseBody, json, finalizeLog, requestId } = ctx;

  if (pathname === '/api/templates' && method === 'GET') { const result = store.listDocumentTemplates(requireUser(req)); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/templates' && method === 'POST') { const result = store.createDocumentTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname === '/api/templates/auto-build' && method === 'POST') { const result = store.autoBuildTemplate(requireUser(req), await parseBody(req)); finalizeLog(201); json(ctx.res, 201, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish') && method === 'POST') { const id = pathname.split('/')[3]; const result = store.publishTemplate(requireUser(req), id); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }
  if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings') && method === 'POST') { const id = pathname.split('/')[3]; const body = await parseBody(req); const result = store.updateTemplateMappings(requireUser(req), id, body.mappings || []); finalizeLog(200); json(ctx.res, 200, result, { 'X-Request-Id': requestId }); return true; }

  return false;
}
