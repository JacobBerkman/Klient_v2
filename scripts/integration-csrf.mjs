import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('csrf')

try {
  const baseUrl = `http://127.0.0.1:${context.port}`

  const login = await context.login()
  assert(Boolean(login.token), 'Login should return bearer token')

  const csrfBootstrap = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Authorization: `Bearer ${login.token}`
    }
  })
  const csrfData = await csrfBootstrap.json()
  const setCookie = csrfBootstrap.headers.get('set-cookie') || ''
  const csrfCookie = setCookie.split(';')[0]

  assert(csrfBootstrap.ok, 'Failed to issue CSRF token for authenticated session')
  assert(Boolean(csrfData.csrfToken), 'CSRF token missing from issuance response')
  assert(Boolean(csrfData.expiresAt), 'CSRF bootstrap should include TTL metadata')
  assert(csrfCookie.startsWith('__Host-klient-csrf='), 'CSRF cookie missing')

  const mutatingHeaders = {
    Authorization: `Bearer ${login.token}`,
    'Content-Type': 'application/json',
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    Cookie: csrfCookie,
    'X-CSRF-Token': csrfData.csrfToken
  }

  const validMutationResponse = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: mutatingHeaders
  })
  const validMutationData = await validMutationResponse.json()
  assert(validMutationResponse.status === 200, 'Valid CSRF token should permit mutating request')
  assert(validMutationData.ok === true, 'Logout should succeed with valid CSRF token')

  const secondLogin = await context.login()
  const staleCandidateResponse = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Authorization: `Bearer ${secondLogin.token}`
    }
  })
  const staleCandidateData = await staleCandidateResponse.json()
  const staleCandidateCookie = (staleCandidateResponse.headers.get('set-cookie') || '').split(';')[0]

  const freshCsrfResponse = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Authorization: `Bearer ${secondLogin.token}`
    }
  })
  const freshCsrfData = await freshCsrfResponse.json()
  const freshCookie = (freshCsrfResponse.headers.get('set-cookie') || '').split(';')[0]

  const staleTokenResponse = await fetch(`${baseUrl}/api/exports/process`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secondLogin.token}`,
      'X-CSRF-Token': staleCandidateData.csrfToken,
      Cookie: staleCandidateCookie,
      Origin: baseUrl,
      Referer: `${baseUrl}/`
    }
  })
  const staleTokenData = await staleTokenResponse.json()
  assert(staleTokenResponse.status === 403, 'Stale CSRF token should fail after rotation')
  assert(staleTokenData.error?.code === 'CSRF_VALIDATION_FAILED', 'Stale-token response should include CSRF error code')

  const missingTokenResponse = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secondLogin.token}`,
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      Cookie: freshCookie
    }
  })
  const missingTokenData = await missingTokenResponse.json()
  assert(missingTokenResponse.status === 403, 'Missing CSRF token should fail')
  assert(
    missingTokenData.error?.code === 'CSRF_VALIDATION_FAILED',
    'Missing-token response should include CSRF error code'
  )

  const invalidOriginResponse = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secondLogin.token}`,
      'X-CSRF-Token': freshCsrfData.csrfToken,
      Cookie: freshCookie,
      Origin: 'https://malicious.example',
      Referer: 'https://malicious.example/attack',
      'Content-Type': 'application/json'
    }
  })
  const invalidOriginData = await invalidOriginResponse.json()
  assert(invalidOriginResponse.status === 403, 'Origin mismatch should fail for browser-like requests')
  assert(
    invalidOriginData.error?.code === 'CSRF_VALIDATION_FAILED',
    'Origin-failure response should include CSRF error code'
  )

  console.log(
    JSON.stringify(
      {
        suite: 'integration-csrf',
        bootstrap: csrfBootstrap.status,
        validMutation: validMutationResponse.status,
        missingToken: missingTokenResponse.status,
        staleToken: staleTokenResponse.status,
        crossOrigin: invalidOriginResponse.status
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
