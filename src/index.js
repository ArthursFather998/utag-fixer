/* utag-fixer: audio tag repair, extracted into a clean standalone library.
   Pipeline: scan -> catalog match -> confidence -> auto-apply or review
   -> learn. Audio never leaves the device (AcoustID sends only the
   on-device fingerprint + duration). */

import { createCatalogGate, createMbSearch } from './gates.js';
import { createCatalog } from './catalog.js';
import { createCurated } from './curated.js';
import { createInMemory } from './memory.js';
import { createEngine } from './fixer.js';
import { parseAudioFile } from './reader.js';
import { fileNameCandidates, fmtDur } from './utils.js';

export { createInMemory, createIndexedDB } from './memory.js';
export { createCurated } from './curated.js';
export { fileNameCandidates, fmtDur, strSim, titleSimilar } from './utils.js';

/* createFixer options:
   - storage:   memory adapter {get, put, all, count}. Default: in-memory.
                Use createIndexedDB() for persistence across sessions.
   - ownership:  { decide(track) } plugin, see README "Ownership hook".
                Default: none.
   - acoustIdKey: free key from https://acoustid.org/new-application.
                Without it, fingerprinting is skipped silently.
   - fanartKey:  fanart.tv key for the extended artwork chain (optional).
   - reader:     async (file, {duration}) -> {common, format} (music-metadata
                parseBlob shape). Default: window.mm.parseBlob if present.
   - fingerprint: async (file, {maxSeconds}) -> {fingerprint, duration}.
                Default: window.UtagFingerprint.compute if present.
   - curated:    array of {match:{artist,title}, fix:{artist,title}}.
   - onPersist:  (track) -> void, called after each track save.
   - onProgress: (done, total, track) -> void.
   - onReview:   (reviewItems) -> void, called at the end of fixAll/audit.
   - userAgent:  sent to MusicBrainz (their rules require one). */
export function createFixer(opts) {
  opts = opts || {};
  const gate = createCatalogGate();
  const mb = createMbSearch(opts.userAgent || 'utag-fixer/1.0 (audio tag fixer)');
  const catalog = createCatalog({
    gate,
    mb,
    getFanartKey: () => (typeof opts.fanartKey === 'function' ? opts.fanartKey() : opts.fanartKey) || '',
  });
  const curated = createCurated();
  if (opts.curated) curated.set(opts.curated);

  const engine = createEngine({
    storage: opts.storage || createInMemory(),
    curated,
    ownership: opts.ownership || null,
    acoustIdKey: opts.acoustIdKey || '',
    fanartKey: opts.fanartKey || '',
    reader: opts.reader || null,
    fingerprint: opts.fingerprint || null,
    onPersist: opts.onPersist || null,
    onLog: opts.onLog || null,
    catalog,
    mb,
  });

  let nextId = 1;

  // Parse audio files into track records, applying curated fixes at parse.
  async function scan(files, { onProgress } = {}) {
    const tracks = [];
    const list = [...(files || [])];
    let i = 0;
    for (const f of list) {
      i++;
      try {
        const t = await parseAudioFile(f, { id: 'ut' + (nextId++), reader: opts.reader || null, curated });
        tracks.push(t);
      } catch (e) {
        (opts.onLog || console.warn)('scan failed', f && f.name, e);
      }
      if (onProgress) { try { onProgress(i, list.length, f); } catch (e) {} }
    }
    return tracks;
  }

  /* Fix everything with missing tags: album-first pass, then the parallel
     per-song pool. Returns {scanned, fixed, matched, review, via}.
     onTrack(t, status, note) paints progress; statuses: scanning,
     fingerprinting (transient), fixed, review, ok, nomatch, skipped. */
  async function fixAll(tracks, runOpts) {
    runOpts = runOpts || {};
    const list = (tracks || []).filter(engine.needsFix);
    const review = [];
    const via = { apple: 0, deezer: 0, musicbrainz: 0, memory: 0, acoustid: 0 };
    let scanned = 0, fixed = 0, matched = 0;
    const queueReview = (queued) => {
      for (const q of (queued || [])) {
        if (!review.some(x => x.trackId === q.trackId && x.proposal.field === q.proposal.field && x.proposal.to === q.proposal.to)) {
          review.push(q);
        }
      }
    };
    const countVia = (t) => {
      const tv = t.tagsVia || '';
      if (tv.includes('memory')) via.memory++;
      else if (tv.includes('AcoustID')) via.acoustid++;
      else if (tv.includes('Deezer')) via.deezer++;
      else if (tv.includes('Apple')) via.apple++;
      else if (tv.includes('MusicBrainz')) via.musicbrainz++;
    };
    const noteFixed = (t) => { countVia(t); };
    const roster = runOpts.roster || [];
    const onTrack = runOpts.onTrack || null;
    const paint = (t, status, note) => { try { if (onTrack) onTrack(t, status, note); } catch (e) {} };

    // Phase 1: album-first. Named-album clusters resolve from one listing
    // lookup each; memory-known tracks skip the network entirely.
    let leftover = list;
    try {
      const cr = await engine.fixAlbumClusters(list, runOpts.albums || [], runOpts.artists || [], (t, status, note) => {
        if (status === 'scanning') { paint(t, 'scanning'); return; }
        scanned++;
        if (status === 'fixed') { fixed++; matched++; noteFixed(t); }
        else if (status === 'ok') { matched++; }
        paint(t, status, note);
      }, { clusterTimeoutMs: runOpts.clusterTimeoutMs });
      leftover = cr.leftover;
    } catch (e) { (opts.onLog || console.warn)('album-first pass failed', e); }

    // Phase 2: parallel fix pool for everything the album pass left over.
    // A caller-supplied skipHandle (or a fresh one) receives .now(trackId)
    // so the UI can interrupt a track mid-run.
    const skipHandle = (runOpts.skipHandle && typeof runOpts.skipHandle === 'object') ? runOpts.skipHandle : {};
    await engine.fixTrackPool(leftover, roster, {
      concurrency: runOpts.concurrency || 5,
      skipHandle,
      isSkipped: runOpts.isSkipped || null,
      onStart: (t) => { paint(t, 'scanning'); },
      onFingerprint: (t) => { paint(t, 'fingerprinting'); },
      onDone: (t, res) => {
        scanned++;
        if (res) {
          if (res.fixed) { fixed += res.fixed; matched++; noteFixed(t); }
          queueReview(res.queued);
          paint(t, res.status, res.note);
        } else {
          paint(t, 'nomatch');
        }
      },
    });
    if (opts.onProgress) { try { opts.onProgress(scanned, list.length, null); } catch (e) {} }

    review.sort((a, b) => ((b.proposal || {}).confidence || 0) - ((a.proposal || {}).confidence || 0));
    if (opts.onReview) { try { opts.onReview(review); } catch (e) {} }
    return { scanned, fixed, matched, review, via, skipHandle };
  }

  // Quiet pass: curated fixes + fill-only repair on existing records.
  async function heal(tracks, { onProgress } = {}) {
    return engine.heal(tracks, onProgress);
  }

  // Full correction audit with auto-apply for confident proposals.
  async function audit(tracks, roster, onProgress) {
    const r = await engine.audit(tracks, roster, onProgress);
    if (opts.onReview) { try { opts.onReview(r.review); } catch (e) {} }
    return r;
  }

  // Approve one review item: apply it, learn it, log the calibration signal.
  // Pass the track explicitly, or attach it as item.track when rendering.
  async function approveReview(item, track) {
    const t = track || item.track;
    if (!t) throw new Error('approveReview needs the track: pass it or set item.track');
    const before = { ...t };
    await engine.applyProposal(t, item.proposal);
    try { await engine.learnFix(before, t); } catch (e) {}
    try { await engine.logCalib(item.proposal.source, item.proposal.confidence, true); } catch (e) {}
    return t;
  }

  // Skip one review item: log the rejection signal only.
  async function skipReview(item) {
    try { await engine.logCalib(item.proposal.source, item.proposal.confidence, false); } catch (e) {}
  }

  return {
    scan,
    fixAll,
    heal,
    audit,
    approveReview,
    skipReview,
    fixTrack: (t, roster, o) => engine.fixTrack(t, roster, o),
    fixAlbum: (tracks, albums, artists) => engine.fixAlbum(tracks, albums, artists),
    needsFix: engine.needsFix,
    learn: (before, after) => engine.learnFix(before, after),
    skip: (t) => engine.skipTrack(t),
    unskip: (t) => engine.unskipTrack(t),
    isSkipped: (t) => engine.isSkipped(t),
    memoryStats: () => engine.memCount(),
    memoryAll: () => engine.memAll(),
    setCurated: (list) => curated.set(list),
    curatedCount: () => curated.count(),
    logCalib: (s, c, a) => engine.logCalib(s, c, a),
    autoThresholdFor: (s) => engine.autoThresholdFor(s),
    version: '1.0.0',
  };
}
