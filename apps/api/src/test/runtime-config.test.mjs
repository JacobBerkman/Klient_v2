import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimeModuleUrl = pathToFileURL(resolve('apps/api/src/runtime.mjs')).href;
const trackedEnvKeys = [
  'NODE_ENV',
  'APP_SECRET',
  'ALLOW_DEV_FALLBACK_APP_SECRET',
  'UNSAFE_ALLOW_WEAK_APP_SECRET'
];

async function loadRuntimeWithEnv(overrides) {
  const snapshot = Object.fromEntries(trackedEnvKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of trackedEnvKeys) delete process.env[key];
    Object.assign(process.env, overrides);
    return await import(`${runtimeModuleUrl}?t=${Date.now()}-${Math.random()}`);
  } finally {
    for (const key of trackedEnvKeys) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  }
}

test('runtime rejects fallback APP_SECRET in development without explicit override', async () => {
  await assert.rejects(
    () => loadRuntimeWithEnv({ NODE_ENV: 'development' }),
    /ALLOW_DEV_FALLBACK_APP_SECRET=true/
  );
});

test('runtime allows fallback APP_SECRET in test', async () => {
  const { runtime, validateRuntimeConfig } = await loadRuntimeWithEnv({ NODE_ENV: 'test' });
  const diagnostics = validateRuntimeConfig();
  assert.equal(runtime.appSecretHealth.usingFallback, true);
  assert.match(diagnostics.warnings.join(' '), /NODE_ENV=test/);
});

test('runtime allows fallback APP_SECRET in development when explicit override is enabled', async () => {
  const { runtime, validateRuntimeConfig } = await loadRuntimeWithEnv({
    NODE_ENV: 'development',
    ALLOW_DEV_FALLBACK_APP_SECRET: 'true'
  });
  const diagnostics = validateRuntimeConfig();
  assert.equal(runtime.appSecretHealth.usingFallback, true);
  assert.match(diagnostics.warnings.join(' '), /ALLOW_DEV_FALLBACK_APP_SECRET=true/);
});

test('runtime rejects weak APP_SECRET in production unless unsafe override is set', async () => {
  await assert.rejects(
    () => loadRuntimeWithEnv({ NODE_ENV: 'production', APP_SECRET: 'abc123' }),
    /UNSAFE_ALLOW_WEAK_APP_SECRET=true/
  );

  const { runtime, validateRuntimeConfig } = await loadRuntimeWithEnv({
    NODE_ENV: 'production',
    APP_SECRET: 'abc123',
    UNSAFE_ALLOW_WEAK_APP_SECRET: 'true'
  });
  const diagnostics = validateRuntimeConfig();
  assert.equal(runtime.allowUnsafeAppSecret, true);
  assert.match(diagnostics.warnings.join(' '), /UNSAFE_ALLOW_WEAK_APP_SECRET=true/);
});
