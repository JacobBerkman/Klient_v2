import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { runtime } from '../runtime.mjs';
import { assertStorageProvider } from './provider-interface.mjs';
import { createLocalFilesystemStorageProvider } from './local-provider.mjs';
import { createS3CompatibleStorageProvider } from './s3-provider.mjs';

function parseRetentionPolicies() {
  return {
    export_artifact: {
      ttlDays: Number(runtime.storageExportTtlDays || 14),
      archiveAfterDays: Number(runtime.storageExportArchiveAfterDays || 3),
      purgeAfterDays: Number(runtime.storageExportPurgeAfterDays || 30)
    },
    uploaded_document: {
      ttlDays: Number(runtime.storageUploadTtlDays || 365),
      archiveAfterDays: Number(runtime.storageUploadArchiveAfterDays || 90),
      purgeAfterDays: Number(runtime.storageUploadPurgeAfterDays || 730)
    }
  };
}

export function createObjectStorage({ provider, bucketDocuments, bucketExports, retentionPolicies } = {}) {
  const resolvedProvider = assertStorageProvider(provider || buildProviderFromRuntime());
  const policies = retentionPolicies || parseRetentionPolicies();

  function assertRetentionClass(input = {}) {
    if (!input.retentionClass) return;
    if (!policies[input.retentionClass]) {
      throw new Error(`Unknown retention class: ${input.retentionClass}`);
    }
  }

  return {
    provider: resolvedProvider,
    bucketDocuments: bucketDocuments || runtime.storageBucketDocuments,
    bucketExports: bucketExports || runtime.storageBucketExports,
    retentionPolicies: policies,
    async putObject(input) {
      assertRetentionClass(input);
      return resolvedProvider.putObject(input);
    },
    async getObject(input) {
      return resolvedProvider.getObject(input);
    },
    async createPresignedUploadUrl(input) {
      assertRetentionClass(input);
      return resolvedProvider.createPresignedUploadUrl(input);
    },
    async createPresignedDownloadUrl(input) {
      return resolvedProvider.createPresignedDownloadUrl(input);
    },
    async deleteObject(input) {
      return resolvedProvider.deleteObject(input);
    },
    describeHealth() {
      return {
        provider: runtime.storageProvider,
        buckets: { documents: bucketDocuments || runtime.storageBucketDocuments, exports: bucketExports || runtime.storageBucketExports },
        ...(typeof resolvedProvider.describeHealth === 'function' ? resolvedProvider.describeHealth() : {})
      };
    }
  };
}

function buildProviderFromRuntime() {
  if (runtime.storageProvider === 's3') {
    if (!runtime.storageEndpoint || !runtime.storageRegion || !runtime.storageAccessKeyId || !runtime.storageSecretAccessKey) {
      throw new Error('S3 storage provider requires STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.');
    }
    return createS3CompatibleStorageProvider({
      endpoint: runtime.storageEndpoint,
      region: runtime.storageRegion,
      accessKeyId: runtime.storageAccessKeyId,
      secretAccessKey: runtime.storageSecretAccessKey,
      forcePathStyle: runtime.storageForcePathStyle
    });
  }

  const baseDir = resolve(runtime.storageLocalDir || resolve(process.cwd(), 'data', 'objects'));
  mkdirSync(baseDir, { recursive: true });
  return createLocalFilesystemStorageProvider({ rootDir: baseDir });
}

export const objectStorage = createObjectStorage();
