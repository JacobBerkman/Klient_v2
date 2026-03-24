import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

export function createLocalFilesystemStorageProvider({ rootDir }) {
  const baseDir = resolve(rootDir || resolve(process.cwd(), 'data', 'objects'));
  const presignedTokens = new Map();
  const objectMetadata = new Map();

  function keyPath(bucket, key) {
    const normalized = String(key || '').replace(/^\/+/, '');
    return resolve(baseDir, bucket, normalized);
  }

  function metadataKey({ bucket, key }) {
    return `${bucket}:${key}`;
  }

  function putToken(operation, object, expiresInSeconds = 300) {
    const token = randomUUID();
    const normalizedObject = {
      ...object,
      maxSizeBytes: Number(object?.maxSizeBytes || 0) || null,
      tokenScope: {
        actorId: object?.actorId || null,
        context: object?.context || null,
        intent: object?.intent || null
      }
    };
    presignedTokens.set(token, {
      operation,
      object: normalizedObject,
      consumed: false,
      oneTime: object?.oneTime !== false,
      expiresAt: Date.now() + Math.max(1, Number(expiresInSeconds || 300)) * 1000
    });
    return token;
  }

  function digest(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
  }

  return {
    type: 'local',
    baseDir,
    async putObject({ bucket, key, body }) {
      const absolutePath = keyPath(bucket, key);
      await mkdir(dirname(absolutePath), { recursive: true });
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      await writeFile(absolutePath, buffer);
      const etag = digest(buffer);
      objectMetadata.set(metadataKey({ bucket, key }), {
        checksum: etag,
        etag,
        sizeBytes: buffer.length,
        uploadedAt: nowIso()
      });
      return { etag, checksum: etag, sizeBytes: buffer.length };
    },
    async getObject({ bucket, key }) {
      const absolutePath = keyPath(bucket, key);
      const body = await readFile(absolutePath);
      const etag = digest(body);
      return { body, etag, checksum: etag, contentType: null };
    },
    async createPresignedUploadUrl(object) {
      const token = putToken('upload', object, object.expiresInSeconds || 900);
      const expiresAt = new Date(Date.now() + (object.expiresInSeconds || 900) * 1000).toISOString();
      return {
        method: 'PUT',
        url: `/api/storage/presigned/upload?token=${encodeURIComponent(token)}`,
        headers: {
          'Content-Type': object.contentType || 'application/octet-stream',
          ...(object.actorId ? { 'X-Storage-Actor-Id': object.actorId } : {}),
          ...(object.context ? { 'X-Storage-Context': object.context } : {}),
          ...(object.intent ? { 'X-Storage-Intent': object.intent } : {})
        },
        expiresAt
      };
    },
    async createPresignedDownloadUrl(object) {
      const token = putToken('download', object, object.expiresInSeconds || 900);
      const expiresAt = new Date(Date.now() + (object.expiresInSeconds || 900) * 1000).toISOString();
      return {
        method: 'GET',
        url: `/api/storage/presigned/download?token=${encodeURIComponent(token)}`,
        headers: {},
        expiresAt
      };
    },
    async deleteObject({ bucket, key }) {
      const absolutePath = keyPath(bucket, key);
      if (existsSync(absolutePath)) {
        await rm(absolutePath, { force: true });
      }
    },
    consumePresignedToken(token, operation, context = {}) {
      const entry = presignedTokens.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        presignedTokens.delete(token);
        return null;
      }
      if (entry.operation !== operation) return null;
      if (entry.consumed && entry.oneTime) return null;
      if (entry.object?.tokenScope?.actorId && context.actorId && entry.object.tokenScope.actorId !== context.actorId) return null;
      if (entry.object?.tokenScope?.context && context.context && entry.object.tokenScope.context !== context.context) return null;
      if (entry.object?.tokenScope?.intent && context.intent && entry.object.tokenScope.intent !== context.intent) return null;
      if (entry.oneTime) {
        entry.consumed = true;
        presignedTokens.delete(token);
      }
      return entry.object;
    },
    getObjectMetadata({ bucket, key }) {
      return objectMetadata.get(metadataKey({ bucket, key })) || null;
    },
    describeHealth() {
      const info = {
        provider: 'local',
        baseDir,
        exists: existsSync(baseDir),
        activePresignedTokens: presignedTokens.size,
        checkedAt: nowIso()
      };
      return info;
    },
    async statObject({ bucket, key }) {
      const absolutePath = keyPath(bucket, key);
      const objectStat = await stat(absolutePath);
      const stored = objectMetadata.get(metadataKey({ bucket, key })) || {};
      return { sizeBytes: objectStat.size, updatedAt: objectStat.mtime.toISOString(), etag: stored.etag || null, checksum: stored.checksum || null };
    }
  };
}
