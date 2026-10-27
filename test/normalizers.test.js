import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalError, UrjaPortalClient } from '../src/portal-client.js';
import {
  normalizeConsumptionPoint,
  normalizeLocation,
  normalizeMeterSummary,
  normalizeTransformer,
  parseMeterDetailPage
} from '../src/normalizers.js';

test('normalizes the portal meter-list field names', () => {
  assert.deepEqual(normalizeMeterSummary({
    meterId: 'J100000',
    serialNo: 'SE33962',
    make: 'HPL',
    phaseType: 'single',
    installStatus: 'Installed',
    dtCode: 'DT-001'
  }), {
    meterId: 'J100000',
    serialNumber: 'SE33962',
    make: 'HPL',
    phaseType: 'single',
    installationStatus: 'Installed',
    transformerCode: 'DT-001'
  });
});

test('extracts nameplate and hierarchy from a meter detail page', () => {
  const html = `<main>
    <h1>Meter J100000</h1>
    <nav><span>Circle 1 (C-01)</span><span>›</span><span>Division 1 (D-01)</span><span>›</span><span>Feeder 1 (F-001)</span></nav>
    <section><h2>Location</h2><dl>
      <div><dt>Not a nameplate field</dt><dd>Ignore me</dd></div>
    </dl></section>
    <section><h2>Nameplate</h2><dl>
      <div><dt>Meter ID</dt><dd>J100000</dd></div>
      <div><dt>Make</dt><dd>HPL</dd></div>
    </dl></section>
  </main>`;

  assert.deepEqual(parseMeterDetailPage(html, 'J100000'), {
    nameplate: { 'Meter ID': 'J100000', Make: 'HPL' },
    hierarchy: [
      { level: 'circle', name: 'Circle 1 (C-01)' },
      { level: 'division', name: 'Division 1 (D-01)' },
      { level: 'feeder', name: 'Feeder 1 (F-001)' }
    ]
  });
});

test('rejects login pages and mismatched meter detail pages', () => {
  assert.throws(
    () => parseMeterDetailPage('<main><h1>Sign in</h1></main>', 'J100000'),
    /different page/
  );
  assert.throws(
    () => parseMeterDetailPage('<main><h1>Meter J200000</h1></main>', 'J100000'),
    /different page/
  );
});

test('rejects a meter page with missing or mismatched nameplate identifiers', () => {
  const html = `<main><h1>Meter J100000</h1>
    <section><h2>Nameplate</h2><dl>
      <div><dt>Make</dt><dd>HPL</dd></div>
    </dl></section>
  </main>`;
  assert.throws(() => parseMeterDetailPage(html, 'J100000'), /did not identify/);
});

test('uses unknown for a breadcrumb item without a recognizable hierarchy code', () => {
  const html = `<main><h1>Meter J100000</h1>
    <nav><span>Unlabeled location</span></nav>
    <section><h2>Nameplate</h2><dl>
      <div><dt>Meter ID</dt><dd>J100000</dd></div>
      <div><dt>Make</dt><dd></dd></div>
    </dl></section>
  </main>`;
  assert.deepEqual(parseMeterDetailPage(html, 'J100000'), {
    nameplate: { 'Meter ID': 'J100000', Make: null },
    hierarchy: [{ level: 'unknown', name: 'Unlabeled location' }]
  });
});

test('normalizes numeric geo, consumption, and transformer fields', () => {
  assert.deepEqual(normalizeLocation({ latitude: '26.9', longitude: '75.8' }), {
    latitude: 26.9,
    longitude: 75.8
  });
  assert.deepEqual(normalizeConsumptionPoint({
    timestamp: '23/06/2026 23:30',
    kwh: '12.5',
    kvah: '13.2',
    voltR: '230'
  }), {
    timestamp: '23/06/2026 23:30',
    kwh: 12.5,
    kvah: 13.2,
    voltageR: 230
  });
  assert.deepEqual(normalizeTransformer({
    code: 'DT-001',
    capacityKva: 100
  }), {
    code: 'DT-001',
    name: null,
    feederCode: null,
    capacityKva: 100
  });
  assert.deepEqual(normalizeLocation(undefined), {
    latitude: null,
    longitude: null
  });
});

test('represents missing or nonnumeric numeric fields as null', () => {
  assert.deepEqual(normalizeLocation({ latitude: 'unknown' }), {
    latitude: null,
    longitude: null
  });
});

test('rejects malformed upstream meter and transformer identifiers', () => {
  assert.throws(() => normalizeMeterSummary({ serialNo: 'SE1' }), /Invalid meter record/);
  assert.throws(() => normalizeTransformer({ name: 'No code' }), /Invalid transformer record/);
});

test('maps malformed portal records and pagination metadata to safe upstream errors', async () => {
  const client = new UrjaPortalClient({
    baseUrl: 'https://portal.example.invalid',
    email: 'test@example.invalid',
    password: 'not-a-real-password',
    timeoutMs: 1000
  });
  client.getJson = async () => ({
    data: [{ serialNo: 'SE1' }],
    page: 1,
    pageSize: 20,
    total: 1
  });

  await assert.rejects(client.listMeters({ query: '', page: 1 }), (error) => {
    assert.ok(error instanceof PortalError);
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'Urja portal returned an invalid meter record');
    return true;
  });

  client.getJson = async () => ({
    data: [],
    page: 1,
    pageSize: 'not-a-number',
    total: 0
  });
  await assert.rejects(client.listMeters({ query: '', page: 1 }), (error) => {
    assert.ok(error instanceof PortalError);
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'Urja portal returned invalid pagination metadata');
    return true;
  });
});
