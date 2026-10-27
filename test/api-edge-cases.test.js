import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

process.env.PORTAL_BASE_URL ??= 'https://portal.invalid';
process.env.PORTAL_EMAIL ??= 'test@example.invalid';
process.env.PORTAL_PASSWORD ??= 'not-a-real-password';

const { createApp } = await import('../src/server.js');
const { PortalError, UrjaPortalClient } = await import('../src/portal-client.js');

async function withServer(app, callback) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('rejects invalid meter IDs with a safe JSON 400 response', async () => {
  const api = createApp({
    async getMeter() {
      assert.fail('Invalid meter ID must not reach the portal client');
    }
  });

  await withServer(api, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meters/not!valid`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'INVALID_REQUEST',
        message: 'meterId may contain only letters, numbers, underscores, and hyphens'
      }
    });
  });
});

test('defaults omitted search parameters and rejects invalid page and repeated query values', async () => {
  const calls = [];
  const api = createApp({
    async listMeters(options) {
      calls.push(options);
      return { data: [], pagination: { page: options.page, pageSize: 20, total: 0 } };
    }
  });

  await withServer(api, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meters`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0 }
    });

    for (const path of [
      '/api/v1/meters?page=-1',
      '/api/v1/meters?q=first&q=second'
    ]) {
      const invalid = await fetch(`${baseUrl}${path}`);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, 'INVALID_REQUEST');
    }
  });

  assert.deepEqual(calls, [{ query: '', page: 1 }]);
});

test('exposes local index, hierarchy, and nearby query routes', async () => {
  const calls = [];
  const service = {
    index: {
      async getHierarchy() {
        return { data: [], meta: { totalMeters: 0, indexedAt: new Date().toISOString(), stale: false } };
      },
      async queryMeters(options) {
        calls.push(options);
        return { data: [], pagination: { page: options.page, pageSize: options.limit, total: 0 } };
      }
    }
  };
  const api = createApp(service);

  await withServer(api, async (baseUrl) => {
    const hierarchy = await fetch(`${baseUrl}/api/v1/hierarchy`);
    assert.equal(hierarchy.status, 200);

    const filtered = await fetch(`${baseUrl}/api/v1/index/meters?make=HPL&status=Installed`);
    assert.equal(filtered.status, 200);

    const nearby = await fetch(`${baseUrl}/api/v1/meters/nearby?lat=26.9&lon=75.8&radiusKm=5`);
    assert.equal(nearby.status, 200);

    const invalid = await fetch(`${baseUrl}/api/v1/meters/nearby?lat=26.9&radiusKm=5`);
    assert.equal(invalid.status, 400);
  });

  assert.deepEqual(calls, [
    {
      q: undefined,
      make: 'HPL',
      status: 'Installed',
      transformer: undefined,
      lat: undefined,
      lon: undefined,
      radiusKm: undefined,
      page: 1,
      limit: 100
    },
    { lat: 26.9, lon: 75.8, radiusKm: 5, page: 1, limit: 100 }
  ]);
});

test('returns a generic JSON 502 for upstream failures without exposing internals', async () => {
  const api = createApp({
    async listMeters() {
      throw new PortalError('Connection refused at 127.0.0.1:54321 with secret token', 502);
    }
  });

  await withServer(api, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meters`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { code: 'UPSTREAM_ERROR', message: 'The request could not be completed' }
    });
  });
});

test('returns a generic JSON 504 for upstream timeouts', async () => {
  const api = createApp({
    async listMeters() {
      throw new PortalError('Urja portal timed out at secret endpoint', 504);
    }
  });

  await withServer(api, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meters`);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: { code: 'UPSTREAM_TIMEOUT', message: 'The request could not be completed' }
    });
  });
});

test('marks cached consumption readings as stale in the API response', async () => {
  const readings = [{ timestamp: '01/01/2026 00:00', kwh: 12 }];
  const api = createApp({
    async getConsumption() {
      return { readings, stale: true };
    }
  });

  await withServer(api, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meters/J100051/consumption`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { meterId: 'J100051', readings, stale: true }
    });
  });
});

test('returns a safe JSON error for malformed request bodies', async () => {
  const api = createApp({});
  await withServer(api, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":"never-echo-this",'
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.deepEqual(body, {
      error: { code: 'INVALID_REQUEST', message: 'Invalid request' }
    });
    assert.equal(JSON.stringify(body).includes('never-echo-this'), false);
  });
});

test('maps an unreachable portal to a generic upstream error', async () => {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const { port } = reservation.address();
  await new Promise((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });

  const client = new UrjaPortalClient({
    baseUrl: `http://127.0.0.1:${port}`,
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 500
  });
  await assert.rejects(client.listMeters({ query: '', page: 1 }), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'Unable to authenticate with the Urja portal');
    assert.equal(error.message.includes('not-a-real-password'), false);
    return true;
  });
});

test('maps Axios timeout errors to a gateway timeout', async () => {
  const client = new UrjaPortalClient({
    baseUrl: 'https://portal.example.invalid',
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 1
  });
  client.authenticated = true;
  client.http.request = async () => {
    const error = new Error('timeout of 1ms exceeded');
    error.code = 'ECONNABORTED';
    throw error;
  };
  await assert.rejects(client.request('/portal/test'), (error) => {
    assert.equal(error.statusCode, 504);
    assert.equal(error.message, 'Urja portal request timed out');
    return true;
  });
});

test('maps an ambiguous upstream 404 to a generic bad-gateway error', async () => {
  const client = new UrjaPortalClient({
    baseUrl: 'https://portal.example.invalid',
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 1000
  });
  client.authenticated = true;
  client.http.request = async () => {
    const error = new Error('Not Found');
    error.response = { status: 404, headers: {} };
    throw error;
  };
  await assert.rejects(client.request('/meters/NO-SUCH-METER'), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'Urja portal returned not found for an upstream route or record');
    return true;
  });
});

test('disables redirects and uses Axios default status rejection', () => {
  const client = new UrjaPortalClient({
    baseUrl: 'https://portal.example.invalid',
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 1000
  });
  assert.equal(client.http.defaults.maxRedirects, 0);
  assert.equal(client.http.defaults.validateStatus(302), false);
  assert.equal(client.http.defaults.validateStatus(200), true);
});

test('retries a transient 503 response with exponential delay', async () => {
  const client = new UrjaPortalClient({
    baseUrl: 'https://portal.example.invalid',
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 1000
  });
  client.authenticated = true;
  let attempts = 0;
  client.http.request = async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('upstream unavailable');
      error.response = { status: 503, headers: {} };
      throw error;
    }
    return { status: 200, data: { data: [], page: 1, pageSize: 20, total: 0 } };
  };
  assert.equal((await client.getJson('/portal/meters/search')).data.length, 0);
  assert.equal(attempts, 3);
});

test('preserves the session cookie and reauthenticates once after session expiry', async () => {
  let loginCount = 0;
  const observedCookies = [];
  const baseUrl = 'https://portal.example.invalid';
  const client = new UrjaPortalClient({
    baseUrl,
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 1000
  });

  client.http = {
    defaults: { maxRedirects: 0 },
    async get(path) {
      assert.equal(path, '/login');
      return { status: 200 };
    },
    async post(path, body, options) {
      assert.equal(path, '/login');
      assert.match(body, /email=test%40example.invalid/);
      assert.equal(options.headers.Origin, baseUrl);
      assert.equal(options.headers.Referer, `${baseUrl}/login`);
      loginCount += 1;
      await client.jar.setCookie(
        `__Secure-better-auth.session_token=session-${loginCount}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        baseUrl
      );
      return {
        status: 200,
        data: { type: 'redirect', status: 303, location: '/meters' }
      };
    },
    async request() {
      const cookies = await client.jar.getCookies(baseUrl);
      const session = cookies.find((cookie) => cookie.key === '__Secure-better-auth.session_token');
      observedCookies.push(session?.value ?? '');
      if (loginCount === 1) {
        const error = new Error('expired session');
        error.response = { status: 401, headers: {} };
        throw error;
      }
      return {
        status: 200,
        data: { data: [], page: 1, pageSize: 20, total: 0 }
      };
    }
  };

  const result = await client.listMeters({ query: '', page: 1 });
  assert.deepEqual(result.data, []);
  assert.equal(loginCount, 2);
  assert.deepEqual(observedCookies, ['session-1', 'session-2']);
});
