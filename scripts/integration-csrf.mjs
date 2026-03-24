import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('csrf');

try {
  const baseUrl = `http://127.0.0.1:${context.port}`;

  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  const csrfData = await csrfResponse.json();
  const setCookie = csrfResponse.headers.get('set-cookie') || '';
  const csrfCookie = setCookie.split(';')[0];

  assert(csrfResponse.ok, 'Failed to issue CSRF token');
  assert(Boolean(csrfData.csrfToken), 'CSRF token missing from issuance response');
  assert(csrfCookie.startsWith('klient-csrf-session='), 'CSRF session cookie missing');

  const validLoginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfData.csrfToken,
      Cookie: csrfCookie,
      Origin: baseUrl,
      Referer: `${baseUrl}/`
    },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const validLoginData = await validLoginResponse.json();
  assert(validLoginResponse.status === 200, 'Valid CSRF token should permit mutating request');
  assert(Boolean(validLoginData.token), 'Login token missing for valid CSRF case');

  const missingTokenResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: csrfCookie,
      Origin: baseUrl,
      Referer: `${baseUrl}/`
    },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const missingTokenData = await missingTokenResponse.json();
  assert(missingTokenResponse.status === 403, 'Missing CSRF token should fail');
  assert(missingTokenData.error?.code === 'CSRF_VALIDATION_FAILED', 'Missing-token response schema should include CSRF error code');

  const invalidTokenResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'invalid-token',
      Cookie: csrfCookie,
      Origin: baseUrl,
      Referer: `${baseUrl}/`
    },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const invalidTokenData = await invalidTokenResponse.json();
  assert(invalidTokenResponse.status === 403, 'Invalid CSRF token should fail');
  assert(invalidTokenData.error?.code === 'CSRF_VALIDATION_FAILED', 'Invalid-token response schema should include CSRF error code');

  const invalidOriginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfData.csrfToken,
      Cookie: csrfCookie,
      Origin: 'https://malicious.example',
      Referer: 'https://malicious.example/attack'
    },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const invalidOriginData = await invalidOriginResponse.json();
  assert(invalidOriginResponse.status === 403, 'Origin mismatch should fail for browser-like requests');
  assert(invalidOriginData.error?.code === 'CSRF_VALIDATION_FAILED', 'Origin-failure response schema should include CSRF error code');

  const healthResponse = await fetch(`${baseUrl}/health`);
  const healthData = await healthResponse.json();
  assert(healthResponse.status === 200, 'GET route should remain unaffected by CSRF checks');
  assert(healthData.status === 'ok', 'Health payload should remain intact');

  console.log(JSON.stringify({
    suite: 'integration-csrf',
    validToken: 'pass',
    missingToken: missingTokenResponse.status,
    invalidToken: invalidTokenResponse.status,
    invalidOrigin: invalidOriginResponse.status,
    healthStatus: healthResponse.status
  }, null, 2));
} finally {
  await context.shutdown();
}
