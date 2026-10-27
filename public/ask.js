/*
 * Natural-language query parser for Flock Energy.
 *
 * It turns a sentence such as
 *   "installed Secure meters without coordinates"
 *   "how many are decommissioned"
 *   "meters within 2 km of 1234567"
 * into the same filter fields the Meters view uses. It is rule based, so no API key or network
 * call is needed.
 *
 * It never needs the meter list. The dashboard holds only one page of meters at a time, so the
 * parser works from a small vocabulary (statuses and makes) and leaves the rest to the server:
 *   - anything it does not recognise becomes a free-text search (`q`), which the server matches
 *     against meter ids, serial numbers, transformers and network names;
 *   - "near <meter>" returns the meter id, and the server finds its coordinates.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AtlasAsk = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STOP_WORDS = new Set([
    'show', 'me', 'find', 'list', 'give', 'display', 'get', 'see', 'tell', 'about', 'please',
    'all', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'without',
    'that', 'which', 'who', 'whose', 'are', 'is', 'was', 'were', 'be', 'been', 'do', 'does', 'can',
    'have', 'has', 'having', 'there', 'any', 'i', 'we', 'you', 'my', 'our', 'us',
    'meter', 'meters', 'status', 'make', 'makes', 'made', 'manufacturer', 'manufactured', 'brand',
    'transformer', 'transformers', 'located', 'location', 'locations', 'coordinates', 'map',
    'and', 'or', 'what', 'whats', "what's", 'where', 'how', 'many', 'much', 'those', 'these', 'them',
    'it', 'its', 'this', 'selected', 'current', 'also', 'only', 'just', 'than', 'into', 'up', 'out',
    'near', 'nearby', 'around', 'within', 'km', 'kms', 'm', 'under', 'over'
  ]);

  const NEAR_RE = /\b(?:near|nearby|around|within|close to|next to|surrounding|neighbou?ring|neighbou?rs? of)\b/;
  const RADIUS_RE = /(\d+(?:\.\d+)?)\s*(kilomet(?:er|re)s?|kms?|meters?|metres?|m)\b/;
  const NO_LOCATION_RE = /\b(?:without|with no|have no|has no|having no|no|missing|lacking)\s+(?:a\s+|any\s+|the\s+)?(?:location|locations|coordinates|coords|gps|geolocation|geo)\b|\bunmapped\b|\bnot\s+(?:located|mapped|geolocated)\b/;
  const HAS_LOCATION_RE = /\b(?:(?:with|having|that have|which have|have|has)\s+(?:a\s+|any\s+|valid\s+)?(?:location|locations|coordinates|coords|gps|geolocation)|located|mapped|geolocated|on the map)\b/;
  const RESET_RE = /^\s*(?:clear|reset|start over|everything|show (?:me )?(?:all|everything)|(?:all|every) meters?)\s*$/;
  const REFINE_RE = /^\s*(?:and|also|now|only|but|then|narrow (?:it |this |that )?(?:down )?to|filter (?:these |those |them )?(?:to|by)|of (?:these|those)|among (?:these|those)|within (?:these|those))\s+/;

  const INSTALLED_ALIASES = ['active', 'working', 'live', 'in service', 'in-service'];
  const DECOMMISSIONED_ALIASES = ['retired', 'removed', 'inactive', 'scrapped', 'decommission'];

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Removes one whole word from the (space padded) working text. */
  function removeToken(work, token) {
    return work.replace(new RegExp('(^|\\s)' + escapeRegExp(token) + '(?=\\s|$)'), '$1 ');
  }

  /**
   * Does this word look like a meter id? Ids are long and contain digits (1234567, MTR-00231).
   * The page can pass `ctx.isMeterId(token)` when it knows better (for example, from a search it just ran).
   */
  function looksLikeMeterId(token, ctx) {
    if (typeof ctx.isMeterId === 'function') {
      return Boolean(ctx.isMeterId(token));
    }
    return /^[a-z0-9][a-z0-9_-]{3,}$/.test(token) && /\d/.test(token);
  }

  function parse(input, ctx) {
    const found = {};
    const ignored = [];
    const hints = [];
    const vocab = ctx.vocab ?? { statuses: [], makes: [], transformers: [] };
    const kindOf = ctx.kindOf ?? (() => 'other');

    let work = ` ${String(input ?? '').toLowerCase()
      .replace(/[?!,;:()"“”]/g, ' ')
      .replace(/\.(?=\s|$)/g, ' ')} `.replace(/\s+/g, ' ');

    if (RESET_RE.test(work)) {
      return { reset: true, found, ignored, hints, wantsCount: false, refine: false };
    }

    // "and only …", "narrow down to …": keep the filters that are already on.
    let refine = false;
    work = work.replace(REFINE_RE, () => {
      refine = true;
      return ' ';
    });

    const countWords = /\b(?:how many|count|number of|total)\b/g;
    const wantsCount = /\b(?:how many|count|number of|total)\b/.test(work);
    work = work.replace(countWords, ' ');

    work = work.replace(/\bun(installed)\b/g, 'not $1');

    // ---- coordinates -------------------------------------------------------
    if (NO_LOCATION_RE.test(work)) {
      found.located = 'no';
      work = work.replace(NO_LOCATION_RE, ' ');
    } else if (HAS_LOCATION_RE.test(work)) {
      found.located = 'yes';
      work = work.replace(HAS_LOCATION_RE, ' ');
    }

    // ---- distance from a meter ----------------------------------------------
    const hasNear = NEAR_RE.test(work);
    if (hasNear) {
      work = work.replace(NEAR_RE, ' ');
      let radiusKm = null;
      const radius = work.match(RADIUS_RE);
      if (radius) {
        const amount = Number.parseFloat(radius[1]);
        radiusKm = radius[2].startsWith('k') ? amount : amount / 1000;
        work = work.replace(radius[0], ' ');
      }

      let centerId = null;
      for (const token of work.split(/\s+/).filter(Boolean)) {
        if (looksLikeMeterId(token, ctx)) {
          work = removeToken(work, token);
          centerId = token;
          break;
        }
      }
      if (!centerId && ctx.selectedId) {
        centerId = String(ctx.selectedId);
      }
      if (centerId) {
        found.near = {
          meterId: centerId,
          km: radiusKm && radiusKm > 0 ? Math.min(radiusKm, 1000) : 2,
          label: centerId
        };
      }
    }

    // ---- installation status -----------------------------------------------
    const aliases = [];
    for (const status of vocab.statuses) {
      aliases.push([status.toLowerCase(), status]);
    }
    const installed = vocab.statuses.find((status) => kindOf(status) === 'installed');
    const decommissioned = vocab.statuses.find((status) => kindOf(status) === 'decommissioned');
    if (installed) INSTALLED_ALIASES.forEach((alias) => aliases.push([alias, installed]));
    if (decommissioned) {
      DECOMMISSIONED_ALIASES.forEach((alias) => aliases.push([alias, decommissioned]));
      aliases.push(['decommissioned', decommissioned]);
    }
    aliases.sort((a, b) => b[0].length - a[0].length);
    for (const [alias, status] of aliases) {
      const pattern = new RegExp(`(^|\\s)(?:(not|non|never)[-\\s]+)?${escapeRegExp(alias)}(?:ed)?(?=\\s|$)`);
      const match = work.match(pattern);
      if (!match) continue;
      if (match[2]) {
        found.statusNot = status;
      } else {
        found.status = status;
      }
      work = work.replace(pattern, ' ');
      break;
    }

    // ---- manufacturer -------------------------------------------------------
    const makes = [...vocab.makes].sort((a, b) => b.length - a.length);
    for (const make of makes) {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(make.toLowerCase())}(?=\\s|$)`);
      if (pattern.test(work)) {
        found.make = make;
        work = work.replace(pattern, '$1 ');
        break;
      }
    }

    // ---- transformer ----------------------------------------------------------
    // "transformer DT-0123": the code is taken as typed (the server compares it ignoring case).
    // A transformer code on its own, with no keyword, is simply searched for as text.
    const known = new Map((vocab.transformers ?? []).map((code) => [code.toLowerCase(), code]));
    for (const token of work.split(/\s+/).filter(Boolean)) {
      if (known.has(token)) {
        found.transformer = known.get(token);
        work = removeToken(work, token);
        break;
      }
    }
    if (!found.transformer) {
      const phrase = work.match(/(?:^|\s)(?:transformer|transformers|xfmr|dts?)\s+([a-z0-9_\-/]+)/);
      if (phrase) {
        const candidates = [...known.keys()].filter((code) => code.startsWith(phrase[1]));
        if (candidates.length === 1) {
          found.transformer = known.get(candidates[0]);
        } else if (!known.size || known.has(phrase[1])) {
          found.transformer = known.get(phrase[1]) ?? phrase[1].toUpperCase();
        }
        if (found.transformer) {
          work = removeToken(work, phrase[1]);
        }
      }
    }

    // ---- whatever is left is searched for as text ------------------------------
    // (meter ids, serial numbers, area names). The server matches it against the whole index.
    const keep = [];
    for (const token of work.split(/\s+/)) {
      if (!token || STOP_WORDS.has(token) || /^[-_/'’]+$/.test(token) || /^\d{1,2}$/.test(token)) continue;
      keep.push(token);
    }
    if (keep.length) found.q = keep.join(' ');

    if (hasNear && !found.near && !found.q) {
      hints.push('Tell me which meter to measure from, e.g. “within 2 km of <meter id>”, or open a meter first.');
    }

    return { found, ignored, hints, wantsCount, refine };
  }

  return { parse };
});