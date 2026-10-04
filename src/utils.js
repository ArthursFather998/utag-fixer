/* utag-fixer: pure string, matching, and fetch helpers. No side effects. */

export function fmtDur(s) {
  if (!s || !isFinite(s)) return '';
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function baseTitle(name) {
  return (name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

// Lowercase, collapse every non-alphanumeric run to one space.
export function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Spaceless lowercase compare, so glued file names match spaced titles.
export const compact = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Levenshtein-based similarity in [0,1].
export function strSim(a, b) {
  a = (a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  b = (b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  let prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    const t = prev; prev = cur; cur = t;
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

// Title matching: normalized compare plus a spaceless compare so glued
// filenames ("SongfeatGuest") match spaced catalog titles.
export function titleMatches(a, b, exactOnly) {
  const nt = norm(a), rt = norm(b);
  if (!exactOnly && (rt === nt || rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1)) return true;
  const cn = compact(a), ct = compact(b);
  if (!cn || !ct) return false;
  if (exactOnly) return ct === cn;
  return cn.length >= 6 && ct.length >= 6 && (ct === cn || ct.indexOf(cn) !== -1 || cn.indexOf(ct) !== -1);
}

// Title resemblance without any catalog search.
export function titleSimilar(a, b) {
  const nt = norm(a), rt = norm(b);
  if (rt === nt || rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1) return true;
  const cn = compact(a), ct = compact(b);
  return cn.length >= 6 && ct.length >= 6 && (ct === cn || ct.indexOf(cn) !== -1 || cn.indexOf(ct) !== -1);
}

// JSON GET with a timeout. Returns null on any failure (offline included).
export async function fetchJSON(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Race a promise against a timeout so one slow op can never wedge a run.
export function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + (label || 'op'))), ms); });
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), to]);
}

// Fetch an artwork URL with a 6s timeout. Returns the Blob, false when the
// URL definitively has no image (404, try the next candidate), or null when
// the fetch flaked (the URL string is still a viable fallback).
export async function artBlob(url) {
  try {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), 6000);
    const rr = await fetch(url, { signal: c.signal });
    clearTimeout(tm);
    if (rr.status === 404) return false;
    if (rr.ok) {
      const b = await rr.blob();
      if (b && b.size > 1000) return b;
    }
  } catch (e) {}
  return null;
}

// Blob-first artwork fetch with URL fallback, shared by the catalog passes.
export async function fetchArtBlob(au) {
  try {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), 6000);
    const rr = await fetch(au, { signal: c.signal });
    clearTimeout(tm);
    if (rr.ok) {
      const b = await rr.blob();
      if (b && b.size > 1000) return b;
    }
  } catch (e) {}
  return au || null; // URL string still displays if the download flaked
}

// Ordinal hint from a filename or title: a-side -> 0, b-side -> 1, part
// 1/2, trailing 1/2 or i/ii. Null when there is no hint.
export function ordinalHint(name) {
  const c = compact(name || '');
  if (c.indexOf('bside') !== -1) return 1;
  if (c.indexOf('aside') !== -1) return 0;
  const n = ' ' + norm(name) + ' ';
  const m = n.match(/\b(?:part|pt|disc)\s*([12])\b/) || n.match(/\b([12]|i|ii)\s*$/);
  if (m) return (m[1] === '1' || m[1] === 'i') ? 0 : 1;
  return null;
}

// Leading track number from a filename ("07 - Title.mp3" -> 7).
export function leadNumber(name) {
  const b = (name || '').split('/').pop();
  const m = b.match(/^\s*0*(\d{1,3})\b/);
  return m ? parseInt(m[1], 10) : 0;
}

// Reject a catalog candidate when both durations are known and far apart.
export function durationVeto(trackDur, catalogMs) {
  const sdur = (catalogMs || 0) / 1000;
  return trackDur > 0 && sdur > 0 && Math.abs(trackDur - sdur) > 8;
}

/* ---- filename parsing (v7.8 scored candidates) ----
   Real-world file names are feral, so instead of one "Artist - Title"
   guess this builds scored parse candidates:
     "01. Artist - Title", "Artist_-_Title", "[DL] A - T",
     "Title - Artist" (reversed, wins only when tag hints agree),
     folder paths (".../Album Name/02 - Title.flac" -> album),
     leading track numbers, feat. artists.
   Audio qualifiers ("(Sped Up)", "(Remix)", "(Live)") are PRESERVED in
   titles, only downloader/video junk is stripped, so a stripped query
   can never propose dropping a qualifier the confidence gates protect.
   A candidate seeds a catalog query only when it carries BOTH artist and
   title: an artist-less file name ("Track 01.mp3") must never seed one. */

const FOLDER_JUNK = /^(downloads?|music|audio|mp3s?|flacs?|m4as?|songs?|tracks?|new folder|untitled|various( artists)?|my music|itunes|library)$/i;

export function stripFileJunk(s) {
  return (s || '')
    .replace(/\[[^\]]*(spotify.downloader|downloader|free download|320\s?kbps|\bmp3\b|\bflac\b|\bm4a\b)[^\]]*\]/gi, '')
    .replace(/[\[\(]\s*(official\s+(audio|video|music\s+video)|lyrics?|audio|video|hd|4k|hq|mv)\s*[\]\)]/gi, '')
    .replace(/[\[\(]\s*(19|20)\d{2}\s*[\]\)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseFeat(title) {
  const m = (title || '').match(/[\[\(]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[\]\)]/i);
  return m ? m[1].trim() : '';
}

export function fileNameCandidates(name, folderPath, hints) {
  const out = { list: [], album: null, trackNo: 0 };
  let b = baseTitle(name || '').replace(/_+/g, ' ').replace(/\.{2,}/g, ' ');
  b = stripFileJunk(b);
  const ln = b.match(/^\s*0*(\d{1,3})\s*[.\-–—)\]:]\s+/);
  if (ln && b.slice(ln[0].length).trim()) {
    out.trackNo = parseInt(ln[1], 10);
    b = b.slice(ln[0].length).trim();
  }
  if (folderPath) {
    const parts = String(folderPath).split(/[\\/]/).filter(p => p && p.trim());
    const folder = (parts[parts.length - 1] || '').trim();
    const fm = folder.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
    const alb = (fm ? fm[2] : folder).trim();
    if (alb && alb.length >= 2 && !FOLDER_JUNK.test(alb)) out.album = alb;
  }
  const ha = hints && hints.artist && hints.artist !== 'Unknown Artist' ? hints.artist : '';
  const ht = hints && hints.title && hints.title !== 'Unknown Title' ? hints.title : '';
  const seen = new Set();
  const push = (artist, title, score) => {
    artist = (artist || '').replace(/\s+/g, ' ').trim();
    title = (title || '').replace(/\s+/g, ' ').trim();
    if (!artist || !title || /^unknown (artist|title)$/i.test(artist) || /^unknown (artist|title)$/i.test(title)) return;
    const k = artist.toLowerCase() + '|||' + title.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    let s = score;
    if (ha || ht) s += 0.5 * strSim(artist, ha) + 0.5 * strSim(title, ht);
    out.list.push({ artist, title, score: s, feat: parseFeat(title), trackNo: out.trackNo, album: out.album });
  };
  const m = b.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
  if (m) {
    push(m[1], m[2], 1.0);  // forward
    push(m[2], m[1], 0.55); // reversed, wins only when tag hints agree
  }
  out.list.sort((x, y) => y.score - x.score);
  return out;
}

export function splitArtistTitle(name) {
  const c = fileNameCandidates(name).list[0];
  if (c) return { artist: c.artist, title: c.title };
  const b = baseTitle(name || '').trim();
  return { artist: 'Unknown Artist', title: b || 'Unknown Title' };
}
