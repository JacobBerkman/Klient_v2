import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimePath = pathToFileURL(resolve('apps/api/src/runtime.mjs')).href;

async function importRuntime(authProvider) {
  if (authProvider === undefined) {
    delete process.env.AUTH_PROVIDER;
  } else {
    process.env.AUTH_PROVIDER = authProvider;
  }
  return import(`${runtimePath}?t=${Date.now()}-${Math.random()}`);
}

async function loadRuntime(authProvider) {
  const mod = await importRuntime(authProvider);
  return mod.runtime.authProvider;
}

test('runtime allows explicit oidc and saml auth providers', async () => {
  assert.equal(await loadRuntime('oidc'), 'oidc');
  assert.equal(await loadRuntime('saml'), 'saml');
});

test('runtime defaults to local when auth provider is omitted', async () => {
  assert.equal(await loadRuntime(undefined), 'local');
});

test('runtime throws for unknown auth provider and reports accepted values', async () => {
  await assert.rejects(() => importRuntime('unknown-provider'), /Invalid AUTH_PROVIDER: received "unknown-provider"\. Accepted values: local, oidc, saml\./);
});
