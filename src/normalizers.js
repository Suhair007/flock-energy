import * as cheerio from 'cheerio';

const HIERARCHY_CODE_LEVELS = [
  [/^Z-/i, 'zone'],
  [/^C-/i, 'circle'],
  [/^D-/i, 'division'],
  [/^SD-/i, 'subdivision'],
  [/^SS-/i, 'substation'],
  [/^F-/i, 'feeder'],
  [/^DT-/i, 'distributionTransformer']
];

// Characters the portal may use between breadcrumb items; they are never part of a name.
const BREADCRUMB_SEPARATORS = new Set(['›', '>', '»', '/', '|', '→', '·', '-', '–', '—']);

export function normalizeMeterSummary(meter) {
  if (!meter || typeof meter.meterId !== 'string' || !meter.meterId.trim()) {
    throw new Error('Invalid meter record');
  }

  return {
    meterId: meter.meterId.trim(),
    serialNumber: meter.serialNo ?? null,
    make: meter.make ?? null,
    phaseType: meter.phaseType ?? null,
    installationStatus: meter.installStatus ?? null,
    transformerCode: meter.dtCode ?? null
  };
}

function hierarchyLevel(name) {
  const code = name.match(/\(([^()]*)\)\s*$/)?.[1];
  return HIERARCHY_CODE_LEVELS.find(([pattern]) => pattern.test(code ?? ''))?.[1] ?? 'unknown';
}

function sameText(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

/**
 * Reads the portal's meter page: the nameplate table and the hierarchy breadcrumb.
 *
 * The page is only rejected when it clearly is not the requested meter. A missing
 * nameplate or breadcrumb is not fatal, because the breadcrumb is what places the meter
 * in the network tree and the caller can still use whatever else the page held.
 */
export function parseMeterDetailPage(html, expectedMeterId) {
  const $ = cheerio.load(html);
  const nameplate = {};

  $('section').each((_, section) => {
    const sectionElement = $(section);
    const heading = sectionElement.find('h2').first().text().trim().toLowerCase();
    if (heading !== 'nameplate') {
      return;
    }

    sectionElement.find('dl > div').each((_, row) => {
      const label = $(row).find('dt').first().text().trim();
      const value = $(row).find('dd').first().text().trim();
      if (label) {
        nameplate[label] = value || null;
      }
    });
  });

  const heading = $('main h1, h1').first().text().trim();
  const headingMatches = sameText(heading, `Meter ${expectedMeterId}`) || sameText(heading, expectedMeterId);
  const nameplateMatches = sameText(nameplate['Meter ID'], expectedMeterId);
  if (!headingMatches && !nameplateMatches) {
    throw new Error('Portal returned a different page than the requested meter');
  }

  // Leaf elements only, so nested wrappers never produce the same name twice.
  const breadcrumbSelector = 'span, a, li';
  const breadcrumb = [];
  $('main nav').first()
    .find(breadcrumbSelector)
    .filter((_, element) => $(element).find(breadcrumbSelector).length === 0)
    .each((_, element) => {
      const text = $(element).text().replace(/\s+/g, ' ').trim();
      if (!text || BREADCRUMB_SEPARATORS.has(text)) {
        return;
      }
      // The meter itself is sometimes the last crumb; it is a leaf of the tree, not a group.
      if (sameText(text, expectedMeterId) || sameText(text, `Meter ${expectedMeterId}`)) {
        return;
      }
      if (breadcrumb.at(-1) !== text) {
        breadcrumb.push(text);
      }
    });

  const hierarchy = breadcrumb.map((name) => ({
    level: hierarchyLevel(name),
    name
  }));

  return { nameplate, hierarchy };
}

function normalizeNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

/**
 * Coordinates that cannot be real points on Earth (out of range, or the 0,0 placeholder some
 * systems store for "unknown") are treated as "no coordinates" instead of being drawn
 * in the Atlantic Ocean.
 */
export function normalizeLocation(location) {
  const latitude = normalizeNumeric(location?.latitude ?? location?.lat);
  const longitude = normalizeNumeric(location?.longitude ?? location?.lng ?? location?.lon);
  const usable = latitude !== null
    && longitude !== null
    && Math.abs(latitude) <= 90
    && Math.abs(longitude) <= 180
    && !(latitude === 0 && longitude === 0);

  return usable ? { latitude, longitude } : { latitude: null, longitude: null };
}

export function normalizeConsumptionPoint(point) {
  if (!point || typeof point !== 'object') {
    throw new Error('Invalid consumption record');
  }

  return {
    timestamp: point.timestamp ?? null,
    kwh: normalizeNumeric(point.kwh),
    kvah: normalizeNumeric(point.kvah),
    voltageR: normalizeNumeric(point.voltR)
  };
}

export function normalizeTransformer(transformer) {
  if (!transformer || typeof transformer.code !== 'string' || !transformer.code.trim()) {
    throw new Error('Invalid transformer record');
  }

  return {
    code: transformer.code.trim(),
    name: transformer.name ?? null,
    feederCode: transformer.feederCode ?? null,
    capacityKva: normalizeNumeric(transformer.capacityKva)
  };
}