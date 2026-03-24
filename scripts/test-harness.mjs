import { spawn } from 'node:child_process';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          async ensureCsrf() {
            if (this.csrfToken && this.csrfCookie) {
              return { csrfToken: this.csrfToken, csrfCookie: this.csrfCookie };
            }
            const csrfResponse = await fetch(`http://127.0.0.1:${port}/api/csrf`);
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
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/')) {
              const { csrfToken, csrfCookie } = await this.ensureCsrf();
              headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken;
              headers.Cookie = headers.Cookie || csrfCookie;
            }
            const responseInner = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
            const data = await responseInner.json();
            if (!responseInner.ok) {
              throw new Error(`${path}: ${data.message || 'Request failed'}`);
            }
            return data;
          },
          async requestExpectError(path, options = {}, status = 400) {
            const method = (options.method || 'GET').toUpperCase();
            const headers = { ...(options.headers || {}) };
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/')) {
              const { csrfToken, csrfCookie } = await this.ensureCsrf();
              headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || csrfToken;
              headers.Cookie = headers.Cookie || csrfCookie;
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
            return this.request('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password })
            });
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
