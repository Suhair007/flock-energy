import test from 'node:test';
import assert from 'node:assert/strict';
import { MeterIndex, UrjaDataService } from '../src/data-service.js';
import { TtlCache } from '../src/ttl-cache.js';

function hierarchyEntry(level, name) {
  return { level, name };
}

function fakePortal() {
  const meters = [
    { meterId: 'M-001', serialNumber: 'S-001', make: 'HPL', installationStatus: 'Installed', transformerCode: 'DT-1' },
    { meterId: 'M-002', serialNumber: 'S-002', make: 'Secure', installationStatus: 'Decommissioned', transformerCode: 'DT-1' },
    { meterId: 'M-003', serialNumber: 'S-003', make: 'HPL', installationStatus: 'Installed', transformerCode: 'DT-2' }
  ];
  const details = {
    'M-001': {
      nameplate: { 'Meter ID': 'M-001' },
      hierarchy: [
        hierarchyEntry('zone', 'Jaipur Zone (Z-1)'),
        hierarchyEntry('circle', 'Circle A (C-1)'),
        hierarchyEntry('feeder', 'Feeder A (F-1)'),
        hierarchyEntry('distributionTransformer', 'DT A (DT-1)')
      ],
      location: { latitude: 26.9, longitude: 75.8 }
    },
    'M-002': {
      nameplate: { 'Meter ID': 'M-002' },
      hierarchy: [
        hierarchyEntry('circle', 'Circle A (C-1)'),
        hierarchyEntry('zone', 'Jaipur Zone (Z-1)'),
        hierarchyEntry('feeder', 'Feeder A (F-1)'),
        hierarchyEntry('distributionTransformer', 'DT One (DT-1)')
      ],
      location: { latitude: 26.91, longitude: 75.81 }
    },
    'M-003': {
      nameplate: { 'Meter ID': 'M-003' },
      hierarchy: [],
      location: { latitude: null, longitude: null }
    }
  };

  return {
    async listMeters({ page }) {
      if (page > 1) {
        return {
          data: meters.slice(2),
          pagination: { page, pageSize: 2, total: meters.length }
        };
      }
      return {
        data: meters.slice(0, 2),
        pagination: { page, pageSize: 2, total: meters.length }
      };
    },
    async getMeter(meterId) {
      return details[meterId];
    },
    async getConsumption() {
      return [];
    },
    async listTransformers() {
      return { data: [], pagination: { page: 1, pageSize: 0, total: 0 } };
    }
  };
}

test('builds a hierarchy by level/code even when breadcrumb entries are out of order', async () => {
  const service = new UrjaDataService(fakePortal());
  const result = await service.index.getHierarchy();
  const zone = result.data.find((node) => node.level === 'zone');
  const circle = zone.children.find((node) => node.level === 'circle');
  const feeder = circle.children.find((node) => node.level === 'feeder');
  const transformer = feeder.children.find((node) => node.level === 'distributionTransformer');
  const meterIds = transformer.children.map((node) => node.name).sort();

  assert.deepEqual(meterIds, ['M-001', 'M-002']);
  assert.equal(zone.meterCount, 2);
  assert.equal(transformer.meterCount, 2);
  assert.deepEqual(transformer.aliases, ['DT One (DT-1)']);
  assert.ok(result.meta.dataQuality.some((entry) => entry.issue.includes('Conflicting names')));
  assert.ok(result.meta.dataQuality.some((entry) => entry.meterId === 'M-003'));
});

test('reports repeated hierarchy levels and conflicting transformer assignments', async () => {
  const portal = fakePortal();
  const getMeter = portal.getMeter;
  portal.getMeter = async (meterId) => {
    if (meterId === 'M-003') {
      return {
        nameplate: { 'Meter ID': meterId },
        hierarchy: [
          hierarchyEntry('zone', 'Jaipur Zone (Z-2)'),
          hierarchyEntry('zone', 'Alternate Zone (Z-3)'),
          hierarchyEntry('distributionTransformer', 'DT Wrong (DT-X)')
        ],
        location: { latitude: null, longitude: null }
      };
    }
    return getMeter(meterId);
  };

  const result = await new UrjaDataService(portal).index.getHierarchy();
  const issues = result.meta.dataQuality
    .filter((entry) => entry.meterId === 'M-003')
    .map((entry) => entry.issue);

  assert.ok(issues.some((issue) => issue.includes('Multiple zone entries')));
  assert.ok(issues.some((issue) => issue.includes('Transformer code differs')));
});

test('supports local attribute filters and geographic distance sorting', async () => {
  const index = new MeterIndex({ dataService: fakePortal() });
  const byMake = await index.queryMeters({
    make: 'hpl', page: 1, limit: 20
  });
  assert.deepEqual(byMake.data.map((meter) => meter.meterId), ['M-001', 'M-003']);

  const nearby = await index.queryMeters({
    lat: 26.9,
    lon: 75.8,
    radiusKm: 5,
    page: 1,
    limit: 20
  });
  assert.deepEqual(nearby.data.map((meter) => meter.meterId), ['M-001', 'M-002']);
  assert.equal(nearby.data[0].distanceKm, 0);
  assert.ok(nearby.data[1].distanceKm > 0);
});

test('reuses a fresh index snapshot until its refresh TTL expires', async () => {
  const portal = fakePortal();
  let listCalls = 0;
  const dataService = {
    ...portal,
    async listMeters(options) {
      listCalls += 1;
      return portal.listMeters(options);
    }
  };
  const index = new MeterIndex({ dataService, refreshTtlMs: 60_000 });

  const first = await index.getSnapshot();
  const second = await index.getSnapshot();

  assert.equal(first.indexedAt, second.indexedAt);
  assert.equal(second.stale, false);
  assert.equal(listCalls, 2);
});

test('limits index refreshes, returns stale data on refresh failure, and coalesces concurrent builds', async () => {
  let calls = 0;
  let failRefresh = false;
  const dataService = {
    async listMeters() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failRefresh) throw new Error('upstream down');
      return {
        data: [{ meterId: 'M-1', make: 'HPL', transformerCode: 'DT-1' }],
        pagination: { page: 1, pageSize: 20, total: 1 }
      };
    },
    async getMeter() {
      return {
        nameplate: { 'Meter ID': 'M-1' },
        hierarchy: [],
        location: { latitude: null, longitude: null }
      };
    }
  };
  const index = new MeterIndex({
    dataService,
    refreshTtlMs: 0,
    maxMeters: 10,
    detailConcurrency: 2
  });

  const [first, concurrent] = await Promise.all([index.getSnapshot(), index.getSnapshot()]);
  assert.equal(first.totalMeters, 1);
  assert.equal(concurrent.totalMeters, 1);
  assert.equal(calls, 1);

  failRefresh = true;
  const stale = await index.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.warning, 'Using the previous index because the portal refresh failed');
  assert.equal(calls, 2);
});

test('coalesces simultaneous cache misses and caches the result for its TTL', async () => {
  const cache = new TtlCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 'cached' };
  };

  const [first, second] = await Promise.all([
    cache.getOrLoad('example', 60_000, loader),
    cache.getOrLoad('example', 60_000, loader)
  ]);
  assert.deepEqual(first.value, { value: 'cached' });
  assert.deepEqual(second.value, { value: 'cached' });
  assert.equal(calls, 1);
  assert.equal((await cache.getOrLoad('example', 60_000, loader)).cached, true);
});

test('serves expired consumption readings with a stale marker when the portal is unavailable', async () => {
  const readings = [{ timestamp: '01/01/2026 00:00', kwh: 12 }];
  const cache = new TtlCache();
  cache.set('consumption:M-001', readings, 60_000);
  cache.entries.get('consumption:M-001').expiresAt = Date.now() - 1;
  const service = new UrjaDataService({
    async getConsumption() {
      throw new Error('temporary portal failure');
    }
  }, { cache });

  assert.deepEqual(await service.getConsumption('M-001'), {
    readings,
    stale: true
  });
});
