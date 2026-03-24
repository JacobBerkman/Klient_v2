import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DIGIT_ONLY = /\D+/g;
const SSN_DIGITS = 9;
const TAX_ID_DIGITS = 9;

function toDigits(value) {
  return String(value || '').replace(DIGIT_ONLY, '');
}

export function normalizeSsn(value) {
  const digits = toDigits(value);
  if (!digits) return null;
  if (digits.length !== SSN_DIGITS) throw new Error('SSN must contain exactly 9 digits.');
  return digits;
}

export function normalizeTaxId(value) {
  const digits = toDigits(value);
  if (!digits) return null;
  if (digits.length !== TAX_ID_DIGITS) throw new Error('Tax ID must contain exactly 9 digits.');
  return digits;
}

export function maskSsn(value) {
  if (!value) return null;
  const digits = normalizeSsn(value);
  return `***-**-${digits.slice(-4)}`;
}

export function maskTaxId(value) {
  if (!value) return null;
  const digits = normalizeTaxId(value);
  return `**-${digits.slice(-4)}`;
}

function createEncryption(secret) {
  const key = createHash('sha256').update(secret).digest();

  return {
    encrypt(value) {
      if (!value) return null;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    },
    decrypt(payload) {
      if (!payload) return null;
      const [ivHex, tagHex, dataHex] = payload.split(':');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    }
  };
}

export function createPiiService({ secret, audit }) {
  const encryption = createEncryption(secret);

  function buildPatch(input = {}) {
    const patch = {};
    if (Object.hasOwn(input, 'ssn')) {
      patch.ssnCiphertext = encryption.encrypt(normalizeSsn(input.ssn));
    }
    if (Object.hasOwn(input, 'taxId')) {
      patch.taxIdCiphertext = encryption.encrypt(normalizeTaxId(input.taxId));
    }
    return patch;
  }

  return {
    applySensitiveWrite({ actor, profile, input, reason = 'profile.update' }) {
      const patch = buildPatch(input);
      if (!Object.keys(patch).length) {
        return profile.pii || { maskingPolicy: 'role_based', ssnCiphertext: null, taxIdCiphertext: null };
      }

      const nextPii = {
        maskingPolicy: 'role_based',
        ssnCiphertext: patch.ssnCiphertext ?? profile.pii?.ssnCiphertext ?? null,
        taxIdCiphertext: patch.taxIdCiphertext ?? profile.pii?.taxIdCiphertext ?? null
      };

      audit(actor, {
        entityType: 'profile',
        entityId: profile.id,
        action: 'profile.sensitive.updated',
        metadata: { reason, fields: Object.keys(patch).map((field) => field.replace('Ciphertext', '')) }
      });

      return nextPii;
    },
    getMaskedSensitiveData({ actor, profile, reason = 'profile.detail' }) {
      const ssn = encryption.decrypt(profile.pii?.ssnCiphertext);
      const taxId = encryption.decrypt(profile.pii?.taxIdCiphertext);

      audit(actor, {
        entityType: 'profile',
        entityId: profile.id,
        action: 'profile.sensitive.read',
        metadata: {
          reason,
          fields: ['ssn', 'taxId'].filter((field) => (field === 'ssn' ? Boolean(ssn) : Boolean(taxId)))
        }
      });

      return {
        ssnMasked: maskSsn(ssn),
        taxIdMasked: maskTaxId(taxId)
      };
    }
  };
}
