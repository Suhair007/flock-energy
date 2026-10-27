import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import {
  normalizeConsumptionPoint,
  normalizeLocation,
  normalizeMeterSummary,
  normalizeTransformer,
  parseMeterDetailPage
} from './normalizers.js';

export class PortalError extends Error {
  constructor(message, statusCode = 502, { upstreamStatus = null } = {}) {
    super(message);
    this.name = 'PortalError';
    this.statusCode = statusCode;
    // The status the portal itself answered with, when there was one (404 means "no such record").
    this.upstreamStatus = upstreamStatus;
  }
}

function responseIsLoginRedirect(error) {
  if (error?.loginPage) {
    return true;
  }
  const response = error?.response;
  if (!response) {
    return false;
  }

  const location = response.headers?.location ?? '';
  return response.status === 401 || (response.status >= 300 && response.status < 400 && /\/login(?:$|[?#])/i.test(location));
}

/** Some portals answer an expired session with the login page itself (HTTP 200) instead of a redirect. */
function looksLikeLoginPage(response) {
  const type = String(response?.headers?.['content-type'] ?? '');
  const body = response?.data;
  if (!type.includes('text/html') || typeof body !== 'string') {
    return false;
  }
  return /<form/i.test(body)
    && /<input[^>]+type\s*=\s*["']?password/i.test(body)
    && !/<h1[^>]*>\s*Meter\s/i.test(body);
}

function isTimeout(error) {
  return error.code === 'ECONNABORTED'
    || error.code === 'ETIMEDOUT'
    || /timeout/i.test(error.message ?? '');
}

function isTransientNetworkError(error) {
  return [
    'ECONNABORTED',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EPIPE'
  ].includes(error.code);
}

function isRetryableResponse(error) {
  const status = error.response?.status;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Waits long enough for a rate-limited portal to recover: the portal's own Retry-After when it
 * sends one (up to 10 s), otherwise exponential back-off with a little jitter.
 */
function retryDelay(error, attempt) {
  const retryAfter = Number(error.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(400 * (2 ** attempt), 5000) + Math.floor(Math.random() * 250);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Runs at most `limit` tasks at once. Tasks marked "high" (a person waiting on a click)
 * go ahead of the long queue of background index work.
 *
 * The limit adapts to the portal: it starts at `max` (as fast as we are allowed to go), is
 * halved whenever the portal pushes back (429, 503, timeouts) and creeps back up one step
 * after a run of calm successes. A healthy portal is read at full speed; a struggling one
 * is not hammered into refusing everything.
 */
function createLimiter({ max, min = 2 }) {
  let limit = max;
  let active = 0;
  let calm = 0;
  const queues = { high: [], normal: [] };

  const next = () => {
    while (active < limit) {
      const entry = queues.high.shift() ?? queues.normal.shift();
      if (!entry) {
        return;
      }
      active += 1;
      entry.task()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          next();
        });
    }
  };

  const run = (task, priority = 'normal') => new Promise((resolve, reject) => {
    queues[priority === 'high' ? 'high' : 'normal'].push({ task, resolve, reject });
    next();
  });
  run.eased = () => {
    calm += 1;
    if (calm >= 25 && limit < max) {
      limit += 1;
      calm = 0;
      next();
    }
  };
  run.throttled = () => {
    calm = 0;
    limit = Math.max(min, Math.floor(limit / 2));
  };
  Object.defineProperty(run, 'limit', { get: () => limit });
  return run;
}

function normalizePagination({ page, pageSize, total }, fallback = {}) {
  const values = {
    page: page ?? fallback.page,
    pageSize: pageSize ?? fallback.pageSize,
    total: total ?? fallback.total
  };

  for (const [key, value] of Object.entries(values)) {
    const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value)
      : Number.NaN;
    const minimum = key === 'page' ? 1 : 0;
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
      throw new PortalError('Urja portal returned invalid pagination metadata');
    }
    values[key] = parsed;
  }

  return values;
}

function normalizeRecords(records, normalizer, errorMessage) {
  try {
    return records.map(normalizer);
  } catch {
    throw new PortalError(errorMessage);
  }
}

function describeError(error) {
  return error?.message ?? 'Unknown error';
}

export class UrjaPortalClient {
  constructor({
    baseUrl,
    email,
    password,
    timeoutMs,
    // PORTAL_MAX_CONCURRENCY: the most requests allowed in flight to the portal at once.
    // The client backs off on its own when the portal pushes back, so this is only the ceiling.
    maxConcurrentRequests = Number.parseInt(process.env.PORTAL_MAX_CONCURRENCY ?? '', 10) || 8,
    maxRetries = 4
  }) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.maxRetries = maxRetries;
    this.limit = createLimiter({ max: maxConcurrentRequests });
    this.jar = new CookieJar();
    this.authenticated = false;
    this.loginInProgress = null;
    // Bumped on every successful login. Requests started under an older session that
    // hit a login redirect use it to tell "my session expired" from "someone already re-logged in".
    this.sessionVersion = 0;
    this.http = wrapper(axios.create({
      baseURL: baseUrl,
      jar: this.jar,
      withCredentials: true,
      timeout: timeoutMs,
      maxRedirects: 0
    }));
  }

  async login() {
    if (this.loginInProgress) {
      return this.loginInProgress;
    }

    this.loginInProgress = this.loginWithRetry();
    try {
      await this.loginInProgress;
    } finally {
      this.loginInProgress = null;
    }
  }

  /** A busy portal can refuse one login attempt; try a few times before giving up. */
  async loginWithRetry(attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.performLogin();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          await sleep(600 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  async ensureSession() {
    if (this.authenticated && !this.loginInProgress) {
      return;
    }
    await this.login();
  }

  async performLogin() {
    const origin = this.baseUrl;
    try {
      await this.http.get('/login', {
        headers: { 'User-Agent': 'flock-urja-api/1.0' }
      });

      const response = await this.http.post(
        '/login',
        new URLSearchParams({
          email: this.email,
          password: this.password
        }).toString(),
        {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: origin,
            Referer: `${origin}/login`,
            'User-Agent': 'flock-urja-api/1.0'
          }
        }
      );

      const result = typeof response.data === 'string'
        ? JSON.parse(response.data)
        : response.data;

      if (response.status >= 400 || result?.type === 'error') {
        throw new Error('Portal rejected the login request');
      }

      if (result?.type !== 'redirect' || !result.location) {
        throw new Error('Portal returned an unexpected login response');
      }

      const cookies = await this.jar.getCookies(this.baseUrl);
      if (!cookies.some((cookie) => cookie.key === '__Secure-better-auth.session_token')) {
        throw new Error('Portal login completed without creating a session cookie');
      }

      this.authenticated = true;
      this.sessionVersion += 1;
    } catch (error) {
      this.authenticated = false;
      if (error instanceof PortalError) {
        throw error;
      }
      if (isTimeout(error)) {
        throw new PortalError('Urja portal request timed out', 504);
      }
      throw new PortalError('Unable to authenticate with the Urja portal');
    }
  }

  /**
   * One portal request with the shared concurrency limit, retries for rate limiting and
   * transient failures, and a single transparent re-login when the session has expired.
   * `priority: 'high'` is for requests a person is waiting on.
   */
  async request(path, options = {}, retried = false) {
    const { priority = 'normal', ...axiosOptions } = options;
    await this.ensureSession();
    const sessionVersion = this.sessionVersion;

    try {
      let response;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await this.limit(
            () => this.http.request({ ...axiosOptions, url: path }),
            priority
          );
          this.limit.eased();
          break;
        } catch (error) {
          if (responseIsLoginRedirect(error)) {
            throw error;
          }
          const status = error.response?.status;
          if (status === 429 || status === 503 || isTimeout(error)) {
            this.limit.throttled();
          }
          const canRetry = attempt < this.maxRetries
            && (isRetryableResponse(error) || isTransientNetworkError(error));
          if (!canRetry) {
            throw error;
          }
          // The wait happens outside the limiter, so a backing-off request does not hold a slot.
          await sleep(retryDelay(error, attempt));
        }
      }

      if (looksLikeLoginPage(response)) {
        const expired = new Error('Portal session expired');
        expired.loginPage = true;
        throw expired;
      }

      return response;
    } catch (error) {
      if (error instanceof PortalError) {
        throw error;
      }

      if (responseIsLoginRedirect(error) && !retried) {
        // With several requests in flight, many can notice the expired session at once.
        // Only the first one invalidates it; the rest wait for (or reuse) the fresh login.
        if (this.sessionVersion === sessionVersion) {
          this.authenticated = false;
        }
        await this.ensureSession();
        return this.request(path, options, true);
      }

      if (error.loginPage) {
        throw new PortalError('Urja portal session could not be renewed', 502);
      }

      const statusCode = error.response?.status;
      if (statusCode === 404) {
        throw new PortalError(
          'Urja portal returned not found for an upstream route or record',
          502,
          { upstreamStatus: 404 }
        );
      }
      if (isTimeout(error)) {
        throw new PortalError('Urja portal request timed out', 504);
      }
      throw new PortalError(
        statusCode ? `Urja portal request failed (${statusCode})` : 'Urja portal is unavailable',
        502,
        { upstreamStatus: statusCode ?? null }
      );
    }
  }

  async getJson(path, params, { priority = 'normal' } = {}) {
    const response = await this.request(path, {
      method: 'GET',
      params,
      headers: { Accept: 'application/json' },
      priority
    });

    if (typeof response.data !== 'object' || response.data === null) {
      throw new PortalError('Urja portal returned an invalid JSON response');
    }
    return response.data;
  }

  /**
   * One page of the portal's meter list. `priority: 'high'` lets the pages the dashboard is
   * waiting on go ahead of the long queue of background detail lookups.
   */
  async listMeters({ query = '', page = 1 }, { priority = 'normal' } = {}) {
    const result = await this.getJson('/portal/meters/search', {
      q: query,
      page
    }, { priority });

    if (!Array.isArray(result.data)) {
      throw new PortalError('Urja portal returned an invalid meter list');
    }

    const data = normalizeRecords(
      result.data,
      normalizeMeterSummary,
      'Urja portal returned an invalid meter record'
    );
    const pagination = normalizePagination(result);

    return {
      data,
      pagination
    };
  }

  /**
   * Detail page (nameplate + hierarchy) and location, fetched side by side.
   *
   * The two halves are independent: if one fails the other is still returned. The result says
   * which parts were read (`detailLoaded`, `locationLoaded`) and why not (`detailError`,
   * `locationError`), so a caller never mistakes "lookup failed" for "meter has no coordinates".
   * A 404 from the location endpoint means the portal has no location record for the meter,
   * which is a real answer ("no coordinates"), not a failure.
   */
  async getMeter(meterId, { priority = 'normal' } = {}) {
    const encodedId = encodeURIComponent(meterId);

    const [pageResult, geoResult] = await Promise.allSettled([
      this.request(`/meters/${encodedId}`, {
        method: 'GET',
        headers: { Accept: 'text/html' },
        priority
      }),
      this.getJson(`/portal/meters/${encodedId}/geo`, undefined, { priority })
    ]);

    let nameplate = {};
    let hierarchy = [];
    let detailLoaded = false;
    let detailError = null;

    if (pageResult.status === 'fulfilled') {
      const response = pageResult.value;
      if (typeof response.data !== 'string' || !response.headers['content-type']?.includes('text/html')) {
        detailError = 'Portal returned something other than the meter page';
      } else {
        try {
          ({ nameplate, hierarchy } = parseMeterDetailPage(response.data, meterId));
          detailLoaded = true;
        } catch (error) {
          detailError = `Meter page could not be read (${describeError(error)})`;
        }
      }
    } else {
      detailError = describeError(pageResult.reason);
    }

    let location = { latitude: null, longitude: null };
    let locationLoaded = false;
    let locationError = null;

    if (geoResult.status === 'fulfilled') {
      const body = geoResult.value;
      location = normalizeLocation(body?.data !== undefined ? body.data : body);
      locationLoaded = true;
    } else if (geoResult.reason?.upstreamStatus === 404) {
      locationLoaded = true;
    } else {
      locationError = describeError(geoResult.reason);
    }

    return {
      meterId,
      nameplate,
      hierarchy,
      location,
      detailLoaded,
      locationLoaded,
      detailError,
      locationError
    };
  }

  async getConsumption(meterId) {
    const result = await this.getJson(
      `/portal/meters/${encodeURIComponent(meterId)}/energy`,
      undefined,
      { priority: 'high' }
    );
    if (!Array.isArray(result.data)) {
      throw new PortalError('Urja portal returned an invalid consumption series');
    }
    return normalizeRecords(
      result.data,
      normalizeConsumptionPoint,
      'Urja portal returned an invalid consumption record'
    );
  }

  async listTransformers({ page = 1 }) {
    const result = await this.getJson('/portal/dts', { page }, { priority: 'high' });
    if (!Array.isArray(result.data)) {
      throw new PortalError('Urja portal returned an invalid transformer list');
    }
    const data = normalizeRecords(
      result.data,
      normalizeTransformer,
      'Urja portal returned an invalid transformer record'
    );
    const pagination = normalizePagination(result, {
      page,
      pageSize: data.length,
      total: data.length
    });

    return {
      data,
      pagination
    };
  }
}