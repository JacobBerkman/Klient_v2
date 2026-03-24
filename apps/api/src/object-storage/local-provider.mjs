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

  function keyPath(bucket, key) {
    const normalized = String(key || '').replace(/^\/+/, '');
    return resolve(baseDir, bucket, normalized);
  }

  function putToken(operation, object, expiresInSeconds = 300) {
    const token = randomUUID();
    presignedTokens.set(token, {
      operation,
      object,
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
      return { etag: digest(buffer) };
    },
    async getObject({ bucket, key }) {
      const absolutePath = keyPath(bucket, key);
      const body = await readFile(absolutePath);
      return { body, etag: digest(body), contentType: null };
    },
    async createPresignedUploadUrl(object) {
      const token = putToken('upload', object, object.expiresInSeconds || 900);
      const expiresAt = new Date(Date.now() + (object.expiresInSeconds || 900) * 1000).toISOString();
      return {
        method: 'PUT',
        url: `/api/storage/presigned/upload?token=${encodeURIComponent(token)}`,
        headers: {
          'Content-Type': object.contentType || 'application/octet-stream'
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
    consumePresignedToken(token, operation) {
      const entry = presignedTokens.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        presignedTokens.delete(token);
        return null;
      }
      if (entry.operation !== operation) return null;
      if (operation === 'download') {
        return entry.object;
      }
      presignedTokens.delete(token);
      return entry.object;
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
      return { sizeBytes: objectStat.size, updatedAt: objectStat.mtime.toISOString() };
    }
  };
}
