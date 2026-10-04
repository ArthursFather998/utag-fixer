# utag-fixer

A standalone audio tag-fixing engine. It repairs broken or missing metadata on audio files by checking them against public music catalogs, with a learned memory of past fixes and a review queue for uncertain corrections.

Extracted from a personal music-player project into a clean, UI-free ES module. No build step, plain ES modules.

## Pipeline

1. **scan**: parse audio files into track records with music-metadata (on-device; audio never leaves the device). Curated fixes apply at parse time.
2. **catalog match**: for each track with missing tags: scored filename parsing, then Apple Music, Deezer, and MusicBrainz lookups, plus full album-listing resolution.
3. **confidence**: every correction proposal carries a confidence score and source. Proposals at or above the per-source auto-apply threshold (default 0.88) apply on their own; proposals between 0.55 and the threshold go to the **review queue**. Album changes from title-only matches never auto-apply: a safety rule, not a threshold.
4. **learn**: every applied fix (auto, review-approved, or hand-edited) is remembered two ways: by file and by broken-tags fingerprint. Next run, remembered tracks resolve instantly with no network.
5. **fingerprint**: tracks nothing recognizes get identified by sound via AcoustID, but only as a last resort.

Preserved behaviors:

- The auto fixer only queues tracks with **missing/incomplete tags**. Complete-but-wrong tags are manual-editor-only.
- **Skipped tracks stay skipped.** The skip persists in memory and interrupts a run mid-flight, even while a track is being processed.
- **Learned fixes apply instantly** on the next run.
- **Hand-set art is never overwritten.** The `artManual` flag wins over catalog art, remembered art, and ownership claims.
- **Polite API pacing:** MusicBrainz at 1 request/sec (their published rule, serialized across concurrent workers), Apple Music / Deezer / artwork / AcoustID behind a shared 3-in-flight gate, never nested.

## Quick start

```js
import { createFixer, createIndexedDB } from './src/index.js';

const fixer = createFixer({
  storage: createIndexedDB('my-app'),   // persists learned fixes + skips
  acoustIdKey: 'YOUR_ACOUSTID_KEY',      // optional, enables fingerprinting
});

// 1. Parse files
const tracks = await fixer.scan(fileList);

// 2. Fix everything with missing tags
const res = await fixer.fixAll(tracks, {
  roster: ['Artist One', 'Artist Two'],  // canonical artist names for typo repair
  onTrack: (track, status, note) => console.log(status, track.title, note),
});
console.log(`fixed ${res.fixed} of ${res.scanned}, ${res.review.length} to review`);

// 3. Review the uncertain ones
for (const item of res.review) {
  const t = tracks.find(x => x.id === item.trackId);
  console.log(item.proposal.field, item.proposal.from, '->', item.proposal.to,
              Math.round(item.proposal.confidence * 100) + '%', item.proposal.source);
  await fixer.approveReview(item, t); // or: await fixer.skipReview(item);
}
```

The demo page (`demo/index.html`) does all of this with a UI: file picker, per-track progress, review queue with approve/reject, manual tag editor, skip buttons, and key inputs. Serve the repo root over HTTP (ES modules need it) and open `demo/`:

```sh
npx serve .        # or: python3 -m http.server
```

## API reference

`createFixer(opts)` returns:

| Method | What it does |
|---|---|
| `scan(files, {onProgress})` | Parse files into track records. Curated fixes apply at parse. |
| `fixAll(tracks, runOpts)` | Two-phase fix of every track with missing tags. Returns `{scanned, fixed, matched, review, via, skipHandle}`. |
| `heal(tracks)` | Quiet pass: curated fixes, reader-diagnostic backfill, fill-only repair. Returns `{fixed, changed}`. |
| `audit(tracks, roster, onProgress)` | Full correction audit incl. previously tagged tracks. Confident proposals auto-apply; returns `{scanned, fixed, auto, review}`. |
| `fixTrack(track, roster, opts)` | Fix one track. Returns `{fixed, queued, verified, note, status}` (`fixed`, `review`, `ok`, `nomatch`, `skipped`). |
| `fixAlbum(tracks, albums, artists)` | Resolve one album's tracks against its catalog listing. |
| `approveReview(item, track)` | Apply a review proposal, learn it, log the calibration signal. |
| `skipReview(item)` | Log the rejection signal without applying. |
| `needsFix(track)` | True when any core tag is missing. |
| `learn(before, after)` | Record a correction (hand edits go through this too). |
| `skip(track)` / `unskip(track)` / `isSkipped(track)` | Manual skip management. |
| `memoryStats()` / `memoryAll()` | Learned-fix store stats. |
| `setCurated(list)` / `curatedCount()` | Replace/inspect the curated fix list. |
| `logCalib(source, confidence, approved)` | Manual calibration logging. |
| `autoThresholdFor(source)` | Current adaptive auto-apply threshold for a source. |

`fixAll` run options:

| Option | Default | What it does |
|---|---|---|
| `roster` | `[]` | Canonical artist names (string or `{name}`); repairs misspelled artist tags. |
| `albums` / `artists` | `[]` | Seed data for album-listing resolution (`{name, artist}`). |
| `onTrack(track, status, note)` | - | Progress callback. Statuses: `scanning`, `fingerprinting` (transient), `fixed`, `review`, `ok`, `nomatch`, `skipped`. |
| `concurrency` | `5` | Parallel per-song workers, hard cap 6. |
| `skipHandle` | - | Object that receives `.now(trackId)` to interrupt a track mid-run. |
| `clusterTimeoutMs` | `120000` | One slow album cluster never wedges the run; its tracks fall through to per-song fix. |

`createFixer` options:

| Option | What it does |
|---|---|
| `storage` | Memory adapter `{get, put, all, count}`. Default in-memory; `createIndexedDB(name)` persists across sessions. |
| `ownership` | Ownership plugin, see below. |
| `acoustIdKey` | String or `() => string`. Without it, fingerprinting is skipped silently. |
| `fanartKey` | String or `() => string`. Optional, extra artwork source. |
| `reader` | `async (file, {duration}) => {common, format}` (music-metadata `parseBlob` shape). Default: `window.mm.parseBlob` when present. |
| `fingerprint` | `async (file, {maxSeconds}) => {fingerprint, duration}`. Default: `window.UtagFingerprint.compute` when present. |
| `curated` | Array of `{match:{artist,title}, fix:{artist,title}}`. |
| `onPersist(track)` | Called after each track save; the host uses it to persist its own records. |
| `onProgress(done, total, track)` | Overall progress for `fixAll`. |
| `onReview(reviewItems)` | Called with the review queue at the end of `fixAll`/`audit`. |
| `userAgent` | Sent to MusicBrainz (their rules require one). Default `utag-fixer/1.0 (audio tag fixer)`. |

Review items look like `{trackId, title, artist, proposal}` where `proposal` is `{field, from, to, confidence, source}` (`source` is one of `Apple Music`, `Deezer`, `MusicBrainz`, `AcoustID`, `artist roster`).

Track records are plain objects. Core fields: `id, title, artist, album, albumArtist, genre, year, trackNo, discNo, duration, fileName, fileSize, filePath, file, art, artSource, artManual, tagged, tagsVia, diag, dateAdded`. The engine mutates them in place and calls `onPersist`; persisting the collection itself is the host's job.

## Ownership hook

Some tracks should never be left to public catalogs: an artist's own unreleased songs, a label's private archive, a DJ's white labels. The ownership hook runs before the catalog passes and lets a plugin claim such tracks.

```js
const fixer = createFixer({
  ownership: {
    // Return null when this track is not yours to claim.
    async decide(track) {
      if (!isOurs(track)) return null;
      return {
        done: true,               // false: apply fields, then let catalog passes continue
        confidence: 0.99,
        fields: { artist: 'Our Artist', album: 'Our Archive', /* ... */ },
        note: 'matched our archive',
      };
    },
  },
});
```

Claimable fields: `title, artist, album, albumArtist, genre, year, trackNo, discNo, art, artSource`. Applied fields are learned like any other fix. Hand-set art (`artManual`) still wins. Ownership-claimed tracks are never fingerprinted: a false match there would be corruption, not a miss.

The original personal rules this hook replaces, documented here as prose:

- The owner's bundled discography was ground truth for their own songs; store catalogs were considered unable to carry unreleased music and were never given a chance to misidentify those tracks.
- A track was claimed when its artist tag named the owner, when it had no artist tag but its title matched the discography, or when its title matched the discography while the named artist was catalog-known yet had no such song (an obscure artist proved nothing either way, so those stayed manual). A file name containing the owner's name plus an Apple catalog confirmation could also claim an album track with a mangled artist.
- Claimed tracks were repaired from the owner's Apple Music album listing first (real 12-track listing, title/duration matched), then from the discography singles (album tag filled only when missing, never stealing a real album tag), with the bundled artwork restored unless hand-set.
- The owner's songs never went through acoustic fingerprinting.

## curated.json format

Repairs known-mangled tags that no catalog could guess, e.g. a file named `Band Name (Demo - Unfinished).mp3` that a reader split on ` - ` into artist `Band Name (Demo` and title `Unfinished)`. Applied at parse time and in `heal()`.

```json
[
  { "match": { "artist": "Band Name (Demo", "title": "Unfinished)" },
    "fix":   { "artist": "Band Name",      "title": "Song Title" } }
]
```

Matching is exact on the trimmed, lowercased pair. See `curated.sample.json`. Curated fixes are deliberate overrides: unlike catalog corrections, they can remove qualifiers the confidence gates would otherwise protect.

## AcoustID key setup

Fingerprinting is the last resort for tracks no catalog recognizes. It needs a free key:

1. Go to https://acoustid.org/new-application and create an application (free, no approval wait).
2. Pass the client key as `acoustIdKey` to `createFixer`, or type it into the demo's key field (stored only in that browser's localStorage, never committed).

The fingerprint itself is computed on-device from the audio (the demo bundles a chromaprint build in `vendor/`); only the fingerprint string plus the duration are sent to `api.acoustid.org`. The demo's `demo/fingerprint.js` shows the minimal provider: decode to mono PCM, feed chromaprint, return `{fingerprint, duration}`.

## Rate limits

- **MusicBrainz:** 1 request/sec, hard. Enforced inside the engine, serialized across all parallel workers, with 503 backoff (up to 3 tries) and an in-memory cache. Their usage rules require a descriptive User-Agent; set `userAgent`.
- **Apple Music, Deezer, artwork, AcoustID:** share one 3-in-flight gate per fixer instance. Gated calls never nest.
- **fanart.tv:** needs your own key (rate-limited per key); the engine only calls it when a MusicBrainz release id is known.

## Vendor

- `vendor/mm.js` - music-metadata browser bundle (MIT), exposes `window.mm.parseBlob`.
- `vendor/chromaprint-glue.js` + `vendor/chromaprint.wasm` - chromaprint build from @unimusic/chromaprint (MIT), used by the demo fingerprint provider.

## What was deliberately left out

The extraction dropped the original app's personal machinery: its bundled discography and curated data, the singles-shelf bookkeeping, and the owner-specific claim logic (replaced by the ownership hook above). Everything else, matching, scoring, thresholds, pacing, and memory behavior, is faithful to the original.
