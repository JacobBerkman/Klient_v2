export const AUTH_PROVIDERS = ['local', 'oidc', 'saml']
export const PII_KEY_PROVIDERS = ['env', 'kms']
export const STORAGE_PROVIDERS = ['local', 's3']

function readNonEmpty(env, name, fallback = '') {
  const raw = env[name]
  if (raw === undefined || raw === null) return fallback
  const normalized = String(raw).trim()
  return normalized || fallback
}

function readList(env, name) {
  const raw = env[name]
  if (!raw) return []
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function hasValue(env, name) {
  return Boolean(readNonEmpty(env, name))
}

export function readAuthProviderFromEnv(env = process.env) {
  const raw = readNonEmpty(env, 'AUTH_PROVIDER', 'local')
  const normalized = raw.toLowerCase()
  if (!AUTH_PROVIDERS.includes(normalized)) {
    throw new Error(
      `Invalid AUTH_PROVIDER: received "${raw}". Accepted values: ${AUTH_PROVIDERS.join(', ')}.`
    )
  }
  return normalized
}

export function readPiiKeyProviderFromEnv(env = process.env) {
  const normalized = readNonEmpty(env, 'PII_KEY_PROVIDER', 'env').toLowerCase()
  if (!PII_KEY_PROVIDERS.includes(normalized)) {
    throw new Error(`Invalid PII_KEY_PROVIDER: ${normalized}.`)
  }
  return normalized
}

export function readStorageProviderFromEnv(env = process.env) {
  const normalized = readNonEmpty(env, 'STORAGE_PROVIDER', 'local').toLowerCase()
  if (!STORAGE_PROVIDERS.includes(normalized)) {
    throw new Error(`Invalid STORAGE_PROVIDER: ${normalized}.`)
  }
  return normalized
}

export function evaluateRuntimeRequiredEnvPresence(env = process.env) {
  const authProvider = readAuthProviderFromEnv(env)
  const piiKeyProvider = readPiiKeyProviderFromEnv(env)
  const storageProvider = readStorageProviderFromEnv(env)
  const nodeEnv = readNonEmpty(env, 'NODE_ENV', 'development').toLowerCase()

  const authRequired = {
    local: ['ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS'],
    oidc: ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'],
    saml: ['SAML_ENTRY_POINT', 'SAML_ISSUER', 'SAML_CERT']
  }
  const piiRequired = {
    env: ['PII_ACTIVE_KEY_ID', 'PII_KEYRING'],
    kms: ['PII_KMS_KEYRING', 'PII_KMS_ACTIVE_KEY_ID_OR_PII_ACTIVE_KEY_ID']
  }
  const storageRequired = {
    local: [],
    s3: ['STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']
  }

  const authMissing = authRequired[authProvider].filter((name) => {
    if (name === 'ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS') {
      return String(readNonEmpty(env, name, 'false')).toLowerCase() !== 'true'
    }
    return !hasValue(env, name)
  })

  const opsPresence = {
    active: hasValue(env, 'KLIENT_OPS_TOKEN_ACTIVE'),
    previous: hasValue(env, 'KLIENT_OPS_TOKEN_PREVIOUS'),
    set: readList(env, 'KLIENT_OPS_TOKENS').length > 0,
    legacy: hasValue(env, 'KLIENT_OPS_TOKEN')
  }
  const hasAnyOpsToken = Object.values(opsPresence).some(Boolean)

  const piiMissing = piiRequired[piiKeyProvider].filter((name) => {
    if (name === 'PII_KMS_ACTIVE_KEY_ID_OR_PII_ACTIVE_KEY_ID') {
      return !(hasValue(env, 'PII_KMS_ACTIVE_KEY_ID') || hasValue(env, 'PII_ACTIVE_KEY_ID'))
    }
    return !hasValue(env, name)
  })

  const storageMissing = storageRequired[storageProvider].filter((name) => !hasValue(env, name))

  const authReady = authMissing.length === 0
  const opsReady = hasAnyOpsToken
  const piiReady = piiMissing.length === 0
  const storageReady = storageMissing.length === 0

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    nodeEnv,
    mode: {
      authProvider,
      piiKeyProvider,
      storageProvider
    },
    auth: {
      required: authRequired[authProvider],
      missing: authMissing,
      ready: authReady,
      guidance:
        authProvider === 'local'
          ? 'AUTH_PROVIDER=local in production requires ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true with incident approval and expiry.'
          : `AUTH_PROVIDER=${authProvider} selected; provide all required ${authProvider.toUpperCase()} integration variables before release.`
    },
    opsTokens: {
      presence: opsPresence,
      hasAnyToken: hasAnyOpsToken,
      rotationReady: opsPresence.active && opsPresence.previous,
      ready: opsReady,
      guidance:
        'Set KLIENT_OPS_TOKEN_ACTIVE and KLIENT_OPS_TOKEN_PREVIOUS during rotation windows; keep at least one ops token var present at all times.'
    },
    pii: {
      required: piiRequired[piiKeyProvider],
      missing: piiMissing,
      ready: piiReady,
      guidance:
        piiKeyProvider === 'env'
          ? 'PII_KEY_PROVIDER=env requires PII_ACTIVE_KEY_ID and PII_KEYRING.'
          : 'PII_KEY_PROVIDER=kms requires PII_KMS_KEYRING and either PII_KMS_ACTIVE_KEY_ID or PII_ACTIVE_KEY_ID.'
    },
    storage: {
      required: storageRequired[storageProvider],
      missing: storageMissing,
      ready: storageReady,
      guidance:
        storageProvider === 's3'
          ? 'STORAGE_PROVIDER=s3 requires endpoint, region, access key id, and secret access key.'
          : 'STORAGE_PROVIDER=local selected; S3 credentials are not required.'
    },
    overall: {
      ready: authReady && opsReady && piiReady && storageReady,
      checks: {
        authReady,
        opsReady,
        piiReady,
        storageReady
      }
    }
  }
}
