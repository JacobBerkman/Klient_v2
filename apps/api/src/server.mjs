import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './store.mjs';
import { readQuerySummary } from './storage.mjs';
import { SqliteReadRepository } from './repositories/sqlite-read-repository.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '../../web/public');
const store = createStore();
const reads = new SqliteReadRepository();
const port = Number(process.env.PORT || 3000);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res) {
  json(res, 404, { message: 'Not found' });
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '');
}

function requireUser(req) {
  return store.requireUser(getToken(req));
}

function serveStatic(pathname, res) {
  const filePath = pathname === '/' ? resolve(publicDir, 'index.html') : resolve(publicDir, pathname.slice(1));
  readFile(filePath)
    .then((contents) => {
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8'
      }[extname(filePath)] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(contents);
    })
    .catch(() => notFound(res));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (pathname === '/health') return json(res, 200, { status: 'ok' });
    if (pathname === '/ready') return json(res, 200, { status: 'ready', querySummary: readQuerySummary() });
    if (pathname === '/api/register' && req.method === 'POST') return json(res, 201, store.register(await parseBody(req)));
    if (pathname === '/api/login' && req.method === 'POST') return json(res, 200, store.login(await parseBody(req)));
    if (pathname === '/api/invites' && req.method === 'POST') return json(res, 201, store.inviteUser(requireUser(req), await parseBody(req)));
    if (pathname === '/api/invites/accept' && req.method === 'POST') return json(res, 200, store.acceptInvite(await parseBody(req)));
    if (pathname === '/api/password-resets' && req.method === 'POST') return json(res, 200, store.requestPasswordReset((await parseBody(req)).email || ''));
    if (pathname === '/api/password-resets/confirm' && req.method === 'POST') return json(res, 200, store.resetPassword(await parseBody(req)));
    if (pathname === '/api/users' && req.method === 'GET') return json(res, 200, store.listUsers(requireUser(req)));
    if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user: requireUser(req) });
    if (pathname === '/api/logout' && req.method === 'POST') return json(res, 200, store.logout(getToken(req)));
    if (pathname === '/api/dashboard' && req.method === 'GET') return json(res, 200, store.getDashboard(requireUser(req)));
    if (pathname === '/api/profiles' && req.method === 'GET') { const user = requireUser(req); return json(res, 200, reads.listProfiles(user.firmId, { kind: url.searchParams.get('kind'), search: url.searchParams.get('search') || '' })); }
    if (pathname === '/api/profiles' && req.method === 'POST') return json(res, 201, store.createProfile(requireUser(req), await parseBody(req)));
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage-history') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      return json(res, 200, store.listStageHistory(requireUser(req), id));
    }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      return json(res, 200, store.listNotes(requireUser(req), id));
    }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/notes') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      return json(res, 201, store.addNote(requireUser(req), id, body.body || ''));
    }
    if (pathname.startsWith('/api/profiles/') && pathname.split('/').length === 4 && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const user = requireUser(req);
      return json(res, 200, { ...store.getProfileDetail(user, id), profileRecord: reads.getProfileDetail(user.firmId, id) });
    }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/stage') && req.method === 'PATCH') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      return json(res, 200, store.moveProfileStage(requireUser(req), id, body.stage, body.beforeProfileId || null));
    }
    if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') {
      const id = pathname.split('/')[3];
      return json(res, 200, store.updateProfile(requireUser(req), id, await parseBody(req)));
    }
    if (pathname === '/api/board' && req.method === 'GET') return json(res, 200, store.getBoard(requireUser(req)));
    if (pathname === '/api/households' && req.method === 'GET') return json(res, 200, store.listHouseholds(requireUser(req)));
    if (pathname === '/api/households' && req.method === 'POST') return json(res, 201, store.createHousehold(requireUser(req), await parseBody(req)));
    if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      return json(res, 201, store.addHouseholdMember(requireUser(req), id, await parseBody(req)));
    }
    if (pathname.startsWith('/api/households/') && pathname.endsWith('/members') && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      return json(res, 200, store.removeHouseholdMember(requireUser(req), id, body.clientId));
    }
    if (pathname === '/api/households/link-spouse' && req.method === 'POST') { const body = await parseBody(req); return json(res, 200, store.linkSpouse(requireUser(req), body.primaryClientId, body.spouseClientId)); }
    if (pathname === '/api/households/create-spouse' && req.method === 'POST') { const body = await parseBody(req); return json(res, 201, store.createSpouse(requireUser(req), body.primaryClientId, body.spouse)); }
    if (pathname === '/api/forms/templates' && req.method === 'GET') return json(res, 200, store.listFormTemplates(requireUser(req)));
    if (pathname === '/api/forms/templates' && req.method === 'POST') return json(res, 201, store.createFormTemplate(requireUser(req), await parseBody(req)));
    if (pathname === '/api/forms/submissions' && req.method === 'GET') return json(res, 200, store.listFormSubmissions(requireUser(req)));
    if (pathname === '/api/forms/drafts' && req.method === 'GET') return json(res, 200, store.listFormDrafts(requireUser(req)));
    if (pathname === '/api/forms/submissions' && req.method === 'POST') return json(res, 201, store.createFormSubmission(requireUser(req), await parseBody(req)));
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'PATCH') { const id = pathname.split('/')[4]; return json(res, 200, store.updateSubmission(requireUser(req), id, await parseBody(req))); }
    if (pathname.startsWith('/api/forms/submissions/') && req.method === 'DELETE') { const id = pathname.split('/')[4]; return json(res, 200, store.deleteSubmission(requireUser(req), id)); }
    if (pathname === '/api/templates' && req.method === 'GET') return json(res, 200, store.listDocumentTemplates(requireUser(req)));
    if (pathname === '/api/templates' && req.method === 'POST') return json(res, 201, store.createDocumentTemplate(requireUser(req), await parseBody(req)));
    if (pathname === '/api/templates/auto-build' && req.method === 'POST') return json(res, 201, store.autoBuildTemplate(requireUser(req), await parseBody(req)));
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/publish') && req.method === 'POST') { const id = pathname.split('/')[3]; return json(res, 200, store.publishTemplate(requireUser(req), id)); }
    if (pathname.startsWith('/api/templates/') && pathname.endsWith('/mappings') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      return json(res, 200, store.updateTemplateMappings(requireUser(req), id, body.mappings || []));
    }
    if (pathname === '/api/exports' && req.method === 'GET') return json(res, 200, store.listExports(requireUser(req)));
    if (pathname === '/api/exports' && req.method === 'POST') return json(res, 201, store.createExport(requireUser(req), await parseBody(req)));
    if (pathname === '/api/exports/process' && req.method === 'POST') return json(res, 200, store.processQueuedExports());
    if (pathname.startsWith('/api/exports/') && pathname.endsWith('/retry') && req.method === 'POST') { const id = pathname.split('/')[3]; return json(res, 200, store.retryExport(requireUser(req), id)); }
    if (pathname === '/api/audit' && req.method === 'GET') return json(res, 200, store.listAudit(requireUser(req)));
    if (pathname === '/api/analytics' && req.method === 'GET') { const user = requireUser(req); return json(res, 200, { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) }); }
    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/sensitive') && req.method === 'GET') { const id = pathname.split('/')[3]; return json(res, 200, store.getMaskedSensitiveData(requireUser(req), id)); }
    if (pathname === '/api/portal-links' && req.method === 'POST') { const body = await parseBody(req); return json(res, 201, store.createPortalLink(requireUser(req), body.profileId)); }
    if (pathname.startsWith('/api/portal/') && pathname.split('/').length === 4 && req.method === 'GET') { const token = pathname.split('/')[3]; return json(res, 200, store.getPortalData(token)); }
    if (pathname.startsWith('/api/portal/') && pathname.endsWith('/submissions') && req.method === 'POST') { const token = pathname.split('/')[3]; return json(res, 201, store.portalSubmit(token, await parseBody(req))); }
    if (pathname === '/portal' && req.method === 'GET') return serveStatic('portal.html', res);

    return serveStatic(pathname, res);
  } catch (error) {
    return json(res, 400, { message: error.message || 'Request failed' });
  }
});

server.listen(port, () => {
  console.log(`Kinetic Klient listening on http://localhost:${port}`);
});
