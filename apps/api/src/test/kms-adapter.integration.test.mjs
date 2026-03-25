import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyProvider, PiiCryptoService } from '../pii-crypto.mjs';
import { createRuntimeKmsAdapter } from '../kms-adapter.mjs';

function withEnv(env, fn) {
  const previous = { ...process.env };
  process.env = { ...previous, ...env };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env = previous;
    });
}

test('kms adapter fetches active key material and decrypts payloads through key provider', async () => {
  await withEnv({
    PII_KMS_KEYRING: JSON.stringify({ 'kms-key-v1': 'plain:key-material-v1' }),
    PII_KMS_ACTIVE_KEY_ID: 'kms-key-v1'
  }, () => {
    const runtime = { appSecret: 'seed-secret', piiKeyProvider: 'kms' };
    const kmsAdapter = createRuntimeKmsAdapter(runtime);
    const keyProvider = createKeyProvider(runtime, { kmsAdapter });
    const pii = new PiiCryptoService({ keyProvider });

    const encrypted = pii.encrypt('123-45-6789');
    assert.equal(encrypted.keyId, 'kms-key-v1');
    assert.equal(pii.decrypt(encrypted), '123-45-6789');
  });
});

test('kms adapter surfaces key-fetch failure when active key is missing', async () => {
  await withEnv({
    PII_KMS_KEYRING: JSON.stringify({ 'kms-key-v2': 'plain:key-material-v2' }),
    PII_KMS_ACTIVE_KEY_ID: 'kms-key-v1'
  }, () => {
    const runtime = { appSecret: 'seed-secret', piiKeyProvider: 'kms' };
    const kmsAdapter = createRuntimeKmsAdapter(runtime);
    const keyProvider = createKeyProvider(runtime, { kmsAdapter });

    assert.throws(() => keyProvider.getActiveKey(), /KMS key not found/);
  });
});

test('kms adapter surfaces decrypt failure when ciphertext cannot be decrypted', async () => {
  await withEnv({
    PII_KMS_KEYRING: JSON.stringify({ 'kms-key-v1': 'cipherblob:unreadable' }),
    PII_KMS_ACTIVE_KEY_ID: 'kms-key-v1'
  }, () => {
    const runtime = { appSecret: '', piiKeyProvider: 'kms' };
    const kmsAdapter = createRuntimeKmsAdapter(runtime);
    const keyProvider = createKeyProvider(runtime, { kmsAdapter });

    assert.throws(() => keyProvider.getActiveKey(), /Unable to decrypt KMS key material/);
  });
});

test('kms adapter fails key rotation when rotation target is unavailable', async () => {
  await withEnv({
    PII_KMS_KEYRING: JSON.stringify({ 'kms-key-v1': 'plain:key-material-v1' }),
    PII_KMS_ACTIVE_KEY_ID: 'kms-key-v1'
  }, () => {
    const runtime = { appSecret: 'seed-secret', piiKeyProvider: 'kms' };
    const kmsAdapter = createRuntimeKmsAdapter(runtime);
    assert.throws(() => kmsAdapter.rotateActiveKey('kms-key-v2'), /Rotation target key is unavailable/);
  });
});

test('server bootstrap wires createKeyProvider(runtime, { kmsAdapter }) when PII_KEY_PROVIDER=kms', async () => {
  await withEnv({
    APP_SECRET: 'seed-secret',
    PII_KEY_PROVIDER: 'kms',
    PII_KMS_ACTIVE_KEY_ID: 'kms-key-v1',
    PII_KMS_KEYRING: JSON.stringify({ 'kms-key-v1': 'plain:key-material-v1' })
  }, async () => {
    const moduleUrl = new URL('../server.mjs', import.meta.url).href + `?t=${Date.now()}-${Math.random()}`;
    const serverModule = await import(moduleUrl);
    const keyProvider = serverModule.bootstrapPiiKeyProvider();
    assert.ok(keyProvider);
    assert.equal(keyProvider.getActiveKey().keyId, 'kms-key-v1');
  });
});
