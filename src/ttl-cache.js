export class TtlCache {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  /**
   * `cacheable(value)` lets the caller refuse to remember a result (for example a meter
   * whose location lookup failed), so a temporary portal hiccup is retried next time
   * instead of being served from the cache for the whole TTL.
   */
  async getOrLoad(key, ttlMs, loader, { staleIfError = false, cacheable = () => true } = {}) {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      return { value: cached.value, stale: false, cached: true };
    }

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const operation = (async () => {
      try {
        const value = await loader();
        if (cacheable(value)) {
          this.entries.delete(key);
          this.entries.set(key, {
            value,
            cachedAt: Date.now(),
            expiresAt: Date.now() + ttlMs
          });
          this.evictExpiredAndOverflow();
        }
        return { value, stale: false, cached: false };
      } catch (error) {
        if (staleIfError && cached) {
          return { value: cached.value, stale: true, cached: true, refreshError: error };
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, operation);
    return operation;
  }

  set(key, value, ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      cachedAt: Date.now(),
      expiresAt: Date.now() + ttlMs
    });
    this.evictExpiredAndOverflow();
  }

  evictExpiredAndOverflow() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }
}