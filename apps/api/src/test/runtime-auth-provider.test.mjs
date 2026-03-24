import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimePath = pathToFileURL(resolve('apps/api/src/runtime.mjs')).href;

async function loadRuntime(authProvider) {
  process.env.AUTH_PROVIDER = authProvider;
  const mod = await import(`${runtimePath}?t=${Date.now()}-${Math.random()}`);
  return mod.runtime.authProvider;
}

test('runtime allows explicit oidc and saml auth providers', async () => {
  assert.equal(await loadRuntime('oidc'), 'oidc');
  assert.equal(await loadRuntime('saml'), 'saml');
});

test('runtime falls back to local for unknown auth provider', async () => {
  assert.equal(await loadRuntime('unknown-provider'), 'local');
});
