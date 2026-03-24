import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalFilesystemStorageProvider } from '../object-storage/local-provider.mjs';
import { createObjectStorage } from '../object-storage/index.mjs';

test('presigned tokens expire, enforce scope, and are one-time use', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-test-'));
  const provider = createLocalFilesystemStorageProvider({ rootDir });
  try {
    const presigned = await provider.createPresignedUploadUrl({
      bucket: 'docs',
      key: 'firm/upload.pdf',
      contentType: 'application/pdf',
      expiresInSeconds: 1,
      actorId: 'user-1',
      context: 'client',
      intent: 'upload_document'
    });
    const token = new URL(`http://localhost${presigned.url}`).searchParams.get('token');
    assert.ok(token);

    const wrongActor = provider.consumePresignedToken(token, 'upload', { actorId: 'user-2', context: 'client', intent: 'upload_document' });
    assert.equal(wrongActor, null);

    const valid = provider.consumePresignedToken(token, 'upload', { actorId: 'user-1', context: 'client', intent: 'upload_document' });
    assert.equal(valid.key, 'firm/upload.pdf');

    const replay = provider.consumePresignedToken(token, 'upload', { actorId: 'user-1', context: 'client', intent: 'upload_document' });
    assert.equal(replay, null);

    const expiring = await provider.createPresignedUploadUrl({
      bucket: 'docs',
      key: 'firm/soon-expired.pdf',
      contentType: 'application/pdf',
      expiresInSeconds: 1
    });
    const expiringToken = new URL(`http://localhost${expiring.url}`).searchParams.get('token');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const expired = provider.consumePresignedToken(expiringToken, 'upload');
    assert.equal(expired, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('object metadata captures checksum and etag after write', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-meta-'));
  const provider = createLocalFilesystemStorageProvider({ rootDir });
  try {
    const body = Buffer.from('hello world');
    const result = await provider.putObject({ bucket: 'docs', key: 'firm/hello.txt', body });
    assert.ok(result.etag);
    assert.equal(result.checksum, result.etag);

    const metadata = provider.getObjectMetadata({ bucket: 'docs', key: 'firm/hello.txt' });
    assert.equal(metadata.checksum, result.etag);
    assert.equal(metadata.sizeBytes, body.length);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('retention classes are validated for upload intents', async () => {
  const storage = createObjectStorage({
    provider: {
      async putObject() { return { etag: 'ok' }; },
      async getObject() { return { body: Buffer.from(''), etag: 'ok', contentType: 'application/octet-stream' }; },
      async createPresignedUploadUrl() { return { method: 'PUT', url: '/signed', headers: {}, expiresAt: new Date().toISOString() }; },
      async createPresignedDownloadUrl() { return { method: 'GET', url: '/signed', headers: {}, expiresAt: new Date().toISOString() }; },
      async deleteObject() {}
    },
    retentionPolicies: {
      uploaded_document: { ttlDays: 365, archiveAfterDays: 90, purgeAfterDays: 730 }
    }
  });

  await assert.rejects(
    storage.createPresignedUploadUrl({
      bucket: 'docs',
      key: 'firm/file.bin',
      retentionClass: 'missing_class'
    }),
    /Unknown retention class/
  );
});
