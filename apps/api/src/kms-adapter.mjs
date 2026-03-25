function parseJsonObject(name, value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${name} must be a JSON object.`)
    }
    return parsed
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error.message}`)
  }
}

class BaseKeyringAdapter {
  constructor({ provider, keyAlias, activeKeyId, encryptedKeyring, decryptor }) {
    this.provider = provider
    this.keyAlias = keyAlias
    this.activeKeyId = activeKeyId
    this.encryptedKeyring = encryptedKeyring
    this.decryptor = decryptor
  }

  rotateActiveKey(nextKeyId) {
    if (!nextKeyId || !this.encryptedKeyring[nextKeyId]) {
      throw new Error(`Rotation target key is unavailable: ${nextKeyId}.`)
    }
    this.activeKeyId = nextKeyId
  }

  getActiveKey() {
    return this.getKeyById(this.activeKeyId)
  }

  getKeyById(keyId) {
    const ciphertext = this.encryptedKeyring[keyId]
    if (!ciphertext) {
      throw new Error(`KMS key not found for keyId: ${keyId}.`)
    }
    const key = this.decryptor({ keyId, ciphertext, keyAlias: this.keyAlias, provider: this.provider })
    if (!key) {
      throw new Error(`KMS decrypt returned empty key material for keyId: ${keyId}.`)
    }
    return { keyId, key }
  }
}

export class RuntimeKmsAdapter extends BaseKeyringAdapter {
  static fromRuntime(runtime) {
    const keyAlias = process.env.PII_KMS_KEY_ALIAS || 'pii-master'
    const activeKeyId = process.env.PII_ACTIVE_KEY_ID || process.env.PII_KMS_ACTIVE_KEY_ID || 'kms-key-v1'
    const encryptedKeyring = parseJsonObject('PII_KMS_KEYRING', process.env.PII_KMS_KEYRING) || {}
    const fallbackPlaintext = runtime?.appSecret || ''

    return new RuntimeKmsAdapter({
      provider: process.env.PII_KMS_PROVIDER || 'runtime',
      keyAlias,
      activeKeyId,
      encryptedKeyring,
      decryptor: ({ ciphertext }) => {
        if (!ciphertext) {
          throw new Error('Missing KMS ciphertext payload.')
        }
        if (ciphertext.startsWith('plain:')) {
          return ciphertext.slice(6)
        }
        if (fallbackPlaintext && ciphertext === 'app-secret') {
          return fallbackPlaintext
        }
        throw new Error(`Unable to decrypt KMS key material for alias ${keyAlias}.`)
      }
    })
  }
}

export class AwsKmsAdapter extends BaseKeyringAdapter {
  static fromRuntime(runtime) {
    return RuntimeKmsAdapter.fromRuntime({ ...runtime, provider: 'aws-kms' })
  }
}

export class GcpKmsAdapter extends BaseKeyringAdapter {
  static fromRuntime(runtime) {
    return RuntimeKmsAdapter.fromRuntime({ ...runtime, provider: 'gcp-kms' })
  }
}

export function createRuntimeKmsAdapter(runtime) {
  const provider = String(process.env.PII_KMS_PROVIDER || 'runtime').toLowerCase()
  if (provider === 'aws-kms') return AwsKmsAdapter.fromRuntime(runtime)
  if (provider === 'gcp-kms') return GcpKmsAdapter.fromRuntime(runtime)
  return RuntimeKmsAdapter.fromRuntime(runtime)
}
