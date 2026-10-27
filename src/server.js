import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { PortalError, UrjaPortalClient } from './portal-client.js';
import { UrjaDataService } from './data-service.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(currentDirectory, '..');
const openApiDocument = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'openapi.json'), 'utf8')
);

// Optional: `npm install compression` shrinks the JSON a lot. Without it the app still works.
let compression = null;
try {
  compression = (await import('compression')).default;
} catch {
  compression = null;
}

function integerFromEnvironment(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Index tuning. All optional; defaults are deliberately gentle on the portal.
//   INDEX_PAGE_CONCURRENCY    list pages fetched at once                  (default 6)
//   INDEX_DETAIL_CONCURRENCY  meter detail lookups at once (background)   (default 6)
//   INDEX_MAX_METERS          refuse to index more meters than this       (default 5000)
//   INDEX_REFRESH_MINUTES     how often the meter LIST is read again      (default 15)
//   INDEX_DETAIL_HOURS        how long a meter's detail page and location are trusted (default 24)
//   INDEX_SNAPSHOT_PATH       where the index is kept between restarts    (default .cache/meter-index.json, "off" to disable)
const snapshotSetting = process.env.INDEX_SNAPSHOT_PATH;
const indexOptions = {
  pageConcurrency: integerFromEnvironment('INDEX_PAGE_CONCURRENCY', 6),
  detailConcurrency: integerFromEnvironment('INDEX_DETAIL_CONCURRENCY', 6),
  maxMeters: integerFromEnvironment('INDEX_MAX_METERS', 5000),
  refreshTtlMs: integerFromEnvironment('INDEX_REFRESH_MINUTES', 15) * 60 * 1000,
  detailTtlMs: integerFromEnvironment('INDEX_DETAIL_HOURS', 24) * 60 * 60 * 1000,
  snapshotPath: snapshotSetting === 'off'
    ? null
    : path.resolve(snapshotSetting ?? path.join(projectRoot, '.cache', 'meter-index.json'))
};

const portal = new UrjaPortalClient({
  baseUrl: config.portalBaseUrl,
  email: config.portalEmail,
  password: config.portalPassword,
  timeoutMs: config.portalTimeoutMs
});
const dataService = new UrjaDataService(portal, { indexOptions });

class InvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRequestError';
    this.statusCode = 400;
  }
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new InvalidRequestError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidRequestError(`${name} is outside the supported range`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^(0|[1-9]\d*)$/.test(String(value))) {
    throw new InvalidRequestError(`${name} must be zero or a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidRequestError(`${name} is outside the supported range`);
  }
  return parsed;
}

function validateMeterId(meterId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meterId)) {
    throw new InvalidRequestError('meterId may contain only letters, numbers, underscores, and hyphens');
  }
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

/** A query value that must be one short string (or absent). Empty strings count as absent. */
function optionalText(request, name, maxLength = 200) {
  const value = request.query[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new InvalidRequestError(`${name} must be a single string`);
  }
  if (value.length > maxLength) {
    throw new InvalidRequestError(`${name} must be ${maxLength} characters or fewer`);
  }
  return value;
}

function optionalChoice(request, name, choices) {
  const value = optionalText(request, name, 40);
  if (value !== undefined && !choices.includes(value)) {
    throw new InvalidRequestError(`${name} must be one of: ${choices.join(', ')}`);
  }
  return value;
}

function parseOptionalNumber(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`${name} must be a number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidRequestError(`${name} must be a number`);
  }
  return parsed;
}

function parseCoordinates(request) {
  const lat = parseOptionalNumber(request.query.lat, 'lat');
  const lon = parseOptionalNumber(request.query.lon, 'lon');
  if ((lat === undefined) !== (lon === undefined)) {
    throw new InvalidRequestError('lat and lon must be provided together');
  }
  if (lat !== undefined && (lat < -90 || lat > 90)) {
    throw new InvalidRequestError('lat must be between -90 and 90');
  }
  if (lon !== undefined && (lon < -180 || lon > 180)) {
    throw new InvalidRequestError('lon must be between -180 and 180');
  }
  return { lat, lon };
}

/**
 * The filters the table and the map share:
 *   q, kind (installed|decommissioned|other), status, statusNot, make, transformer,
 *   located (yes|no|unknown), check (failed), node (a network branch id),
 *   and "near": either lat+lon or nearMeter, together with radiusKm.
 */
function parseScope(request) {
  const { lat, lon } = parseCoordinates(request);
  const nearMeter = optionalText(request, 'nearMeter', 64);
  const radiusKm = parseOptionalNumber(request.query.radiusKm, 'radiusKm');
  if (radiusKm !== undefined && (radiusKm <= 0 || radiusKm > 1000)) {
    throw new InvalidRequestError('radiusKm must be greater than 0 and at most 1000');
  }
  if (lat !== undefined && radiusKm === undefined) {
    throw new InvalidRequestError('radiusKm is required when lat and lon are provided');
  }
  if (radiusKm !== undefined && lat === undefined && nearMeter === undefined) {
    throw new InvalidRequestError('lat and lon (or nearMeter) are required when radiusKm is provided');
  }
  return {
    q: optionalText(request, 'q'),
    kind: optionalChoice(request, 'kind', ['installed', 'decommissioned', 'other']),
    status: optionalText(request, 'status'),
    statusNot: optionalText(request, 'statusNot'),
    make: optionalText(request, 'make'),
    transformer: optionalText(request, 'transformer'),
    located: optionalChoice(request, 'located', ['yes', 'no', 'unknown']),
    check: optionalChoice(request, 'check', ['failed']),
    node: optionalText(request, 'node', 2000),
    nearMeter,
    lat,
    lon,
    radiusKm
  };
}

export function createApp(service = dataService) {
  const app = express();
  const production = process.env.NODE_ENV === 'production';
  app.disable('x-powered-by');
  if (compression) {
    app.use(compression());
  }
  app.use(express.json());
  app.use('/vendor', express.static(
    path.join(projectRoot, 'node_modules', 'leaflet', 'dist'),
    { maxAge: production ? '7d' : 0 }
  ));
  app.use(express.static(path.join(projectRoot, 'public'), { maxAge: production ? '10m' : 0 }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/openapi.json', (_request, response) => {
    response.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const api = express.Router();

  /* ---------------- Portal pass-through (unchanged) ---------------- */

  api.get('/meters', asyncRoute(async (request, response) => {
    if (request.query.q !== undefined && typeof request.query.q !== 'string') {
      throw new InvalidRequestError('q must be a single string');
    }
    const query = (request.query.q ?? '').trim();
    if (query.length > 200) {
      throw new InvalidRequestError('q must be 200 characters or fewer');
    }
    const page = parsePositiveInteger(request.query.page, 1, 'page');
    response.json(await service.listMeters({ query, page }));
  }));

  api.get('/hierarchy', asyncRoute(async (_request, response) => {
    response.json(await service.index.getHierarchy());
  }));

  /* ---------------- The dashboard: small, bounded answers ---------------- */

  // Headline numbers, breakdowns and loading progress. Answers at once, whatever the portal is doing.
  api.get('/overview', asyncRoute(async (_request, response) => {
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.getOverview());
  }));

  // The search box: a few meters, transformers and network areas, never more than `limit` of each.
  api.get('/search', asyncRoute(async (request, response) => {
    const q = optionalText(request, 'q') ?? '';
    const limit = parsePositiveInteger(request.query.limit, 6, 'limit');
    if (limit > 20) {
      throw new InvalidRequestError('limit must be 20 or fewer');
    }
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.search({ q, limit }));
  }));

  // One level of the network at a time (a node's children), paged.
  api.get('/network', asyncRoute(async (request, response) => {
    const limit = parsePositiveInteger(request.query.limit, 60, 'limit');
    if (limit > 200) {
      throw new InvalidRequestError('limit must be 200 or fewer');
    }
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.getNetworkChildren({
      node: optionalText(request, 'node', 2000) ?? '',
      offset: parseNonNegativeInteger(request.query.offset, 0, 'offset'),
      limit,
      q: optionalText(request, 'q') ?? ''
    }));
  }));

  // The whole route from the top of the network down to a node, in one request.
  api.get('/network/path', asyncRoute(async (request, response) => {
    const node = optionalText(request, 'node', 2000);
    if (!node) {
      throw new InvalidRequestError('node is required');
    }
    const limit = parsePositiveInteger(request.query.limit, 60, 'limit');
    if (limit > 200) {
      throw new InvalidRequestError('limit must be 200 or fewer');
    }
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.getNetworkPath({ node, limit }));
  }));

  // Meters inside a map viewport. Over `limit` meters in view they come back as clusters.
  api.get('/map', asyncRoute(async (request, response) => {
    const scope = parseScope(request);
    const limit = parsePositiveInteger(request.query.limit, 800, 'limit');
    if (limit > 3000) {
      throw new InvalidRequestError('limit must be 3000 or fewer');
    }
    const names = ['minLat', 'maxLat', 'minLon', 'maxLon'];
    const values = names.map((name) => parseOptionalNumber(request.query[name], name));
    let bbox = null;
    if (values.some((value) => value !== undefined)) {
      if (values.some((value) => value === undefined)) {
        throw new InvalidRequestError('minLat, maxLat, minLon and maxLon must be provided together');
      }
      bbox = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    }
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.mapQuery({ ...scope, limit, bbox }));
  }));

  /* ---------------- The meter index ---------------- */

  api.get('/index/meters', asyncRoute(async (request, response) => {
    const scope = parseScope(request);
    const page = parsePositiveInteger(request.query.page, 1, 'page');
    const limit = parsePositiveInteger(request.query.limit, 100, 'limit');
    if (limit > 200) {
      throw new InvalidRequestError('limit must be 200 or fewer');
    }
    const sort = optionalChoice(request, 'sort', ['id', 'make', 'status', 'transformer', 'location']);
    const dir = optionalChoice(request, 'dir', ['asc', 'desc']) ?? 'asc';
    const compact = optionalChoice(request, 'compact', ['0', '1']) === '1';
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.queryMeters({ ...scope, page, limit, sort, dir, compact }));
  }));

  // One meter as the drawer needs it: record, place in the network, nameplate. Reads the meter now if it has not been read yet.
  api.get('/index/meters/:meterId', asyncRoute(async (request, response) => {
    validateMeterId(request.params.meterId);
    response.set('Cache-Control', 'no-cache');
    response.json(await service.index.getMeterDetail(request.params.meterId));
  }));

  api.get('/meters/nearby', asyncRoute(async (request, response) => {
    const { lat, lon } = parseCoordinates(request);
    if (lat === undefined) {
      throw new InvalidRequestError('lat and lon are required');
    }
    const radiusKm = parseOptionalNumber(request.query.radiusKm, 'radiusKm') ?? 5;
    if (radiusKm <= 0 || radiusKm > 1000) {
      throw new InvalidRequestError('radiusKm must be greater than 0 and at most 1000');
    }
    const page = parsePositiveInteger(request.query.page, 1, 'page');
    const limit = parsePositiveInteger(request.query.limit, 100, 'limit');
    if (limit > 200) {
      throw new InvalidRequestError('limit must be 200 or fewer');
    }
    response.json(await service.index.queryMeters({
      lat, lon, radiusKm, page, limit
    }));
  }));

  api.get('/meters/:meterId', asyncRoute(async (request, response) => {
    validateMeterId(request.params.meterId);
    response.json({ data: await service.getMeter(request.params.meterId) });
  }));

  api.get('/meters/:meterId/consumption', asyncRoute(async (request, response) => {
    validateMeterId(request.params.meterId);
    const data = await service.getConsumption(request.params.meterId);
    response.json({ data: { meterId: request.params.meterId, readings: data } });
  }));

  api.get('/transformers', asyncRoute(async (request, response) => {
    const page = parsePositiveInteger(request.query.page, 1, 'page');
    response.json(await service.listTransformers({ page }));
  }));

  app.use('/api/v1', api);

  app.use((request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.path}` }
    });
  });

  app.use((error, _request, response, _next) => {
    const statusCode = error instanceof PortalError
      ? error.statusCode
      : error instanceof InvalidRequestError || error.statusCode === 400
        ? 400
        : 500;
    if (statusCode >= 500) {
      console.error('API request failed:', statusCode, error.name ?? 'Error');
    }
    const message = error instanceof InvalidRequestError
      ? error.message
      : statusCode === 400
        ? 'Invalid request'
        : statusCode >= 500
          ? 'The request could not be completed'
          : 'The requested resource was not found';
    response.status(statusCode).json({
      error: {
        code: statusCode === 400 ? 'INVALID_REQUEST'
          : statusCode === 404 ? 'NOT_FOUND'
            : statusCode === 502 ? 'UPSTREAM_ERROR'
              : statusCode === 504 ? 'UPSTREAM_TIMEOUT'
                : 'INTERNAL_ERROR',
        message
      }
    });
  });

  return app;
}

export const app = createApp();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Load the saved index (if any) and start reading the meter list right away,
  // so the first visitor finds the dashboard already filled in.
  dataService.index.warmUp().catch(() => {});
  app.listen(config.port, () => {
    console.log(`Urja API listening on http://localhost:${config.port}`);
  });
}