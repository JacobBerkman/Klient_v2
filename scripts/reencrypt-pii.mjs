import { runtime } from '../apps/api/src/runtime.mjs'
import { createKeyProvider, PiiCryptoService } from '../apps/api/src/pii-crypto.mjs'
import { loadState, saveState } from '../apps/api/src/storage.mjs'

const keyProvider = createKeyProvider(runtime)
const piiCrypto = new PiiCryptoService({ keyProvider })

const actorUserId = process.env.PII_ROTATION_ACTOR_USER_ID || 'system'
const firmId = process.env.PII_ROTATION_FIRM_ID || null
const shouldValidate = process.argv.includes('--validate')
const activeKeyId = keyProvider.getActiveKey().keyId
const encryptedFields = ['ssnEncrypted', 'taxIdEncrypted', 'dobEncrypted']
const legacyFieldMap = {
  ssnCiphertext: 'ssnEncrypted',
  taxIdCiphertext: 'taxIdEncrypted'
}

const state = loadState(() => ({}))
let rotatedProfiles = 0
let rotatedFields = 0

for (const profile of state.profiles || []) {
  if (firmId && profile.firmId !== firmId) continue

  const pii = profile.pii || {}
  let profileChanged = false

  for (const [legacyField, encryptedField] of Object.entries(legacyFieldMap)) {
    if (!pii[legacyField]) continue

    const nextValue = piiCrypto.reencrypt(pii[legacyField])
    pii[encryptedField] = nextValue
    delete pii[legacyField]

    rotatedFields += 1
    profileChanged = true
  }

  for (const field of encryptedFields) {
    const current = pii[field]
    if (!current || !piiCrypto.needsReencryption(current)) continue

    pii[field] = piiCrypto.reencrypt(current)
    rotatedFields += 1
    profileChanged = true
  }

  if (profileChanged) {
    profile.pii = pii
    profile.updatedAt = new Date().toISOString()
    rotatedProfiles += 1
  }
}

saveState(state)

function validateRotation() {
  const targetProfiles = (state.profiles || []).filter((entry) => !firmId || entry.firmId === firmId)
  let profilesChecked = 0
  const legacyCiphertextCount = { ssnCiphertext: 0, taxIdCiphertext: 0 }
  const keyMismatches = []

  for (const profile of targetProfiles) {
    const pii = profile?.pii
    if (!pii) continue

    profilesChecked += 1

    if (pii.ssnCiphertext) legacyCiphertextCount.ssnCiphertext += 1
    if (pii.taxIdCiphertext) legacyCiphertextCount.taxIdCiphertext += 1

    for (const field of encryptedFields) {
      const envelope = pii[field]
      if (envelope?.keyId && envelope.keyId !== activeKeyId) {
        keyMismatches.push({ profileId: profile.id, field, keyId: envelope.keyId })
      }
    }
  }

  const hasLegacyCiphertext = legacyCiphertextCount.ssnCiphertext > 0 || legacyCiphertextCount.taxIdCiphertext > 0
  const isValid = !hasLegacyCiphertext && keyMismatches.length === 0

  return {
    ok: isValid,
    profilesChecked,
    activeKeyId,
    legacyCiphertextCount,
    keyMismatchCount: keyMismatches.length,
    keyMismatches
  }
}

const validation = shouldValidate ? validateRotation() : null

if (validation && !validation.ok) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        actorUserId,
        firmId,
        rotatedProfiles,
        rotatedFields,
        activeKeyId,
        validation
      },
      null,
      2
    )
  )
  process.exit(1)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      actorUserId,
      firmId,
      rotatedProfiles,
      rotatedFields,
      activeKeyId,
      validation
    },
    null,
    2
  )
)
