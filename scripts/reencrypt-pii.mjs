import { runtime } from '../apps/api/src/runtime.mjs';
import { createKeyProvider, PiiCryptoService } from '../apps/api/src/pii-crypto.mjs';
import { loadState, saveState } from '../apps/api/src/storage.mjs';

const keyProvider = createKeyProvider(runtime);
const piiCrypto = new PiiCryptoService({ keyProvider });
const actorUserId = process.env.PII_ROTATION_ACTOR_USER_ID || 'system';
const firmId = process.env.PII_ROTATION_FIRM_ID || null;

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
