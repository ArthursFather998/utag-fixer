/* utag-fixer: catalog search, correction audits, album listings, artwork.
   Sources, in order: Apple Music (fill + audit), Deezer (fill + audit +
   artwork), MusicBrainz (audit + release ids for the artwork chain),
   Spotify oEmbed / Cover Art Archive / fanart.tv (artwork chain),
   AcoustID (fingerprint lookup).
   Audio never leaves the device except for AcoustID fingerprints, which
   are computed on-device and sent as fingerprint + duration only. */

import {
  fetchJSON, norm, compact, strSim, titleMatches, titleSimilar,
  fileNameCandidates, leadNumber, durationVeto, artBlob, fetchArtBlob,
} from './utils.js';

const TAG_MISSING = v => !v || v === 'Unknown Album' || v === 'Unknown Artist' || v === 'Unknown Title';

export function createCatalog({ gate, mb, getFanartKey }) {
  const listingCache = new Map();
  const artistListingsCache = new Map();
  const fanartKey = () => (getFanartKey ? getFanartKey() : '');

  /* ---- fill-only passes: fields that already have values are never
     overwritten here. Corrections go through the scored audits. ---- */

  async function autoTagQueryUngated(tr, q) {
    const qs = ((q.a ? q.a + ' ' : '') + q.t).trim();
    if (!qs) return false;
    const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(qs) + '&media=music&entity=song&limit=6', 12000);
    if (!d || !d.resultCount) return false;
    const na = norm(q.a);
    let best = null;
    for (const r of d.results) {
      const ra = norm(r.artistName);
      const artistOK = !na || na === 'unknown artist' || ra === na || ra.indexOf(na) !== -1 || na.indexOf(ra) !== -1;
      if (titleMatches(q.t, r.trackName, false) && artistOK) { best = r; break; }
    }
    if (!best) return false;
    if (TAG_MISSING(tr.title)) tr.title = best.trackName || tr.title;
    if (TAG_MISSING(tr.artist)) tr.artist = best.artistName || tr.artist;
    if (TAG_MISSING(tr.album)) tr.album = best.collectionName || tr.album;
    if (!tr.genre) tr.genre = best.primaryGenreName || tr.genre;
    if (!tr.year) tr.year = (best.releaseDate || '').slice(0, 4) || tr.year;
    if (!tr.trackNo) tr.trackNo = best.trackNumber || tr.trackNo;
    tr.tagsVia = tr.tagsVia || 'Apple Music';
    const au = (best.artworkUrl100 || '').replace('100x100bb', '1200x1200bb');
    // Never overwrite hand-set artwork. Blob first (works offline); the URL
    // string as fallback so art still displays if the download flakes.
    if (au && !tr.art && !tr.artManual) {
      tr.art = await fetchArtBlob(au);
      tr.artSource = 'Apple Music';
    }
    tr.tagged = true;
    return true;
  }

  async function autoTagDeezerArtUngated(tr, q) {
    const qs = ((q.a ? q.a + ' ' : '') + q.t).trim();
    if (!qs || tr.art || tr.artManual) return false;
    const d = await fetchJSON('https://api.deezer.com/search?q=' + encodeURIComponent(qs) + '&limit=6', 12000);
    if (!d || !d.total || !d.data) return false;
    const na = norm(q.a);
    for (const r of d.data) {
      const ra = norm((r.artist && r.artist.name) || '');
      const artistOK = !na || na === 'unknown artist' || ra === na || ra.indexOf(na) !== -1 || na.indexOf(ra) !== -1;
      if (titleMatches(q.t, r.title || '', false) && artistOK) {
        const au = (r.album && r.album.cover_xl) || '';
        if (au) {
          tr.art = await fetchArtBlob(au);
          tr.artSource = 'Deezer';
          tr.tagsVia = (tr.tagsVia ? tr.tagsVia + '+' : '') + 'Deezer';
          tr.tagged = true;
          return true;
        }
      }
    }
    return false;
  }

  /* ---- extended artwork chain: runs when Apple and Deezer found no art.
     Sources: Spotify oEmbed (needs a spotifyId on the track, no auth),
     Cover Art Archive (via the MusicBrainz release id), fanart.tv (needs
     a fanartKey). Candidates are tried highest resolution first. Never
     touches existing or hand-set art. ---- */

  async function artChainExtra(tr) {
    if (tr.art || tr.artManual) return false;
    const cands = [];
    if (tr.spotifyId) {
      try {
        const o = await fetchJSON('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + tr.spotifyId), 8000);
        if (o && o.thumbnail_url) cands.push({ url: o.thumbnail_url, w: o.thumbnail_width || 640, source: 'Spotify' });
      } catch (e) {}
    }
    // Cover Art Archive + fanart.tv need a MusicBrainz release id. The MB
    // lookup is cached and polite (1/sec), so a repeat query costs nothing.
    // A fingerprinted track already knows its release MBID: go straight to
    // Cover Art Archive without spending the MB search.
    let releaseId = tr.mbReleaseId || null;
    try {
      let artistId = null;
      if (!releaseId) {
        const recs = await mb.search(tr.title, tr.artist);
        const pick = mbPick(recs, tr);
        const rel = pick && (pick.releases || [])[0];
        const ac = pick && (pick['artist-credit'] || [])[0];
        artistId = ac && ac.artist && ac.artist.id;
        releaseId = (rel && rel.id) || null;
      }
      const fkey = fanartKey();
      if (releaseId) {
        cands.push({ url: 'https://coverartarchive.org/release/' + releaseId + '/front', w: 1400, source: 'Cover Art Archive' });
        if (fkey) {
          try {
            const f = await fetchJSON('https://webservice.fanart.tv/v3/music/albums/' + releaseId + '?api_key=' + encodeURIComponent(fkey), 8000);
            const alb = f && f.albums && f.albums[releaseId];
            const covers = alb && alb.albumcover;
            if (covers && covers.length && covers[0].url) cands.push({ url: covers[0].url, w: 1000, source: 'fanart.tv' });
          } catch (e) {}
        }
      }
      if (fkey && artistId) {
        try {
          const f = await fetchJSON('https://webservice.fanart.tv/v3/music/' + artistId + '?api_key=' + encodeURIComponent(fkey), 8000);
          const thumbs = f && f.artistthumb;
          if (thumbs && thumbs.length && thumbs[0].url) cands.push({ url: thumbs[0].url, w: 1000, source: 'fanart.tv' });
        } catch (e) {}
      }
    } catch (e) {}
    if (!cands.length) return false;
    cands.sort((a, b) => b.w - a.w);
    for (const cd of cands) {
      const blob = await artBlob(cd.url);
      if (blob === false) continue; // definitively missing, try the next
      tr.art = blob || cd.url;
      tr.artSource = cd.source;
      tr.tagsVia = (tr.tagsVia ? tr.tagsVia + '+' : '') + cd.source;
      tr.tagged = true;
      return true;
    }
    return false;
  }

  /* ---- correction audits: identify AND correct wrong tags, not just fill
     gaps. Each audit returns {proposals, verified}: verified means the
     source confidently identified the song even if nothing needed changing
     (so callers can skip slower sources). Proposals compete per field,
     most confident wins. ---- */

  function auditQueries(t) {
    const queries = [];
    const tagQ = ((t.artist && t.artist !== 'Unknown Artist') ? t.artist + ' ' : '') + (t.title || '');
    if (tagQ.trim()) queries.push({ qs: tagQ.trim(), a: (t.artist && t.artist !== 'Unknown Artist') ? t.artist : '', t: t.title || '' });
    try {
      const pc = fileNameCandidates(t.fileName || '', t.filePath || '', { artist: t.artist, title: t.title });
      for (const c of pc.list.slice(0, 4)) {
        const qs = (c.artist + ' ' + c.title).trim();
        if (qs && !queries.some(q => q.qs === qs)) queries.push({ qs, a: c.artist, t: c.title });
      }
    } catch (e) {}
    return queries;
  }

  async function appleAuditQueryUngated(qq, t) {
    const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(qq.qs) + '&media=music&entity=song&limit=8', 12000);
    if (!d || !d.resultCount) return null;
    let best = null, bestScore = 0;
    for (const r of d.results) {
      const ts = strSim(r.trackName, qq.t);
      const as = strSim(r.artistName, qq.a);
      // Title-only query (no artist): score on the title alone, stricter bar.
      const score = qq.a ? ts * 0.6 + as * 0.4 : ts;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const threshold = qq.a ? 0.75 : 0.85;
    if (!best || bestScore < threshold) return null;
    const out = [];
    const conf = 0.55 + bestScore * 0.4; // 0.85..0.95 at high similarity
    // Gates compare the catalog hit against the QUERY's title/artist (which
    // is what actually matched), not the current tags, so a filename query
    // can correct fully-mangled tags, while a mere qualifier difference
    // ("(Sped Up)") never triggers a rewrite.
    if (strSim(best.trackName, qq.t) >= 0.9 && best.trackName !== t.title && norm(best.trackName) !== norm(t.title)) {
      out.push({ field: 'title', from: t.title, to: best.trackName, confidence: Math.min(conf, 0.92), source: 'Apple Music' });
    }
    if (qq.a && strSim(best.artistName, qq.a) >= 0.85 && best.artistName !== t.artist && norm(best.artistName) !== norm(t.artist)) {
      out.push({ field: 'artist', from: t.artist, to: best.artistName, confidence: Math.min(conf, 0.9), source: 'Apple Music' });
    }
    if (best.collectionName && best.collectionName !== t.album && norm(best.collectionName) !== norm(t.album || '') && strSim(best.trackName, qq.t) >= 0.9) {
      // Title-only matches can't tell which artist's song this is, so an
      // album change from one always goes to review, never auto-applies.
      const albumConf = qq.a ? Math.min(conf - 0.05, 0.88) : Math.min(conf - 0.05, 0.87);
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: best.collectionName, confidence: albumConf, source: 'Apple Music', ...(qq.a ? {} : { titleOnlyAlbum: true }) });
    }
    return { proposals: out, verified: bestScore >= (qq.a ? 0.85 : 0.92) };
  }

  async function deezerAuditQueryUngated(qq, t) {
    const d = await fetchJSON('https://api.deezer.com/search?q=' + encodeURIComponent(qq.qs) + '&limit=8', 12000);
    if (!d || !d.total || !d.data || !d.data.length) return null;
    let best = null, bestScore = 0;
    for (const r of d.data) {
      const ts = strSim(r.title || '', qq.t);
      const as = strSim((r.artist && r.artist.name) || '', qq.a);
      const score = qq.a ? ts * 0.6 + as * 0.4 : ts;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const threshold = qq.a ? 0.75 : 0.85;
    if (!best || bestScore < threshold) return null;
    const out = [];
    const conf = 0.55 + bestScore * 0.4;
    const bTitle = best.title || '', bArtist = (best.artist && best.artist.name) || '';
    const bAlbum = (best.album && best.album.title) || '';
    if (strSim(bTitle, qq.t) >= 0.9 && bTitle !== t.title && norm(bTitle) !== norm(t.title)) {
      out.push({ field: 'title', from: t.title, to: bTitle, confidence: Math.min(conf, 0.92), source: 'Deezer' });
    }
    if (qq.a && strSim(bArtist, qq.a) >= 0.85 && bArtist !== t.artist && norm(bArtist) !== norm(t.artist)) {
      out.push({ field: 'artist', from: t.artist, to: bArtist, confidence: Math.min(conf, 0.9), source: 'Deezer' });
    }
    if (bAlbum && bAlbum !== t.album && norm(bAlbum) !== norm(t.album || '') && strSim(bTitle, qq.t) >= 0.9) {
      const albumConf = qq.a ? Math.min(conf - 0.05, 0.88) : Math.min(conf - 0.05, 0.87);
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: bAlbum, confidence: albumConf, source: 'Deezer', ...(qq.a ? {} : { titleOnlyAlbum: true }) });
    }
    return { proposals: out, verified: bestScore >= (qq.a ? 0.85 : 0.92) };
  }

  async function appleAudit(t) {
    const queries = auditQueries(t);
    for (const qq of queries) {
      try {
        const r = await gate(() => appleAuditQueryUngated(qq, t));
        if (r && (r.proposals.length || r.verified)) return r;
      } catch (e) {}
    }
    return { proposals: [], verified: false };
  }

  async function deezerAudit(t) {
    const queries = auditQueries(t);
    for (const qq of queries) {
      try {
        const r = await gate(() => deezerAuditQueryUngated(qq, t));
        if (r && (r.proposals.length || r.verified)) return r;
      } catch (e) {}
    }
    return { proposals: [], verified: false };
  }

  function mbPick(recs, t) {
    if (!recs || !recs.length) return null;
    const dur = t.duration || 0;
    let best = null, bestScore = -1;
    for (const rec of recs) {
      if (!titleSimilar(t.title, rec.title) && (rec.score || 0) < 85) continue;
      let s = rec.score || 0;
      const rlen = rec.length || 0;
      if (dur > 0 && rlen > 0) {
        const d = Math.abs(dur - rlen / 1000);
        if (d > 20) continue;
        s += 20 - d;
      }
      if (s > bestScore) { bestScore = s; best = rec; }
    }
    return best;
  }

  async function mbProposal(t) {
    let recs = null;
    try { recs = await mb.search(t.title, t.artist); } catch (e) { return []; }
    const pick = mbPick(recs, t);
    if (!pick) return [];
    const out = [];
    const mbArtist = (pick['artist-credit'] || []).map(a => (a.name || '') + (a.joinphrase || '')).join('').trim();
    const ts = strSim(pick.title, t.title), as = mbArtist ? strSim(mbArtist, t.artist) : 0;
    if (ts < 0.8 || (mbArtist && as < 0.7)) return [];
    const conf = 0.5 + (ts * 0.6 + as * 0.4) * 0.35; // caps ~0.85, review tier
    if (pick.title && pick.title !== t.title && norm(pick.title) !== norm(t.title) && ts >= 0.9) {
      out.push({ field: 'title', from: t.title, to: pick.title, confidence: conf, source: 'MusicBrainz' });
    }
    if (mbArtist && mbArtist !== t.artist && norm(mbArtist) !== norm(t.artist) && as >= 0.85) {
      out.push({ field: 'artist', from: t.artist, to: mbArtist, confidence: conf, source: 'MusicBrainz' });
    }
    const rel = (pick.releases || [])[0];
    if (rel && rel.title && rel.title !== t.album && norm(rel.title) !== norm(t.album || '') && ts >= 0.9) {
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: rel.title, confidence: conf - 0.05, source: 'MusicBrainz' });
    }
    return out;
  }

  /* ---- album listings: resolve a named album to its full track listing
     via Apple id lookup (lookup is not subject to the search index's
     quirks). Named albums resolve directly; known artists expand to
     their full catalogs (every collection id under the artist name),
     which surfaces even tracks the search index suppresses. ---- */

  async function listingFromCollectionId(colId, skipArt) {
    try {
      const ld = await fetchJSON('https://itunes.apple.com/lookup?id=' + colId + '&entity=song&limit=200', 12000);
      if (!ld || !ld.results) return null;
      const col = ld.results.find(r => r.wrapperType === 'collection') || {};
      const songs = ld.results.filter(r => r.wrapperType === 'track');
      if (!songs.length) return null;
      const artUrl = (col.artworkUrl100 || '').replace('100x100bb', '1200x1200bb') || null;
      let art = null;
      if (artUrl && !skipArt) art = await fetchArtBlob(artUrl);
      return { col, songs, art, artUrl, artFetched: !skipArt };
    } catch (e) { return null; }
  }

  async function ensureListingArt(l) {
    if (!l || l.artFetched) return l ? l.art : null;
    l.artFetched = true;
    if (l.artUrl && !l.art) l.art = await fetchArtBlob(l.artUrl);
    return l.art;
  }

  async function albumTrackListing(albumName, artistName) {
    const ck = (artistName || '') + '|||' + albumName;
    if (listingCache.has(ck)) return listingCache.get(ck);
    let out = null;
    try {
      const q = (artistName ? artistName + ' ' : '') + albumName;
      const sd = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&entity=song&limit=10', 12000);
      if (sd && sd.resultCount) {
        const na = norm(albumName), nar = norm(artistName);
        let colId = 0;
        for (const r of sd.results) {
          const rn = norm(r.collectionName), ra = norm(r.artistName);
          const nameOK = rn === na || rn.indexOf(na) !== -1 || na.indexOf(rn) !== -1;
          const artOK = !nar || ra === nar || ra.indexOf(nar) !== -1 || nar.indexOf(ra) !== -1;
          if (r.collectionId && nameOK && artOK) { colId = r.collectionId; break; }
        }
        if (colId) out = await listingFromCollectionId(colId);
      }
    } catch (e) {}
    listingCache.set(ck, out);
    return out;
  }

  async function candidateListings(seedAlbums, seedArtists) {
    const out = [];
    const seenCol = new Set();
    const push = l => {
      const id = l && l.col && l.col.collectionId;
      if (l && id && !seenCol.has(id)) { seenCol.add(id); out.push(l); }
    };
    for (const a of (seedAlbums || [])) {
      if (!a || !a.name || a.name === 'Unknown Album') continue;
      push(await albumTrackListing(a.name, a.artist));
    }
    for (const ar of (seedArtists || [])) {
      if (!ar || ar === 'Unknown Artist') continue;
      if (artistListingsCache.has(ar)) { artistListingsCache.get(ar).forEach(push); continue; }
      const got = [];
      try {
        const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(ar) + '&entity=song&limit=200', 12000);
        if (d && d.resultCount) {
          const nar = norm(ar);
          const mine = d.results.filter(r => {
            const ra = norm(r.artistName);
            return ra === nar || ra.indexOf(nar) !== -1 || nar.indexOf(ra) !== -1;
          });
          const ids = [...new Set(mine.map(r => r.collectionId).filter(Boolean))].slice(0, 6);
          for (const id of ids) {
            const l = await listingFromCollectionId(id, true); // art lazy
            if (l && l.col && l.col.collectionId && !seenCol.has(l.col.collectionId)) { seenCol.add(l.col.collectionId); out.push(l); got.push(l); }
          }
        }
      } catch (e) {}
      artistListingsCache.set(ar, got);
    }
    // Full albums before single releases: a track on both gets album tagging.
    out.sort((a, b) => b.songs.length - a.songs.length);
    return out;
  }

  function matchListingTitle(title, songs, used, exactOnly) {
    for (const s of songs) {
      if (used.has(s.trackId)) continue;
      if (titleMatches(title, s.trackName, exactOnly)) { used.add(s.trackId); return s; }
    }
    return null;
  }

  // Multi-signal match of a local track against a catalog track listing:
  // title resemblance first, then filename track-number + duration.
  function matchTrackMulti(t, songs, used) {
    const num = leadNumber(t.fileName);
    for (const s of songs) {
      if (used.has(s.trackId)) continue;
      if (durationVeto(t.duration || 0, s.trackTimeMillis || 0)) continue;
      if (titleSimilar(t.title, s.trackName)) { used.add(s.trackId); return s; }
    }
    for (const s of songs) {
      if (used.has(s.trackId)) continue;
      if (durationVeto(t.duration || 0, s.trackTimeMillis || 0)) continue;
      const sdur = (s.trackTimeMillis || 0) / 1000, dur = t.duration || 0;
      if (num > 0 && s.trackNumber === num && (s.discNumber || 1) === (t.discNo || 1) &&
          dur > 0 && sdur > 0 && Math.abs(dur - sdur) <= 6) {
        used.add(s.trackId); return s;
      }
    }
    return null;
  }

  // Apply a catalog track to a local track record. Returns true if changed.
  function applyListing(tr, s, col, art) {
    const before = [tr.title, tr.artist, tr.album, tr.albumArtist, tr.genre, tr.year, tr.trackNo, tr.discNo, !!tr.art].join('|');
    tr.title = s.trackName || tr.title;
    tr.artist = s.artistName || tr.artist;
    tr.album = col.collectionName || tr.album;
    tr.albumArtist = col.artistName || tr.albumArtist;
    tr.genre = s.primaryGenreName || col.primaryGenreName || tr.genre;
    tr.year = (col.releaseDate || '').slice(0, 4) || tr.year;
    tr.trackNo = s.trackNumber || tr.trackNo;
    tr.discNo = s.discNumber || tr.discNo;
    tr.tagsVia = 'Apple Music';
    // Take the listing's artwork: listings are tried albums-first, so an
    // album track gets the album art, not a stale single cover.
    // Hand-set artwork is never overwritten.
    if (art && !tr.artManual) { tr.art = art; if (!tr.artSource) tr.artSource = 'Apple Music'; }
    tr.tagged = true;
    if ((tr.diag || '').indexOf('fix v') === 0) tr.diag = 'reader-ok';
    return [tr.title, tr.artist, tr.album, tr.albumArtist, tr.genre, tr.year, tr.trackNo, tr.discNo, !!tr.art].join('|') !== before;
  }

  /* ---- AcoustID: the fingerprint is computed on-device (see demo/
     fingerprint.js for a chromaprint example); only the fingerprint +
     duration go to AcoustID for lookup. POST: long fingerprints choke GET
     URLs. The key is supplied by the host, never hardcoded. ---- */

  async function acoustidLookupUngated(fp, durSec, key) {
    if (!key) return null;
    const body = 'client=' + encodeURIComponent(key) +
      '&fingerprint=' + encodeURIComponent(fp) +
      '&duration=' + Math.max(1, Math.round(durSec || 0)) +
      '&meta=recordings+releasegroups';
    let d = null;
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 15000);
      const r = await fetch('https://api.acoustid.org/v2/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: c.signal,
      });
      clearTimeout(t);
      if (r.ok) d = await r.json();
    } catch (e) {}
    if (!d || !d.results || !d.results.length) return null;
    // Best recording across all results, highest AcoustID score wins.
    let best = null;
    for (const res of d.results) {
      const s = Number(res.score || 0);
      for (const rec of (res.recordings || [])) {
        if (!best || s > best.score) best = { score: s, rec };
      }
    }
    return best;
  }

  /* ---- generic catalog helpers, handy for ownership implementations ---- */

  // Does the named artist's catalog actually contain this title?
  async function artistHasSong(artist, title) {
    try {
      if (!artist || !title || title === 'Unknown Title') return false;
      const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(artist + ' ' + title) + '&media=music&entity=song&limit=8', 12000);
      if (!d || !d.resultCount) return false;
      for (const r of d.results) {
        if (strSim(r.trackName, title) * 0.6 + strSim(r.artistName, artist) * 0.4 >= 0.8) return true;
      }
    } catch (e) {}
    return false;
  }

  // Is this a real catalog artist at all? Unknown-to-Apple proves nothing.
  async function artistKnown(artist) {
    try {
      if (!artist || artist === 'Unknown Artist') return false;
      const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(artist) + '&media=music&entity=musicArtist&limit=5', 12000);
      if (!d || !d.resultCount) return false;
      for (const r of d.results) {
        if (strSim(r.artistName || '', artist) >= 0.8) return true;
      }
    } catch (e) {}
    return false;
  }

  return {
    autoTagQuery: (tr, q) => gate(() => autoTagQueryUngated(tr, q)),
    autoTagDeezerArt: (tr, q) => gate(() => autoTagDeezerArtUngated(tr, q)),
    artChainExtra,
    appleAudit, deezerAudit, mbProposal, mbPick,
    listingFromCollectionId, albumTrackListing, candidateListings,
    matchListingTitle, matchTrackMulti, applyListing, ensureListingArt,
    acoustidLookup: (fp, dur, key) => gate(() => acoustidLookupUngated(fp, dur, key)),
    artistKnown, artistHasSong,
  };
}
