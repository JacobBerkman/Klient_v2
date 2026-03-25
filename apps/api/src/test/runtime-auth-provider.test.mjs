import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimePath = pathToFileURL(resolve('apps/api/src/runtime.mjs')).href

function withAuthEnv(provider) {
  process.env.APP_SECRET = 'runtime-auth-provider-test-secret-1234!'
  if (provider === 'oidc') {
    process.env.AUTH_PROVIDER = 'oidc'
    process.env.OIDC_ISSUER_URL = 'https://issuer.example.test'
    process.env.OIDC_CLIENT_ID = 'client-id'
    process.env.OIDC_CLIENT_SECRET = 'client-secret'
    process.env.OIDC_REDIRECT_URI = 'https://app.example.test/callback'
    return
  }
  if (provider === 'saml') {
    process.env.AUTH_PROVIDER = 'saml'
    process.env.SAML_ENTRY_POINT = 'https://idp.example.test/sso'
    process.env.SAML_ISSUER = 'klient-test'
    process.env.SAML_CERT = '-----BEGIN CERTIFICATE-----test-----END CERTIFICATE-----'
    return
  }
  if (provider === undefined) {
    delete process.env.AUTH_PROVIDER
    return
  }
  process.env.AUTH_PROVIDER = provider
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

test('runtime diagnostics report missing provider configuration', async () => {
  process.env.AUTH_PROVIDER = 'oidc'
  delete process.env.OIDC_ISSUER_URL
  delete process.env.OIDC_CLIENT_ID
  delete process.env.OIDC_CLIENT_SECRET
  delete process.env.OIDC_REDIRECT_URI

  const mod = await import(`${runtimePath}?t=${Date.now()}-${Math.random()}`)
  const diagnostics = mod.validateRuntimeConfig()
  assert.equal(diagnostics.ok, false)
  assert.match(diagnostics.issues.join(' '), /OIDC provider requires OIDC_ISSUER_URL/)
})
