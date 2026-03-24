import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const scratchRoot = resolve(repoRoot, '.tmp-tests');
mkdirSync(scratchRoot, { recursive: true });
const tempDir = mkdtempSync(join(scratchRoot, 'klient-ordering-'));
const port = 3123;

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function startServer() {
  const child = spawn(process.execPath, [resolve(repoRoot, 'apps/api/src/server.mjs')], {
    cwd: tempDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${data.message || 'Request failed'}`);
  }
  return data;
}

async function waitForReady() {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    try {
      await jsonFetch('/ready');
      return;
    } catch {
      await wait(150);
    }
  }
  throw new Error('Server did not become ready in time');
}

function idsForStage(board, stage) {
  return board.find((column) => column.stage === stage)?.cards.map((card) => card.id) || [];
}

async function run() {
  let server;
  try {
    server = startServer();
    await waitForReady();

    const login = await jsonFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    });

    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

    const alpha = await jsonFetch('/api/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ kind: 'prospect', firstName: 'Alpha', lastName: 'Order', stage: 'discovery' }) });
    const bravo = await jsonFetch('/api/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ kind: 'prospect', firstName: 'Bravo', lastName: 'Order', stage: 'discovery' }) });

    await jsonFetch(`/api/profiles/${bravo.id}/stage`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ stage: 'discovery', beforeProfileId: alpha.id })
    });

    let board = await jsonFetch('/api/board', { headers: { Authorization: `Bearer ${login.token}` } });
    const discoveryIds = idsForStage(board, 'discovery');
    const alphaIndex = discoveryIds.indexOf(alpha.id);
    const bravoIndex = discoveryIds.indexOf(bravo.id);
    assert(alphaIndex >= 0 && bravoIndex >= 0 && bravoIndex < alphaIndex, 'reorder inside same stage should place moved profile before target');

    await jsonFetch(`/api/profiles/${bravo.id}/stage`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ stage: 'analysis' })
    });

    board = await jsonFetch('/api/board', { headers: { Authorization: `Bearer ${login.token}` } });
    const analysisIds = idsForStage(board, 'analysis');
    assert(analysisIds.includes(bravo.id), 'move across stages should place profile in destination stage');
    assert(!idsForStage(board, 'discovery').includes(bravo.id), 'move across stages should remove profile from source stage');

    server.kill('SIGTERM');
    await wait(250);

    server = startServer();
    await waitForReady();

    const reloadedLogin = await jsonFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    });

    const reloadedBoard = await jsonFetch('/api/board', { headers: { Authorization: `Bearer ${reloadedLogin.token}` } });
    const reloadedDiscovery = idsForStage(reloadedBoard, 'discovery');
    const reloadedAnalysis = idsForStage(reloadedBoard, 'analysis');

    assert(!reloadedDiscovery.includes(bravo.id), 'stable order after reload should preserve stage membership');
    assert(reloadedAnalysis.includes(bravo.id), 'stable order after reload should keep moved card in destination');

    console.log('pipeline ordering tests passed');
  } finally {
    if (server && !server.killed) server.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = 1;
});
