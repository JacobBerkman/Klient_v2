import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const DEFAULT_ALGORITHM = 'aes-256-gcm'
const LEGACY_PAYLOAD_PARTS = 3

function toKeyBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw
  const value = String(raw || '')
  if (!value) throw new Error('Key material is required.')
  return createHash('sha256').update(value).digest()
}

function encodeCiphertext(keyBuffer, plaintext, alg = DEFAULT_ALGORITHM) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(alg, keyBuffer, iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decodeCiphertext(keyBuffer, payload, alg = DEFAULT_ALGORITHM) {
  const [ivHex, tagHex, dataHex] = String(payload || '').split(':')
  const decipher = createDecipheriv(alg, keyBuffer, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}

export class EnvKeyProvider {
  constructor({ activeKeyId, keyring }) {
    this.activeKeyId = activeKeyId
    this.keyring = keyring
  }

  static fromRuntime(runtime) {
    const activeKeyId = process.env.PII_ACTIVE_KEY_ID || 'app-secret-v1'
    const parsed = process.env.PII_KEYRING ? JSON.parse(process.env.PII_KEYRING) : null
    const keyring =
      parsed && typeof parsed === 'object' && Object.keys(parsed).length ? parsed : { [activeKeyId]: runtime.appSecret }
    if (!keyring[activeKeyId]) {
      throw new Error(`PII keyring does not include active key: ${activeKeyId}.`)
    }
    return new EnvKeyProvider({ activeKeyId, keyring })
  }

  getActiveKey() {
    return { keyId: this.activeKeyId, key: toKeyBuffer(this.keyring[this.activeKeyId]) }
  }

  getKeyById(keyId) {
    if (!this.keyring[keyId]) return null
    return { keyId, key: toKeyBuffer(this.keyring[keyId]) }
  }
}

export class KmsHsmKeyProvider {
  constructor({ adapter }) {
    this.adapter = adapter
  }

  getActiveKey() {
    const active = this.adapter.getActiveKey()
    return { keyId: active.keyId, key: toKeyBuffer(active.key) }
  }

  getKeyById(keyId) {
    const found = this.adapter.getKeyById(keyId)
    if (!found) return null
    return { keyId, key: toKeyBuffer(found.key) }
  }
}

export function createKeyProvider(runtime, options = {}) {
  if ((runtime.piiKeyProvider || 'env') === 'kms') {
    if (!options.kmsAdapter) throw new Error('KMS key provider selected but no kmsAdapter was provided.')
    return new KmsHsmKeyProvider({ adapter: options.kmsAdapter })
  }
  return EnvKeyProvider.fromRuntime(runtime)
}

export class PiiCryptoService {
  constructor({ keyProvider, now = () => new Date().toISOString(), legacyKeyId = 'legacy-app-secret-v1' }) {
    this.keyProvider = keyProvider
    this.now = now
    this.legacyKeyId = legacyKeyId
  }

  encrypt(value) {
    if (!value) return null
    const active = this.keyProvider.getActiveKey()
    return {
      keyId: active.keyId,
      alg: DEFAULT_ALGORITHM,
      createdAt: this.now(),
      ciphertext: encodeCiphertext(active.key, value, DEFAULT_ALGORITHM)
    }
  }

  decrypt(payload) {
    if (!payload) return null
    if (typeof payload === 'string') {
      const key = this.resolveLegacyKey(payload)
      return decodeCiphertext(key.key, payload, DEFAULT_ALGORITHM)
    }
    const keyRef = this.keyProvider.getKeyById(payload.keyId)
    if (!keyRef) throw new Error(`Unable to resolve PII key: ${payload.keyId}.`)
    return decodeCiphertext(keyRef.key, payload.ciphertext, payload.alg || DEFAULT_ALGORITHM)
  }

  needsReencryption(payload) {
    if (!payload) return false
    if (typeof payload === 'string') return true
    return payload.keyId !== this.keyProvider.getActiveKey().keyId
  }

  reencrypt(payload) {
    if (!payload) return null
    if (!this.needsReencryption(payload)) return payload
    const plaintext = this.decrypt(payload)
    return this.encrypt(plaintext)
  }

  resolveLegacyKey(payload) {
    const parts = String(payload || '').split(':')
    if (parts.length !== LEGACY_PAYLOAD_PARTS) {
      throw new Error('Invalid legacy ciphertext payload.')
    }
    const preferred = this.keyProvider.getKeyById(this.legacyKeyId)
    if (preferred) return preferred
    return this.keyProvider.getActiveKey()
  }
}
