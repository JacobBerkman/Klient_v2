import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimePath = pathToFileURL(resolve('apps/api/src/runtime.mjs')).href
const trackedEnvKeys = [
  'NODE_ENV',
  'APP_SECRET',
  'AUTH_PROVIDER',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_ALLOWED_ALGS',
  'SAML_ENTRY_POINT',
  'SAML_ISSUER',
  'SAML_CERT',
  'SAML_CLOCK_SKEW_SECONDS',
  'PII_ACTIVE_KEY_ID',
  'PII_KEYRING'
]

const baseEnv = {
  APP_SECRET: 'runtime-auth-provider-test-secret-1234!',
  PII_ACTIVE_KEY_ID: 'app-secret-v1',
  PII_KEYRING: '{"app-secret-v1":"ZmFrZS1rZXk="}'
}

function withAuthEnv(provider) {
  Object.assign(process.env, baseEnv)

  if (provider === 'oidc') {
    process.env.AUTH_PROVIDER = 'oidc'
    process.env.OIDC_ISSUER_URL = 'https://issuer.example.test'
    process.env.OIDC_CLIENT_ID = 'client-id'
    process.env.OIDC_CLIENT_SECRET = 'client-secret-1234'
    process.env.OIDC_REDIRECT_URI = 'https://app.example.test/callback'
    process.env.OIDC_ALLOWED_ALGS = 'RS256'
    return
  }

  if (provider === 'saml') {
    process.env.AUTH_PROVIDER = 'saml'
    process.env.SAML_ENTRY_POINT = 'https://idp.example.test/sso'
    process.env.SAML_ISSUER = 'klient-test'
    process.env.SAML_CERT = '-----BEGIN CERTIFICATE-----test-----END CERTIFICATE-----'
    process.env.SAML_CLOCK_SKEW_SECONDS = '0'
    return
  }

  if (provider === undefined) {
    delete process.env.AUTH_PROVIDER
    return
  }

  process.env.AUTH_PROVIDER = provider
}

async function withRuntimeEnv(overrides, fn) {
  const snapshot = Object.fromEntries(trackedEnvKeys.map((key) => [key, process.env[key]]))

  try {
    for (const key of trackedEnvKeys) delete process.env[key]
    Object.assign(process.env, overrides)
    const mod = await import(`${runtimePath}?t=${Date.now()}-${Math.random()}`)
    return await fn(mod)
  } finally {
    for (const key of trackedEnvKeys) {
      if (snapshot[key] === undefined) delete process.env[key]
      else process.env[key] = snapshot[key]
    }
  }
}

async function importRuntime(authProvider) {
  withAuthEnv(authProvider)
  return import(`${runtimePath}?t=${Date.now()}-${Math.random()}`)
}

async function loadRuntime(authProvider) {
  const mod = await importRuntime(authProvider)
  return mod.runtime.authProvider
}

test('runtime allows explicit oidc and saml auth providers with strict env validation', async () => {
  assert.equal(await loadRuntime('oidc'), 'oidc')
  assert.equal(await loadRuntime('saml'), 'saml')
})

test('runtime defaults to local when auth provider is omitted', async () => {
  assert.equal(await loadRuntime(undefined), 'local')
})

test('runtime throws for unknown auth provider and reports accepted values', async () => {
  await assert.rejects(
    () => importRuntime('unknown-provider'),
    /Invalid AUTH_PROVIDER: received "unknown-provider"\. Accepted values: local, oidc, saml\./
  )
})

test('runtime diagnostics warn for missing provider configuration outside production', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      AUTH_PROVIDER: 'oidc'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [])
      assert.match(diagnostics.warnings.join(' '), /OIDC provider requires OIDC_ISSUER_URL\./)
    }
  )
})

test('production oidc reports exact missing required settings', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'oidc',
      OIDC_ALLOWED_ALGS: 'RS256'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [
        'OIDC provider requires OIDC_ISSUER_URL.',
        'OIDC provider requires OIDC_CLIENT_ID.',
        'OIDC provider requires OIDC_CLIENT_SECRET.',
        'OIDC provider requires OIDC_REDIRECT_URI.'
      ])
    }
  )
})

test('production oidc reports exact https and secret length violations', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'oidc',
      OIDC_ISSUER_URL: 'http://issuer.example.test',
      OIDC_CLIENT_ID: 'client-id',
      OIDC_CLIENT_SECRET: 'short-secret',
      OIDC_REDIRECT_URI: 'http://app.example.test/callback',
      OIDC_ALLOWED_ALGS: 'RS256'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [
        'OIDC_ISSUER_URL must use https:// in production.',
        'OIDC_REDIRECT_URI must use https:// in production.',
        'OIDC_CLIENT_SECRET must be at least 16 characters in production.'
      ])
    }
  )
})

test('production saml reports exact missing required settings', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'saml',
      SAML_CLOCK_SKEW_SECONDS: '0'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [
        'SAML provider requires SAML_ENTRY_POINT.',
        'SAML provider requires SAML_ISSUER.',
        'SAML provider requires SAML_CERT.'
      ])
    }
  )
})

test('production saml reports exact https/pem/clock-skew violations', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'saml',
      SAML_ENTRY_POINT: 'http://idp.example.test/sso',
      SAML_ISSUER: 'klient-test',
      SAML_CERT: 'not-a-pem',
      SAML_CLOCK_SKEW_SECONDS: '-5'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [
        'SAML_ENTRY_POINT must use https:// in production.',
        'SAML_CERT must contain a PEM certificate block in production.',
        'SAML_CLOCK_SKEW_SECONDS must be a non-negative number when provided.'
      ])
    }
  )
})
