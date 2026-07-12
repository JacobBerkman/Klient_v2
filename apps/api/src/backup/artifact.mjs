// Encrypted-backup artifact format + crypto for Kinetic Klient.
//
// Layout of an on-disk artifact (a single self-contained file):
//
//   bytes 0..3   ASCII magic  "KLBK"
//   bytes 4..7   uint32 BE    JSON header length (H)
//   bytes 8..8+H JSON header  (utf8, see buildHeader)
//   bytes 8+H..  ciphertext   (AES-256-GCM ciphertext of the plaintext DB)
//
// The 96-bit IV and 128-bit GCM auth tag live inside the JSON header (hex),
// so the artifact "carries iv+authTag+ciphertext with a small JSON header"
// exactly as the runbook describes. A fixed AAD binds the format version into
// the tag; any bit-flip in the ciphertext (or a wrong key) fails auth on
// decrypt via GCM's final() check.
//
// Key material precedence:
//   1. BACKUP_ENCRYPTION_KEY  (dedicated key — recommended)
//        * 64 hex chars  -> used raw as a 32-byte key      (keyDerivation: raw-hex)
//        * anything else  -> scrypt(passphrase, salt, 32)   (keyDerivation: scrypt)
//   2. APP_SECRET             (fallback — WARNs loudly)
//        * scrypt(APP_SECRET, salt, 32)                     (keyDerivation: scrypt)
//
// The keySource + salt + scrypt params are recorded in the header so restore
// can re-derive the identical key from the same environment variable.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

export const MAGIC = Buffer.from('KLBK', 'ascii')
export const ARTIFACT_VERSION = 1
export const ALGORITHM = 'aes-256-gcm'
export const AAD = Buffer.from('kinetic-klient-backup-v1', 'utf8')

const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16
const HEADER_PREFIX_BYTES = 8
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i
// scrypt cost params. N must be a power of two; maxmem is bumped so the
// default 16384/8/1 fits comfortably in node's crypto memory budget.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: KEY_BYTES, maxmem: 64 * 1024 * 1024 }

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Derive a fresh backup key from the environment for a NEW backup. Returns the
 * key plus the metadata needed to reproduce it at restore time.
 */
export function deriveBackupKey(env = process.env) {
  const backupKey = String(env.BACKUP_ENCRYPTION_KEY || '').trim()
  if (backupKey) {
    if (HEX_KEY_PATTERN.test(backupKey)) {
      return {
        key: Buffer.from(backupKey, 'hex'),
        keySource: 'backup-key',
        keyDerivation: 'raw-hex',
        salt: null,
        usingFallback: false
      }
    }
    const salt = randomBytes(SALT_BYTES)
    return {
      key: scryptSync(backupKey, salt, KEY_BYTES, SCRYPT_PARAMS),
      keySource: 'backup-key',
      keyDerivation: 'scrypt',
      salt,
      usingFallback: false
    }
  }

  const appSecret = String(env.APP_SECRET || '').trim()
  if (!appSecret) {
    throw new Error(
      'Cannot derive a backup key: set BACKUP_ENCRYPTION_KEY (recommended) or APP_SECRET before running a backup.'
    )
  }
  const salt = randomBytes(SALT_BYTES)
  return {
    key: scryptSync(appSecret, salt, KEY_BYTES, SCRYPT_PARAMS),
    keySource: 'app-secret',
    keyDerivation: 'scrypt',
    salt,
    usingFallback: true
  }
}

/**
 * Re-derive the key for an existing artifact from its header + environment.
 */
export function resolveBackupKey(header, env = process.env) {
  const envName = header.keySource === 'app-secret' ? 'APP_SECRET' : 'BACKUP_ENCRYPTION_KEY'
  const material = String(env[envName] || '').trim()
  if (!material) {
    throw new Error(
      `Cannot decrypt backup: environment variable ${envName} is not set (keySource=${header.keySource}).`
    )
  }
  if (header.keyDerivation === 'raw-hex') {
    if (!HEX_KEY_PATTERN.test(material)) {
      throw new Error(`Cannot decrypt backup: ${envName} must be 64 hex characters for a raw-hex artifact.`)
    }
    return Buffer.from(material, 'hex')
  }
  if (header.keyDerivation === 'scrypt') {
    const salt = Buffer.from(String(header.salt || ''), 'hex')
    const params = header.scrypt || {}
    return scryptSync(material, salt, params.keylen || KEY_BYTES, {
      N: params.N || SCRYPT_PARAMS.N,
      r: params.r || SCRYPT_PARAMS.r,
      p: params.p || SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem
    })
  }
  throw new Error(`Unsupported keyDerivation in backup header: ${header.keyDerivation}`)
}

function serializeArtifact(header, ciphertext) {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(HEADER_PREFIX_BYTES)
  MAGIC.copy(prefix, 0)
  prefix.writeUInt32BE(headerJson.length, 4)
  return Buffer.concat([prefix, headerJson, ciphertext])
}

/**
 * Parse the framing of an artifact buffer into { header, ciphertext }.
 * Throws if the magic bytes or length framing are invalid.
 */
export function parseArtifact(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_PREFIX_BYTES) {
    throw new Error('Invalid backup artifact: file is too small to contain a header.')
  }
  if (!buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Invalid backup artifact: bad magic bytes (not a KLBK file).')
  }
  const headerLength = buffer.readUInt32BE(4)
  const headerEnd = HEADER_PREFIX_BYTES + headerLength
  if (headerLength <= 0 || headerEnd > buffer.length) {
    throw new Error('Invalid backup artifact: header length is out of range.')
  }
  let header
  try {
    header = JSON.parse(buffer.subarray(HEADER_PREFIX_BYTES, headerEnd).toString('utf8'))
  } catch {
    throw new Error('Invalid backup artifact: header is not valid JSON.')
  }
  return { header, ciphertext: buffer.subarray(headerEnd) }
}

/**
 * Encrypt a plaintext DB buffer into an artifact buffer.
 * `createdAt` is passed in explicitly (callers may use Date.now/new Date).
 */
export function encryptBackup(plaintext, { createdAt, env = process.env, sourceLabel = null } = {}) {
  if (!Buffer.isBuffer(plaintext)) {
    throw new Error('encryptBackup requires a Buffer of plaintext database bytes.')
  }
  const derived = deriveBackupKey(env)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, derived.key, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  const header = {
    magic: 'KLBK',
    version: ARTIFACT_VERSION,
    algorithm: ALGORITHM,
    createdAt: createdAt || new Date().toISOString(),
    keySource: derived.keySource,
    keyDerivation: derived.keyDerivation,
    salt: derived.salt ? derived.salt.toString('hex') : null,
    scrypt:
      derived.keyDerivation === 'scrypt'
        ? { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, keylen: KEY_BYTES }
        : null,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    aad: AAD.toString('utf8'),
    plaintextBytes: plaintext.length,
    plaintextSha256: sha256Hex(plaintext),
    sourceLabel
  }

  return { artifact: serializeArtifact(header, ciphertext), header, usingFallback: derived.usingFallback }
}

/**
 * Decrypt an artifact buffer back to the plaintext DB bytes.
 * Throws on auth-tag failure (tampered ciphertext OR wrong key) and on a
 * post-decrypt SHA-256 mismatch. An explicit `key` overrides env derivation
 * (used by the drill to exercise the wrong-key path deterministically).
 */
export function decryptBackup(artifactBuffer, { env = process.env, key = null } = {}) {
  const { header, ciphertext } = parseArtifact(artifactBuffer)
  const decryptionKey = key || resolveBackupKey(header, env)
  const decipher = createDecipheriv(ALGORITHM, decryptionKey, Buffer.from(header.iv, 'hex'))
  decipher.setAAD(Buffer.from(header.aad || AAD.toString('utf8'), 'utf8'))
  decipher.setAuthTag(Buffer.from(header.authTag, 'hex'))
  // final() throws when the GCM tag does not verify — this is the tamper /
  // wrong-key tripwire.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (header.plaintextSha256 && sha256Hex(plaintext) !== header.plaintextSha256) {
    throw new Error('Backup integrity check failed: decrypted SHA-256 does not match the artifact header.')
  }
  return { header, plaintext }
}
