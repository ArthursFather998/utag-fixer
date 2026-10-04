/* utag-fixer: polite concurrency gates.
   The parallel fix pool fires many fixes at once. Apple Music, Deezer,
   artwork, and AcoustID queries share one 3-in-flight gate so the pool
   can never hammer the APIs. No gated call nests inside another.
   MusicBrainz keeps its own strict 1 request/sec pacing (their published
   politeness rule), serialized across concurrent callers, with an
   in-memory cache so a repeated title/artist costs nothing. */

import { fetchJSON, norm } from './utils.js';

export function makeGate(max) {
  let inFlight = 0;
  const waiters = [];
  const pump = () => {
    while (inFlight < max && waiters.length) {
      const w = waiters.shift();
      inFlight++;
      w();
    }
  };
  return function gate(fn) {
    return new Promise((resolve, reject) => {
      waiters.push(() => {
        Promise.resolve().then(fn).then(
          v => { inFlight--; pump(); resolve(v); },
          e => { inFlight--; pump(); reject(e); }
        );
      });
      pump();
    });
  };
}

// One shared 3-in-flight gate per fixer instance (created in index.js).
export function createCatalogGate() {
  return makeGate(3);
}

// MusicBrainz paced search. One instance per fixer (its cache and pacing
// state are per run, never global).
export function createMbSearch(userAgent) {
  const mbCache = new Map();
  let mbLastReq = 0;
  let mbPace = Promise.resolve();

  async function search(title, artist) {
    const key = norm(title) + '|||' + norm(artist);
    if (mbCache.has(key)) return mbCache.get(key);
    let release;
    const slot = new Promise(res => { release = res; });
    const prev = mbPace;
    mbPace = slot;
    await prev; // serialize: MusicBrainz never sees concurrent requests
    try {
      return await searchInner(title, artist);
    } finally {
      release();
    }
  }

  async function searchInner(title, artist) {
    const key = norm(title) + '|||' + norm(artist);
    if (mbCache.has(key)) return mbCache.get(key); // re-check after the wait
    // 1 req/sec politeness + 503 backoff (up to 3 tries). Failures are
    // never cached: a throttled lookup must not poison later tracks.
    let out = null, backoff = 2000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = 1100 - (Date.now() - mbLastReq);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      mbLastReq = Date.now();
      try {
        let q = 'recording:"' + String(title || '').replace(/"/g, '') + '"';
        if (artist && artist !== 'Unknown Artist') q += ' AND artist:"' + String(artist).replace(/"/g, '') + '"';
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch('https://musicbrainz.org/ws/2/recording/?query=' + encodeURIComponent(q) + '&fmt=json&limit=8', {
          signal: c.signal,
          headers: { 'User-Agent': userAgent || 'utag-fixer/1.0 (audio tag fixer)' },
        });
        clearTimeout(t);
        if (r.status === 503) { await new Promise(rr => setTimeout(rr, backoff)); backoff *= 2; continue; }
        if (r.ok) {
          const d = await r.json();
          out = (d.recordings || []).filter(x => x && (x.score || 0) >= 60);
        }
        break;
      } catch (e) {
        break; // offline: skip
      }
    }
    if (out) mbCache.set(key, out);
    return out;
  }

  return { search };
}
