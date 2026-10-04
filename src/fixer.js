/* utag-fixer: the tag-fixing engine.
   One song, fully fixed:
     1. Tag memory: a remembered fix applies instantly, no searching.
     2. Ownership hook: an optional plugin claims tracks it knows
        (see README "Ownership hook" for the original personal rules).
     3. Scored corrections: roster -> Apple Music -> Deezer -> MusicBrainz,
        filename fallback. Confident proposals auto-apply (per-source
        adaptive thresholds, default 0.88); uncertain ones (0.55 to
        threshold) return queued for review. Title-only album changes never
        auto-apply: a safety rule, not a threshold.
     4. Fill for anything still missing (fill-only: present-but-wrong
        fields are never clobbered, hand-set artwork never overwritten).
     5. Acoustic fingerprinting, last resort, only on "No match" tracks.
   The auto fixer only queues tracks with missing/incomplete tags:
   complete-but-wrong tags are manual-editor-only. Skipped tracks stay
   skipped: the skip persists in memory and interrupts a run mid-flight.
   Learned fixes apply instantly on the next run. */

import { withTimeout, norm, strSim, fileNameCandidates, titleSimilar } from './utils.js';

const TAG_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo', 'art'];
const FIX_LABEL = { title: 'Title', artist: 'Artist', album: 'Album', albumArtist: 'Album artist', genre: 'Genre' };
const OWNABLE_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo', 'art', 'artSource'];

export function createEngine(deps) {
  const {
    storage, curated, ownership, acoustIdKey, fanartKey, reader, fingerprint,
    onPersist, onLog, catalog, mb,
  } = deps;
  const log = onLog || ((...a) => console.warn(...a));

  // Storage ops are bounded: a wedged store must never hang a fix run.
  const mem = (p, label) => withTimeout(p, 10000, 'mem:' + (label || 'op'));
  const save = (t) => { try { if (onPersist) onPersist(t); } catch (e) { log('onPersist failed', e); } };

  function needsFix(tr) {
    return tr.album === 'Unknown Album' || !tr.art || tr.artist === 'Unknown Artist' || !tr.title || tr.title === 'Unknown Title';
  }

  /* ---- tag memory: remembers corrections the fixer got right (auto-
     applied, review-approved, hand-edited), so the next run just knows.
     Two keys per fix: the file itself (survives re-tagging) and the
     broken-tags fingerprint (catches a different rip of the same song
     with the same mangled tags). ---- */

  function memKeyFile(t) { return 'f:' + (t.fileName || '') + '::' + (t.fileSize || 0); }
  function memKeyTags(title, artist, album) {
    return 't:' + norm(title || '') + '|' + norm(artist || '') + '|' + norm(album || '');
  }
  function memFixOf(t) {
    return {
      title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
      genre: t.genre, year: t.year, trackNo: t.trackNo, discNo: t.discNo, art: t.art,
    };
  }
  async function learnFix(before, after) {
    try {
      const fix = memFixOf(after), b = memFixOf(before);
      const changed = TAG_FIELDS
        .some(k => String(fix[k] == null ? '' : fix[k]) !== String(b[k] == null ? '' : b[k]));
      if (!changed) return;
      const rec = { fix, learnedAt: Date.now() };
      await mem(storage.put({ key: memKeyFile(after), ...rec }), 'learn-put');
      const brokenKey = memKeyTags(b.title, b.artist, b.album);
      if (brokenKey !== memKeyTags(fix.title, fix.artist, fix.album)) {
        await mem(storage.put({ key: brokenKey, ...rec }), 'learn-put2');
      }
    } catch (e) {}
  }
  async function recallFix(t) {
    try {
      let rec = await mem(storage.get(memKeyFile(t)), 'recall-file');
      if (!rec) rec = await mem(storage.get(memKeyTags(t.title, t.artist, t.album)), 'recall-tags');
      return (rec && rec.fix) || null;
    } catch (e) { return null; }
  }
  // Apply a remembered fix. Never overwrites hand-set artwork with a
  // remembered one: a newer hand-set always wins. Returns true on change.
  async function applyMemFix(t, fix) {
    let changed = false;
    for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo']) {
      if (fix[k] !== undefined && fix[k] !== null && fix[k] !== '' && t[k] !== fix[k]) { t[k] = fix[k]; changed = true; }
    }
    if (fix.art !== undefined && !t.artManual && t.art !== fix.art) { t.art = fix.art; changed = true; }
    if (!changed) return false;
    t.tagged = true;
    t.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'memory';
    save(t);
    return true;
  }

  /* ---- manual skip: a track the user never wants the auto fixer to
     touch. Stored on the same memory record as learned fixes (flag
     only), so a skip survives restarts and a later unskip keeps any
     learned fix. ---- */

  const skipKeyFor = t => memKeyFile(t);
  async function recallSkip(t) {
    try {
      const rec = await mem(storage.get(memKeyFile(t)), 'skip-get');
      return !!(rec && rec.skip);
    } catch (e) { return false; }
  }
  async function skipTrack(t) {
    try {
      const k = memKeyFile(t);
      const rec = (await mem(storage.get(k), 'skip-read')) || {};
      rec.key = k; rec.skip = true; rec.when = Date.now();
      await mem(storage.put(rec), 'skip-put');
    } catch (e) {}
  }
  async function unskipTrack(t) {
    try {
      const k = memKeyFile(t);
      const rec = await mem(storage.get(k), 'unskip-read');
      if (rec && rec.skip) { delete rec.skip; await mem(storage.put(rec), 'unskip-put'); }
    } catch (e) {}
  }
  async function isSkipped(t) { return recallSkip(t); }
  async function memCount() {
    try { return await mem(storage.count(), 'count'); } catch (e) { return 0; }
  }
  async function memAll() {
    try { return await mem(storage.all(), 'all'); } catch (e) { return []; }
  }

  /* ---- calibration: every review approve/skip (and approve-all) is
     logged per source + confidence bucket. The auto-apply threshold per
     source becomes the lowest confidence bucket with approval rate >= 95%
     and at least 10 samples. Clamped: never auto below 0.60, never above
     the 0.88 default. With insufficient data the fixed 0.88 behavior
     holds exactly. The review floor (0.55) is unchanged, and the
     title-only album cap stays a hard safety rule outside this. ---- */

  async function logCalib(source, confidence, approved) {
    try {
      const bucket = Math.round((confidence || 0) * 20) / 20; // 0.05 steps
      const src = source || 'unknown';
      const key = 'calib:' + src + ':' + bucket.toFixed(2);
      const rec = (await mem(storage.get(key), 'calib-get')) || { key, approved: 0, total: 0 };
      rec.approved += approved ? 1 : 0;
      rec.total += 1;
      await mem(storage.put(rec), 'calib-put');
      const ik = 'calibidx:' + src;
      const idx = (await mem(storage.get(ik), 'calibidx-get')) || { key: ik, buckets: {} };
      idx.buckets[bucket.toFixed(2)] = true;
      await mem(storage.put(idx), 'calibidx-put');
    } catch (e) {}
  }
  async function autoThresholdFor(source) {
    const DEF = 0.88, FLOOR = 0.60;
    try {
      const src = source || 'unknown';
      const idx = await mem(storage.get('calibidx:' + src), 'thr-idx');
      const buckets = idx && idx.buckets ? Object.keys(idx.buckets).map(Number).sort((a, b) => a - b) : [];
      let thr = DEF;
      for (const b of buckets) {
        const rec = await mem(storage.get('calib:' + src + ':' + b.toFixed(2)), 'thr-bucket');
        if (rec && rec.total >= 10 && rec.approved / rec.total >= 0.95) { thr = b; break; }
      }
      return Math.min(DEF, Math.max(FLOOR, thr));
    } catch (e) { return DEF; }
  }

  /* ---- fill pass: fill in missing tags from the catalog (audio never
     leaves the device). Strictly fill-only: fields that already have
     values are never overwritten here; corrections go through the
     scored audit proposals instead. Tries the tag query first, then the
     file-name query (mangled tags poison the first, the file name often
     still holds "Artist - Title"). ---- */

  const TAG_MISSING = v => !v || v === 'Unknown Album' || v === 'Unknown Artist' || v === 'Unknown Title';
  async function autoTag(tr, opts) {
    opts = opts || {};
    if (!needsFix(tr) && !opts.fillAny) return false;
    const queries = [];
    if (tr.title && tr.title !== 'Unknown Title') {
      queries.push({ a: tr.artist && tr.artist !== 'Unknown Artist' ? tr.artist : '', t: tr.title });
    }
    try {
      // Every scored filename candidate seeds its own query: more
      // candidates, better recall. The parser only emits candidates with
      // both artist and title, so the artist-less safety rule holds.
      const pc = fileNameCandidates(tr.fileName || '', tr.filePath || '', { artist: tr.artist, title: tr.title });
      for (const c of pc.list.slice(0, 4)) {
        const q = { a: c.artist, t: c.title };
        if (!queries.some(x => x.a === q.a && x.t === q.t)) queries.push(q);
      }
      // Fill-only extras from the filename: folder album and leading track
      // number. Never overwrite anything present.
      if (TAG_MISSING(tr.album) && pc.album) tr.album = pc.album;
      if (!tr.trackNo && pc.trackNo) tr.trackNo = pc.trackNo;
    } catch (e) {}
    let filled = false;
    for (const q of queries) {
      try { if (await catalog.autoTagQuery(tr, q)) { filled = true; break; } } catch (e) {}
    }
    // Artwork fallback chain: Apple first (inside autoTagQuery), then
    // Deezer gets its turn when Apple had no art.
    if (!tr.art && !tr.artManual) {
      for (const q of queries) {
        try { if (await catalog.autoTagDeezerArt(tr, q)) { filled = true; break; } } catch (e) {}
      }
    }
    // Extended art chain (Spotify oEmbed, Cover Art Archive, fanart.tv)
    // when Apple and Deezer both came up empty.
    if (!tr.art && !tr.artManual) {
      try { if (await catalog.artChainExtra(tr)) filled = true; } catch (e) {}
    }
    return filled;
  }

  /* ---- correction audits ---- */

  // Roster pass: the canonical artist list corrects misspelled artist tags.
  function rosterProposal(t, roster) {
    const ta = (t.artist || '').trim();
    if (!ta || ta === 'Unknown Artist') return null;
    const nta = ta.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const r of roster) {
      if ((r.name || r || '').toLowerCase().replace(/[^a-z0-9]/g, '') === nta) return null; // already canonical
    }
    let best = null, bestSim = 0;
    for (const r of roster) {
      const s = strSim(typeof r === 'string' ? r : r.name, ta);
      if (s > bestSim) { bestSim = s; best = r; }
    }
    const bestName = best && (typeof best === 'string' ? best : best.name);
    if (bestName && bestSim >= 0.8 && bestSim < 1) {
      return { field: 'artist', from: ta, to: bestName, confidence: 0.5 + bestSim * 0.45, source: 'artist roster' };
    }
    return null;
  }

  async function auditTrack(t, roster) {
    const proposals = [];
    let verified = false;
    try {
      const rp = rosterProposal(t, roster || []);
      if (rp) proposals.push(rp);
    } catch (e) {}
    // Only consult the network when the roster didn't already settle it and
    // the track has something to search with. Fallback chain: Apple Music
    // -> Deezer -> MusicBrainz. MusicBrainz is skipped when an earlier
    // source already confidently identified the song, to spare the 1/sec
    // budget. Proposals from every consulted source compete per field,
    // most confident wins.
    if (t.title && t.title !== 'Unknown Title') {
      try {
        const ar = await catalog.appleAudit(t);
        proposals.push(...ar.proposals);
        verified = ar.verified;
      } catch (e) {}
      if (!verified) {
        try {
          const dr = await catalog.deezerAudit(t);
          proposals.push(...dr.proposals);
          verified = verified || dr.verified;
        } catch (e) {}
      }
      if (!verified) { try { proposals.push(...await catalog.mbProposal(t)); } catch (e) {} }
    }
    // One proposal per field: keep the most confident.
    const byField = new Map();
    for (const p of proposals) {
      const cur = byField.get(p.field);
      if (!cur || p.confidence > cur.confidence) byField.set(p.field, p);
    }
    return { proposals: [...byField.values()], verified };
  }

  async function applyProposal(t, p) {
    t[p.field] = p.to;
    t.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'audit(' + p.source + ')';
    t.tagged = true;
    // Calibration bookkeeping: remember what the fixer auto-set and how
    // sure it was, so a later hand-edit can log a rejection signal.
    t.autoConf = { ...(t.autoConf || {}), [p.field]: p.confidence };
    t.autoSource = { ...(t.autoSource || {}), [p.field]: p.source };
    save(t);
  }

  /* ---- ownership hook: a plugin that claims tracks it knows (an
     artist's own catalog, a label's archive, ...). Runs before the
     catalog passes. decide(track) returns null, or
       { done, confidence, fields: {title, artist, album, ...}, note }
     fields are applied fill-and-correct style (hand-set art still wins);
     done:false lets the normal catalog passes take it from there.
     See README "Ownership hook" for the original rules this replaced. ---- */

  async function applyOwnership(t, claim) {
    const notes = [];
    const fields = claim.fields || {};
    let changed = 0;
    for (const k of OWNABLE_FIELDS) {
      if (fields[k] === undefined || fields[k] === null || fields[k] === '') continue;
      if (k === 'art' && t.artManual) continue;
      if (String(t[k] == null ? '' : t[k]) !== String(fields[k])) {
        notes.push((FIX_LABEL[k] || k) + ': ' + (t[k] || '—') + ' → ' + fields[k]);
        t[k] = fields[k];
        changed++;
      }
    }
    if (!changed) return { done: claim.done !== false, changed: 0, note: claim.note || '' };
    t.tagged = true;
    t.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'ownership';
    save(t);
    if (claim.note) notes.push(claim.note);
    return { done: claim.done !== false, changed, note: notes.join('; ') };
  }

  /* ---- acoustic fingerprinting: last-resort ID for tracks the catalog
     chain can't recognize (the "No match" tier). The fingerprint is
     computed on-device (pass `fingerprint`, or set
     window.UtagFingerprint.compute); only the fingerprint + duration go
     to AcoustID. Never runs on ownership-claimed tracks: a false match
     there would be corruption, not a miss. ---- */

  function resolveFingerprintCompute() {
    if (typeof fingerprint === 'function') return fingerprint;
    if (typeof window !== 'undefined') {
      const u = window.UtagFingerprint;
      if (u && u.compute) return u.compute.bind(u);
      const s = window.SplotifyFingerprint; // vendored shim compat
      if (s && s.compute) return s.compute.bind(s);
    }
    return null;
  }

  async function fingerprintTrack(t, opts) {
    opts = opts || {};
    if (t._claimedByOwnership) return null;
    const cfgKey = typeof acoustIdKey === 'function' ? acoustIdKey() : acoustIdKey;
    const key = opts.acoustIdKey || cfgKey;
    if (!key) return null;
    const compute = resolveFingerprintCompute();
    if (!compute) return null;
    const file = t.file;
    if (!file || !file.size) return null;
    let fp = null, dur = 0;
    try {
      if (opts.onFingerprint) { try { opts.onFingerprint(t); } catch (e) {} }
      const r = await withTimeout(compute(file, { maxSeconds: 60 }), 90000, 'fingerprint ' + (t.fileName || 'track'));
      fp = r && r.fingerprint; dur = (r && r.duration) || 0;
    } catch (e) { return null; }
    if (!fp) return null;
    let hit = null;
    try { hit = await catalog.acoustidLookup(fp, dur, key); } catch (e) {}
    if (!hit || !hit.rec) return null;
    const rec = hit.rec;
    const score = hit.score;
    // Duration veto: the match's recording must be near the file's length.
    const recDur = Number(rec.duration || 0);
    const fileDur = Number(dur || t.duration || 0);
    if (recDur > 0 && fileDur > 0 && Math.abs(recDur - fileDur) > Math.max(10, 0.2 * fileDur)) return null;
    const artists = (rec.artists || []).map(a => a && a.name).filter(Boolean).join(', ');
    const rel = (rec.releasegroups || [])[0] || null;
    const conf = Math.min(0.99, Math.max(0, Number(score) || 0));
    const out = [];
    if (rec.title && rec.title !== t.title && norm(rec.title) !== norm(t.title)) {
      out.push({ field: 'title', from: t.title, to: rec.title, confidence: Math.min(conf, 0.92), source: 'AcoustID' });
    }
    if (artists && artists !== t.artist && norm(artists) !== norm(t.artist)) {
      out.push({ field: 'artist', from: t.artist, to: artists, confidence: Math.min(conf, 0.9), source: 'AcoustID' });
    }
    if (rel && rel.title && rel.title !== t.album && norm(rel.title) !== norm(t.album || '')) {
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: rel.title, confidence: Math.min(conf, 0.87), source: 'AcoustID', titleOnlyAlbum: true });
    }
    if (!out.length) return null;
    return { proposals: out, releaseId: (rel && rel.id) || null };
  }

  /* ---- fixTrack: one song, fully fixed. The single engine behind the
     fixer. Returns {fixed, queued, verified, note, status} where status
     is one of: fixed, review, ok, nomatch, skipped. ---- */

  async function fixTrack(t, roster, opts) {
    opts = opts || {};
    const notes = [];
    let fixed = 0;
    const queued = [];
    let verified = false;
    const before = memFixOf(t);
    // Manually skipped songs resolve instantly: no network, no writes.
    try { if (await recallSkip(t)) return { fixed: 0, queued: [], verified: true, note: 'skipped', status: 'skipped' }; } catch (e) {}
    // Per-source adaptive auto-apply thresholds, cached for the run.
    const thrCache = new Map();
    const thrFor = async (source) => {
      if (!thrCache.has(source)) thrCache.set(source, await autoThresholdFor(source));
      return thrCache.get(source);
    };
    // Route scored proposals through the same auto/review split for every
    // source. Title-only album changes never auto-apply: a safety rule,
    // not a threshold.
    const routeProposals = async (proposals) => {
      for (const p of proposals) {
        const thr = await thrFor(p.source);
        if (p.confidence >= thr && !(p.field === 'album' && p.titleOnlyAlbum)) {
          try {
            await applyProposal(t, p);
            fixed++;
            notes.push((FIX_LABEL[p.field] || p.field) + ': ' + p.from + ' → ' + p.to);
          } catch (e) {}
        } else if (p.confidence >= 0.55) {
          queued.push({ trackId: t.id, title: t.title, artist: t.artist, proposal: p });
        }
      }
    };
    // Tag memory first: if we've fixed this song before, just apply what
    // we already know is correct. No searching needed.
    try {
      const remembered = await recallFix(t);
      if (remembered) {
        if (await applyMemFix(t, remembered)) { fixed++; notes.push('remembered fix'); }
        return { fixed, queued, verified: true, note: notes.join('; '), status: fixed ? 'fixed' : 'ok' };
      }
    } catch (e) {}
    // Ownership hook: a plugin's own catalog is ground truth for its
    // tracks, and the store catalogs must not get a chance to misidentify
    // them. A full claim returns done; otherwise the catalog passes below
    // take it from there.
    try {
      const decide = ownership && ownership.decide;
      if (decide) {
        const claim = await decide(t);
        if (claim) {
          t._claimedByOwnership = true;
          const applied = await applyOwnership(t, claim);
          if (applied.note) notes.push(applied.note);
          if (applied.done) {
            fixed += applied.changed;
            if (fixed > 0) { try { await learnFix(before, t); } catch (e) {} }
            delete t._claimedByOwnership;
            return { fixed, queued, verified: true, note: notes.join('; '), status: fixed ? 'fixed' : 'ok' };
          }
        }
      }
    } catch (e) { log('ownership hook failed', e); }
    try {
      const ar = await auditTrack(t, roster);
      verified = ar.verified;
      await routeProposals(ar.proposals);
    } catch (e) {}
    // Fill pass for anything still missing. autoTag is fill-only, so
    // present-but-wrong fields are never clobbered, and hand-set artwork
    // is never overwritten.
    if (needsFix(t)) {
      const tr = { ...t };
      try {
        if (await autoTag(tr)) {
          const upd = {};
          ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo', 'art', 'artSource'].forEach(f => {
            if (tr[f] !== undefined && String(tr[f] !== null ? tr[f] : '') !== String(t[f] !== null && t[f] !== undefined ? t[f] : '')) upd[f] = tr[f];
          });
          if (Object.keys(upd).length) {
            upd.tagged = true;
            upd.tagsVia = tr.tagsVia || t.tagsVia;
            Object.assign(t, upd);
            save(t);
            fixed++;
            const filledNames = Object.keys(upd).filter(f => f !== 'tagged' && f !== 'tagsVia').map(f => FIX_LABEL[f] || f);
            if (filledNames.length) notes.push('filled ' + filledNames.join(', '));
          }
        }
      } catch (e) {}
    }
    let status = fixed ? 'fixed' : queued.length ? 'review' : verified ? 'ok' : 'nomatch';
    // Acoustic fingerprinting, last resort. Runs ONLY on tracks that
    // reached the "No match" tier, never speculatively (it is CPU-heavy).
    if (status === 'nomatch') {
      try {
        const fg = await fingerprintTrack(t, opts);
        if (fg && fg.proposals && fg.proposals.length) {
          await routeProposals(fg.proposals);
          status = fixed ? 'fixed' : queued.length ? 'review' : 'nomatch';
          // The release MBID feeds the artwork chain (Cover Art Archive),
          // wired through mbReleaseId so the MB search is skipped.
          // Hand-set art stays untouched.
          if (status !== 'nomatch' && !t.art && !t.artManual && fg.releaseId) {
            try {
              const tr = { ...t, mbReleaseId: fg.releaseId };
              if (await catalog.artChainExtra(tr)) {
                const upd = { art: tr.art, artSource: tr.artSource, tagged: true, tagsVia: tr.tagsVia };
                Object.assign(t, upd);
                save(t);
                fixed++;
                notes.push('artwork: ' + (tr.artSource || 'Cover Art Archive'));
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    const note = notes.join('; ');
    // Remember what we got right, so next time we just know.
    if (fixed > 0) { try { await learnFix(before, t); } catch (e) {} }
    delete t._claimedByOwnership;
    return { fixed, queued, verified, note, status };
  }

  /* ---- audit: full-collection correction audit. Confident corrections
     auto-apply (adaptive per-source thresholds); the rest return for the
     review screen, highest confidence first. Re-verifies previously
     tagged tracks too. ---- */

  async function audit(tracks, roster, onProgress) {
    const review = [];
    let fixed = 0, scanned = 0, autoCount = 0;
    const thrCache = new Map();
    const thrFor = async (source) => {
      if (!thrCache.has(source)) thrCache.set(source, await autoThresholdFor(source));
      return thrCache.get(source);
    };
    for (const t of (tracks || [])) {
      scanned++;
      if (onProgress) { try { onProgress(scanned, tracks.length, t); } catch (e) {} }
      let ar = { proposals: [], verified: false };
      try { ar = await auditTrack(t, roster); } catch (e) { continue; }
      for (const p of ar.proposals) {
        const thr = await thrFor(p.source);
        if (p.confidence >= thr && !(p.field === 'album' && p.titleOnlyAlbum)) {
          try { await applyProposal(t, p); fixed++; autoCount++; } catch (e) {}
        } else if (p.confidence >= 0.55) {
          review.push({ trackId: t.id, title: t.title, artist: t.artist, proposal: p });
        }
      }
    }
    review.sort((a, b) => ((b.proposal || {}).confidence || 0) - ((a.proposal || {}).confidence || 0));
    return { scanned, fixed, auto: autoCount, review };
  }

  /* ---- fixAlbum: look up the whole album, apply proper tags + track
     order. Unknown album: per-track fix first; anything identified
     reveals its album/artist, then every candidate listing (named albums
     + full artist catalogs, all via id lookup) is matched by
     title/duration signals. ---- */

  async function fixAlbum(tracks, knownAlbums, knownArtists) {
    tracks = (tracks || []).filter(Boolean);
    if (!tracks.length) return { fixed: 0, total: 0, matched: 0, found: false, via: { apple: 0, musicbrainz: 0 } };
    const albumName = tracks[0].album || '';
    const artistName = tracks[0].albumArtist && tracks[0].albumArtist !== 'Unknown Artist' ? tracks[0].albumArtist
      : (tracks[0].artist && tracks[0].artist !== 'Unknown Artist' ? tracks[0].artist : '');
    const trackArtist = t => (t.albumArtist && t.albumArtist !== 'Unknown Artist' ? t.albumArtist
      : (t.artist && t.artist !== 'Unknown Artist' ? t.artist : ''));
    if (!albumName || albumName === 'Unknown Album') {
      let fixed = 0, matched = 0, attempted = 0;
      const via = { apple: 0, musicbrainz: 0 };
      const leftover = [];
      for (const t of tracks) {
        const tr = { ...t };
        if (!needsFix(tr)) continue;
        attempted++;
        try {
          if (await autoTag(tr)) {
            Object.assign(t, {
              title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
              genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
              art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
              ...(tr.artSource !== undefined ? { artSource: tr.artSource } : {}),
            });
            save(t);
            fixed++; matched++; via.apple++; continue;
          }
        } catch (e) {}
        leftover.push(t);
      }
      if (leftover.length) {
        const seedAlbums = [];
        const seenA = new Set();
        const addAlbum = (name, artist) => {
          if (!name || name === 'Unknown Album') return;
          const k = (artist || '') + '|||' + name;
          if (!seenA.has(k)) { seenA.add(k); seedAlbums.push({ name, artist }); }
        };
        (knownAlbums || []).forEach(a => addAlbum(a.name, a.artist));
        tracks.forEach(t => addAlbum(t.album, trackArtist(t)));
        const seedArtists = new Set();
        (knownArtists || []).forEach(a => { if (a && a !== 'Unknown Artist') seedArtists.add(a); });
        tracks.forEach(t => { const a = trackArtist(t); if (a) seedArtists.add(a); });
        const listings = await catalog.candidateListings(seedAlbums, [...seedArtists]);
        for (const listing of listings) {
          const used = new Set();
          for (let i = leftover.length - 1; i >= 0; i--) {
            const t = leftover[i];
            const m = catalog.matchTrackMulti(t, listing.songs, used);
            if (!m) continue;
            const tr = { ...t };
            const changed = catalog.applyListing(tr, m, listing.col, listing.art);
            try {
              Object.assign(t, tr);
              save(t);
              matched++;
              if (changed) { fixed++; via.apple++; }
            } catch (e) {}
            leftover.splice(i, 1);
          }
          if (!leftover.length) break;
        }
        // MusicBrainz pass: anything Apple couldn't identify gets a shot
        // against the open database before falling through.
        const mbRes = await mbFixTracks(leftover);
        fixed += mbRes.fixed; matched += mbRes.matched; via.musicbrainz += mbRes.fixed;
      }
      return { fixed, total: tracks.length, matched, found: attempted > 0, via };
    }
    // Known album: match each track against the album's own listing plus
    // the artist's other releases, full albums first. A track that lives
    // on both an album and a single gets the album tagging, so albums
    // stay complete instead of fragmenting into stray singles.
    const primary = await catalog.albumTrackListing(albumName, artistName);
    const artistSeeds = new Set();
    if (artistName) artistSeeds.add(artistName);
    tracks.forEach(t => { const a = trackArtist(t); if (a) artistSeeds.add(a); });
    const alts = await catalog.candidateListings([], [...artistSeeds]);
    if (!primary && !alts.length) return { fixed: 0, total: tracks.length, matched: 0, found: false, notFound: true, via: { apple: 0, musicbrainz: 0 } };
    let fixed = 0, matched = 0;
    const matchedIds = [];
    const via = { apple: 0, musicbrainz: 0 };
    const applyMatch = async (t, m, listing) => {
      matched++;
      matchedIds.push(t.id);
      const art = await catalog.ensureListingArt(listing);
      const tr = { ...t };
      const changed = catalog.applyListing(tr, m, listing.col, art);
      try { Object.assign(t, tr); save(t); if (changed) { fixed++; via.apple++; } } catch (e) {}
    };
    const usedPrimary = new Set();
    const stillUnmatched = [];
    if (primary && primary.col && primary.col.collectionId) {
      for (const t of tracks) {
        const m = catalog.matchTrackMulti(t, primary.songs, usedPrimary);
        if (m) await applyMatch(t, m, primary);
        else stillUnmatched.push(t);
      }
    } else {
      stillUnmatched.push(...tracks);
    }
    if (stillUnmatched.length && alts.length) {
      const ordered = [];
      const seenCol = new Set(primary && primary.col ? [primary.col.collectionId] : []);
      for (const l of alts) {
        const id = l && l.col && l.col.collectionId;
        if (l && id && !seenCol.has(id)) { seenCol.add(id); ordered.push(l); }
      }
      ordered.sort((a, b) => b.songs.length - a.songs.length);
      const usedBy = new Map();
      for (const t of stillUnmatched) {
        let best = null, bestListing = null;
        for (const listing of ordered) {
          let used = usedBy.get(listing);
          if (!used) { used = new Set(); usedBy.set(listing, used); }
          const m = catalog.matchTrackMulti(t, listing.songs, used);
          if (m) { best = m; bestListing = listing; break; }
        }
        if (!best) continue;
        await applyMatch(t, best, bestListing);
      }
    }
    const albumLabel = primary ? primary.col.collectionName
      : (alts[0] && alts[0].col ? alts[0].col.collectionName : '');
    return { fixed, total: tracks.length, matched, matchedIds, found: true, album: albumLabel, via };
  }

  async function mbFixTracks(leftovers) {
    let fixed = 0, matched = 0;
    for (let i = leftovers.length - 1; i >= 0; i--) {
      const t = leftovers[i];
      if (!t.title || t.title === 'Unknown Title') continue;
      let recs = null;
      try { recs = await mb.search(t.title, t.artist); } catch (e) { continue; }
      const pick = catalog.mbPick(recs, t);
      if (!pick) continue;
      matched++;
      const before = [t.title, t.artist, t.album, t.albumArtist].join('|');
      t.title = pick.title || t.title;
      const mbArtist = (pick['artist-credit'] || []).map(a => (a.name || '') + (a.joinphrase || '')).join('').trim();
      if (mbArtist) t.artist = mbArtist;
      const rel = (pick.releases || [])[0];
      if (rel && rel.title) t.album = rel.title;
      if (!t.albumArtist || t.albumArtist === 'Unknown Artist') t.albumArtist = t.artist;
      t.tagged = true;
      t.tagsVia = 'MusicBrainz';
      const changed = before !== [t.title, t.artist, t.album, t.albumArtist].join('|');
      try {
        save(t);
        if (changed) fixed++;
      } catch (e) {}
      leftovers.splice(i, 1);
    }
    return { fixed, matched };
  }

  /* ---- fixAlbumClusters: album-first pass. Cluster named-album tracks
     and resolve each cluster with one album-listing lookup, instead of
     auditing every song individually. One listing lookup identifies the
     whole album, which also kills most "title-only match can't tell which
     artist's song this is" review items: inside a listing there is no
     ambiguity. Memory-known tracks skip the network entirely.
     Returns whatever the album pass didn't resolve for the per-song path.
     onTrack(t, status, note) paints progress: 'scanning' is transient;
     every track gets exactly one terminal status. ---- */

  const FP_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo'];
  const fpOf = t => FP_FIELDS.map(f => t[f]).join('|') + '|' + (!!t.art) + '|' + (t.artSource || '');

  async function fixAlbumClusters(tracks, knownAlbums, knownArtists, onTrack, opts) {
    opts = opts || {};
    const clusterTimeoutMs = opts.clusterTimeoutMs || 120000;
    const list = tracks || [];
    const clusters = new Map();
    const leftover0 = [];
    for (const t of list) {
      const alb = t.album;
      if (!alb || alb === 'Unknown Album') { leftover0.push(t); continue; }
      const aa = t.albumArtist && t.albumArtist !== 'Unknown Artist' ? t.albumArtist
        : (t.artist && t.artist !== 'Unknown Artist' ? t.artist : '');
      const k = alb + '|||' + aa;
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k).push(t);
    }
    const resolved = new Set();
    const paint = (t, status, note) => { try { if (onTrack) onTrack(t, status, note); } catch (e) {} };
    for (const members of clusters.values()) {
      const rest = [];
      for (const t of members) {
        paint(t, 'scanning');
        let skipped = false;
        try { skipped = await recallSkip(t); } catch (e) {}
        if (skipped) { resolved.add(t.id); paint(t, 'skipped', 'skipped'); continue; }
        let recalled = false;
        try {
          const rec = await recallFix(t);
          if (rec && await applyMemFix(t, rec)) recalled = true;
        } catch (e) {}
        if (recalled) { resolved.add(t.id); paint(t, 'fixed', 'remembered fix'); }
        else rest.push(t);
      }
      if (!rest.length) continue;
      const before = new Map(rest.map(t => [t.id, fpOf(t)]));
      let res = null;
      // A single slow cluster must never wedge the whole run: 120s cap,
      // then its tracks fall through to the per-song pass.
      try { res = await withTimeout(fixAlbum(rest, knownAlbums || [], knownArtists || []), clusterTimeoutMs, 'album cluster ' + (rest[0] && rest[0].album)); }
      catch (e) { log('album cluster timed out/failed', rest[0] && rest[0].album, e && e.message); }
      const matched = res && res.matchedIds ? new Set(res.matchedIds) : new Set();
      for (const t of rest) {
        if (fpOf(t) !== before.get(t.id)) {
          resolved.add(t.id);
          paint(t, 'fixed', 'album: ' + (t.album || ''));
        } else if (matched.has(t.id)) {
          resolved.add(t.id);
          paint(t, 'ok', 'album tags already correct');
        }
        // Unmatched tracks stay unresolved and fall through to per-song fix.
      }
    }
    return { leftover: list.filter(t => !resolved.has(t.id)), resolved: resolved.size };
  }

  /* ---- fixTrackPool: parallel fix pool for the per-song path. N
     concurrent fixTrack calls (default 5, hard cap 6). MusicBrainz keeps
     its own 1/sec pacing; Apple/Deezer share the 3-slot gate. Writes
     stay per-track. onStart/onDone paint progress; each track fires
     exactly one terminal onDone. ---- */

  async function fixTrackPool(tracks, roster, opts) {
    opts = opts || {};
    const list = tracks || [];
    const n = Math.max(1, Math.min(opts.concurrency || 5, 6));
    // Per-track skip signal. The skip control rejects a track's race
    // immediately, even mid-flight through a hung await, instead of
    // waiting out its timeouts. Late completions are harmless (idempotent
    // writes) and the persistent skip record keeps it skipped next run.
    const skipRejectors = new Map();
    const armSkip = (id) => new Promise((_, rej) => { skipRejectors.set(id, rej); });
    const disarmSkip = (id) => { skipRejectors.delete(id); };
    const skipNow = (id) => {
      const r = skipRejectors.get(id);
      if (r) { skipRejectors.delete(id); r(new Error('skipped')); }
    };
    if (opts.skipHandle && typeof opts.skipHandle === 'object') opts.skipHandle.now = skipNow;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        const t = list[i];
        if (opts.onStart) { try { opts.onStart(t); } catch (e) {} }
        let res = null;
        try { res = await Promise.race([fixTrack(t, roster, opts), armSkip(t.id)]); }
        catch (e) {
          const wasSkip = (e && e.message === 'skipped') || (opts.isSkipped && opts.isSkipped(t.id));
          res = wasSkip
            ? { fixed: 0, queued: [], verified: false, note: 'skipped', status: 'skipped' }
            : null;
        }
        finally { disarmSkip(t.id); }
        if (opts.onDone) { try { opts.onDone(t, res); } catch (e) {} }
      }
    };
    const ws = [];
    for (let k = 0; k < Math.min(n, list.length); k++) ws.push(worker());
    await Promise.all(ws);
    return { total: list.length };
  }

  /* ---- heal: quiet pass over tracks already in the collection. Applies
     curated fixes, backfills the reader diagnostic, and fill-fixes
     anything still missing. Runs on launch in the original app. ---- */

  async function heal(tracks) {
    let fixed = 0, touched = 0;
    const parserOK = !!reader;
    try {
      for (const t of (tracks || [])) {
        // Curated metadata fixes: repair known-mangled tags on existing records.
        let mf = null;
        try { mf = curated.get(t.artist, t.title); } catch (e) {}
        if (mf && ((mf.fa && t.artist !== mf.fa) || (mf.ft && t.title !== mf.ft))) {
          try {
            if (mf.fa) t.artist = mf.fa;
            if (mf.ft) t.title = mf.ft;
            t.tagsVia = 'Curated';
            save(t);
            touched++;
          } catch (e) {}
        }
        if (!t.diag) {
          // Backfill the reader diagnostic so track info stays truthful.
          // Never clobbers fixer notes (set below).
          const d = parserOK ? 'reader-ok' : 'reader-missing (no metadata reader configured)';
          try { t.diag = d; save(t); touched++; } catch (e) {}
        }
        if (!needsFix(t)) continue;
        const tr = { ...t };
        try {
          if (await autoTag(tr)) {
            const upd = {
              title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
              genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
              art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
            };
            Object.assign(t, upd);
            save(t);
            fixed++;
          }
        } catch (e) { log('heal failed', t.fileName, e); }
      }
    } catch (e) { log('heal failed', e); }
    return { fixed, changed: fixed + touched };
  }

  return {
    needsFix,
    fixTrack, fixAlbum, fixAlbumClusters, fixTrackPool,
    audit, heal,
    autoTag, auditTrack, applyProposal, fingerprintTrack,
    learnFix, recallFix, memCount, memAll,
    skipKeyFor, recallSkip, isSkipped, skipTrack, unskipTrack,
    logCalib, autoThresholdFor,
  };
}
