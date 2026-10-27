/*
 * Flock Energy · Operations dashboard.
 *
 * The page never downloads "all the meters". Every view asks the server for one small, bounded answer:
 *   Overview  -> /overview           numbers and breakdowns (polled while the server is still loading)
 *   Meters    -> /index/meters       one page of 25, filtered and sorted by the server
 *   Network   -> /network            one level of the tree at a time, 60 per page
 *   Map       -> /map                only what is inside the viewport, clustered when there are many
 *   Search    -> /search             a handful of meters, transformers and areas
 *   Drawer    -> /index/meters/:id   one meter (read from the portal on demand if it was not yet)
 */

const DEFAULT_CENTER = [26.9124, 75.7873];
const PAGE_SIZE = 25;
const NET_PAGE = 60;
const MAP_LIMIT = 900;
const READINGS_TTL_MS = 60 * 1000;
const POLL_BUSY_MS = 1500;
const POLL_IDLE_MS = 30 * 1000;
const RECENT_KEY = 'atlas-recent';
const VIEWS = ['overview', 'meters', 'network', 'map'];
const VIEW_TITLES = { overview: 'Overview', meters: 'Meters', network: 'Network', map: 'Map' };

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const KIND_LABEL = { installed: 'Installed', decommissioned: 'Decommissioned', other: 'Other' };
const LOC_LABEL = { mapped: 'Mapped', none: 'No coordinates', unknown: 'Unavailable', pending: 'Checking…' };

// Network levels, top to bottom: the letters shown in the node icon, and the names used in headings.
const LEVELS = {
  zone: { icon: 'Z', label: 'Zone', plural: 'Zones' },
  circle: { icon: 'C', label: 'Circle', plural: 'Circles' },
  division: { icon: 'D', label: 'Division', plural: 'Divisions' },
  subdivision: { icon: 'SD', label: 'Sub-division', plural: 'Sub-divisions' },
  substation: { icon: 'SS', label: 'Substation', plural: 'Substations' },
  feeder: { icon: 'F', label: 'Feeder', plural: 'Feeders' },
  distributionTransformer: { icon: 'T', label: 'Transformer', plural: 'Transformers' },
  unassigned: { icon: '?', label: 'Position unknown', plural: 'Position unknown' },
  unknown: { icon: '•', label: 'Group', plural: 'Groups' }
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const emptyScope = () => ({
  q: '', kind: '', status: '', statusNot: '', make: '', transformer: '', located: '', check: '', near: null, node: null
});

const state = {
  view: 'overview',
  meterId: null,
  overview: null,
  meta: null,
  signatures: {},
  scope: emptyScope(),
  sort: { key: 'id', dir: 'asc' },
  page: 0,
  total: 0,
  rows: [],
  facets: null,
  metersToken: 0,
  metersAbort: null,
  metersLoadedAt: 0,
  answer: '',
  wantsCount: false,
  pollTimer: null,
  failures: 0,
  lastRefresh: 0,
  readings: new Map(),
  drawerToken: 0,
  lastFocus: null
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isLightTheme = () => document.documentElement.dataset.theme === 'light';

function debounce(callback, delay) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// Browser storage can be blocked (private windows, embedded views); everything that uses it must work without it.
const store = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* the choice then lasts for this visit only */ }
  }
};

function svgEl(name, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name, size = 16) {
  const svg = svgEl('svg', { width: size, height: size, 'aria-hidden': 'true' });
  svg.append(svgEl('use', { href: `#i-${name}` }));
  return svg;
}

/** Builds an element. All text goes through textContent, so portal values are never parsed as markup. */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function setText(selector, text) {
  const node = $(selector);
  if (node && node.textContent !== text) node.textContent = text;
}

const formatNumber = (value, digits = 0) => Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const percent = (part, whole) => (whole > 0 ? `${Math.round(part / whole * 100)}%` : '');

function formatAgo(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'just now';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function formatDistance(km) {
  return km >= 1 ? `${formatNumber(km, 1)} km` : `${Math.round(km * 1000)} m`;
}

function formatStamp(value, { long = false } = {}) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return String(value ?? '');
  const hasTime = /[T ]\d{1,2}:\d{2}/.test(String(value));
  const options = long
    ? { day: 'numeric', month: 'short', year: 'numeric', ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}) }
    : { day: 'numeric', month: 'short' };
  return new Date(time).toLocaleString(undefined, options);
}

function formatAxis(value) {
  return Math.abs(value) >= 100000
    ? value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    : formatNumber(value, 1);
}

function statusKind(status) {
  const value = String(status ?? '').trim().toLocaleLowerCase();
  if (value === 'installed') return 'installed';
  if (value.includes('decommission')) return 'decommissioned';
  return 'other';
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let toastTimer = null;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

/** Re-draws a list only when its data really changed, so buttons are not replaced under the pointer while data trickles in. */
function changed(key, value) {
  const signature = JSON.stringify(value);
  if (state.signatures[key] === signature) return false;
  state.signatures[key] = signature;
  return true;
}

function animateNumber(node, target) {
  if (!node) return;
  node.classList.remove('is-loading');
  const from = Number(node.dataset.value);
  node.dataset.value = String(target);
  if (!Number.isFinite(from) || from === target || reducedMotion() || Math.abs(target - from) < 2) {
    node.textContent = formatNumber(target);
    return;
  }
  const start = performance.now();
  const duration = 600;
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = formatNumber(Math.round(from + (target - from) * eased));
    if (t < 1 && Number(node.dataset.value) === target) requestAnimationFrame(step);
    else node.textContent = formatNumber(Number(node.dataset.value));
  };
  requestAnimationFrame(step);
}

function setNumber(selector, value) {
  const node = $(selector);
  if (!node) return;
  if (value === null || value === undefined) {
    node.classList.add('is-loading');
    node.textContent = '—';
    delete node.dataset.value;
  } else {
    animateNumber(node, value);
  }
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

async function requestJson(url, { signal } = {}) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      error.aborted = true;
      throw error;
    }
    const failure = new Error('Cannot reach the server');
    failure.network = true;
    throw failure;
  }
  let result = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    const failure = new Error(result?.error?.message ?? `Request failed (${response.status})`);
    failure.status = response.status;
    throw failure;
  }
  if (result === null) {
    throw new Error('The server returned an unreadable response');
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Views and the address bar                                           */
/* ------------------------------------------------------------------ */

function parseHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const view = params.get('view');
  return { view: VIEWS.includes(view) ? view : null, meter: params.get('meter') || null };
}

function writeHash({ push = false } = {}) {
  const params = new URLSearchParams();
  params.set('view', state.view);
  if (state.meterId) params.set('meter', state.meterId);
  const next = `#${params.toString()}`;
  if (window.location.hash === next) return;
  try {
    window.history[push ? 'pushState' : 'replaceState'](null, '', next);
  } catch {
    // Some embedded contexts block history updates; deep links are optional.
  }
}

function showView(view, { fromHash = false } = {}) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  document.body.dataset.view = view;
  for (const section of $$('.view')) section.hidden = section.dataset.view !== view;
  for (const link of $$('[data-view-link]')) {
    const active = link.dataset.viewLink === view;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${VIEW_TITLES[view]} · Flock Energy`;
  if (!fromHash) writeHash({ push: true });
  if (view === 'meters') loadMeters();
  if (view === 'network') ensureNetwork();
  if (view === 'map') ensureMap();
  if (!fromHash) window.scrollTo({ top: 0 });
}

function applyHash() {
  const { view, meter } = parseHash();
  if (view && view !== state.view) showView(view, { fromHash: true });
  if (meter && meter !== state.meterId) openMeter(meter, { source: 'hash' });
  else if (!meter && state.meterId) closeDrawer({ fromHash: true });
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function applyOverview(result) {
  state.overview = result.data;
  state.meta = result.meta;
  renderPill();
  renderHero();
  renderFreshness();
  if (changed('attention', [result.data.summary, result.data.quality, result.meta.listComplete, result.meta.phase])) renderAttention();
  if (changed('ranks', [result.data.transformers, result.data.makes])) renderRanks();
  if (changed('filters', result.data.filters)) populateFilters(result.data.filters);
  refreshActiveView(result.meta);
}

async function pollOverview() {
  clearTimeout(state.pollTimer);
  let delay = POLL_IDLE_MS;
  try {
    const result = await requestJson('/api/v1/overview');
    state.failures = 0;
    applyOverview(result);
    const busy = result.meta.phase !== 'idle' || !result.meta.listComplete;
    delay = result.meta.error ? 5000 : busy ? POLL_BUSY_MS : POLL_IDLE_MS;
  } catch (error) {
    state.failures += 1;
    renderPill({ failed: error.message });
    delay = Math.min(2000 * state.failures, 15000);
  }
  state.pollTimer = setTimeout(pollOverview, document.hidden ? Math.max(delay, 10000) : delay);
}

function renderPill({ failed } = {}) {
  const pill = $('#sync-pill');
  const meta = state.meta;
  let kind = '';
  let text = 'Connecting…';
  let title = '';
  if (failed) {
    kind = 'is-error';
    text = 'Server unreachable';
    title = `${failed}. Trying again.`;
  } else if (meta) {
    const summary = state.overview.summary;
    const checked = summary.total - summary.pending;
    if (meta.error) {
      kind = 'is-error';
      text = 'Portal unreachable · retrying';
      title = meta.error;
    } else if (!meta.listComplete) {
      kind = 'is-busy';
      text = 'Loading meters…';
      title = `${formatNumber(meta.listProgress.listed)} of ${formatNumber(meta.listProgress.total)} meters listed`;
    } else if (meta.phase === 'hydrating' || meta.phase === 'retrying') {
      kind = 'is-busy';
      text = `Mapping network · ${percent(checked, summary.total) || '0%'}`;
      title = `${formatNumber(checked)} of ${formatNumber(summary.total)} meters read in detail. You can keep working; locations and the network fill in as they arrive.`;
    } else if (meta.stale) {
      kind = 'is-warn';
      text = 'Showing last known data';
      title = meta.warning ?? '';
    } else {
      text = `Up to date · ${formatAgo(meta.indexedAt)}`;
      title = `Meter list read ${formatAgo(meta.indexedAt)}`;
    }
  }
  pill.className = `pill ${kind}`.trim();
  setText('#sync-text', text);
  pill.title = title;
}

function renderHero() {
  const { summary, transformers } = state.overview;
  const meta = state.meta;
  const listing = !meta.listComplete;
  const total = summary.total || null;
  setNumber('#hero-total', total);

  let note = '';
  if (listing && meta.listProgress.total) {
    note = `Reading the list · ${formatNumber(meta.listProgress.listed)} of ${formatNumber(meta.listProgress.total)}`;
  } else if (total) {
    note = transformers.distinct ? `Across ${formatNumber(transformers.distinct)} transformers` : '';
  }
  setText('#hero-note', note);

  const figures = {
    installed: summary.installed,
    decommissioned: summary.decommissioned,
    other: summary.other
  };
  for (const [kind, value] of Object.entries(figures)) {
    setNumber(`#stat-${kind}`, listing ? null : value);
    setText(`#stat-${kind}-note`, listing ? '' : `${percent(value, summary.total)} of all meters`);
  }
  const checked = summary.total - summary.pending;
  setNumber('#stat-located', listing ? null : summary.located);
  setText('#stat-located-note', listing
    ? ''
    : summary.pending > 0
      ? `${formatNumber(checked)} of ${formatNumber(summary.total)} checked`
      : `${percent(summary.located, summary.total)} of all meters`);

  const split = $$('#hero-bar i');
  const sizes = listing ? [0, 0, 0] : [summary.installed, summary.decommissioned, summary.other];
  split.forEach((segment, index) => {
    segment.style.flexBasis = summary.total ? `${sizes[index] / summary.total * 100}%` : '0%';
  });

  // Loading progress: what is happening, in plain words.
  const progress = $('#hero-progress');
  const bar = $('#hero-progress-bar');
  let text = '';
  let fraction = null;
  if (listing && !meta.error) {
    text = 'Reading the meter list. The numbers above settle in a moment.';
    fraction = meta.listProgress.total ? meta.listProgress.listed / meta.listProgress.total : null;
  } else if (meta.phase === 'hydrating' && summary.pending > 0) {
    text = `Locating meters and mapping the network · ${formatNumber(checked)} of ${formatNumber(summary.total)}. Everything below already works; it fills in as details arrive.`;
    fraction = summary.total ? checked / summary.total : 0;
  } else if (meta.phase === 'retrying') {
    text = `Re-reading meters the portal skipped · ${formatNumber(meta.hydration.done)} of ${formatNumber(meta.hydration.total)}`;
    fraction = meta.hydration.total ? meta.hydration.done / meta.hydration.total : 0;
  } else if (meta.error) {
    text = `The portal could not be reached (${meta.error}). Trying again shortly.`;
  }
  progress.hidden = !text;
  $('.progress', progress).classList.toggle('indeterminate', Boolean(text) && fraction === null);
  bar.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
  setText('#hero-progress-text', text);

  setText('#overview-sub', listing
    ? 'Reading the meter list…'
    : meta.stale
      ? 'The portal could not be reached; showing the last data we have.'
      : 'Choose a number to see the meters behind it.');
}

function renderFreshness() {
  const meta = state.meta;
  setText('#freshness', meta.indexedAt
    ? `Meter list read ${formatAgo(meta.indexedAt)}${meta.stale ? ' · showing last known data' : ''}`
    : 'Meter list not read yet.');
}

function attentionRows() {
  const { summary, quality, statuses } = state.overview;
  const meta = state.meta;
  const rows = [];
  if (summary.noCoordinates > 0) {
    const checked = summary.total - summary.pending;
    rows.push({
      count: summary.noCoordinates,
      title: 'No coordinates',
      note: `The portal has no location for ${percent(summary.noCoordinates, checked)} of the meters checked, so they can’t be shown on the map.`,
      scope: { located: 'no' }
    });
  }
  if (summary.detailsMissing > 0) {
    rows.push({
      count: summary.detailsMissing,
      title: 'Details could not be read',
      note: 'The portal did not answer for these meters. They are retried automatically.',
      scope: { check: 'failed' }
    });
  }
  if (summary.other > 0) {
    const names = statuses.filter((status) => status.kind === 'other').map((status) => status.label);
    rows.push({
      count: summary.other,
      title: 'Other statuses',
      note: `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
      scope: { kind: 'other' }
    });
  }
  if (quality.count > 0 && meta.listComplete && summary.pending === 0) {
    rows.push({
      count: quality.count,
      title: 'Data notes',
      note: 'Missing or inconsistent fields reported while building the network.',
      view: 'network'
    });
  }
  return rows;
}

function renderAttention() {
  const host = $('#attention-list');
  const meta = state.meta;
  if (!meta.listComplete) {
    host.replaceChildren(el('p', { class: 'panel-empty', text: 'Checks appear once the meter list is in.' }));
    return;
  }
  const rows = attentionRows();
  state.attention = rows;
  if (!rows.length) {
    const pending = state.overview.summary.pending > 0;
    host.replaceChildren(el('div', { class: 'attn-ok' }, el('i'), el('span', {
      text: pending ? 'Nothing so far. Still reading meter details…' : 'Nothing needs attention.'
    })));
    return;
  }
  host.replaceChildren(...rows.map((row, index) => el('button', { type: 'button', class: 'attn-row', dataset: { index } },
    el('b', { class: 'attn-count', text: formatNumber(row.count) }),
    el('span', { class: 'attn-text' }, el('strong', { text: row.title }), el('small', { text: row.note })),
    el('span', { class: 'attn-go' }, icon('chevron', 18)))));
}

function rankRow({ label, sub, count, max, onClick }) {
  return el('button', { type: 'button', class: 'rank-row', onclick: onClick },
    el('span', { class: 'rank-top' },
      el('span', { text: label }, sub ? el('small', { text: sub }) : null),
      el('b', { text: formatNumber(count) })),
    el('span', { class: 'rank-track' }, el('span', { class: 'rank-fill', style: `width:${Math.max(count / max * 100, 3)}%` })));
}

function renderRanks() {
  const { transformers, makes } = state.overview;
  const busiest = $('#busiest-list');
  if (transformers.busiest.length) {
    const max = transformers.busiest[0].count;
    busiest.replaceChildren(...transformers.busiest.map((entry) => rankRow({
      label: entry.title === entry.code ? entry.code : entry.title,
      sub: entry.title === entry.code ? '' : entry.code,
      count: entry.count,
      max,
      onClick: () => (entry.pathId
        ? openNetworkNode(entry.pathId)
        : setScope({ transformer: entry.code }, { view: 'meters' }))
    })));
  }
  const list = $('#makes-list');
  if (makes.length) {
    const max = makes[0].count;
    list.replaceChildren(...makes.map((entry) => rankRow({
      label: entry.label,
      count: entry.count,
      max,
      onClick: () => (entry.label === 'Unknown' ? showView('meters') : setScope({ make: entry.label }, { view: 'meters' }))
    })));
  }
}

function populateFilters(filters) {
  const select = $('#m-make');
  const selected = state.scope.make || select.value;
  select.replaceChildren(el('option', { value: '', text: 'All makes' }),
    ...filters.makes.map((make) => el('option', { value: make, text: make })));
  select.value = filters.makes.includes(selected) ? selected : '';
}

/** "Pick up where you left off": the last few meters opened in this browser. */
function recentMeters() {
  try {
    const list = JSON.parse(store.get(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.id === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberMeter(meter) {
  const entry = { id: meter.id, make: meter.make ?? '', status: meter.status ?? '' };
  const next = [entry, ...recentMeters().filter((item) => item.id !== meter.id)].slice(0, 6);
  store.set(RECENT_KEY, JSON.stringify(next));
  renderRecent();
}

function renderRecent() {
  const list = recentMeters();
  $('#recent-panel').hidden = !list.length;
  $('#recent-list').replaceChildren(...list.map((entry) => el('button', {
    type: 'button',
    class: 'recent-chip',
    onclick: () => openMeter(entry.id, { source: 'recent' })
  }, el('i', { class: `dot k-${statusKind(entry.status)}` }), el('strong', { text: entry.id }),
  entry.make ? el('small', { text: entry.make }) : null)));
}

/** While details keep arriving, refresh whatever the person is looking at, gently. */
function refreshActiveView(meta) {
  const busy = meta.phase !== 'idle' || !meta.listComplete;
  const due = Date.now() - state.lastRefresh > 6000;
  const sawDone = state.wasBusy && !busy;
  state.wasBusy = busy;
  if (!(busy && due) && !sawDone) return;
  if (state.view === 'meters' && state.metersLoadedAt && !state.loadingMeters) loadMeters({ quiet: true });
  else if (state.view === 'network' && net.cols.length) reloadNetwork();
  else if (state.view === 'map' && mapState.map) loadMap({ quiet: true });
  state.lastRefresh = Date.now();
}

/* ------------------------------------------------------------------ */
/* Scope: the filters the Meters and Map views share                   */
/* ------------------------------------------------------------------ */

function scopeActive(scope = state.scope) {
  return Boolean(scope.q || scope.kind || scope.status || scope.statusNot || scope.make || scope.transformer
    || scope.located || scope.check || scope.near || scope.node);
}

function scopeParams(extra = {}) {
  const s = state.scope;
  const params = new URLSearchParams();
  for (const key of ['q', 'kind', 'status', 'statusNot', 'make', 'transformer', 'located', 'check']) {
    if (s[key]) params.set(key, s[key]);
  }
  if (s.node) params.set('node', s.node.pathId);
  if (s.near) {
    params.set('nearMeter', s.near.meterId);
    params.set('radiusKm', String(s.near.km));
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params;
}

function setScope(patch, { view, replace = false, keepAnswer = false } = {}) {
  state.scope = { ...(replace ? emptyScope() : state.scope), ...patch };
  state.page = 0;
  if (!keepAnswer) {
    state.answer = '';
    state.wantsCount = false;
  }
  syncScopeControls();
  if (view && view !== state.view) {
    showView(view);
  } else {
    refreshScopedViews();
  }
}

function refreshScopedViews() {
  if (state.view === 'meters') loadMeters();
  if (state.view === 'map') ensureMap({ fit: true });
}

function scopeChips() {
  const s = state.scope;
  const chips = [];
  if (s.q) chips.push({ label: `“${s.q}”`, clear: { q: '' } });
  if (s.kind) chips.push({ label: KIND_LABEL[s.kind], clear: { kind: '' } });
  if (s.status) chips.push({ label: s.status, clear: { status: '' } });
  if (s.statusNot) chips.push({ label: `Not ${s.statusNot}`, clear: { statusNot: '' } });
  if (s.make) chips.push({ label: `Make: ${s.make}`, clear: { make: '' } });
  if (s.transformer) chips.push({ label: `Transformer ${s.transformer}`, clear: { transformer: '' } });
  if (s.located) {
    chips.push({
      label: { yes: 'Has coordinates', no: 'No coordinates', unknown: 'Not checked yet' }[s.located],
      clear: { located: '' }
    });
  }
  if (s.check) chips.push({ label: 'Details not read', clear: { check: '' } });
  if (s.node) chips.push({ label: `Inside ${s.node.label}`, clear: { node: null } });
  if (s.near) chips.push({ label: `Within ${formatDistance(s.near.km)} of ${s.near.label}`, clear: { near: null } });
  return chips;
}

/** Brings the inputs, buttons and chips in line with the scope. */
function syncScopeControls() {
  const s = state.scope;
  const search = $('#m-search');
  if (document.activeElement !== search) search.value = s.q;
  for (const button of $$('#m-kind button')) {
    button.setAttribute('aria-pressed', String(button.dataset.kind === s.kind));
  }
  const make = $('#m-make');
  if (make.value !== s.make) {
    if (s.make && ![...make.options].some((option) => option.value === s.make)) {
      make.append(el('option', { value: s.make, text: s.make }));
    }
    make.value = s.make;
  }
  $('#m-located').value = s.located;

  const chips = scopeChips();
  for (const host of [$('#chips-meters'), $('#chips-map')]) {
    host.replaceChildren(...chips.map((chip) => el('button', {
      type: 'button',
      class: 'chip',
      'aria-label': `Remove filter: ${chip.label}`,
      onclick: () => setScope(chip.clear)
    }, el('span', { text: chip.label }), el('span', { class: 'chip-x', 'aria-hidden': 'true', text: '×' }))),
    ...(chips.length > 1 || state.answer ? [el('button', { type: 'button', class: 'link-btn', text: 'Clear all', onclick: clearScope })] : []));
  }
  $('#scope-meters').hidden = !chips.length && !state.answer;
  setText('#scope-answer', state.answer);
}

function clearScope() {
  $('#omni-input').value = '';
  setScope({}, { replace: true });
}

/* ------------------------------------------------------------------ */
/* Meters: one page at a time                                          */
/* ------------------------------------------------------------------ */

async function loadMeters({ quiet = false } = {}) {
  state.metersAbort?.abort();
  const controller = new AbortController();
  state.metersAbort = controller;
  const token = ++state.metersToken;
  state.loadingMeters = true;
  if (!quiet) $('.table-card').classList.add('is-stale');
  if (!quiet && !state.rows.length) renderRowsSkeleton();

  const params = scopeParams({
    compact: 1,
    limit: PAGE_SIZE,
    page: state.page + 1,
    sort: state.sort.key,
    dir: state.sort.dir
  });
  try {
    const result = await requestJson(`/api/v1/index/meters?${params}`, { signal: controller.signal });
    if (token !== state.metersToken) return;
    state.rows = result.data;
    state.total = result.pagination.total;
    state.facets = result.meta.facets;
    state.metersMeta = result.meta;
    state.metersLoadedAt = Date.now();
    renderMeters();
  } catch (error) {
    if (error.aborted || token !== state.metersToken) return;
    state.rows = [];
    $('#m-rows').replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'table-empty', text: `Could not load meters (${error.message}).` })));
  } finally {
    if (token === state.metersToken) {
      state.loadingMeters = false;
      $('.table-card').classList.remove('is-stale');
    }
  }
}

function renderRowsSkeleton() {
  const rows = Array.from({ length: 8 }, () => el('tr', {},
    ...Array.from({ length: 6 }, (_, index) => el('td', {}, el('span', { class: 'sk', style: `width:${index === 0 ? 90 : 60 + (index * 7) % 30}px` })))));
  $('#m-rows').replaceChildren(...rows);
}

function locCell(row) {
  return el('span', { class: `loc loc-${row.loc}`, text: LOC_LABEL[row.loc] ?? row.loc });
}

function renderMeters() {
  const { facets, total, rows } = state;
  const meta = state.metersMeta;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  state.page = Math.min(Math.max(state.page, 0), pages - 1);

  if (facets) {
    setText('#seg-all', formatNumber(facets.total));
    for (const kind of ['installed', 'decommissioned', 'other']) setText(`#seg-${kind}`, formatNumber(facets[kind]));
  }
  setText('#meters-sub', total
    ? `${formatNumber(total)} ${total === 1 ? 'meter' : 'meters'}${scopeActive() ? ' match your filters' : ' in total'}`
    : 'No meters match');
  setText('#m-page-label', total
    ? `${formatNumber(state.page * PAGE_SIZE + 1)}–${formatNumber(state.page * PAGE_SIZE + rows.length)} of ${formatNumber(total)}`
    : '—');
  $('#m-prev').disabled = state.page <= 0;
  $('#m-next').disabled = state.page >= pages - 1;
  $('#m-map').disabled = !total;

  if (!rows.length) {
    let message = 'No meters match these filters.';
    if (!meta.listComplete) message = 'The meter list is still loading. Meters appear here as they arrive.';
    else if (meta.hints?.length) message = meta.hints.join(' ');
    $('#m-rows').replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'table-empty', text: message })));
  } else {
    $('#m-rows').replaceChildren(...rows.map(meterRow));
  }

  const notes = [];
  if (meta.hints?.length && rows.length) notes.push(meta.hints.join(' '));
  if (!meta.listComplete) notes.push('Still loading the meter list, so results will grow.');
  else if (meta.pending > 0 && ['yes', 'no', 'unknown'].includes(state.scope.located)) {
    notes.push(`${formatNumber(meta.pending)} meters haven’t been checked for coordinates yet, so this may change.`);
  } else if (meta.pending > 0 && state.scope.node) {
    notes.push(`${formatNumber(meta.pending)} meters are still being placed in the network.`);
  }
  setText('#m-note', notes.join(' '));

  // A question asked in the search box is answered above the list.
  if (state.wantsCount) {
    state.answer = `${formatNumber(total)} ${total === 1 ? 'meter matches' : 'meters match'}.`;
  }
  syncScopeControls();
  markSelectedRow();
}

function meterRow(row) {
  const tr = el('tr', { tabindex: 0, dataset: { meterId: row.id }, 'aria-label': `Open meter ${row.id}` },
    el('td', {}, el('span', { class: 'cell-id' },
      el('strong', { text: row.id }),
      row.serial ? el('span', { class: 'cell-sub', text: row.serial }) : null,
      row.distanceKm !== undefined ? el('span', { class: 'cell-sub', text: `${formatDistance(row.distanceKm)} away` }) : null)),
    el('td', { text: row.make || '—' }),
    el('td', {}, el('span', { class: 'status-cell' }, el('i', { class: `dot k-${row.kind}` }), row.status || '—')),
    el('td', { text: row.transformer || '—' }),
    el('td', {}, locCell(row)),
    el('td', { class: 'col-go' }, el('span', { class: 'row-go' }, icon('chevron', 16))));
  if (row.id === state.meterId) tr.classList.add('is-selected');
  return tr;
}

function markSelectedRow() {
  for (const row of $('#m-rows').children) {
    row.classList.toggle('is-selected', Boolean(state.meterId) && row.dataset.meterId === state.meterId);
  }
}

function initMeters() {
  $('#m-search').addEventListener('input', debounce(() => {
    setScope({ q: $('#m-search').value.trim() });
  }, 220));
  for (const button of $$('#m-kind button')) {
    button.addEventListener('click', () => setScope({ kind: button.dataset.kind, status: '', statusNot: '' }));
  }
  $('#m-make').addEventListener('change', () => setScope({ make: $('#m-make').value }));
  $('#m-located').addEventListener('change', () => setScope({ located: $('#m-located').value }));
  $('#m-map').addEventListener('click', () => showView('map'));
  $('#m-rows').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-meter-id]');
    if (row) openMeter(row.dataset.meterId, { source: 'table' });
  });
  $('#m-rows').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-meter-id]');
    if (row) {
      event.preventDefault();
      openMeter(row.dataset.meterId, { source: 'table' });
    }
  });
  for (const button of $$('.sort')) {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' };
      state.page = 0;
      for (const header of $$('.data-table th')) header.removeAttribute('aria-sort');
      button.closest('th').setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      loadMeters();
    });
  }
  $('#m-prev').addEventListener('click', () => {
    state.page = Math.max(state.page - 1, 0);
    loadMeters();
    $('#view-meters .table-card').scrollIntoView({ block: 'nearest' });
  });
  $('#m-next').addEventListener('click', () => {
    state.page += 1;
    loadMeters();
    $('#view-meters .table-card').scrollIntoView({ block: 'nearest' });
  });
}

/* ------------------------------------------------------------------ */
/* The search box: find a meter, a transformer or an area, or ask      */
/* ------------------------------------------------------------------ */

const omni = { items: [], index: -1, open: false, abort: null, token: 0, results: null };

function askContext() {
  const overview = state.overview;
  return {
    vocab: { statuses: overview?.filters.statuses ?? [], makes: overview?.filters.makes ?? [], transformers: [] },
    selectedId: state.meterId,
    kindOf: statusKind
  };
}

/** What the box understood from a sentence, as scope fields (or null when it is just a name or id). */
function parseAsk(text) {
  if (!window.AtlasAsk || !text.trim()) return null;
  const result = window.AtlasAsk.parse(text, askContext());
  if (result.reset) return { reset: true, result };
  const keys = Object.keys(result.found).filter((key) => key !== 'q');
  return keys.length ? { result } : null;
}

function describeFound(found) {
  const parts = [];
  if (found.status) parts.push(found.status);
  if (found.statusNot) parts.push(`not ${found.statusNot}`);
  if (found.make) parts.push(found.make);
  if (found.transformer) parts.push(`transformer ${found.transformer}`);
  if (found.located) parts.push(found.located === 'yes' ? 'with coordinates' : 'without coordinates');
  if (found.near) parts.push(`within ${formatDistance(found.near.km)} of ${found.near.label}`);
  if (found.q) parts.push(`matching “${found.q}”`);
  return parts.join(' · ');
}

function applyAsk(parsed) {
  const { result } = parsed;
  if (parsed.reset) {
    state.wantsCount = false;
    setScope({}, { replace: true, view: 'meters' });
    state.answer = 'Showing every meter.';
    syncScopeControls();
    return;
  }
  const { found } = result;
  const base = result.refine ? state.scope : emptyScope();
  const next = { ...base };
  for (const key of ['status', 'statusNot', 'make', 'transformer', 'located', 'near']) {
    if (found[key] !== undefined) next[key] = found[key];
  }
  if (found.q) next.q = base.q && result.refine ? `${base.q} ${found.q}` : found.q;
  if (found.status) { next.statusNot = ''; next.kind = ''; }
  if (found.statusNot) next.status = '';
  state.wantsCount = result.wantsCount;
  state.answer = result.hints.join(' ');
  setScope(next, { view: 'meters', replace: true, keepAnswer: true });
  state.wantsCount = result.wantsCount;
}

function suggestions() {
  const overview = state.overview;
  const list = [];
  if (!overview) return list;
  const installed = overview.filters.statuses.find((status) => statusKind(status) === 'installed');
  const decommissioned = overview.filters.statuses.find((status) => statusKind(status) === 'decommissioned');
  if (decommissioned) list.push('How many meters are decommissioned?');
  if (installed && overview.filters.makes.length) list.push(`${installed} ${overview.filters.makes[0]} meters`);
  list.push('Meters without coordinates');
  const anchor = state.meterId ?? state.rows.find((row) => row.loc === 'mapped')?.id;
  if (anchor) list.push(`Meters within 2 km of ${anchor}`);
  return list.slice(0, 4);
}

function omniGroup(title) {
  return el('div', { class: 'omni-group', role: 'presentation', text: title });
}

function omniItem({ id, ico, title, sub, meta, onSelect }) {
  const item = el('button', { type: 'button', class: 'omni-item', role: 'option', id, 'aria-selected': 'false' },
    el('span', { class: 'omni-ico' }, ico),
    el('span', { class: 'omni-main' }, el('strong', { text: title }), sub ? el('small', { text: sub }) : null),
    meta ? el('span', { class: 'omni-meta' }, meta) : null);
  item.addEventListener('mousedown', (event) => event.preventDefault());
  item.addEventListener('click', onSelect);
  return item;
}

function renderOmni() {
  const list = $('#omni-list');
  const text = $('#omni-input').value.trim();
  omni.items = [];
  const nodes = [];
  const add = (node, activate) => {
    if (activate) {
      node.dataset.omniIndex = String(omni.items.length);
      omni.items.push({ node, activate });
    }
    nodes.push(node);
  };

  if (!text) {
    const recent = recentMeters();
    if (recent.length) {
      nodes.push(omniGroup('Recent meters'));
      recent.slice(0, 4).forEach((entry, index) => {
        const open = () => { closeOmni(); openMeter(entry.id, { source: 'search' }); };
        add(omniItem({
          id: `omni-r${index}`,
          ico: icon('clock', 17),
          title: entry.id,
          sub: [entry.make, entry.status].filter(Boolean).join(' · '),
          onSelect: open
        }), open);
      });
    }
    const tips = suggestions();
    if (tips.length) {
      nodes.push(omniGroup('Try asking'));
      tips.forEach((tip, index) => {
        const run = () => {
          $('#omni-input').value = tip;
          const parsed = parseAsk(tip);
          closeOmni();
          if (parsed) applyAsk(parsed);
        };
        add(omniItem({ id: `omni-t${index}`, ico: icon('spark', 17), title: tip, onSelect: run }), run);
      });
    }
  } else {
    const parsed = parseAsk(text);
    if (parsed) {
      const run = () => { closeOmni(); applyAsk(parsed); };
      nodes.push(omniGroup('Ask'));
      add(omniItem({
        id: 'omni-ask',
        ico: icon('spark', 17),
        title: parsed.reset ? 'Show every meter' : 'Filter the meters',
        sub: parsed.reset ? '' : describeFound(parsed.result.found),
        meta: [document.createTextNode('Enter')],
        onSelect: run
      }), run);
    }

    const data = omni.results;
    if (data && omni.resultsFor === text) {
      if (data.meters.length) {
        nodes.push(omniGroup(`Meters${data.meterTotal > data.meters.length ? ` · ${formatNumber(data.meterTotal)} found` : ''}`));
        data.meters.forEach((meter, index) => {
          const open = () => { closeOmni(); openMeter(meter.id, { source: 'search' }); };
          add(omniItem({
            id: `omni-m${index}`,
            ico: icon('meters', 17),
            title: meter.id,
            sub: [meter.make, meter.transformer, meter.serial].filter(Boolean).join(' · '),
            meta: [el('i', { class: `dot k-${meter.kind}` }), document.createTextNode(meter.status || '')],
            onSelect: open
          }), open);
        });
      }
      if (data.transformers.length) {
        nodes.push(omniGroup('Transformers'));
        data.transformers.forEach((entry, index) => {
          const open = () => {
            closeOmni();
            if (entry.pathId) openNetworkNode(entry.pathId);
            else setScope({ transformer: entry.code }, { view: 'meters' });
          };
          add(omniItem({
            id: `omni-d${index}`,
            ico: 'T',
            title: entry.code,
            sub: entry.title !== entry.code ? entry.title : '',
            meta: [document.createTextNode(`${formatNumber(entry.count)} meters`)],
            onSelect: open
          }), open);
        });
      }
      if (data.nodes.length) {
        nodes.push(omniGroup('Areas'));
        data.nodes.forEach((node, index) => {
          const open = () => { closeOmni(); openNetworkNode(node.pathId); };
          add(omniItem({
            id: `omni-n${index}`,
            ico: (LEVELS[node.level] ?? LEVELS.unknown).icon,
            title: node.title,
            sub: [(LEVELS[node.level] ?? LEVELS.unknown).label, node.code].filter(Boolean).join(' · '),
            meta: [document.createTextNode(`${formatNumber(node.meterCount)} meters`)],
            onSelect: open
          }), open);
        });
      }
      if (data.meterTotal > 0) {
        const all = () => { closeOmni(); setScope({ q: text }, { replace: true, view: 'meters' }); };
        nodes.push(omniGroup('Everything'));
        add(omniItem({
          id: 'omni-all',
          ico: icon('arrow', 17),
          title: `See all ${formatNumber(data.meterTotal)} ${data.meterTotal === 1 ? 'match' : 'matches'} in Meters`,
          onSelect: all
        }), all);
      }
      if (!data.meters.length && !data.transformers.length && !data.nodes.length && !parsed) {
        nodes.push(el('p', { class: 'omni-empty', text: `Nothing found for “${text}”. Try a meter id, serial number, transformer code or area name.` }));
      }
    } else if (!parsed) {
      nodes.push(el('p', { class: 'omni-empty', text: 'Searching…' }));
    }
  }

  nodes.push(el('div', { class: 'omni-foot', 'aria-hidden': 'true' },
    el('span', {}, el('kbd', { text: '↑↓' }), 'move'),
    el('span', {}, el('kbd', { text: 'Enter' }), 'open'),
    el('span', {}, el('kbd', { text: 'Esc' }), 'close')));
  list.replaceChildren(...nodes);
  omni.index = omni.items.length ? Math.min(Math.max(omni.index, 0), omni.items.length - 1) : -1;
  paintOmniActive();
}

function paintOmniActive() {
  omni.items.forEach((entry, index) => {
    const active = index === omni.index;
    entry.node.classList.toggle('is-active', active);
    entry.node.setAttribute('aria-selected', String(active));
    if (active) {
      $('#omni-input').setAttribute('aria-activedescendant', entry.node.id);
      entry.node.scrollIntoView({ block: 'nearest' });
    }
  });
  if (omni.index < 0) $('#omni-input').removeAttribute('aria-activedescendant');
}

function openOmni() {
  omni.open = true;
  $('#omni-list').hidden = false;
  $('#omni-input').setAttribute('aria-expanded', 'true');
  renderOmni();
}

function closeOmni() {
  omni.open = false;
  omni.abort?.abort();
  $('#omni-list').hidden = true;
  $('#omni-input').setAttribute('aria-expanded', 'false');
  $('#omni-input').removeAttribute('aria-activedescendant');
  $('#omni-input').blur();
}

const searchServer = debounce(async () => {
  const text = $('#omni-input').value.trim();
  if (!text) return;
  omni.abort?.abort();
  const controller = new AbortController();
  omni.abort = controller;
  const token = ++omni.token;
  try {
    const result = await requestJson(`/api/v1/search?q=${encodeURIComponent(text)}&limit=6`, { signal: controller.signal });
    if (token !== omni.token || !omni.open) return;
    omni.results = result.data;
    omni.resultsFor = text;
    omni.index = -1;
    renderOmni();
    omni.index = omni.items.length ? 0 : -1;
    paintOmniActive();
  } catch (error) {
    if (error.aborted || token !== omni.token) return;
    omni.results = { meters: [], meterTotal: 0, transformers: [], nodes: [] };
    omni.resultsFor = text;
    renderOmni();
  }
}, 140);

function initOmni() {
  const input = $('#omni-input');
  input.addEventListener('focus', () => { if (!omni.open) { omni.index = -1; openOmni(); } });
  input.addEventListener('input', () => {
    if (!omni.open) openOmni();
    omni.index = -1;
    renderOmni();
    omni.index = omni.items.length ? 0 : -1;
    paintOmniActive();
    searchServer();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!omni.open) openOmni();
      if (!omni.items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      omni.index = (omni.index + step + omni.items.length) % omni.items.length;
      paintOmniActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = omni.items[omni.index];
      if (entry) entry.activate();
      else if (input.value.trim()) setScope({ q: input.value.trim() }, { replace: true, view: 'meters' });
    } else if (event.key === 'Escape') {
      if (omni.open) {
        event.stopPropagation();
        closeOmni();
      }
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (omni.open && !event.target.closest('#omni')) closeOmni();
  });
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag);
    if ((event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Network: branches that open to the right, one level at a time       */
/* ------------------------------------------------------------------ */

const net = { cols: [], focus: null, token: 0, loaded: false };
const enc = encodeURIComponent;

function columnLevelLabel(items) {
  const first = items[0];
  if (!first) return 'Empty';
  if (first.type === 'meter') return 'Meters';
  return (LEVELS[first.level] ?? LEVELS.unknown).plural;
}

function colFrom(parent, data, selected = null) {
  return {
    parent,
    total: data.total,
    offset: data.offset ?? 0,
    items: data.items,
    selected,
    filter: '',
    level: columnLevelLabel(data.items)
  };
}

function networkUrl({ node = '', offset = 0, q = '' } = {}) {
  const params = new URLSearchParams({ limit: String(NET_PAGE) });
  if (node) params.set('node', node);
  if (offset) params.set('offset', String(offset));
  if (q) params.set('q', q);
  return `/api/v1/network?${params}`;
}

async function ensureNetwork() {
  if (net.loaded) {
    requestAnimationFrame(drawLinks);
    renderBanner();
    return;
  }
  net.loaded = true;
  await loadRoot();
}

async function loadRoot() {
  const token = ++net.token;
  try {
    const result = await requestJson(networkUrl());
    if (token !== net.token) return;
    net.cols = [colFrom('', result.data)];
    net.focus = result.data.parent;
    renderNetwork();
    await autoDescend();
  } catch (error) {
    net.loaded = false;
    $('#branch').replaceChildren(el('p', { class: 'col-empty', text: `The network could not be loaded (${error.message}).` }));
  }
}

/** A level with only one branch is opened for you, all the way down to the first real choice. */
async function autoDescend() {
  for (let guard = 0; guard < 8; guard += 1) {
    const col = net.cols.at(-1);
    if (!col || col.total !== 1 || col.items.length !== 1 || col.items[0].type !== 'group') return;
    await selectItem(net.cols.length - 1, col.items[0]);
  }
}

async function selectItem(ci, item) {
  const col = net.cols[ci];
  if (!col) return;
  if (item.type === 'meter') {
    openMeter(item.id, { source: 'network' });
    return;
  }
  net.cols.length = ci + 1;
  col.selected = item.pathId;
  net.focus = item;
  const token = ++net.token;
  renderNetwork({ keepScroll: true });
  try {
    const result = await requestJson(networkUrl({ node: item.pathId }));
    if (token !== net.token) return;
    net.cols.push(colFrom(item.pathId, result.data));
    net.focus = result.data.parent;
    renderNetwork({ keepScroll: true, reveal: true });
  } catch (error) {
    if (token !== net.token) return;
    toast(`Could not open that branch (${error.message})`);
  }
}

function applyPath(data, options) {
  net.cols = data.columns.map((column) => colFrom(column.parent, column, column.selected));
  net.focus = data.selected;
  renderNetwork(options);
}

/** Opens the network at a node (a transformer, a feeder…) with every level above it expanded. */
async function openNetworkNode(pathId) {
  net.loaded = true;
  showView('network');
  const token = ++net.token;
  try {
    const result = await requestJson(`/api/v1/network/path?node=${enc(pathId)}&limit=${NET_PAGE}`);
    if (token !== net.token) return;
    applyPath(result.data, { reveal: true });
  } catch (error) {
    if (token !== net.token) return;
    toast(error.status === 404 ? 'That part of the network has changed. Showing the top level.' : `Could not open the network (${error.message})`);
    loadRoot();
  }
}

/** While details keep arriving, counts change: quietly refresh the open branches (unless somebody is typing in one). */
async function reloadNetwork() {
  if (!net.loaded || !net.cols.length) return;
  if (net.cols.some((col) => col.filter || col.offset > 0) || document.activeElement?.closest?.('#branch')) return;
  const deepest = net.cols.map((col) => col.selected).filter((value) => typeof value === 'string' && value.startsWith('/')).at(-1);
  const token = ++net.token;
  try {
    if (!deepest) {
      const result = await requestJson(networkUrl());
      if (token !== net.token) return;
      net.cols = [colFrom('', result.data)];
      net.focus = result.data.parent;
      renderNetwork({ keepScroll: true });
      return;
    }
    const result = await requestJson(`/api/v1/network/path?node=${enc(deepest)}&limit=${NET_PAGE}`);
    if (token !== net.token) return;
    applyPath(result.data, { keepScroll: true });
  } catch (error) {
    if (token === net.token && error.status === 404) {
      net.loaded = false;
      ensureNetwork();
    }
  }
}

async function fetchColumnPage(ci, { offset, q }) {
  const col = net.cols[ci];
  const result = await requestJson(networkUrl({ node: col.parent, offset, q }));
  return result.data;
}

async function filterColumn(ci, text) {
  const col = net.cols[ci];
  if (!col) return;
  col.filter = text.trim();
  try {
    const data = await fetchColumnPage(ci, { offset: 0, q: col.filter });
    if (net.cols[ci] !== col || col.filter !== text.trim()) return;
    col.items = data.items;
    col.total = data.total;
    col.offset = 0;
    refillColumn(ci);
  } catch (error) {
    toast(`Could not filter (${error.message})`);
  }
}

async function loadMoreColumn(ci, direction) {
  const col = net.cols[ci];
  if (!col) return;
  const offset = direction === 'before' ? Math.max(col.offset - NET_PAGE, 0) : col.offset + col.items.length;
  try {
    const data = await fetchColumnPage(ci, { offset, q: col.filter });
    if (direction === 'before') {
      col.items = [...data.items.slice(0, col.offset - offset), ...col.items];
      col.offset = offset;
    } else {
      col.items = [...col.items, ...data.items];
    }
    col.total = data.total;
    refillColumn(ci);
  } catch (error) {
    toast(`Could not load more (${error.message})`);
  }
}

function healthBar(item) {
  const stats = item.stats ?? {};
  const total = item.meterCount || 0;
  const bar = el('span', { class: 'node-bar', 'aria-hidden': 'true' });
  for (const kind of ['installed', 'decommissioned', 'other']) {
    const count = stats[kind] ?? 0;
    if (count && total) bar.append(el('i', { class: `k-${kind}`, style: `width:${count / total * 100}%` }));
  }
  return bar;
}

function nodeButton(item, ci, index, col) {
  if (item.type === 'meter') {
    const detail = [item.make, item.status].filter(Boolean).join(' · ') || 'Reading details…';
    const note = item.loc === 'none' ? 'No GPS' : item.loc === 'pending' ? '…' : '';
    const button = el('button', { type: 'button', class: 'node is-meter', dataset: { col: ci, index, meterId: item.id }, 'aria-label': `Open meter ${item.id}` },
      el('i', { class: `dot k-${item.kind}` }),
      el('span', { class: 'node-title', text: item.id }),
      el('span', { class: 'node-n', text: note }),
      el('span', { class: 'node-sub', text: detail }));
    if (item.id === state.meterId) button.classList.add('is-selected');
    return button;
  }
  const level = LEVELS[item.level] ?? LEVELS.unknown;
  const button = el('button', { type: 'button', class: 'node', dataset: { col: ci, index }, 'aria-label': `${level.label} ${item.title}, ${formatNumber(item.meterCount)} meters` },
    el('span', { class: 'node-ico', text: level.icon }),
    el('span', { class: 'node-title', text: item.title }),
    el('span', { class: 'node-n', text: formatNumber(item.meterCount) }),
    el('span', { class: 'node-sub', text: [level.label, item.code].filter(Boolean).join(' · ') }),
    healthBar(item));
  if (item.pathId === col.selected) {
    button.classList.add('is-selected');
    button.setAttribute('aria-current', 'true');
  }
  return button;
}

function fillColumnList(list, col, ci) {
  const nodes = [];
  if (col.offset > 0 && !col.filter) {
    nodes.push(el('button', { type: 'button', class: 'more-btn', dataset: { more: 'before', col: ci }, text: 'Show earlier' }));
  }
  col.items.forEach((item, index) => nodes.push(nodeButton(item, ci, index, col)));
  if (!col.items.length) {
    nodes.push(el('p', { class: 'col-empty', text: col.filter ? 'Nothing matches that filter.' : 'Nothing here yet.' }));
  }
  const remaining = col.total - (col.offset + col.items.length);
  if (remaining > 0) {
    nodes.push(el('button', { type: 'button', class: 'more-btn', dataset: { more: 'after', col: ci },
      text: `Show ${formatNumber(Math.min(remaining, NET_PAGE))} more of ${formatNumber(remaining)}` }));
  }
  list.replaceChildren(...nodes);
}

function refillColumn(ci) {
  const colEl = $(`#branch .col[data-col="${ci}"]`);
  if (!colEl) return;
  const col = net.cols[ci];
  fillColumnList($('.col-list', colEl), col, ci);
  setText(`#branch .col[data-col="${ci}"] .col-title b`, formatNumber(col.total));
  requestAnimationFrame(drawLinks);
}

function renderColumn(col, ci) {
  const filter = col.total > 14 || col.filter
    ? el('input', {
      class: 'col-filter',
      type: 'search',
      placeholder: `Filter ${col.level.toLowerCase()}…`,
      'aria-label': `Filter ${col.level}`,
      value: col.filter,
      oninput: debounce((event) => filterColumn(ci, event.target.value), 220)
    })
    : null;
  const list = el('div', { class: 'col-list', role: 'group', 'aria-label': col.level });
  fillColumnList(list, col, ci);
  return el('div', { class: 'col', dataset: { col: ci } },
    el('div', { class: 'col-head' }, el('div', { class: 'col-title' }, el('span', { text: col.level }), el('b', { text: formatNumber(col.total) })), filter),
    list);
}

function renderNetwork({ keepScroll = false, reveal = false } = {}) {
  const host = $('#branch');
  const scrolls = keepScroll ? $$('.col-list', host).map((list) => list.scrollTop) : [];
  host.replaceChildren(...net.cols.flatMap((col, ci) => [
    renderColumn(col, ci),
    ci < net.cols.length - 1 ? el('div', { class: 'gutter', dataset: { gutter: ci }, 'aria-hidden': 'true' }) : null
  ]).filter(Boolean));
  $$('.col-list', host).forEach((list, index) => { if (scrolls[index]) list.scrollTop = scrolls[index]; });
  renderFocus();
  renderCrumbs();
  renderBanner();
  if (reveal) {
    const scroller = $('#branch-scroll');
    requestAnimationFrame(() => scroller.scrollTo({ left: scroller.scrollWidth, behavior: reducedMotion() ? 'auto' : 'smooth' }));
  }
  requestAnimationFrame(drawLinks);
}

/** The soft band that joins a selected branch to the column of its children: what makes the columns read as a tree. */
function drawLinks() {
  const host = $('#branch');
  if (!host) return;
  for (const gutter of $$('.gutter', host)) {
    const ci = Number(gutter.dataset.gutter);
    const colEl = $(`.col[data-col="${ci}"]`, host);
    const nextEl = $(`.col[data-col="${ci + 1}"]`, host);
    gutter.replaceChildren();
    const selected = colEl && $('.node.is-selected', colEl);
    if (!selected || !nextEl) continue;
    const box = gutter.getBoundingClientRect();
    const width = box.width;
    const own = $('.col-list', colEl).getBoundingClientRect();
    const target = $('.col-list', nextEl);
    const next = target.getBoundingClientRect();
    const rect = selected.getBoundingClientRect();
    const clamp = (y) => Math.min(Math.max(y, own.top - box.top + 2), own.bottom - box.top - 2);
    const y1 = clamp(rect.top - box.top);
    const y2 = Math.max(clamp(rect.bottom - box.top), y1 + 2);
    const kids = [...target.children].filter((child) => child.matches('.node, .more-btn'));
    const firstKid = kids[0]?.getBoundingClientRect();
    const lastKid = kids.at(-1)?.getBoundingClientRect();
    const t1 = Math.max(firstKid ? firstKid.top : next.top, next.top) - box.top;
    const t2 = Math.max(Math.min(lastKid ? lastKid.bottom : next.bottom, next.bottom) - box.top, t1 + 2);
    const mid = width / 2;
    const top = `M0,${y1} C${mid},${y1} ${mid},${t1} ${width},${t1}`;
    const bottom = `M0,${y2} C${mid},${y2} ${mid},${t2} ${width},${t2}`;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${box.height}`, preserveAspectRatio: 'none' });
    svg.append(
      svgEl('path', { class: 'link-fill', d: `M0,${y1} C${mid},${y1} ${mid},${t1} ${width},${t1} L${width},${t2} C${mid},${t2} ${mid},${y2} 0,${y2} Z` }),
      svgEl('path', { class: 'link-edge', d: top }),
      svgEl('path', { class: 'link-edge', d: bottom })
    );
    gutter.append(svg);
  }
}

function renderBanner() {
  const banner = $('#net-banner');
  const overview = state.overview;
  if (!overview || !state.meta?.listComplete || overview.summary.pending === 0) {
    banner.hidden = true;
    return;
  }
  const { total, pending } = overview.summary;
  banner.hidden = false;
  banner.textContent = `Mapping the network · ${formatNumber(total - pending)} of ${formatNumber(total)} meters placed. Branches and counts fill in as details arrive; you can already explore.`;
}

function renderCrumbs() {
  const host = $('#net-crumbs');
  const steps = [];
  net.cols.forEach((col, ci) => {
    const item = col.items.find((entry) => entry.type === 'group' && entry.pathId === col.selected);
    if (item) steps.push({ ci, item });
  });
  const nodes = [el('button', { type: 'button', class: 'crumb', text: 'Whole network', 'aria-current': steps.length ? null : 'true', onclick: () => loadRoot() })];
  steps.forEach(({ ci, item }, index) => {
    nodes.push(icon('chevron', 14).cloneNode(true));
    nodes[nodes.length - 1].setAttribute('class', 'crumb-sep');
    nodes.push(el('button', {
      type: 'button',
      class: 'crumb',
      text: item.title,
      title: `${(LEVELS[item.level] ?? LEVELS.unknown).label}${item.code ? ` · ${item.code}` : ''}`,
      'aria-current': index === steps.length - 1 ? 'true' : null,
      onclick: () => selectItem(ci, item)
    }));
  });
  host.replaceChildren(...nodes);
}

function statRow(kind, count, total) {
  return el('div', { class: 'focus-stat' }, el('i', { class: `dot k-${kind}` }), el('span', { text: KIND_LABEL[kind] }),
    el('span', {}, el('b', { text: formatNumber(count) }), ' ', el('small', { text: percent(count, total) })));
}

function renderFocus() {
  const host = $('#focus');
  const focus = net.focus;
  if (!focus) {
    host.replaceChildren(el('p', { class: 'focus-note', text: 'Loading the network…' }));
    return;
  }
  const isRoot = focus.type === 'root';
  const level = LEVELS[focus.level] ?? LEVELS.unknown;
  const stats = focus.stats ?? { installed: 0, decommissioned: 0, other: 0, located: 0, pending: 0 };
  const total = focus.meterCount ?? 0;

  const bar = el('div', { class: 'split-bar', role: 'img', 'aria-label': 'Meters by status' },
    ...['installed', 'decommissioned', 'other'].map((kind) => el('i', { class: `k-${kind}`, style: `flex-basis:${total ? stats[kind] / total * 100 : 0}%` })));

  const scope = isRoot ? null : { pathId: focus.pathId, label: focus.title };
  const nodes = [
    el('div', {},
      el('p', { class: 'focus-level', text: isRoot ? 'Everything' : level.label }),
      el('h2', { class: 'focus-title', text: focus.title }),
      focus.code ? el('p', { class: 'focus-code', text: focus.code }) : null),
    el('div', {},
      el('div', { class: 'focus-number', text: formatNumber(total) }),
      el('p', { class: 'focus-number-label', text: total === 1 ? 'meter' : 'meters' })),
    bar,
    el('div', { class: 'focus-stats' },
      statRow('installed', stats.installed, total),
      statRow('decommissioned', stats.decommissioned, total),
      statRow('other', stats.other, total),
      el('div', { class: 'focus-stat' }, icon('map', 12), el('span', { text: 'On the map' }),
        el('span', {}, el('b', { text: formatNumber(stats.located) }), ' ', el('small', { text: percent(stats.located, total) })))),
    stats.pending > 0
      ? el('p', { class: 'focus-note', text: `${formatNumber(stats.pending)} of these are still being read, so the counts can change.` })
      : null,
    el('div', { class: 'focus-actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => setScope({ node: scope }, { replace: true, view: 'meters' }) },
        icon('meters', 16), `View ${formatNumber(total)} ${total === 1 ? 'meter' : 'meters'}`),
      el('button', { type: 'button', class: 'btn btn-quiet', disabled: !stats.located, onclick: () => setScope({ node: scope }, { replace: true, view: 'map' }) },
        icon('map', 16), 'Show on map'))
  ];

  const quality = state.overview?.quality;
  if (isRoot && quality?.count > 0 && state.overview.summary.pending === 0) {
    nodes.push(el('details', {},
      el('summary', { text: `${formatNumber(quality.count)} data notes` }),
      el('ul', {}, ...quality.groups.map((group) => el('li', {},
        el('strong', { text: `${formatNumber(group.count)} × ${group.issue}` }),
        group.reasons.length ? el('small', { text: group.reasons.join('; ') }) : null,
        group.meters.length ? el('small', { text: `e.g. ${group.meters.join(', ')}` }) : null)))));
  }
  host.replaceChildren(...nodes.filter(Boolean));
}

function paintNetworkSelection() {
  for (const button of $$('#branch .node.is-meter')) {
    button.classList.toggle('is-selected', Boolean(state.meterId) && button.dataset.meterId === state.meterId);
  }
}

function initNetwork() {
  $('#branch').addEventListener('click', (event) => {
    const more = event.target.closest('[data-more]');
    if (more) {
      loadMoreColumn(Number(more.dataset.col), more.dataset.more);
      return;
    }
    const node = event.target.closest('.node');
    if (!node) return;
    const ci = Number(node.dataset.col);
    const item = net.cols[ci]?.items[Number(node.dataset.index)];
    if (item) selectItem(ci, item);
  });
  let queued = false;
  $('#branch').addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; drawLinks(); });
  }, true);
}

/* ------------------------------------------------------------------ */
/* Map: only what is in view                                           */
/* ------------------------------------------------------------------ */

const mapState = { map: null, layer: null, tiles: null, halo: null, haloAt: null, abort: null, loadToken: 0, fitToken: 0, fitting: false, sig: null, focus: null };

function initMap() {
  mapState.map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(DEFAULT_CENTER, 11);
  mapState.map.attributionControl.setPrefix(false);
  L.control.zoom({ position: 'bottomright' }).addTo(mapState.map);
  mapState.tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(mapState.map);
  mapState.layer = L.layerGroup().addTo(mapState.map);
  const soon = debounce(() => loadMap(), 250);
  mapState.map.on('moveend', () => { if (!mapState.fitting) soon(); });
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => mapState.map?.invalidateSize()).observe($('#map'));
  }
}

function mapSignature() {
  return scopeParams().toString();
}

function ensureMap() {
  if (!window.L) {
    setText('#map-count', 'The map could not load');
    return;
  }
  if (!mapState.map) initMap();
  requestAnimationFrame(() => {
    mapState.map.invalidateSize();
    if (mapState.focus) {
      const { lat, lon } = mapState.focus;
      mapState.focus = null;
      mapState.sig = mapSignature();
      mapState.fitting = true;
      mapState.map.setView([lat, lon], 16, { animate: false });
      mapState.fitting = false;
      loadMap();
    } else if (mapState.sig !== mapSignature()) {
      fitMapToScope();
    } else {
      loadMap({ quiet: true });
    }
  });
}

/** Zooms to wherever the current filters' meters are. Asks for the bounds only (limit 1), not the meters. */
async function fitMapToScope() {
  const signature = mapSignature();
  mapState.sig = signature;
  const token = ++mapState.fitToken;
  try {
    const result = await requestJson(`/api/v1/map?${scopeParams({ limit: 1 })}`);
    if (token !== mapState.fitToken) return;
    const bounds = result.data.bounds;
    if (bounds) {
      mapState.fitting = true;
      mapState.map.fitBounds([[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]], { padding: [70, 70], maxZoom: 15, animate: false });
      mapState.fitting = false;
    }
  } catch (error) {
    if (token !== mapState.fitToken) return;
  }
  loadMap();
}

function markerStyle(kind, selected) {
  const color = cssVar(`--c-${kind}`) || '#9a92bd';
  return selected
    ? { radius: 8, weight: 3, color: isLightTheme() ? '#19142b' : '#ffffff', fillColor: color, fillOpacity: 1 }
    : { radius: 5.5, weight: 1.5, color: isLightTheme() ? '#ffffff' : '#0a0910', fillColor: color, fillOpacity: 0.95 };
}

function tooltipContent(point) {
  return el('div', {}, el('span', { class: 'tip-id', text: point.id }),
    el('span', { class: 'tip-line', text: `${point.make || 'Unknown make'} · ${point.status || 'Status unavailable'}` }));
}

async function loadMap({ quiet = false } = {}) {
  const map = mapState.map;
  if (!map || state.view !== 'map') return;
  mapState.abort?.abort();
  const controller = new AbortController();
  mapState.abort = controller;
  const token = ++mapState.loadToken;
  const bounds = map.getBounds().pad(0.08);
  const params = scopeParams({
    limit: MAP_LIMIT,
    minLat: bounds.getSouth(),
    maxLat: bounds.getNorth(),
    minLon: bounds.getWest(),
    maxLon: bounds.getEast()
  });
  if (!quiet) setText('#map-sub', 'Loading…');
  try {
    const result = await requestJson(`/api/v1/map?${params}`, { signal: controller.signal });
    if (token !== mapState.loadToken) return;
    drawMap(result.data, result.meta);
  } catch (error) {
    if (error.aborted || token !== mapState.loadToken) return;
    setText('#map-sub', `Could not load the map (${error.message})`);
  }
}

function drawMap(data, meta) {
  const layer = mapState.layer;
  layer.clearLayers();
  if (data.mode === 'points') {
    for (const point of data.points) {
      L.circleMarker([point.lat, point.lon], markerStyle(point.kind, point.id === state.meterId))
        .bindTooltip(() => tooltipContent(point), { direction: 'top', offset: [0, -6], className: 'atlas-tip' })
        .on('click', () => openMeter(point.id, { source: 'map' }))
        .addTo(layer);
    }
  } else {
    for (const cluster of data.clusters) {
      const size = Math.round(34 + Math.min(Math.log10(cluster.count) * 12, 30));
      const marker = L.marker([cluster.lat, cluster.lon], {
        icon: L.divIcon({
          className: 'cluster-icon',
          html: `<div class="cluster" style="width:${size}px;height:${size}px">${Number(cluster.count)}</div>`,
          iconSize: [size, size]
        }),
        keyboard: false
      });
      marker.bindTooltip(`${formatNumber(cluster.count)} meters · click to zoom in`, { direction: 'top', className: 'atlas-tip' });
      marker.on('click', () => {
        const b = cluster.bounds;
        mapState.map.fitBounds([[b.minLat, b.minLon], [b.maxLat, b.maxLon]], { padding: [60, 60], maxZoom: 17 });
      });
      marker.addTo(layer);
    }
  }
  syncHalo();

  setText('#map-count', `${formatNumber(data.located)} ${data.located === 1 ? 'meter' : 'meters'} on the map`);
  const parts = [];
  if (!data.located) parts.push(meta.pending > 0 ? 'Meters appear here as their locations are read.' : 'None of the matching meters have coordinates.');
  else if (data.mode === 'clusters') parts.push(`${formatNumber(data.inView)} in view · zoom in to see each one`);
  else parts.push(`${formatNumber(data.inView)} in view`);
  if (data.unlocated > 0) parts.push(`${formatNumber(data.unlocated)} without a position yet`);
  setText('#map-sub', parts.join(' · '));
}

function syncHalo() {
  mapState.halo?.remove();
  mapState.halo = null;
  if (!mapState.map || !mapState.haloAt) return;
  mapState.halo = L.circleMarker([mapState.haloAt.lat, mapState.haloAt.lon], {
    radius: 16, weight: 2, color: cssVar('--accent'), fill: false, interactive: false
  }).addTo(mapState.map);
}

function initMapControls() {
  $('#map-fit').addEventListener('click', () => { if (mapState.map) fitMapToScope(); });
}

/* ------------------------------------------------------------------ */
/* Meter drawer                                                        */
/* ------------------------------------------------------------------ */

function drawerSkeleton() {
  return el('div', { class: 'd-section' },
    el('span', { class: 'sk', style: 'width:60%;height:30px;margin-bottom:18px' }),
    el('span', { class: 'sk', style: 'width:90%;margin-bottom:12px' }),
    el('span', { class: 'sk', style: 'width:75%;margin-bottom:12px' }),
    el('span', { class: 'sk', style: 'width:82%' }));
}

function openDrawerShell(id) {
  const drawer = $('#drawer');
  if (!drawer.classList.contains('is-open')) {
    state.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  setText('#drawer-title', id);
  $('#drawer-body').replaceChildren(drawerSkeleton());
  $('#drawer-body').scrollTop = 0;
}

async function openMeter(id, { source = 'code' } = {}) {
  state.meterId = id;
  const token = ++state.drawerToken;
  openDrawerShell(id);
  writeHash();
  markSelectedRow();
  paintNetworkSelection();
  if (source !== 'hash') $('#drawer-close').focus({ preventScroll: true });

  try {
    const result = await requestJson(`/api/v1/index/meters/${enc(id)}`);
    if (token !== state.drawerToken) return;
    state.drawerMeter = result.data;
    mapState.haloAt = result.data.loc === 'mapped' ? { lat: result.data.lat, lon: result.data.lon } : null;
    syncHalo();
    rememberMeter(result.data);
    renderDrawer(result.data);
    loadReadings(id, token);
  } catch (error) {
    if (token !== state.drawerToken) return;
    $('#drawer-body').replaceChildren(el('p', { class: 'panel-empty', text: error.status === 404
      ? `Meter ${id} was not found in the meter list.`
      : `Could not load this meter (${error.message}).` }));
  }
}

function closeDrawer({ fromHash = false, keepHalo = false } = {}) {
  const wasOpen = $('#drawer').classList.contains('is-open');
  state.meterId = null;
  state.drawerToken += 1;
  $('#drawer').classList.remove('is-open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  if (!keepHalo) {
    mapState.haloAt = null;
    syncHalo();
  }
  if (!fromHash) writeHash();
  markSelectedRow();
  paintNetworkSelection();
  if (wasOpen && state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus({ preventScroll: true });
  state.lastFocus = null;
}

function factItem(label, value) {
  return el('div', {}, el('dt', { text: label }), el('dd', {}, value ?? '—'));
}

function renderDrawer(meter) {
  const mapped = meter.loc === 'mapped';
  const transformerStep = meter.trail.find((step) => step.level === 'distributionTransformer');
  const body = [];

  body.push(el('div', { class: 'd-chips' },
    el('span', { class: 'd-pill' }, el('i', { class: `dot k-${meter.kind}` }), meter.status || 'Status unavailable'),
    meter.make ? el('span', { class: 'd-pill', text: meter.make }) : null,
    el('span', { class: `loc loc-${meter.loc}`, text: LOC_LABEL[meter.loc] })));

  body.push(el('div', { class: 'd-actions' },
    el('button', { type: 'button', class: 'btn', disabled: !mapped, onclick: () => showOnMap(meter) }, icon('map', 16), 'Show on map'),
    el('button', { type: 'button', class: 'btn btn-quiet', disabled: !meter.trail.length, onclick: () => {
      closeDrawer({ keepHalo: true });
      openNetworkNode(meter.trail.at(-1).pathId);
    } }, icon('network', 16), 'In network'),
    el('button', { type: 'button', class: 'btn btn-quiet', disabled: !mapped, onclick: () => {
      closeDrawer();
      setScope({ near: { meterId: meter.id, km: 2, label: meter.id } }, { replace: true, view: 'meters' });
    } }, 'Within 2 km'),
    el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => copyText(meter.id) }, icon('copy', 16), 'Copy ID')));

  if (meter.pending) {
    body.push(el('p', { class: 'd-note', text: 'The portal is slow to answer for this meter, so its location and place in the network are still being read.' }));
  } else if (meter.placement === 'inferred') {
    body.push(el('p', { class: 'd-note', text: 'The portal gave no network path for this meter. It is shown with the other meters on the same transformer.' }));
  }

  const transformerValue = meter.transformer
    ? el('button', { type: 'button', text: meter.transformer, onclick: () => {
      closeDrawer({ keepHalo: true });
      if (transformerStep) openNetworkNode(transformerStep.pathId);
      else setScope({ transformer: meter.transformer }, { replace: true, view: 'meters' });
    } })
    : null;
  body.push(el('dl', { class: 'd-facts' },
    factItem('Serial number', meter.serial),
    factItem('Make', meter.make),
    factItem('Transformer', transformerValue),
    factItem('Phase', meter.phaseType),
    factItem('Coordinates', mapped ? `${meter.lat.toFixed(5)}, ${meter.lon.toFixed(5)}` : LOC_LABEL[meter.loc])));

  body.push(el('section', { class: 'd-section' }, el('h3', { text: 'Where it sits' }),
    meter.trail.length
      ? el('div', { class: 'd-trail' }, ...meter.trail.map((step) => el('button', {
        type: 'button',
        class: 'd-step',
        onclick: () => { closeDrawer({ keepHalo: true }); openNetworkNode(step.pathId); }
      }, el('i'), el('span', {}, el('small', { text: (LEVELS[step.level] ?? LEVELS.unknown).label }),
        el('strong', { text: step.code ? `${step.title} · ${step.code}` : step.title })))))
      : el('p', { class: 'panel-empty', text: 'Its position in the network is not known.' })));

  body.push(el('section', { class: 'd-section' }, el('h3', { text: 'Consumption · cumulative kWh' }),
    el('div', { class: 'd-metrics', id: 'd-metrics', hidden: true }),
    el('div', { class: 'chart-wrap', id: 'd-chart' }, el('div', { class: 'chart-empty' }, el('span', {}, el('i', { class: 'spinner' }), 'Loading consumption…')))));

  const plate = Object.entries(meter.nameplate ?? {});
  if (plate.length) {
    body.push(el('details', { class: 'd-nameplate' }, el('summary', { text: `Nameplate · ${plate.length} fields` }),
      el('dl', {}, ...plate.map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: value ?? '—' }))))));
  }
  if (meter.issues?.length) {
    body.push(el('section', { class: 'd-section' }, el('h3', { text: 'Data notes' }),
      ...meter.issues.map((issue) => el('p', { class: 'd-note', text: `${issue.issue}${issue.detail ? `: ${issue.detail}` : ''}` }))));
  }
  $('#drawer-body').replaceChildren(...body.filter(Boolean));
}

function showOnMap(meter) {
  mapState.focus = { lat: meter.lat, lon: meter.lon };
  mapState.haloAt = { lat: meter.lat, lon: meter.lon };
  closeDrawer({ keepHalo: true });
  showView('map');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${text}`);
  } catch {
    toast('Could not copy. Select the text and copy it by hand.');
  }
}

async function loadReadings(id, token) {
  const wrap = $('#d-chart');
  if (!wrap) return;
  let readings;
  const cached = state.readings.get(id);
  if (cached && Date.now() - cached.at < READINGS_TTL_MS) {
    readings = cached.readings;
  } else {
    try {
      const result = await requestJson(`/api/v1/meters/${enc(id)}/consumption`);
      readings = result.data.readings;
      state.readings.set(id, { at: Date.now(), readings });
    } catch (error) {
      if (token === state.drawerToken) showChartMessage(error.message);
      return;
    }
  }
  if (token !== state.drawerToken) return;
  renderMetrics(readings);
  renderChart(readings);
}

function showChartMessage(message) {
  const wrap = $('#d-chart');
  if (wrap) wrap.replaceChildren(el('div', { class: 'chart-empty', text: message }));
}

function renderMetrics(readings) {
  const host = $('#d-metrics');
  if (!host) return;
  const numeric = readings.filter((reading) => Number.isFinite(reading.kwh));
  if (!numeric.length) {
    host.hidden = true;
    return;
  }
  const values = numeric.map((reading) => reading.kwh);
  const change = values.at(-1) - values[0];
  const items = [
    ['Latest', formatNumber(values.at(-1), 1), 'kWh'],
    ['Change', `${change > 0 ? '+' : ''}${formatNumber(change, 1)}`, 'kWh over the period'],
    ['Readings', formatNumber(values.length), 'data points']
  ];
  host.replaceChildren(...items.map(([label, value, note]) => el('div', { class: 'metric' },
    el('span', { text: label }), el('strong', { text: value }), el('small', { text: note }))));
  host.hidden = false;
}

function renderChart(readings) {
  state.lastReadings = readings;
  const wrap = $('#d-chart');
  if (!wrap) return;
  const points = readings
    .map((reading, index) => ({ value: reading.kwh, index, timestamp: reading.timestamp }))
    .filter((point) => Number.isFinite(point.value));
  if (!readings.length) return showChartMessage('No consumption readings were returned for this meter.');
  if (!points.length) return showChartMessage('This meter has no numeric kWh readings.');

  const width = Math.max(wrap.clientWidth, 280);
  const height = Math.max(wrap.clientHeight, 200);
  const pad = { left: 50, right: 14, top: 16, bottom: 28 };
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const spread = (Math.max(...values) - minimum) || 1;
  const x = (index) => pad.left + index / Math.max(readings.length - 1, 1) * (width - pad.left - pad.right);
  const y = (value) => height - pad.bottom - (value - minimum) / spread * (height - pad.top - pad.bottom);
  const path = points.map((point, order) => `${order ? 'L' : 'M'}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.at(-1).index).toFixed(1)},${height - pad.bottom} L${x(points[0].index).toFixed(1)},${height - pad.bottom} Z`;

  const svg = svgEl('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Cumulative energy readings in kilowatt-hours' });
  const gradient = svgEl('linearGradient', { id: 'chart-fill', x1: 0, x2: 0, y1: 0, y2: 1 });
  gradient.append(
    svgEl('stop', { offset: '0%', style: 'stop-color: var(--accent); stop-opacity: .3' }),
    svgEl('stop', { offset: '100%', style: 'stop-color: var(--accent); stop-opacity: 0' }));
  const defs = svgEl('defs');
  defs.append(gradient);
  svg.append(defs);
  for (const fraction of [1, 0.5, 0]) {
    const value = minimum + spread * fraction;
    const yy = y(value);
    svg.append(
      svgEl('line', { class: fraction === 0 ? 'chart-axis' : 'chart-grid', x1: pad.left, x2: width - pad.right, y1: yy, y2: yy }),
      svgEl('text', { class: 'chart-label', x: pad.left - 8, y: yy + 3.5, 'text-anchor': 'end' }, formatAxis(value)));
  }
  svg.append(
    svgEl('path', { class: 'chart-area', d: area }),
    svgEl('path', { class: 'chart-line', d: path }),
    svgEl('text', { class: 'chart-label', x: pad.left, y: height - 8 }, formatStamp(readings[0]?.timestamp)),
    svgEl('text', { class: 'chart-label', x: (pad.left + width - pad.right) / 2, y: height - 8, 'text-anchor': 'middle' }, formatStamp(readings[Math.floor(readings.length / 2)]?.timestamp)),
    svgEl('text', { class: 'chart-label', x: width - pad.right, y: height - 8, 'text-anchor': 'end' }, formatStamp(readings.at(-1)?.timestamp)));

  const cursor = svgEl('line', { class: 'chart-cursor', y1: pad.top, y2: height - pad.bottom, visibility: 'hidden' });
  const dot = svgEl('circle', { class: 'chart-dot', r: 5, visibility: 'hidden' });
  svg.append(cursor, dot);

  const tooltip = el('div', { class: 'chart-tooltip', hidden: true });
  const tooltipValue = el('strong');
  const tooltipTime = el('span');
  tooltip.append(tooltipValue, tooltipTime);

  const showAt = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const pointerX = (clientX - rect.left) * (width / rect.width);
    let nearest = points[0];
    let best = Infinity;
    for (const point of points) {
      const distance = Math.abs(x(point.index) - pointerX);
      if (distance < best) { nearest = point; best = distance; }
    }
    const px = x(nearest.index);
    const py = y(nearest.value);
    cursor.setAttribute('x1', px);
    cursor.setAttribute('x2', px);
    cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    dot.setAttribute('visibility', 'visible');
    tooltipValue.textContent = `${formatNumber(nearest.value, 2)} kWh`;
    tooltipTime.textContent = formatStamp(nearest.timestamp, { long: true });
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(Math.max(px * rect.width / width, 70), Math.max(rect.width - 70, 70))}px`;
    tooltip.style.top = `${Math.max(py * rect.height / height - 12, 44)}px`;
  };
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  svg.addEventListener('pointermove', (event) => showAt(event.clientX));
  svg.addEventListener('pointerdown', (event) => showAt(event.clientX));
  svg.addEventListener('pointerleave', hide);
  wrap.replaceChildren(svg, tooltip);
}

/* ------------------------------------------------------------------ */
/* Theme, events and start-up                                          */
/* ------------------------------------------------------------------ */

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('atlas-theme', theme);
  $('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f3fa' : '#0a0910');
  if (state.view === 'map' && mapState.map) {
    loadMap({ quiet: true });
    syncHalo();
  }
}

function initEvents() {
  $('#theme-toggle').addEventListener('click', () => setTheme(isLightTheme() ? 'dark' : 'light'));
  $('#drawer-close').addEventListener('click', () => closeDrawer());
  $('#scrim').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.meterId && !omni.open) closeDrawer();
  });

  // The big numbers on the Overview are doors into the Meters view.
  $('#hero').addEventListener('click', (event) => {
    const stat = event.target.closest('.stat[data-scope]');
    if (!stat) return;
    setScope(JSON.parse(stat.dataset.scope), { replace: true, view: stat.dataset.go ?? 'meters' });
  });
  $('#attention-list').addEventListener('click', (event) => {
    const row = event.target.closest('.attn-row[data-index]');
    const entry = row && state.attention?.[Number(row.dataset.index)];
    if (!entry) return;
    if (entry.view) showView(entry.view);
    else setScope(entry.scope, { replace: true, view: 'meters' });
  });

  window.addEventListener('hashchange', applyHash);
  window.addEventListener('popstate', applyHash);
  window.addEventListener('resize', debounce(() => {
    drawLinks();
    mapState.map?.invalidateSize();
    if (state.meterId && state.lastReadings && $('#d-chart')) renderChart(state.lastReadings);
  }, 150));
}

function start() {
  initMeters();
  initOmni();
  initNetwork();
  initMapControls();
  initEvents();
  renderRecent();
  syncScopeControls();

  const { view, meter } = parseHash();
  showView(view ?? 'overview', { fromHash: true });
  if (!view) writeHash();
  if (meter) openMeter(meter, { source: 'hash' });
  pollOverview();
}

start();