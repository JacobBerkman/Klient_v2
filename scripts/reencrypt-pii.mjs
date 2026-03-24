import { runtime } from '../apps/api/src/runtime.mjs';
import { createKeyProvider, PiiCryptoService } from '../apps/api/src/pii-crypto.mjs';
import { loadState, saveState } from '../apps/api/src/storage.mjs';

const keyProvider = createKeyProvider(runtime);
const piiCrypto = new PiiCryptoService({ keyProvider });
const actorUserId = process.env.PII_ROTATION_ACTOR_USER_ID || 'system';
const firmId = process.env.PII_ROTATION_FIRM_ID || null;
const shouldValidate = process.argv.includes('--validate');

const state = loadState(() => ({}));
let rotatedProfiles = 0;
let rotatedFields = 0;

for (const profile of state.profiles || []) {
  if (firmId && profile.firmId !== firmId) continue;

  let profileChanged = false;
  for (const field of ['ssnEncrypted', 'taxIdEncrypted']) {
    const current = profile?.pii?.[field];
    if (!current) continue;
    if (!piiCrypto.needsReencryption(current)) continue;
    profile.pii[field] = piiCrypto.reencrypt(current);
    rotatedFields += 1;
    profileChanged = true;
  }

  if (profileChanged) {
    profile.updatedAt = new Date().toISOString();
    rotatedProfiles += 1;
  }
}

saveState(state);

console.log(JSON.stringify({
  ok: true,
  actorUserId,
  firmId,
  rotatedProfiles,
  rotatedFields,
  activeKeyId: keyProvider.getActiveKey().keyId
}, null, 2));
const result = store.reencryptSensitiveData({ actorUserId, firmId });

function validateRotation() {
  const activeKeyId = store._internal.piiCrypto.keyProvider.getActiveKey().keyId;
  const targetProfiles = store.state.profiles.filter((entry) => !firmId || entry.firmId === firmId);
  const legacyCount = { ssn: 0, taxId: 0 };
  const rotatedMismatches = [];

  targetProfiles.forEach((profile) => {
    if (!profile?.pii) return;
    for (const field of ['ssn', 'taxId']) {
      if (profile.pii[`${field}Ciphertext`]) {
        legacyCount[field] += 1;
      }
      const envelope = profile.pii[`${field}Encrypted`];
      if (envelope?.keyId && envelope.keyId !== activeKeyId) {
        rotatedMismatches.push({ profileId: profile.id, field, keyId: envelope.keyId });
      }
    }
  });

  if (rotatedMismatches.length > 0 || legacyCount.ssn > 0 || legacyCount.taxId > 0) {
    throw new Error(`PII rotation validation failed: ${JSON.stringify({ activeKeyId, legacyCount, rotatedMismatches })}`);
  }
  return {
    activeKeyId,
    checkedProfiles: targetProfiles.length,
    legacyCount
  };
}

const validation = shouldValidate ? validateRotation() : null;
console.log(JSON.stringify({ ok: true, ...result, validation }, null, 2));
