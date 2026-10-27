import fs from 'node:fs/promises';
import path from 'node:path';
import { TtlCache } from './ttl-cache.js';
import { PortalError } from './portal-client.js';

const CACHE_TTLS = {
  meterPages: 5 * 60 * 1000,
  meterDetails: 15 * 60 * 1000,
  consumption: 60 * 1000,
  transformers: 15 * 60 * 1000
};

// Version 3: every meter remembers when its detail page and location were last read (`hydratedAt`),
// so a restart or a refresh only has to read the meters that are new, unread or old.
// Version 2 files (built by the previous loader) are still understood and treated as read at their index time.
const SNAPSHOT_FILE_VERSION = 3;
const READABLE_SNAPSHOT_VERSIONS = new Set([2, 3]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await callback(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function normalizedKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function describeError(error) {
  return error?.message ?? 'Unknown error';
}

function hierarchyCode(name) {
  return name.match(/\(([^()]*)\)\s*$/)?.[1]?.toUpperCase() ?? null;
}

/* ------------------------------------------------------------------ */
/* Meter records                                                       */
/* ------------------------------------------------------------------ */

// What the portal's meter list gives for every meter. These fields are refreshed on every listing.
const SUMMARY_FIELDS = ['meterId', 'serialNumber', 'make', 'phaseType', 'installationStatus', 'transformerCode'];

function hasCoordinates(meter) {
  return Number.isFinite(meter.location?.latitude) && Number.isFinite(meter.location?.longitude);
}

function statusKindOf(status) {
  const value = normalizedKey(status);
  if (value === 'installed') return 'installed';
  if (value.includes('decommission')) return 'decommissioned';
  return 'other';
}

/** The detail page and location of this meter have not been read yet (it is only known from the list). */
function isPending(meter) {
  return !meter.hydratedAt;
}

/** A meter is incomplete when a portal lookup failed (as opposed to the portal having no data). */
function isIncomplete(meter) {
  return meter.detailLoaded === false || meter.locationLoaded === false;
}

/** 'mapped' | 'none' (the portal has no coordinates) | 'unknown' (lookup failed) | 'pending' (not read yet). */
function locationState(meter) {
  if (hasCoordinates(meter)) return 'mapped';
  if (meter.locationLoaded === true) return 'none';
  return isPending(meter) ? 'pending' : 'unknown';
}

const LOCATION_RANK = { mapped: 0, none: 1, unknown: 2, pending: 3 };

/** A meter that is only known from the list: everything the detail page adds is still empty. */
function newRecord(summary) {
  return {
    ...summary,
    nameplate: {},
    hierarchy: [],
    location: { latitude: null, longitude: null },
    detailLoaded: null,
    locationLoaded: null,
    dataQuality: [],
    hydratedAt: null
  };
}

function pickSummary(record) {
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    summary[field] = record[field] ?? null;
  }
  return summary;
}

/**
 * Combines the list entry with what the portal returned for its detail page and location.
 *
 * Each half is taken from the fresh answer when it succeeded. Otherwise it falls back to a
 * copy that was read successfully earlier (the previous index, or the first pass of this build),
 * so one failed request never wipes out data that was already known. Whatever is still
 * missing is recorded as a data-quality note with the portal's own reason.
 */
function assembleMeter(summary, details, failure, fallbacks = []) {
  const known = fallbacks.filter(Boolean);
  const failureText = failure ? describeError(failure) : null;

  let nameplate = {};
  let hierarchy = [];
  let detailLoaded = false;
  if (details && details.detailLoaded !== false) {
    nameplate = details.nameplate ?? {};
    hierarchy = details.hierarchy ?? [];
    detailLoaded = true;
  } else {
    const source = known.find((meter) => meter.detailLoaded === true);
    if (source) {
      nameplate = source.nameplate ?? {};
      hierarchy = source.hierarchy ?? [];
      detailLoaded = true;
    }
  }

  let location = { latitude: null, longitude: null };
  let locationLoaded = false;
  if (details && details.locationLoaded !== false) {
    location = details.location ?? location;
    locationLoaded = true;
  } else {
    const source = known.find((meter) => meter.locationLoaded === true);
    if (source) {
      location = source.location ?? location;
      locationLoaded = true;
    }
  }

  const dataQuality = [];
  if (!detailLoaded) {
    dataQuality.push({
      issue: 'Meter detail could not be loaded',
      detail: details?.detailError ?? failureText
    });
  }
  if (!locationLoaded) {
    dataQuality.push({
      issue: 'Meter location could not be loaded',
      detail: details?.locationError ?? failureText
    });
  }

  return { ...summary, nameplate, hierarchy, location, detailLoaded, locationLoaded, dataQuality };
}

/* ------------------------------------------------------------------ */
/* Network tree                                                        */
/* ------------------------------------------------------------------ */

// Position of each level in the network, top to bottom. Unrecognised levels are not listed:
// they keep the place they had in the breadcrumb.
const LEVEL_ORDER = new Map([
  ['zone', 0],
  ['circle', 1],
  ['division', 2],
  ['subdivision', 3],
  ['substation', 4],
  ['feeder', 5],
  ['distributionTransformer', 6]
]);

const UNASSIGNED_ITEM = Object.freeze({
  level: 'unassigned',
  name: 'Hierarchy unavailable',
  code: 'UNASSIGNED'
});

// Meters whose detail page has not been read yet and whose transformer is not known elsewhere.
const PENDING_ITEM = Object.freeze({
  level: 'unassigned',
  name: 'Still being placed',
  code: 'PENDING'
});

/** Puts breadcrumb items in network order without moving items of an unknown level out of place. */
function orderHierarchy(items) {
  let previousRank = -1;
  return items
    .map((item, index) => {
      const rank = LEVEL_ORDER.get(item.level) ?? previousRank + 0.5;
      previousRank = rank;
      return { item, rank, index };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

function cleanHierarchy(meter, issues) {
  const entries = [];
  for (const raw of meter.hierarchy ?? []) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      issues.push({ meterId: meter.meterId, issue: 'Hierarchy entry has no name' });
      continue;
    }
    const code = raw.code ?? hierarchyCode(name);
    entries.push({
      level: raw.level ?? 'unknown',
      name,
      code: code ? String(code).trim().toUpperCase() : null
    });
  }

  const items = orderHierarchy(entries);
  const seenLevels = new Set();
  for (const item of items) {
    if (item.level !== 'unknown' && seenLevels.has(item.level)) {
      issues.push({
        meterId: meter.meterId,
        issue: 'Several entries for the same level in the hierarchy breadcrumb',
        detail: item.level
      });
    }
    seenLevels.add(item.level);
  }
  return items;
}

function nodeKey(item) {
  return item.code ? `${item.level}:${item.code}` : `${item.level}:${normalizedKey(item.name)}`;
}

/** "Jaipur Zone 1 (Z-01)" -> title "Jaipur Zone 1", code "Z-01". */
function splitNodeName(item) {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(item.name);
  const title = match && match[1] ? match[1] : item.name;
  let code = match && match[1] ? match[2] : (item.code ?? '');
  if (String(code).toLowerCase() === title.toLowerCase() || item.level === 'unassigned') {
    code = '';
  }
  return { title, codeLabel: String(code) };
}

function createNode(item, id, pathId, parentPathId) {
  const { title, codeLabel } = splitNodeName(item);
  return {
    id,
    pathId,
    parentPathId,
    level: item.level,
    name: item.name,
    title,
    codeLabel,
    code: item.code ?? null,
    meterCount: 0,
    stats: { installed: 0, decommissioned: 0, other: 0, located: 0, pending: 0 },
    children: []
  };
}

function addToStats(stats, meter) {
  const kind = statusKindOf(meter.installationStatus);
  stats[kind] += 1;
  if (hasCoordinates(meter)) {
    stats.located += 1;
  }
  if (isPending(meter)) {
    stats.pending += 1;
  }
}

function syntheticTransformer(listCode, lookups) {
  return {
    level: 'distributionTransformer',
    name: lookups.nameByTransformer.get(normalizedKey(listCode)) ?? listCode,
    code: listCode.toUpperCase(),
    synthetic: true
  };
}

/**
 * Decides where a meter sits in the network.
 *
 *  - Normal case: the breadcrumb the portal gave us.
 *  - Breadcrumb stops short of the transformer: the transformer from the meter list is added.
 *  - No breadcrumb (not read yet, or the portal had none): the meter is placed with the other meters
 *    on the same transformer, whose breadcrumb is known. Only when that transformer is unknown
 *    elsewhere does it go under "Still being placed" (not read yet) or "Hierarchy unavailable"
 *    (read, but the portal gave nothing). It is never promoted to a top-level transformer.
 */
function placeMeter(meter, items, lookups, issues) {
  const listCode = typeof meter.transformerCode === 'string' ? meter.transformerCode.trim() : '';
  const listKey = normalizedKey(listCode);
  const pending = isPending(meter);
  // Nothing is "missing" for a meter that has not been read yet, and a failed read is reported once already.
  const reportMissing = !pending && meter.detailLoaded !== false;
  const fallbackItem = pending ? PENDING_ITEM : UNASSIGNED_ITEM;
  const fallbackPlacement = pending ? 'pending' : 'unassigned';

  const transformer = items.find((item) => item.level === 'distributionTransformer');
  if (transformer) {
    if (listKey && transformer.code && normalizedKey(transformer.code) !== listKey) {
      issues.push({
        meterId: meter.meterId,
        issue: 'Transformer code differs between meter list and hierarchy',
        detail: `${listCode} vs ${transformer.code}`
      });
    }
    return { items, placement: 'portal' };
  }

  if (items.length) {
    if (!listCode) {
      return { items, placement: 'portal' };
    }
    return { items: [...items, syntheticTransformer(listCode, lookups)], placement: 'portal' };
  }

  if (listCode) {
    const branch = lookups.branchByTransformer.get(listKey);
    if (branch) {
      if (reportMissing) {
        issues.push({
          meterId: meter.meterId,
          issue: 'No hierarchy breadcrumb available',
          detail: `placed with the other meters on ${listCode}`
        });
      }
      return { items: [...branch, syntheticTransformer(listCode, lookups)], placement: 'inferred' };
    }
    if (reportMissing) {
      issues.push({
        meterId: meter.meterId,
        issue: 'No hierarchy breadcrumb available',
        detail: `${listCode} is not known anywhere else in the network`
      });
    }
    return { items: [fallbackItem, syntheticTransformer(listCode, lookups)], placement: fallbackPlacement };
  }

  if (reportMissing) {
    issues.push({
      meterId: meter.meterId,
      issue: 'No hierarchy breadcrumb or transformer code available'
    });
  }
  return { items: [fallbackItem], placement: fallbackPlacement };
}

function insertMeter(tree, lookup, meter, placed, issues) {
  let siblings = tree;
  let trail = '';
  const nodePath = [];

  for (const item of placed.items) {
    const id = nodeKey(item);
    const parentTrail = trail;
    trail = `${trail}/${id}`;
    nodePath.push(trail);
    let node = lookup.get(trail);
    if (!node) {
      node = createNode(item, id, trail, parentTrail);
      lookup.set(trail, node);
      siblings.push(node);
    } else if (!item.synthetic && normalizedKey(node.name) !== normalizedKey(item.name)) {
      if (!node.aliases) {
        node.aliases = [];
      }
      if (!node.aliases.some((value) => normalizedKey(value) === normalizedKey(item.name))) {
        node.aliases.push(item.name);
      }
      issues.push({
        meterId: meter.meterId,
        issue: 'Conflicting names for the same hierarchy code',
        detail: `${item.level} ${item.code ?? ''}: "${node.name}" and "${item.name}"`.trim()
      });
    }
    node.meterCount += 1;
    addToStats(node.stats, meter);
    siblings = node.children;
  }
  meter.nodePath = nodePath;

  siblings.push({
    id: `meter:${meter.meterId}`,
    level: 'meter',
    name: meter.meterId,
    code: meter.meterId,
    meterCount: 1,
    children: [],
    metadata: {
      serialNumber: meter.serialNumber,
      make: meter.make,
      installationStatus: meter.installationStatus,
      transformerCode: meter.transformerCode,
      latitude: meter.location?.latitude ?? null,
      longitude: meter.location?.longitude ?? null,
      placement: placed.placement,
      dataQuality: meter.dataQuality
    }
  });
}

function nodeRank(node) {
  if (node.level === 'meter') return 2;
  if (node.level === 'unassigned') return 1;
  return 0;
}

/** Groups first (network order by name), "Hierarchy unavailable" after them, meters last. */
function sortTree(nodes) {
  nodes.sort((a, b) => nodeRank(a) - nodeRank(b) || collator.compare(a.name, b.name));
  for (const node of nodes) {
    if (node.children.length) {
      sortTree(node.children);
    }
  }
}

/**
 * Builds the distribution network: zone > circle > division > sub-division > substation >
 * feeder > transformer > meter. Every group carries its meter count and a status/coordinate
 * breakdown, so the UI can show how healthy each branch is without walking it.
 * Also records on each meter where it was placed (`placement`), its path (`treePath`) and the
 * ids of the groups above it (`nodePath`, used to filter meters by branch).
 *
 * It works on whatever has been read so far: meters that are still unread are placed with
 * the other meters on their transformer when that is known.
 */
export function buildTree(meters) {
  const issues = [];
  const prepared = meters.map((meter) => ({ meter, items: cleanHierarchy(meter, issues) }));

  // What the portal tells us about each transformer: its name, and the branch above it.
  const branchByTransformer = new Map();
  const nameByTransformer = new Map();
  for (const { meter, items } of prepared) {
    const index = items.findIndex((item) => item.level === 'distributionTransformer');
    if (index === -1) {
      continue;
    }
    const key = normalizedKey(items[index].code ?? meter.transformerCode);
    if (!key) {
      continue;
    }
    if (!nameByTransformer.has(key)) {
      nameByTransformer.set(key, items[index].name);
    }
    if (index > 0 && !branchByTransformer.has(key)) {
      branchByTransformer.set(key, items.slice(0, index));
    }
  }
  const lookups = { branchByTransformer, nameByTransformer };

  const tree = [];
  const lookup = new Map();
  for (const { meter, items } of prepared) {
    const placed = placeMeter(meter, items, lookups, issues);
    insertMeter(tree, lookup, meter, placed, issues);
    meter.placement = placed.placement;
    meter.treePath = placed.items
      .filter((item) => item.level !== 'unassigned')
      .map((item) => item.name);
  }

  sortTree(tree);

  // Where each transformer sits, so a transformer code can be turned into a place in the network.
  const transformerPaths = new Map();
  for (const node of lookup.values()) {
    if (node.level === 'distributionTransformer' && node.code && !node.pathId.startsWith('/unassigned:')) {
      const key = normalizedKey(node.code);
      if (!transformerPaths.has(key)) {
        transformerPaths.set(key, node.pathId);
      }
    }
  }
  return { tree, dataQuality: issues, lookup, transformerPaths };
}

/** Groups data-quality notes by kind, with a few example meters and reasons for each. */
function summarizeQuality(dataQuality) {
  const groups = new Map();
  for (const entry of dataQuality) {
    const group = groups.get(entry.issue) ?? { issue: entry.issue, count: 0, reasons: [], meters: [] };
    group.count += 1;
    if (entry.detail && group.reasons.length < 3 && !group.reasons.includes(entry.detail)) {
      group.reasons.push(entry.detail);
    }
    if (entry.meterId && group.meters.length < 3) {
      group.meters.push(entry.meterId);
    }
    groups.set(entry.issue, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function distanceInKm(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA))
    * Math.cos(radians(latitudeB))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/* ------------------------------------------------------------------ */
/* Compact, UI-ready shapes                                            */
/* ------------------------------------------------------------------ */

/** One meter as the table, search and map draw it. Short keys, no nameplate. */
function toRow(meter, extras = {}) {
  const located = hasCoordinates(meter);
  return {
    id: meter.meterId,
    serial: meter.serialNumber ?? null,
    make: meter.make ?? null,
    status: meter.installationStatus ?? null,
    kind: statusKindOf(meter.installationStatus),
    transformer: meter.transformerCode ?? null,
    lat: located ? meter.location.latitude : null,
    lon: located ? meter.location.longitude : null,
    loc: locationState(meter),
    path: (meter.treePath ?? []).join(' › '),
    ...extras
  };
}

/** A network group as the branch view draws it. */
function summarizeNode(node) {
  return {
    type: 'group',
    pathId: node.pathId,
    parentPathId: node.parentPathId,
    level: node.level,
    title: node.title,
    code: node.codeLabel,
    name: node.name,
    meterCount: node.meterCount,
    stats: node.stats,
    childCount: node.children.length,
    childKind: node.children[0]?.level === 'meter' ? 'meter' : 'group'
  };
}

function sumStats(nodes) {
  const stats = { installed: 0, decommissioned: 0, other: 0, located: 0, pending: 0 };
  let meterCount = 0;
  for (const node of nodes) {
    meterCount += node.meterCount;
    for (const key of Object.keys(stats)) {
      stats[key] += node.stats?.[key] ?? 0;
    }
  }
  return { meterCount, stats };
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))]
    .sort((a, b) => a.localeCompare(b));
}

function increment(map, key, label) {
  const entry = map.get(key);
  if (entry) {
    entry.count += 1;
  } else {
    map.set(key, { label, count: 1 });
  }
}

function tokensOf(text) {
  return normalizedKey(text).split(/\s+/).filter(Boolean);
}

function searchableText(meter) {
  return [
    meter.meterId,
    meter.serialNumber,
    meter.make,
    meter.installationStatus,
    meter.transformerCode,
    ...(meter.treePath ?? [])
  ].map(normalizedKey).join(' ');
}

/**
 * The filters shared by the table and the map. `skipKind` leaves out the status filters, which is how
 * the table counts "Installed / Decommissioned / Other" for the buttons above it.
 */
function matchesFilters(meter, f, { skipKind = false } = {}) {
  if (f.tokens.length) {
    const text = searchableText(meter);
    for (const token of f.tokens) {
      if (!text.includes(token)) return false;
    }
  }
  if (!skipKind) {
    if (f.kind && statusKindOf(meter.installationStatus) !== f.kind) return false;
    if (f.status && normalizedKey(meter.installationStatus) !== f.status) return false;
    if (f.statusNot && normalizedKey(meter.installationStatus) === f.statusNot) return false;
  }
  if (f.make && normalizedKey(meter.make) !== f.make) return false;
  if (f.transformer && normalizedKey(meter.transformerCode) !== f.transformer) return false;
  if (f.located === 'yes' && !hasCoordinates(meter)) return false;
  if (f.located === 'no' && locationState(meter) !== 'none') return false;
  if (f.located === 'unknown' && !['pending', 'unknown'].includes(locationState(meter))) return false;
  if (f.check === 'failed' && !isIncomplete(meter)) return false;
  if (f.node && !(meter.nodePath ?? []).includes(f.node)) return false;
  if (f.near) {
    if (!hasCoordinates(meter)) return false;
    if (distanceInKm(f.near.lat, f.near.lon, meter.location.latitude, meter.location.longitude) > f.near.km) return false;
  }
  return true;
}

const SORTERS = {
  id: (meter) => meter.meterId,
  make: (meter) => meter.make ?? '',
  status: (meter) => meter.installationStatus ?? '',
  transformer: (meter) => meter.transformerCode ?? '',
  location: (meter) => LOCATION_RANK[locationState(meter)]
};

export class MeterIndex {
  constructor({
    dataService,
    refreshTtlMs = 15 * 60 * 1000,
    maxMeters = 5000,
    detailConcurrency = 4,
    pageConcurrency = 6,
    snapshotPath = null,
    retryCooldownMs = 30 * 1000,
    retryPasses = 2,
    retryPauseMs = 2000,
    incompleteTtlMs = 5 * 60 * 1000,
    detailTtlMs = 24 * 60 * 60 * 1000,
    staleBatch = 250,
    treeMinIntervalMs = 1500,
    persistDelayMs = 15 * 1000
  }) {
    this.dataService = dataService;
    // How often the meter LIST is read again. It is cheap (a few pages), and it keeps status, make and transformer current.
    this.refreshTtlMs = refreshTtlMs;
    this.maxMeters = maxMeters;
    this.detailConcurrency = detailConcurrency;
    this.pageConcurrency = pageConcurrency;
    this.snapshotPath = snapshotPath;
    this.retryCooldownMs = retryCooldownMs;
    // How many extra passes are made over meters whose portal lookup failed, and how long to wait first.
    this.retryPasses = retryPasses;
    this.retryPauseMs = retryPauseMs;
    // Meters whose lookup failed are tried again after this long.
    this.incompleteTtlMs = incompleteTtlMs;
    // A meter's detail page and location rarely change. They are read again only after this long,
    // and only `staleBatch` meters per cycle, so re-checking is spread out instead of repeating the whole network.
    this.detailTtlMs = detailTtlMs;
    this.staleBatch = staleBatch;
    this.treeMinIntervalMs = treeMinIntervalMs;
    this.persistDelayMs = persistDelayMs;

    this.meters = new Map();        // meterId -> record
    this.idLookup = new Map();      // lower-case meter id or serial -> record
    this.indexedAt = null;          // when the meter list was last read completely (ms)
    this.version = 0;               // bumped on every change, so caches and the UI can tell
    this.listing = null;
    this.hydrating = null;
    this.hydrationPass = 0;
    this.listProgress = { total: 0, listed: 0 };
    this.hydrateProgress = { total: 0, done: 0 };
    this.listQuality = [];
    this.lastError = null;
    this.retryAfter = 0;
    this.lastHydrationEnd = 0;
    this.priorityIds = new Set();
    this.treeCache = null;
    this.persistedLoading = null;
    this.persistTimer = null;
    this.persisting = null;
  }

  touch() {
    this.version += 1;
  }

  /* ---------------------------- lifecycle ---------------------------- */

  /** Every public read starts here: load the saved index once, and make sure refreshing is under way when it is due. */
  async ready() {
    await this.loadPersisted();
    this.ensureFresh();
  }

  /** Call once at start-up so the first visitor finds the index already loading (or loaded from disk). */
  async warmUp() {
    await this.ready();
  }

  listIsDue() {
    return this.indexedAt === null || Date.now() - this.indexedAt > this.refreshTtlMs;
  }

  ensureFresh({ force = false } = {}) {
    if (this.listing) {
      return;
    }
    if ((force || this.listIsDue()) && Date.now() >= this.retryAfter) {
      this.startListing();
      return;
    }
    if (!this.hydrating && this.hasHydrationWork()) {
      this.startHydration();
    }
  }

  startListing() {
    if (this.listing) {
      return this.listing;
    }
    const operation = this.refreshList()
      .then(
        () => {
          this.lastError = null;
        },
        (error) => {
          this.lastError = error;
          this.retryAfter = Date.now() + this.retryCooldownMs;
          console.error('Meter list refresh failed:', error?.name ?? 'Error', describeError(error));
        }
      )
      .finally(() => {
        if (this.listing === operation) {
          this.listing = null;
        }
        this.touch();
        // The list is in: start reading meter details in the background.
        this.ensureFresh();
      });
    this.listing = operation;
    return operation;
  }

  /* ------------------------------ listing ------------------------------ */

  /**
   * Reads the meter list. This is all the dashboard needs for its headline numbers, the table and the search,
   * so it is deliberately separate from (and much faster than) reading every meter's detail page.
   *
   * Meters already known keep what was read about them earlier; only status, make and transformer are refreshed.
   * With no saved index (first run) the meters become searchable page by page, while the rest of the list is still arriving.
   */
  async refreshList() {
    const cold = this.meters.size === 0;
    this.listProgress = { total: 0, listed: 0 };

    const firstPage = await this.dataService.listMeters({ query: '', page: 1 }, { priority: 'high' });
    const pagination = firstPage.pagination;
    if (pagination.total > this.maxMeters) {
      throw new PortalError(`Meter index limit exceeded (${this.maxMeters})`, 502);
    }
    if (pagination.total > 0 && pagination.pageSize <= 0) {
      throw new PortalError('Urja portal returned invalid pagination metadata');
    }
    this.listProgress.total = pagination.total;

    const collected = new Map();
    let returned = 0;
    const absorb = (result) => {
      for (const summary of result.data) {
        returned += 1;
        collected.set(summary.meterId, summary);
        if (cold && !this.meters.has(summary.meterId)) {
          this.meters.set(summary.meterId, newRecord(summary));
        }
      }
      this.listProgress.listed = returned;
      if (cold) {
        this.touch();
      }
    };

    absorb(firstPage);
    const pageCount = pagination.total > 0 ? Math.ceil(pagination.total / pagination.pageSize) : 1;
    const remainingPages = Array.from({ length: Math.max(pageCount - 1, 0) }, (_, index) => index + 2);
    try {
      await mapConcurrent(remainingPages, this.pageConcurrency, async (page) => {
        absorb(await this.dataService.listMeters({ query: '', page }, { priority: 'high' }));
      });
    } catch (error) {
      if (cold) {
        // A half-read list would show wrong totals; start over on the next attempt.
        this.meters = new Map();
        this.rebuildLookup();
        this.touch();
      }
      throw error;
    }

    const quality = [];
    if (returned !== pagination.total) {
      quality.push({
        issue: 'Portal meter count differs from the meters it returned',
        detail: `reported ${pagination.total}, returned ${returned}`
      });
    }
    if (collected.size !== returned) {
      quality.push({
        issue: 'Portal returned duplicate meter IDs',
        detail: `${returned - collected.size} duplicates`
      });
    }

    const next = new Map();
    for (const [meterId, summary] of collected) {
      const previous = this.meters.get(meterId);
      if (previous) {
        Object.assign(previous, summary);
        next.set(meterId, previous);
      } else {
        next.set(meterId, newRecord(summary));
      }
    }
    this.meters = next;
    this.listQuality = quality;
    this.indexedAt = Date.now();
    this.rebuildLookup();
    for (const id of this.priorityIds) {
      if (!this.meters.has(id)) this.priorityIds.delete(id);
    }
    this.touch();
    console.log(`Meter list read: ${this.meters.size} meters (${[...this.meters.values()].filter(isPending).length} details still to read)`);
    this.persistSoon();
  }

  rebuildLookup() {
    this.idLookup = new Map();
    for (const meter of this.meters.values()) {
      this.idLookup.set(normalizedKey(meter.meterId), meter);
    }
    for (const meter of this.meters.values()) {
      const serial = normalizedKey(meter.serialNumber);
      if (serial && !this.idLookup.has(serial)) {
        this.idLookup.set(serial, meter);
      }
    }
  }

  findMeter(idOrSerial) {
    return this.idLookup.get(normalizedKey(idOrSerial)) ?? null;
  }

  /* ----------------------------- hydration ----------------------------- */

  /** Reads one meter's detail page and location and combines them with anything already known. */
  async loadMeter(summary, fallbacks = [], priority = 'normal') {
    let details = null;
    let failure = null;
    try {
      details = typeof this.dataService.fetchMeterDetails === 'function'
        ? await this.dataService.fetchMeterDetails(summary.meterId, { priority })
        : await this.dataService.getMeter(summary.meterId);
    } catch (error) {
      failure = error;
    }
    return assembleMeter(pickSummary(summary), details, failure, fallbacks);
  }

  /** Reads one meter now and stores the answer on its record. */
  async hydrateOne(meterId, priority = 'normal') {
    const current = this.meters.get(meterId);
    if (!current) {
      return null;
    }
    const loaded = await this.loadMeter(current, [current], priority);
    // A list refresh may have swapped the record while the portal was answering.
    const latest = this.meters.get(meterId);
    if (!latest) {
      return null;
    }
    latest.nameplate = loaded.nameplate;
    latest.hierarchy = loaded.hierarchy;
    latest.location = loaded.location;
    latest.detailLoaded = loaded.detailLoaded;
    latest.locationLoaded = loaded.locationLoaded;
    latest.dataQuality = loaded.dataQuality;
    latest.hydratedAt = Date.now();
    this.touch();
    this.persistSoon();
    return latest;
  }

  /** Reads a meter on behalf of someone looking at it (a click), ahead of the background queue. */
  async ensureMeter(meterId, { waitMs = 12000 } = {}) {
    await this.ready();
    const meter = this.meters.get(meterId);
    if (!meter) {
      return null;
    }
    if (isPending(meter) || isIncomplete(meter)) {
      await Promise.race([this.hydrateOne(meterId, 'high'), sleep(waitMs)]);
    }
    return this.meters.get(meterId) ?? null;
  }

  /** Moves meters somebody is looking at (a page of the table, a branch of the network) to the front of the background queue. */
  prioritize(meterIds) {
    for (const id of meterIds) {
      const meter = this.meters.get(id);
      if (meter && (isPending(meter) || isIncomplete(meter))) {
        this.priorityIds.add(id);
      }
    }
    while (this.priorityIds.size > 400) {
      this.priorityIds.delete(this.priorityIds.values().next().value);
    }
    if (this.priorityIds.size && !this.hydrating && !this.listing) {
      this.ensureFresh();
    }
  }

  hasHydrationWork() {
    const now = Date.now();
    const settled = now - this.lastHydrationEnd > this.incompleteTtlMs;
    let failed = false;
    let stale = false;
    for (const meter of this.meters.values()) {
      if (isPending(meter)) return true;
      if (isIncomplete(meter)) failed = true;
      else if (now - meter.hydratedAt > this.detailTtlMs) stale = true;
    }
    return (failed || stale) && settled;
  }

  /**
   * The order meters are read in:
   *   1. one meter per transformer whose place in the network is not known yet. That alone fills in the whole
   *      network skeleton, because every other meter on that transformer can be placed beside it;
   *   2. the rest of the meters that were never read;
   *   3. meters whose lookup failed earlier, and a limited batch of the oldest reads.
   */
  pickWork(pass) {
    const now = Date.now();
    const pending = [];
    const failed = [];
    const stale = [];
    const knownBranches = new Set();
    for (const meter of this.meters.values()) {
      if (isPending(meter)) {
        pending.push(meter);
        continue;
      }
      if (isIncomplete(meter)) {
        failed.push(meter);
      } else if (now - meter.hydratedAt > this.detailTtlMs) {
        stale.push(meter);
      }
      const key = normalizedKey(meter.transformerCode);
      if (key && meter.detailLoaded === true && (meter.hierarchy?.length ?? 0) > 1) {
        knownBranches.add(key);
      }
    }
    if (pass > 0) {
      return failed.map((meter) => meter.meterId);
    }

    const seeds = [];
    const rest = [];
    for (const meter of pending) {
      const key = normalizedKey(meter.transformerCode);
      if (!key) {
        seeds.push(meter);
      } else if (!knownBranches.has(key)) {
        knownBranches.add(key);
        seeds.push(meter);
      } else {
        rest.push(meter);
      }
    }
    stale.sort((a, b) => a.hydratedAt - b.hydratedAt);
    return [...seeds, ...rest, ...failed, ...stale.slice(0, this.staleBatch)].map((meter) => meter.meterId);
  }

  needsAttempt(meterId, pass) {
    const meter = this.meters.get(meterId);
    if (!meter) return false;
    if (pass > 0) return isIncomplete(meter);
    return isPending(meter)
      || isIncomplete(meter)
      || Date.now() - meter.hydratedAt > this.detailTtlMs;
  }

  startHydration() {
    if (this.hydrating) {
      return this.hydrating;
    }
    const operation = this.hydrateAll()
      .catch((error) => {
        console.error('Reading meter details failed:', error?.name ?? 'Error', describeError(error));
      })
      .finally(() => {
        if (this.hydrating === operation) {
          this.hydrating = null;
        }
        this.hydrationPass = 0;
        this.hydrateProgress = { total: 0, done: 0 };
        this.lastHydrationEnd = Date.now();
        this.touch();
        this.persist();
        this.reportHydration();
      });
    this.hydrating = operation;
    return operation;
  }

  async hydrateAll() {
    for (let pass = 0; pass <= this.retryPasses; pass += 1) {
      const work = this.pickWork(pass);
      if (!work.length) {
        break;
      }
      this.hydrationPass = pass;
      this.hydrateProgress = { total: work.length, done: 0 };
      if (pass > 0) {
        await sleep(this.retryPauseMs * pass);
      }
      await this.runWorkers(work, pass);
    }
  }

  async runWorkers(work, pass) {
    const visited = new Set();
    let cursor = 0;

    const next = () => {
      // Whatever somebody is looking at goes first.
      for (const id of this.priorityIds) {
        this.priorityIds.delete(id);
        if (!visited.has(id) && this.needsAttempt(id, pass)) {
          return id;
        }
      }
      while (cursor < work.length) {
        const id = work[cursor];
        cursor += 1;
        if (!visited.has(id)) {
          return id;
        }
      }
      return null;
    };

    const worker = async () => {
      for (;;) {
        const id = next();
        if (id === null) {
          return;
        }
        visited.add(id);
        if (this.needsAttempt(id, pass)) {
          await this.hydrateOne(id, 'normal');
        }
        this.hydrateProgress.done = Math.min(this.hydrateProgress.done + 1, this.hydrateProgress.total);
      }
    };

    await Promise.all(Array.from({ length: this.detailConcurrency }, () => worker()));
  }

  /** One line in the server log, plus the reasons if the portal left meters unread. */
  reportHydration() {
    const meters = [...this.meters.values()];
    const located = meters.filter(hasCoordinates).length;
    const incomplete = meters.filter(isIncomplete).length;
    const pending = meters.filter(isPending).length;
    console.log(
      `Meter details: ${meters.length} meters, ${located} with coordinates, ${incomplete} not fully read, ${pending} not read yet`
    );
    if (incomplete > 0) {
      const issues = [];
      for (const meter of meters) {
        for (const entry of meter.dataQuality ?? []) {
          if (/could not be loaded/.test(entry.issue)) issues.push({ meterId: meter.meterId, ...entry });
        }
      }
      for (const group of summarizeQuality(issues)) {
        console.warn(`  ${group.count} x ${group.issue}: ${group.reasons.join('; ') || 'no reason given'}`);
      }
    }
  }

  /* ------------------------ optional persistence ------------------------ */

  loadPersisted() {
    if (!this.snapshotPath) {
      return Promise.resolve();
    }
    // One shared read, so concurrent first requests all wait for the same file.
    this.persistedLoading ??= this.readPersisted();
    return this.persistedLoading;
  }

  async readPersisted() {
    if (this.meters.size > 0 || this.listing) {
      return;
    }
    try {
      const stored = JSON.parse(await fs.readFile(this.snapshotPath, 'utf8'));
      const indexedAt = Date.parse(stored?.indexedAt);
      if (
        READABLE_SNAPSHOT_VERSIONS.has(stored?.version)
        && Array.isArray(stored.meters)
        && Number.isFinite(indexedAt)
        && this.meters.size === 0
      ) {
        const meters = new Map();
        for (const raw of stored.meters) {
          if (typeof raw?.meterId !== 'string' || !raw.meterId) continue;
          const record = newRecord(pickSummary(raw));
          const read = raw.detailLoaded !== null && raw.detailLoaded !== undefined
            || raw.locationLoaded !== null && raw.locationLoaded !== undefined;
          if (read) {
            record.nameplate = raw.nameplate ?? {};
            record.hierarchy = Array.isArray(raw.hierarchy) ? raw.hierarchy : [];
            record.location = raw.location ?? record.location;
            record.detailLoaded = raw.detailLoaded ?? null;
            record.locationLoaded = raw.locationLoaded ?? null;
            record.dataQuality = Array.isArray(raw.dataQuality) ? raw.dataQuality : [];
            record.hydratedAt = Number.isFinite(raw.hydratedAt) ? raw.hydratedAt : indexedAt;
          }
          meters.set(record.meterId, record);
        }
        this.meters = meters;
        this.indexedAt = indexedAt;
        this.listQuality = Array.isArray(stored.listQuality) ? stored.listQuality : [];
        this.rebuildLookup();
        this.touch();
      }
    } catch {
      // No usable snapshot on disk: the first request simply builds a new one.
    }
  }

  serialize() {
    return JSON.stringify({
      version: SNAPSHOT_FILE_VERSION,
      indexedAt: new Date(this.indexedAt ?? Date.now()).toISOString(),
      listQuality: this.listQuality,
      meters: [...this.meters.values()].map((meter) => ({
        ...pickSummary(meter),
        nameplate: meter.nameplate,
        hierarchy: meter.hierarchy,
        location: meter.location,
        detailLoaded: meter.detailLoaded,
        locationLoaded: meter.locationLoaded,
        dataQuality: meter.dataQuality,
        hydratedAt: meter.hydratedAt
      }))
    });
  }

  persistSoon() {
    if (!this.snapshotPath || this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, this.persistDelayMs);
    this.persistTimer.unref?.();
  }

  persist() {
    if (!this.snapshotPath || this.indexedAt === null) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const target = this.snapshotPath;
    const temporary = `${target}.${process.pid}.tmp`;
    const write = async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(temporary, this.serialize());
      await fs.rename(temporary, target);
    };
    this.persisting = (this.persisting ?? Promise.resolve())
      .then(write)
      .catch((error) => {
        console.warn('Could not save the meter index snapshot:', error?.code ?? error?.name ?? 'Error');
      });
  }

  /** Resolves when pending snapshot writes are done (used by tests and shutdown). */
  async flush() {
    this.persist();
    await this.persisting;
  }

  /* ------------------------------- network ------------------------------- */

  /**
   * The network as it is known right now. While meters are still being read it is rebuilt at most every
   * `treeMinIntervalMs`, so a burst of progress does not turn into a burst of rebuilds.
   */
  getTreeState() {
    const cache = this.treeCache;
    if (cache && (cache.version === this.version
      || (this.hydrating && Date.now() - cache.builtAt < this.treeMinIntervalMs))) {
      return cache;
    }
    const meters = [...this.meters.values()];
    const { tree, dataQuality, lookup, transformerPaths } = buildTree(meters);
    const quality = [...this.listQuality];
    for (const meter of meters) {
      for (const entry of meter.dataQuality ?? []) {
        quality.push({ meterId: meter.meterId, ...entry });
      }
    }
    quality.push(...dataQuality);
    this.treeCache = { version: this.version, builtAt: Date.now(), tree, lookup, transformerPaths, quality };
    return this.treeCache;
  }

  networkItem(node, meters) {
    if (node.level === 'meter') {
      const meter = meters.get(node.name);
      return meter
        ? { type: 'meter', ...toRow(meter) }
        : { type: 'meter', id: node.name, make: null, status: null, kind: 'other', loc: 'pending' };
    }
    return summarizeNode(node);
  }

  /** One page of the children of a network node (or of the top level), optionally narrowed by a name filter. */
  async getNetworkChildren({ node = '', offset = 0, limit = 60, q = '' } = {}) {
    await this.ready();
    const state = this.getTreeState();
    let parent = null;
    let list;
    if (!node) {
      list = state.tree;
    } else {
      parent = state.lookup.get(node);
      if (!parent) {
        throw new PortalError('That part of the network is not available', 404);
      }
      list = parent.children;
    }

    const key = normalizedKey(q);
    if (key) {
      list = list.filter((child) => {
        if (normalizedKey(child.name).includes(key)) return true;
        if (child.level === 'meter') {
          return normalizedKey(this.meters.get(child.name)?.serialNumber).includes(key);
        }
        return normalizedKey(child.code).includes(key);
      });
    }

    const slice = list.slice(offset, offset + limit);
    const items = slice.map((child) => this.networkItem(child, this.meters));
    this.prioritize(slice.filter((child) => child.level === 'meter').map((child) => child.name));

    const parentSummary = parent
      ? summarizeNode(parent)
      : { type: 'root', title: 'Whole network', ...sumStats(state.tree) };
    return {
      data: { parent: parentSummary, total: list.length, offset, items },
      meta: this.snapshotMeta()
    };
  }

  /**
   * Everything needed to open the network at a given node in one request: one column per ancestor
   * (each page chosen so the ancestor itself is in it), plus the first page of the node's own children.
   */
  async getNetworkPath({ node, limit = 60 }) {
    await this.ready();
    const state = this.getTreeState();
    const target = state.lookup.get(node);
    if (!target) {
      throw new PortalError('That part of the network is not available', 404);
    }
    const chain = [];
    for (let current = target; current; current = current.parentPathId ? state.lookup.get(current.parentPathId) : null) {
      chain.unshift(current);
    }

    const columns = [];
    let parent = null;
    for (const entry of chain) {
      const list = parent ? parent.children : state.tree;
      const index = Math.max(list.indexOf(entry), 0);
      const offset = Math.floor(index / limit) * limit;
      columns.push({
        parent: parent?.pathId ?? '',
        total: list.length,
        offset,
        selected: entry.pathId,
        items: list.slice(offset, offset + limit).map((child) => this.networkItem(child, this.meters))
      });
      parent = entry;
    }
    const children = target.children.slice(0, limit);
    columns.push({
      parent: target.pathId,
      total: target.children.length,
      offset: 0,
      selected: null,
      items: children.map((child) => this.networkItem(child, this.meters))
    });
    this.prioritize(children.filter((child) => child.level === 'meter').map((child) => child.name));
    return { data: { columns, selected: summarizeNode(target) }, meta: this.snapshotMeta() };
  }

  async getHierarchy() {
    await this.ready();
    const state = this.getTreeState();
    return {
      data: state.tree,
      meta: {
        ...this.snapshotMeta(),
        dataQuality: state.quality,
        dataQualitySummary: summarizeQuality(state.quality)
      }
    };
  }

  /* ------------------------------- queries ------------------------------- */

  /** Turns request parameters into filters, resolving "near this meter" and "inside this branch". */
  prepareFilters(params, state) {
    const hints = [];
    const filters = {
      tokens: tokensOf(params.q),
      kind: params.kind ?? '',
      status: normalizedKey(params.status),
      statusNot: normalizedKey(params.statusNot),
      make: normalizedKey(params.make),
      transformer: normalizedKey(params.transformer),
      located: params.located ?? '',
      check: params.check ?? '',
      node: '',
      near: null,
      empty: false
    };

    if (params.node) {
      if (state.lookup.has(params.node)) {
        filters.node = params.node;
      } else {
        filters.empty = true;
        hints.push('That part of the network is not available any more.');
      }
    }

    if (params.nearMeter) {
      const center = this.findMeter(params.nearMeter);
      if (!center) {
        filters.empty = true;
        hints.push(`I couldn't find a meter “${params.nearMeter}”.`);
      } else if (!hasCoordinates(center)) {
        filters.empty = true;
        hints.push(isPending(center)
          ? `Meter ${center.meterId} has not been located yet, so I can't measure distance from it.`
          : `Meter ${center.meterId} has no coordinates, so I can't measure distance from it.`);
      } else {
        filters.near = {
          lat: center.location.latitude,
          lon: center.location.longitude,
          km: params.radiusKm ?? 2,
          meterId: center.meterId
        };
      }
    } else if (params.radiusKm !== undefined && params.lat !== undefined) {
      filters.near = { lat: params.lat, lon: params.lon, km: params.radiusKm };
    }
    return { filters, hints };
  }

  snapshotMeta() {
    const stale = Boolean(this.lastError) && this.indexedAt !== null;
    return {
      totalMeters: this.meters.size,
      indexedAt: this.indexedAt === null ? null : new Date(this.indexedAt).toISOString(),
      stale,
      ...(stale ? { warning: 'Using the previous index because the portal refresh failed' } : {})
    };
  }

  /** What is being read right now, in the words the UI shows. */
  phase() {
    if (this.listing) return 'listing';
    if (this.hydrating) return this.hydrationPass > 0 ? 'retrying' : 'hydrating';
    return 'idle';
  }

  async queryMeters(params) {
    await this.ready();
    const {
      page = 1,
      limit = 100,
      compact = false,
      sort = null,
      dir = 'asc'
    } = params;
    const state = this.getTreeState();
    const { filters, hints } = this.prepareFilters(params, state);

    const all = filters.empty ? [] : [...this.meters.values()];
    const facets = compact ? { installed: 0, decommissioned: 0, other: 0, total: 0 } : null;
    let matches = [];
    for (const meter of all) {
      if (!matchesFilters(meter, filters, { skipKind: true })) continue;
      if (facets) {
        facets[statusKindOf(meter.installationStatus)] += 1;
        facets.total += 1;
      }
      if (matchesFilters(meter, filters)) {
        matches.push(meter);
      }
    }

    let distances = null;
    const sortedByDistance = Boolean(filters.near) && !sort;
    if (filters.near) {
      distances = new Map();
      for (const meter of matches) {
        distances.set(meter.meterId, distanceInKm(filters.near.lat, filters.near.lon, meter.location.latitude, meter.location.longitude));
      }
    }
    if (sortedByDistance) {
      matches.sort((a, b) => distances.get(a.meterId) - distances.get(b.meterId));
    } else {
      const getValue = SORTERS[sort] ?? SORTERS.id;
      const direction = dir === 'desc' ? -1 : 1;
      matches.sort((a, b) => {
        const left = getValue(a);
        const right = getValue(b);
        const order = typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right));
        return direction * order || collator.compare(a.meterId, b.meterId);
      });
    }

    const total = matches.length;
    const start = (page - 1) * limit;
    const slice = matches.slice(start, start + limit);
    // Whatever is on screen is read next, so its location and place in the network fill in first.
    this.prioritize(slice.map((meter) => meter.meterId));

    const data = slice.map((meter) => {
      if (compact) {
        return toRow(meter, distances ? { distanceKm: distances.get(meter.meterId) } : {});
      }
      const { nodePath, ...record } = meter;
      return distances ? { ...record, distanceKm: distances.get(meter.meterId) } : record;
    });

    let pending = 0;
    for (const meter of this.meters.values()) {
      if (isPending(meter)) pending += 1;
    }
    return {
      data,
      pagination: { page, pageSize: limit, total },
      meta: {
        ...this.snapshotMeta(),
        phase: this.phase(),
        listComplete: this.indexedAt !== null,
        pending,
        hints,
        ...(facets ? { facets } : {})
      }
    };
  }

  /**
   * Meters for the map, limited to what is in view. When more meters than `limit` are in view they come back
   * as grid clusters (a count and a centre), so the map stays fast and the response stays small at any zoom.
   */
  async mapQuery(params) {
    await this.ready();
    const { limit = 800, bbox = null } = params;
    const state = this.getTreeState();
    const { filters, hints } = this.prepareFilters(params, state);

    let located = 0;
    let unlocated = 0;
    const inView = [];
    let bounds = null;
    if (!filters.empty) {
      for (const meter of this.meters.values()) {
        if (!matchesFilters(meter, filters)) continue;
        if (!hasCoordinates(meter)) {
          unlocated += 1;
          continue;
        }
        located += 1;
        const { latitude, longitude } = meter.location;
        bounds = bounds
          ? {
            minLat: Math.min(bounds.minLat, latitude),
            maxLat: Math.max(bounds.maxLat, latitude),
            minLon: Math.min(bounds.minLon, longitude),
            maxLon: Math.max(bounds.maxLon, longitude)
          }
          : { minLat: latitude, maxLat: latitude, minLon: longitude, maxLon: longitude };
        if (bbox && (latitude < bbox.minLat || latitude > bbox.maxLat || longitude < bbox.minLon || longitude > bbox.maxLon)) {
          continue;
        }
        inView.push(meter);
      }
    }

    let mode = 'points';
    let points = [];
    let clusters = [];
    if (inView.length <= limit) {
      points = inView.map((meter) => ({
        id: meter.meterId,
        lat: meter.location.latitude,
        lon: meter.location.longitude,
        kind: statusKindOf(meter.installationStatus),
        make: meter.make ?? null,
        status: meter.installationStatus ?? null
      }));
    } else {
      mode = 'clusters';
      const area = bbox ?? bounds;
      const columns = 12;
      const rows = 8;
      const spanLat = (area.maxLat - area.minLat) || 0.01;
      const spanLon = (area.maxLon - area.minLon) || 0.01;
      const cells = new Map();
      for (const meter of inView) {
        const { latitude, longitude } = meter.location;
        const column = Math.min(columns - 1, Math.floor((longitude - area.minLon) / spanLon * columns));
        const row = Math.min(rows - 1, Math.floor((latitude - area.minLat) / spanLat * rows));
        const key = row * columns + column;
        let cell = cells.get(key);
        if (!cell) {
          cell = {
            count: 0,
            sumLat: 0,
            sumLon: 0,
            kinds: { installed: 0, decommissioned: 0, other: 0 },
            minLat: latitude,
            maxLat: latitude,
            minLon: longitude,
            maxLon: longitude
          };
          cells.set(key, cell);
        }
        cell.count += 1;
        cell.sumLat += latitude;
        cell.sumLon += longitude;
        cell.kinds[statusKindOf(meter.installationStatus)] += 1;
        cell.minLat = Math.min(cell.minLat, latitude);
        cell.maxLat = Math.max(cell.maxLat, latitude);
        cell.minLon = Math.min(cell.minLon, longitude);
        cell.maxLon = Math.max(cell.maxLon, longitude);
      }
      clusters = [...cells.values()].map((cell) => ({
        lat: cell.sumLat / cell.count,
        lon: cell.sumLon / cell.count,
        count: cell.count,
        kinds: cell.kinds,
        bounds: { minLat: cell.minLat, maxLat: cell.maxLat, minLon: cell.minLon, maxLon: cell.maxLon }
      }));
    }

    let pending = 0;
    for (const meter of this.meters.values()) {
      if (isPending(meter)) pending += 1;
    }
    return {
      data: { mode, points, clusters, inView: inView.length, located, unlocated, bounds },
      meta: { ...this.snapshotMeta(), phase: this.phase(), pending, hints }
    };
  }

  /**
   * The search box: meters by id or serial (best matches first), transformers, and network areas, each group capped.
   */
  async search({ q, limit = 6 }) {
    await this.ready();
    const key = normalizedKey(q);
    const empty = { meters: [], meterTotal: 0, transformers: [], nodes: [] };
    if (!key) {
      return { data: empty, meta: this.snapshotMeta() };
    }
    const tokens = tokensOf(key);
    const state = this.getTreeState();

    const scored = [];
    const transformerCounts = new Map();
    for (const meter of this.meters.values()) {
      const id = normalizedKey(meter.meterId);
      const serial = normalizedKey(meter.serialNumber);
      let score = 0;
      if (id === key || serial === key) score = 100;
      else if (id.startsWith(key)) score = 80;
      else if (serial.startsWith(key)) score = 70;
      else if (id.includes(key)) score = 50;
      else if (serial.includes(key)) score = 40;
      else if (tokens.length > 1 || key.length >= 3) {
        const text = searchableText(meter);
        if (tokens.every((token) => text.includes(token))) score = 10;
      }
      if (score) {
        scored.push({ meter, score });
      }
      const code = normalizedKey(meter.transformerCode);
      if (code && code.includes(key)) {
        increment(transformerCounts, code, meter.transformerCode.trim());
      }
    }
    scored.sort((a, b) => b.score - a.score || collator.compare(a.meter.meterId, b.meter.meterId));
    const top = scored.slice(0, limit);
    this.prioritize(top.map((entry) => entry.meter.meterId));

    const transformers = [...transformerCounts.entries()]
      .map(([code, entry]) => {
        const pathId = state.transformerPaths.get(code) ?? null;
        return {
          code: entry.label,
          title: pathId ? state.lookup.get(pathId).title : entry.label,
          count: entry.count,
          pathId,
          rank: code === key ? 0 : code.startsWith(key) ? 1 : 2
        };
      })
      .sort((a, b) => a.rank - b.rank || b.count - a.count || collator.compare(a.code, b.code))
      .slice(0, 4)
      .map(({ rank, ...rest }) => rest);

    const nodes = [];
    for (const node of state.lookup.values()) {
      if (node.level === 'distributionTransformer' || node.level === 'unassigned') continue;
      const name = normalizedKey(node.name);
      const code = normalizedKey(node.code);
      const rank = name.startsWith(key) || code === key ? 0 : name.includes(key) || code.includes(key) ? 1 : -1;
      if (rank >= 0) {
        nodes.push({ node, rank });
      }
    }
    nodes.sort((a, b) => a.rank - b.rank || b.node.meterCount - a.node.meterCount || collator.compare(a.node.name, b.node.name));

    return {
      data: {
        meters: top.map((entry) => toRow(entry.meter)),
        meterTotal: scored.length,
        transformers,
        nodes: nodes.slice(0, 4).map((entry) => summarizeNode(entry.node))
      },
      meta: this.snapshotMeta()
    };
  }

  /** Everything for the meter drawer: the record, where it sits in the network, and its nameplate. */
  async getMeterDetail(meterId) {
    const meter = await this.ensureMeter(meterId);
    if (!meter) {
      throw new PortalError('Meter not found', 404);
    }
    const state = this.getTreeState();
    const trail = (meter.nodePath ?? [])
      .map((pathId) => state.lookup.get(pathId))
      .filter((node) => node && node.level !== 'unassigned')
      .map(summarizeNode);
    return {
      data: {
        ...toRow(meter),
        phaseType: meter.phaseType ?? null,
        pending: isPending(meter),
        placement: meter.placement ?? null,
        trail,
        nameplate: meter.nameplate ?? {},
        issues: meter.dataQuality ?? []
      },
      meta: this.snapshotMeta()
    };
  }

  /* ------------------------------- overview ------------------------------- */

  /**
   * The headline numbers, the breakdowns and the loading progress. Never waits for the portal:
   * it answers with whatever is known, and says how much is still being read.
   */
  async getOverview() {
    await this.ready();
    const summary = {
      total: 0,
      installed: 0,
      decommissioned: 0,
      other: 0,
      located: 0,
      noCoordinates: 0,
      locationUnknown: 0,
      pending: 0,
      detailsMissing: 0
    };
    const statuses = new Map();
    const makes = new Map();
    const transformers = new Map();

    for (const meter of this.meters.values()) {
      summary.total += 1;
      const kind = statusKindOf(meter.installationStatus);
      summary[kind] += 1;
      const state = locationState(meter);
      if (state === 'mapped') summary.located += 1;
      else if (state === 'none') summary.noCoordinates += 1;
      else summary.locationUnknown += 1;
      if (isPending(meter)) summary.pending += 1;
      if (meter.detailLoaded === false) summary.detailsMissing += 1;

      const status = meter.installationStatus?.trim() || 'Unknown';
      const entry = statuses.get(status) ?? { label: status, kind, count: 0 };
      entry.count += 1;
      statuses.set(status, entry);
      increment(makes, normalizedKey(meter.make) || 'unknown', meter.make?.trim() || 'Unknown');
      const code = normalizedKey(meter.transformerCode);
      if (code) {
        increment(transformers, code, meter.transformerCode.trim());
      }
    }

    const tree = this.getTreeState();
    const busiest = [...transformers.entries()]
      .sort((a, b) => b[1].count - a[1].count || collator.compare(a[1].label, b[1].label))
      .slice(0, 6)
      .map(([key, entry]) => {
        const pathId = tree.transformerPaths.get(key) ?? null;
        return {
          code: entry.label,
          title: pathId ? tree.lookup.get(pathId).title : entry.label,
          count: entry.count,
          pathId
        };
      });

    const listComplete = this.indexedAt !== null;
    const stale = Boolean(this.lastError) && listComplete;
    return {
      data: {
        summary: {
          ...summary,
          // While the list is still arriving the portal's own total is the honest headline number.
          total: listComplete ? summary.total : Math.max(this.listProgress.total, summary.total)
        },
        statuses: [...statuses.values()].sort((a, b) => b.count - a.count),
        makes: [...makes.values()].sort((a, b) => b.count - a.count).slice(0, 8),
        transformers: { distinct: transformers.size, busiest },
        filters: {
          statuses: uniqueSorted([...this.meters.values()].map((meter) => meter.installationStatus)),
          makes: uniqueSorted([...this.meters.values()].map((meter) => meter.make))
        },
        quality: { count: tree.quality.length, groups: summarizeQuality(tree.quality).slice(0, 8) }
      },
      meta: {
        phase: this.phase(),
        listComplete,
        listProgress: { ...this.listProgress },
        hydration: { ...this.hydrateProgress, pass: this.hydrationPass, pending: summary.pending },
        indexedAt: this.indexedAt === null ? null : new Date(this.indexedAt).toISOString(),
        stale,
        version: this.version,
        ...(stale ? { warning: 'Using the previous index because the portal refresh failed' } : {}),
        ...(!listComplete && this.lastError && !this.listing ? { error: describeError(this.lastError) } : {})
      }
    };
  }
}

export class UrjaDataService {
  constructor(portalClient, { cache = new TtlCache(), indexOptions = {} } = {}) {
    this.portalClient = portalClient;
    this.cache = cache;
    this.index = new MeterIndex({ dataService: this, ...indexOptions });
  }

  async listMeters({ query = '', page = 1 }, { priority = 'normal' } = {}) {
    const key = `meters:${normalizedKey(query)}:${page}`;
    return (await this.cache.getOrLoad(
      key,
      CACHE_TTLS.meterPages,
      () => this.portalClient.listMeters({ query, page }, { priority })
    )).value;
  }

  /**
   * Raw detail + location for one meter, including which halves were read. Only complete
   * answers are cached, so a failed lookup is tried again next time instead of being remembered.
   * `priority: 'high'` is for a meter somebody is looking at.
   */
  async fetchMeterDetails(meterId, { priority = 'normal' } = {}) {
    return (await this.cache.getOrLoad(
      `meter:${meterId}`,
      CACHE_TTLS.meterDetails,
      () => this.portalClient.getMeter(meterId, { priority }),
      { cacheable: (result) => result?.detailLoaded !== false && result?.locationLoaded !== false }
    )).value;
  }

  /** The public meter lookup: fails only when the portal gave nothing at all. */
  async getMeter(meterId) {
    const result = await this.fetchMeterDetails(meterId, { priority: 'high' });
    if (result.detailLoaded === false && result.locationLoaded === false) {
      throw new PortalError(result.detailError ?? result.locationError ?? 'Urja portal meter details could not be loaded');
    }
    const warnings = [result.detailError, result.locationError].filter(Boolean);
    return {
      meterId: result.meterId,
      nameplate: result.nameplate,
      hierarchy: result.hierarchy,
      location: result.location,
      ...(warnings.length ? { warnings } : {})
    };
  }

  async getConsumption(meterId) {
    return (await this.cache.getOrLoad(
      `consumption:${meterId}`,
      CACHE_TTLS.consumption,
      () => this.portalClient.getConsumption(meterId)
    )).value;
  }

  async listTransformers({ page = 1 }) {
    return (await this.cache.getOrLoad(
      `transformers:${page}`,
      CACHE_TTLS.transformers,
      () => this.portalClient.listTransformers({ page })
    )).value;
  }
}