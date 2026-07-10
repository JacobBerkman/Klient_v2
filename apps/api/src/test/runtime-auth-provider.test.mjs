import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateRuntimeRequiredEnvPresence } from '../runtime-requirements.mjs'

const runtimePath = pathToFileURL(resolve('apps/api/src/runtime.mjs')).href
const trackedEnvKeys = [
  'NODE_ENV',
  'APP_SECRET',
  'AUTH_PROVIDER',
  'ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS',
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
  'PII_KEYRING',
  'KLIENT_OPS_TOKEN',
  'KLIENT_OPS_TOKEN_ACTIVE',
  'KLIENT_OPS_TOKEN_PREVIOUS',
  'KLIENT_OPS_TOKENS'
]

const baseEnv = {
  APP_SECRET: 'runtime-auth-provider-test-secret-1234!',
  PII_ACTIVE_KEY_ID: 'app-secret-v1',
  PII_KEYRING: '{"app-secret-v1":"ZmFrZS1rZXk="}',
  KLIENT_OPS_TOKEN: 'ops-token-abcdefghijklmnopqrstuvwxyz'
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
        'Required environment is incomplete (auth missing: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI)',
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
        'Required environment is incomplete (auth missing: SAML_ENTRY_POINT, SAML_ISSUER, SAML_CERT)',
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

test('production local auth passes cleanly without break-glass', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'local'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.equal(
        diagnostics.issues.some((issue) => /AUTH_PROVIDER=local is blocked/.test(issue)),
        false
      )
      assert.equal(
        diagnostics.issues.some((issue) => /AUTH_PROVIDER|OIDC|SAML|auth/i.test(issue)),
        false
      )
      assert.match(
        diagnostics.warnings.join(' '),
        /AUTH_PROVIDER=local enables built-in password authentication flows\./
      )
    }
  )
})

test('production requires AUTH_PROVIDER to be explicitly set', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.ok(
        diagnostics.issues.includes(
          'AUTH_PROVIDER must be explicitly set in production (local, oidc, or saml); implicit local fallback is blocked.'
        )
      )
    }
  )
})

test('ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS is inert for production local auth', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'local',
      ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS: 'true'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.equal(
        diagnostics.warnings.some((warning) => /BREAK-GLASS/.test(warning)),
        false
      )
      assert.equal(
        diagnostics.issues.some((issue) => /AUTH_PROVIDER=local is blocked/.test(issue)),
        false
      )
    }
  )
})

test('production oidc with complete config warns that the implementation is not yet available', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'oidc',
      OIDC_ISSUER_URL: 'https://issuer.example.test',
      OIDC_CLIENT_ID: 'client-id',
      OIDC_CLIENT_SECRET: 'client-secret-1234',
      OIDC_REDIRECT_URI: 'https://app.example.test/callback',
      OIDC_ALLOWED_ALGS: 'RS256'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [])
      assert.match(
        diagnostics.warnings.join(' '),
        /AUTH_PROVIDER=oidc configuration is validated but the oidc protocol implementation is not yet available; interactive logins will not succeed\./
      )
    }
  )
})

test('production saml with complete config warns that the implementation is not yet available', async () => {
  await withRuntimeEnv(
    {
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'saml',
      SAML_ENTRY_POINT: 'https://idp.example.test/sso',
      SAML_ISSUER: 'klient-test',
      SAML_CERT: '-----BEGIN CERTIFICATE-----test-----END CERTIFICATE-----',
      SAML_CLOCK_SKEW_SECONDS: '0'
    },
    ({ validateRuntimeConfig }) => {
      const diagnostics = validateRuntimeConfig()
      assert.deepEqual(diagnostics.issues, [])
      assert.match(
        diagnostics.warnings.join(' '),
        /AUTH_PROVIDER=saml configuration is validated but the saml protocol implementation is not yet available; interactive logins will not succeed\./
      )
    }
  )
})

test('evaluateRuntimeRequiredEnvPresence treats local auth as fully satisfied without extra variables', () => {
  const report = evaluateRuntimeRequiredEnvPresence({
    NODE_ENV: 'production',
    AUTH_PROVIDER: 'local',
    KLIENT_OPS_TOKEN: 'ops-token-abcdefghijklmnopqrstuvwxyz',
    PII_ACTIVE_KEY_ID: 'app-secret-v1',
    PII_KEYRING: '{"app-secret-v1":"ZmFrZS1rZXk="}'
  })
  assert.deepEqual(report.auth.required, [])
  assert.deepEqual(report.auth.missing, [])
  assert.equal(report.auth.ready, true)
  assert.equal(
    report.auth.guidance,
    'AUTH_PROVIDER=local is fully supported in production; no additional auth variables are required.'
  )
})
