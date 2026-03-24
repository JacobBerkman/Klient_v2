import { spawn } from 'node:child_process';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCsrfExemptPath(path) {
  return ['/api/login', '/api/register', '/api/invites/accept', '/api/password-resets', '/api/password-resets/confirm'].includes(path);
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function createTestContext(name) {
  const port = 3100 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let bootError = '';
  server.stderr.on('data', (chunk) => {
    bootError += chunk.toString();
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.ok) {
        return {
          port,
          csrfToken: '',
          csrfCookie: '',
          authToken: '',
          async ensureCsrf() {
            if (!this.authToken) {
              throw new Error('Cannot bootstrap CSRF token without auth token.');
            }
            if (this.csrfToken && this.csrfCookie) {
              return { csrfToken: this.csrfToken, csrfCookie: this.csrfCookie };
            }
            const csrfResponse = await fetch(`http://127.0.0.1:${port}/api/csrf`, {
              headers: {
                Authorization: `Bearer ${this.authToken}`
              }
            });
            const csrfData = await csrfResponse.json();
            if (!csrfResponse.ok || !csrfData.csrfToken) {
              throw new Error(`CSRF bootstrap failed: ${csrfData?.message || csrfData?.error?.message || 'unknown error'}`);
            }
            this.csrfToken = csrfData.csrfToken;
            this.csrfCookie = (csrfResponse.headers.get('set-cookie') || '').split(';')[0];
            return { csrfToken: this.csrfToken, csrfCookie: this.csrfCookie };
          },
          async request(path, options = {}) {
            const method = (options.method || 'GET').toUpperCase();
            const headers = { ...(options.headers || {}) };
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !isCsrfExemptPath(path)) {
              const { csrfToken, csrfCookie } = await this.ensureCsrf();
              headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken;
              headers.Cookie = headers.Cookie || csrfCookie;
              headers.Origin = headers.Origin || `http://127.0.0.1:${port}`;
              headers.Referer = headers.Referer || `http://127.0.0.1:${port}/`;
              if (!headers.Authorization && this.authToken) {
                headers.Authorization = `Bearer ${this.authToken}`;
              }
            }
            const responseInner = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
            const data = await responseInner.json();
            const nextCsrfToken = responseInner.headers.get('x-csrf-token');
            const nextCookie = (responseInner.headers.get('set-cookie') || '').split(';')[0];
            if (nextCsrfToken) this.csrfToken = nextCsrfToken;
            if (nextCookie.startsWith('__Host-klient-csrf=')) this.csrfCookie = nextCookie;
            if (!responseInner.ok) {
              throw new Error(`${path}: ${data.message || 'Request failed'}`);
            }
            return data;
          },
          async requestExpectError(path, options = {}, status = 400) {
            const method = (options.method || 'GET').toUpperCase();
            const headers = { ...(options.headers || {}) };
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !isCsrfExemptPath(path)) {
              const { csrfToken, csrfCookie } = await this.ensureCsrf();
              headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken;
              headers.Cookie = headers.Cookie || csrfCookie;
              headers.Origin = headers.Origin || `http://127.0.0.1:${port}`;
              headers.Referer = headers.Referer || `http://127.0.0.1:${port}/`;
              if (!headers.Authorization && this.authToken) {
                headers.Authorization = `Bearer ${this.authToken}`;
              }
            }
            const responseInner = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
            const data = await responseInner.json();
            if (responseInner.status !== status) {
              throw new Error(`${path}: expected ${status}, received ${responseInner.status}`);
            }
            return data;
          },
          authHeaders(token) {
            return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
          },
          async login(email = 'admin@demo.test', password = 'ChangeMe123!') {
            const data = await this.request('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password })
            });
            this.authToken = data.token;
            this.csrfToken = '';
            this.csrfCookie = '';
            return data;
          },
          async shutdown() {
            server.kill('SIGTERM');
            await wait(120);
          }
        };
      }
    } catch {
      // Wait for server startup.
    }
    await wait(100);
  }

  server.kill('SIGTERM');
  throw new Error(`Server failed to start for ${name}. ${bootError}`.trim());
}
