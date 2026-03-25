import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD_HASH_VERSION = 'scrypt_v1';
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;

function legacySha256(password) {
  return createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(String(password || ''), salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION
  }).toString('hex');
  return `${PASSWORD_HASH_VERSION}$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt}$${derivedKey}`;
}

function safeCompareHex(leftHex, rightHex) {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyPassword(password, passwordHash) {
  const normalized = String(passwordHash || '');
  const passwordValue = String(password || '');

  if (/^[a-f0-9]{64}$/i.test(normalized)) {
    const verified = safeCompareHex(legacySha256(passwordValue), normalized.toLowerCase());
    return { verified, needsRehash: verified };
  }

  const [version, costRaw, blockSizeRaw, parallelizationRaw, salt, derivedKey] = normalized.split('$');
  if (version !== PASSWORD_HASH_VERSION || !salt || !derivedKey) {
    return { verified: false, needsRehash: false };
  }

  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelizationRaw);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return { verified: false, needsRehash: false };
  }

  const candidate = scryptSync(passwordValue, salt, KEY_LENGTH, {
    N: cost,
    r: blockSize,
    p: parallelization
  }).toString('hex');

  const verified = safeCompareHex(candidate, derivedKey);
  return { verified, needsRehash: false };
}
