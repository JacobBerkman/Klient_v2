import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('csrf')

try {
  const baseUrl = `http://127.0.0.1:${context.port}`

  const login = await context.login()
  assert(Boolean(login.user?.id), 'Login should return authenticated user')
  assert(Boolean(context.sessionCookie), 'Login should issue session cookie')

  const csrfBootstrap = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Cookie: context.sessionCookie
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
    'Content-Type': 'application/json',
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    Cookie: `${context.sessionCookie}; ${csrfCookie}`,
    'X-CSRF-Token': csrfData.csrfToken
  }

  const validMutationResponse = await fetch(`${baseUrl}/api/exports/process`, {
    method: 'POST',
    headers: mutatingHeaders
  })
  const validMutationData = await validMutationResponse.json()
  const rotatedToken = validMutationResponse.headers.get('x-csrf-token') || ''
  const rotatedCookie = (validMutationResponse.headers.get('set-cookie') || '').split(';')[0]
  assert(validMutationResponse.status === 200, 'Valid CSRF token should permit mutating request')
  assert(validMutationResponse.ok, 'Export processing should succeed with valid CSRF token')
  assert(Boolean(rotatedToken), 'Valid mutation should rotate CSRF token in response header')
  assert(rotatedCookie.startsWith('__Host-klient-csrf='), 'Valid mutation should rotate CSRF cookie')

  const replayResponse = await fetch(`${baseUrl}/api/exports/process`, {
    method: 'POST',
    headers: mutatingHeaders
  })
  const replayData = await replayResponse.json()
  assert(replayResponse.status === 403, 'Replayed CSRF token must be rejected')
  assert(replayData.error?.code === 'CSRF_VALIDATION_FAILED', 'Replay rejection should include CSRF error code')

  const secondLogin = await context.login()
  const staleCandidateResponse = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Cookie: context.sessionCookie
    }
  })
  const staleCandidateData = await staleCandidateResponse.json()
  const staleCandidateCookie = (staleCandidateResponse.headers.get('set-cookie') || '').split(';')[0]

  const freshCsrfResponse = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Cookie: context.sessionCookie
    }
  })
  const freshCsrfData = await freshCsrfResponse.json()
  const freshCookie = (freshCsrfResponse.headers.get('set-cookie') || '').split(';')[0]

  const staleTokenResponse = await fetch(`${baseUrl}/api/exports/process`, {
    method: 'POST',
    headers: {
      'X-CSRF-Token': staleCandidateData.csrfToken,
      Cookie: `${context.sessionCookie}; ${staleCandidateCookie}`,
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
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      Cookie: `${context.sessionCookie}; ${freshCookie}`
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
      'X-CSRF-Token': freshCsrfData.csrfToken,
      Cookie: `${context.sessionCookie}; ${freshCookie}`,
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
        replay: replayResponse.status,
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
