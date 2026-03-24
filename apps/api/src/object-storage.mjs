import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}

function extensionFromFileName(fileName = '') {
  const normalized = String(fileName);
  const idx = normalized.lastIndexOf('.');
  return idx >= 0 ? normalized.slice(idx) : '';
}

function buildObjectKey(namespace, firmId, fileName) {
  const safeNamespace = sanitizeSegment(namespace || 'misc');
  const safeFirm = sanitizeSegment(firmId || 'unknown-firm');
  const extension = extensionFromFileName(fileName);
  return `${safeNamespace}/${safeFirm}/${Date.now()}-${randomUUID()}${extension}`;
}

function streamToBuffer(stream) {
  return new Promise((resolveBuffer, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolveBuffer(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function createLocalStorage(runtime) {
  const rootDir = resolve(process.cwd(), runtime.localStoragePath || 'data/storage');

  return {
    backend: 'local',
    async putObject({ namespace, firmId, fileName, contentType, body }) {
      const objectKey = buildObjectKey(namespace, firmId, fileName);
      const fullPath = join(rootDir, objectKey);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, body);
      return {
        backend: 'local',
        objectKey,
        bucket: null,
        contentType: contentType || 'application/octet-stream',
        sizeBytes: body.byteLength
      };
    },
    async getObject(objectRef) {
      const fullPath = join(rootDir, objectRef.objectKey);
      const content = await readFile(fullPath);
      return {
        content,
        contentType: objectRef.contentType || 'application/octet-stream',
        sizeBytes: content.byteLength
      };
    },
    async deleteObject(objectRef) {
      const fullPath = join(rootDir, objectRef.objectKey);
      await rm(fullPath, { force: true });
    }
  };
}

function createS3Storage(runtime) {
  const client = new S3Client({
    region: runtime.objectStorage.region,
    endpoint: runtime.objectStorage.endpoint || undefined,
    forcePathStyle: runtime.objectStorage.forcePathStyle,
    credentials: runtime.objectStorage.accessKeyId
      ? {
          accessKeyId: runtime.objectStorage.accessKeyId,
          secretAccessKey: runtime.objectStorage.secretAccessKey
        }
      : undefined
  });

  return {
    backend: 's3',
    async putObject({ namespace, firmId, fileName, contentType, body }) {
      const objectKey = buildObjectKey(namespace, firmId, fileName);
      await client.send(
        new PutObjectCommand({
          Bucket: runtime.objectStorage.bucket,
          Key: objectKey,
          ContentType: contentType || 'application/octet-stream',
          Body: body
        })
      );
      return {
        backend: 's3',
        objectKey,
        bucket: runtime.objectStorage.bucket,
        contentType: contentType || 'application/octet-stream',
        sizeBytes: body.byteLength
      };
    },
    async getObject(objectRef) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: objectRef.bucket || runtime.objectStorage.bucket,
          Key: objectRef.objectKey
        })
      );
      const content = Buffer.isBuffer(response.Body)
        ? response.Body
        : response.Body?.transformToByteArray
          ? Buffer.from(await response.Body.transformToByteArray())
          : await streamToBuffer(response.Body);
      return {
        content,
        contentType: response.ContentType || objectRef.contentType || 'application/octet-stream',
        sizeBytes: Number(response.ContentLength || content.byteLength)
      };
    },
    async deleteObject(objectRef) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: objectRef.bucket || runtime.objectStorage.bucket,
          Key: objectRef.objectKey
        })
      );
    }
  };
}

export function createObjectStorage(runtime) {
  if (runtime.objectStorage.backend === 's3') {
    return createS3Storage(runtime);
  }
  return createLocalStorage(runtime);
}
