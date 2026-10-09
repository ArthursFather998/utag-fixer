// UTAG Fixer verification pipeline — Edge Function (Phase 2: heuristic, no AI).
//
// POST /verify  { artist, title?, album?, duration_ms?, year? }
// Pipeline: site-password gate -> canonical rules -> DB-first lookup ->
//   source fan-out (Apple Music / Deezer / MusicBrainz) -> normalize +
//   heuristic scoring -> persist (source_results, artists, releases,
//   tracks, artwork candidates, verifications) -> verified bundle.
//
// Confidence states: verified | high_confidence | needs_review |
//                    conflicting | unknown
// 'verified' is reserved for human approval (review queue) or the Phase 5
// AI adjudicator. The heuristic never assigns it.
//
// Env (all auto-provided in Edge Functions except SITE_PASSWORD):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_PASSWORD (optional)
//
// Deploy: supabase functions deploy verify
// Test:   curl -X POST $URL/functions/v1/verify -H "x-site-password: ..." \
//           -H "Content-Type: application/json" \
//           -d '{"artist":"Frank Ocean","title":"Nights"}'

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

/* ---------------- string utils (ported from utag-fixer src/utils.js) ------ */

const norm = (s: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const compact = (s: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Levenshtein-based similarity in [0,1].
function strSim(a: string, b: string): number {
  a = compact(a); b = compact(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  let prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

function titleSimilar(a: string, b: string): boolean {
  const nt = norm(a), rt = norm(b);
  if (rt === nt || rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1) return true;
  const cn = compact(a), ct = compact(b);
  return cn.length >= 6 && ct.length >= 6 &&
    (ct === cn || ct.indexOf(cn) !== -1 || cn.indexOf(ct) !== -1);
}

/* ---------------- http helper --------------------------------------------- */

async function fetchJSON(url: string, ms: number, headers?: Record<string, string>): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: c.signal, headers });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const MB_UA = "UTAG-Fixer/1.0 (metadata verification; contact: utag-db)";

/* ---------------- normalized candidate ------------------------------------ */

interface Candidate {
  source: string;
  title: string;
  artist: string;
  album: string;
  year: string | null;
  genre: string | null;
  trackNo: number | null;
  discNo: number;
  isrc: string | null;
  duration_ms: number | null;
  artUrl: string | null;
  ids: Record<string, string>;
  raw: any;
}

/* ---------------- source clients ------------------------------------------ */

async function appleSearch(artist: string, title: string): Promise<Candidate[]> {
  const q = [artist, title].filter(Boolean).join(" ").trim();
  if (!q) return [];
  const d = await fetchJSON(
    "https://itunes.apple.com/search?term=" + encodeURIComponent(q) +
    "&media=music&entity=song&limit=8", 12000);
  if (!d || !d.resultCount || !d.results) return [];
  return d.results.map((r: any): Candidate => ({
    source: "apple",
    title: r.trackName || "",
    artist: r.artistName || "",
    album: r.collectionName || "",
    year: (r.releaseDate || "").slice(0, 4) || null,
    genre: r.primaryGenreName || null,
    trackNo: r.trackNumber || null,
    discNo: r.discNumber || 1,
    isrc: r.isrc || null,
    duration_ms: r.trackTimeMillis || null,
    artUrl: (r.artworkUrl100 || "").replace("100x100bb", "1200x1200bb") || null,
    ids: {
      trackId: String(r.trackId || ""),
      collectionId: String(r.collectionId || ""),
      artistId: String(r.artistId || ""),
    },
    raw: r,
  }));
}

async function deezerSearch(artist: string, title: string): Promise<Candidate[]> {
  const q = [artist, title].filter(Boolean).join(" ").trim();
  if (!q) return [];
  const d = await fetchJSON(
    "https://api.deezer.com/search?q=" + encodeURIComponent(q) + "&limit=8", 12000);
  if (!d || !d.total || !d.data) return [];
  return d.data.map((r: any): Candidate => ({
    source: "deezer",
    title: r.title || "",
    artist: (r.artist && r.artist.name) || "",
    album: (r.album && r.album.title) || "",
    year: null,
    genre: null,
    trackNo: r.track_position || null,
    discNo: r.disk_number || 1,
    isrc: r.isrc || null,
    duration_ms: (r.duration || 0) * 1000 || null,
    artUrl: (r.album && (r.album.cover_xl || r.album.cover_big)) || null,
    ids: {
      trackId: String(r.id || ""),
      albumId: String((r.album && r.album.id) || ""),
      artistId: String((r.artist && r.artist.id) || ""),
    },
    raw: r,
  }));
}

async function mbSearch(title: string, artist: string): Promise<Candidate[]> {
  if (!title) return [];
  let query = `recording:"${title.replace(/"/g, "")}"`;
  if (artist) query += ` AND artist:"${artist.replace(/"/g, "")}"`;
  const d = await fetchJSON(
    "https://musicbrainz.org/ws/2/recording/?query=" + encodeURIComponent(query) +
    "&fmt=json&limit=5", 12000, { "User-Agent": MB_UA });
  if (!d || !d.recordings) return [];
  return d.recordings.map((rec: any): Candidate => {
    const mbArtist = (rec["artist-credit"] || [])
      .map((a: any) => (a.name || "") + (a.joinphrase || "")).join("").trim();
    const rel = (rec.releases || [])[0] || {};
    return {
      source: "musicbrainz",
      title: rec.title || "",
      artist: mbArtist,
      album: rel.title || "",
      year: (rel.date || "").slice(0, 4) || null,
      genre: null,
      trackNo: null,
      discNo: 1,
      isrc: (rec.isrcs || [])[0] || null,
      duration_ms: rec.length || null,
      // Cover Art Archive art resolves per release in Phase 3; the release
      // MBID is the join key.
      artUrl: rel.id ? "https://coverartarchive.org/release/" + rel.id + "/front" : null,
      ids: { recordingId: rec.id || "", releaseId: rel.id || "" },
      raw: rec,
    };
  });
}

async function appleArtistSearch(artist: string): Promise<any[]> {
  if (!artist) return [];
  const d = await fetchJSON(
    "https://itunes.apple.com/search?term=" + encodeURIComponent(artist) +
    "&media=music&entity=musicArtist&limit=5", 12000);
  return (d && d.results) || [];
}

async function mbArtistSearch(artist: string): Promise<any[]> {
  if (!artist) return [];
  const d = await fetchJSON(
    "https://musicbrainz.org/ws/2/artist/?query=" +
    encodeURIComponent(`artist:"${artist.replace(/"/g, "")}"`) +
    "&fmt=json&limit=5", 12000, { "User-Agent": MB_UA });
  return (d && d.artists) || [];
}

/* ---------------- scoring --------------------------------------------------- */

interface VerifyInput {
  artist: string;
  title?: string;
  album?: string;
  duration_ms?: number;
  year?: string;
}

function scoreCandidate(c: Candidate, input: VerifyInput): number {
  const ts = input.title ? strSim(c.title, input.title) : 1;
  const as = input.artist ? strSim(c.artist, input.artist) : 1;
  let s = ts * 0.55 + as * 0.35;
  if (input.duration_ms && c.duration_ms) {
    const d = Math.abs(input.duration_ms - c.duration_ms) / 1000;
    s += d <= 8 ? 0.1 * (1 - d / 8) : -0.1;
  }
  return Math.max(0, s);
}

// Sources agreeing on the same album title is strong evidence they found
// the same release, not just similar songs.
function agreementBonus(cands: Candidate[], top: Candidate): number {
  const nal = norm(top.album);
  if (!nal) return 0;
  const agreers = new Set(cands.filter((c) => norm(c.album) === nal).map((c) => c.source));
  return agreers.size >= 2 ? 0.05 : 0;
}

function confidenceFor(score: number, sourcesAgreeing: number): { confidence: number; status: string } {
  if (score >= 0.9 && sourcesAgreeing >= 2) return { confidence: Math.min(0.97, score), status: "high_confidence" };
  if (score >= 0.85) return { confidence: score, status: "needs_review" };
  if (score >= 0.7) return { confidence: score, status: "needs_review" };
  return { confidence: score, status: "unknown" };
}

/* ---------------- db helpers ------------------------------------------------ */

function db() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function applyCanonicalRules(supabase: any, name: string): Promise<string> {
  if (!name) return name;
  try {
    const { data } = await supabase.from("canonical_rules")
      .select("pattern,replacement").eq("rule_type", "artist_alias");
    let out = name;
    for (const r of data || []) {
      try {
        if (new RegExp(r.pattern, "i").test(out)) out = r.replacement;
      } catch (_e) { /* bad rule pattern: skip */ }
    }
    return out;
  } catch (_e) {
    return name;
  }
}

async function findArtist(supabase: any, name: string): Promise<any | null> {
  const lname = name.toLowerCase();
  const { data } = await supabase.from("artists").select("*")
    .ilike("canonical_name", name).limit(5);
  for (const a of data || []) {
    if (norm(a.canonical_name) === norm(name)) return a;
  }
  // alias match (aliases are stored lowercased)
  const { data: data2 } = await supabase.from("artists").select("*")
    .contains("aliases", [lname]).limit(5);
  return (data2 && data2[0]) || null;
}

async function findRelease(supabase: any, artistId: string, title: string, edition = "original"): Promise<any | null> {
  const { data } = await supabase.from("releases").select("*")
    .eq("artist_id", artistId).ilike("title", title).limit(10);
  for (const r of data || []) {
    if (norm(r.title) === norm(title) && (r.edition || "original") === edition) return r;
  }
  return null;
}

async function findTrack(supabase: any, releaseId: string, title: string): Promise<any | null> {
  const { data } = await supabase.from("tracks").select("*")
    .eq("release_id", releaseId).ilike("title", title).limit(10);
  for (const t of data || []) {
    if (norm(t.title) === norm(title)) return t;
  }
  return null;
}

async function canonicalArtwork(supabase: any, releaseId: string): Promise<any | null> {
  const { data } = await supabase.from("artwork").select("*")
    .eq("release_id", releaseId).eq("role", "canonical").limit(1);
  if (data && data[0]) return data[0];
  const { data: data2 } = await supabase.from("artwork").select("*")
    .eq("release_id", releaseId).order("created_at", { ascending: false }).limit(1);
  return (data2 && data2[0]) || null;
}

/* ---------------- persistence ----------------------------------------------- */

async function persistVerification(supabase: any, args: {
  input: VerifyInput;
  winner: Candidate | null;
  winnerScore: number;
  status: string;
  confidence: number;
  candidates: Candidate[];
  rawPayloads: Record<string, any>;
  artistRow: any | null;
  releaseRow: any | null;
  trackRow: any | null;
}): Promise<string> {
  const { data, error } = await supabase.from("verifications").insert({
    entity_type: args.input.title ? "track" : "artist",
    entity_id: args.trackRow?.id || args.releaseRow?.id || args.artistRow?.id || null,
    input: args.input,
    candidates: args.candidates.map((c) => ({
      source: c.source, title: c.title, artist: c.artist, album: c.album,
      year: c.year, genre: c.genre, trackNo: c.trackNo, isrc: c.isrc,
      duration_ms: c.duration_ms, artUrl: c.artUrl, ids: c.ids,
      score: scoreCandidate(c, args.input),
    })),
    decision: args.winner ? {
      source: args.winner.source, title: args.winner.title, artist: args.winner.artist,
      album: args.winner.album, year: args.winner.year, genre: args.winner.genre,
      trackNo: args.winner.trackNo, discNo: args.winner.discNo, isrc: args.winner.isrc,
      artUrl: args.winner.artUrl, ids: args.winner.ids,
    } : null,
    rationale: args.winner
      ? `Heuristic pick: ${args.winner.source} scored ${args.winnerScore.toFixed(3)} ` +
        `(title/artist similarity${args.input.duration_ms ? " + duration" : ""}). ` +
        `No AI adjudication yet (Phase 2); 'verified' requires human approval or Phase 5.`
      : "No candidate cleared the scoring bar.",
    field_confidence: args.winner ? {
      title: args.winnerScore, artist: args.winnerScore,
      album: Math.max(0, args.winnerScore - 0.05),
    } : {},
    overall_confidence: args.status,
    status: args.status,
    model: "heuristic",
    created_by: "verify-function",
  }).select("id").single();
  if (error) throw error;
  return data.id;
}

async function storeSourceResults(supabase: any, queryType: string, queryText: string,
  payloads: Record<string, any>): Promise<void> {
  const rows = Object.entries(payloads)
    .filter(([, p]) => p != null)
    .map(([source, payload]) => ({ source, query_type: queryType, query_text: queryText, payload }));
  if (rows.length) await supabase.from("source_results").insert(rows);
}

/* ---------------- main handler ---------------------------------------------- */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-site-password",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Site-password gate: protects the endpoint (and later Groq spend) once
  // SITE_PASSWORD is set. Unset = open (dev).
  const sitePw = Deno.env.get("SITE_PASSWORD");
  const provided = req.headers.get("x-site-password") || "";
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* empty body */ }
  if (sitePw && provided !== sitePw && body.site_password !== sitePw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const input: VerifyInput = {
    artist: (body.artist || "").trim(),
    title: (body.title || "").trim() || undefined,
    album: (body.album || "").trim() || undefined,
    duration_ms: body.duration_ms || undefined,
    year: body.year || undefined,
  };
  if (!input.artist) {
    return new Response(JSON.stringify({ error: "artist is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = db();
  const ok = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    // 1. Canonical rules first: learned aliases collapse before anything else.
    input.artist = await applyCanonicalRules(supabase, input.artist);

    // 2. DB-first lookup.
    const artistRow = await findArtist(supabase, input.artist);
    if (!input.title) {
      // Artist-only verification path ("find everything you know about X").
      if (artistRow && (artistRow.status === "verified" || artistRow.status === "high_confidence")) {
        const releases = await supabase.from("releases").select("id,title,release_type,edition,release_year,status").eq("artist_id", artistRow.id).limit(50);
        return ok({ db_hit: true, status: artistRow.status, confidence: 1, artist: artistRow, releases: releases.data || [] });
      }
      return ok(await verifyArtist(supabase, input.artist));
    }

    if (artistRow) {
      const rel = input.album
        ? await findRelease(supabase, artistRow.id, input.album)
        : null;
      const releaseRow = rel || (await firstRelease(supabase, artistRow.id, input.title));
      if (releaseRow) {
        const trackRow = await findTrack(supabase, releaseRow.id, input.title);
        if (trackRow && (trackRow.status === "verified" || trackRow.status === "high_confidence")) {
          const art = await canonicalArtwork(supabase, releaseRow.id);
          return ok({
            db_hit: true, status: trackRow.status, confidence: 1,
            artist: artistRow, release: releaseRow, track: trackRow,
            artwork: art, verification_id: null,
          });
        }
      }
    }

    // 3-6. Source fan-out, scoring, persistence.
    return ok(await verifyTrack(supabase, input, artistRow));
  } catch (e) {
    return ok({ error: "verify failed", detail: String((e as Error)?.message || e) }, 500);
  }
});

async function firstRelease(supabase: any, artistId: string, title: string): Promise<any | null> {
  // No album given: find any release of this artist whose tracks include
  // the title, via a track search across their releases.
  const { data: releases } = await supabase.from("releases").select("id").eq("artist_id", artistId).limit(50);
  for (const r of releases || []) {
    const t = await findTrack(supabase, r.id, title);
    if (t) {
      const { data } = await supabase.from("releases").select("*").eq("id", r.id).single();
      return data;
    }
  }
  return null;
}

/* ---------------- track verification ---------------------------------------- */

function detectEdition(albumTitle: string): string {
  const t = " " + norm(albumTitle) + " ";
  if (t.includes(" deluxe ")) return "deluxe";
  if (t.includes(" remaster")) return "remaster";
  if (t.includes(" reissue ")) return "reissue";
  if (t.includes(" anniversary ")) return "anniversary";
  return "original";
}

function detectReleaseType(albumTitle: string): string {
  const t = norm(albumTitle);
  if (t.endsWith(" single")) return "single";
  if (t.endsWith(" ep")) return "ep";
  return "album";
}

function trimPayload(cands: Candidate[]): any[] {
  return cands.slice(0, 8).map((c) => ({
    title: c.title, artist: c.artist, album: c.album, year: c.year,
    genre: c.genre, trackNo: c.trackNo, isrc: c.isrc,
    duration_ms: c.duration_ms, artUrl: c.artUrl, ids: c.ids,
  }));
}

async function verifyTrack(supabase: any, input: VerifyInput, artistRow: any | null): Promise<any> {
  const queryText = [input.artist, input.title, input.album].filter(Boolean).join(" ");

  // 3. Source fan-out (parallel).
  const [apple, deezer, mb] = await Promise.all([
    appleSearch(input.artist, input.title || ""),
    deezerSearch(input.artist, input.title || ""),
    mbSearch(input.title || "", input.artist),
  ]);
  const cands = [...apple, ...deezer, ...mb];

  await storeSourceResults(supabase, "track", queryText, {
    apple: trimPayload(apple), deezer: trimPayload(deezer), musicbrainz: trimPayload(mb),
  });

  if (!cands.length) {
    const vid = await persistVerification(supabase, {
      input, winner: null, winnerScore: 0, status: "unknown", confidence: 0,
      candidates: [], rawPayloads: {}, artistRow, releaseRow: null, trackRow: null,
    });
    return { db_hit: false, status: "unknown", confidence: 0, input, verification_id: vid, note: "No source returned a candidate." };
  }

  // 4. Score + agreement.
  const scored = cands.map((c) => ({ c, s: scoreCandidate(c, input) + agreementBonus(cands, c) }));
  scored.sort((a, b) => b.s - a.s);
  const winner = scored[0].c;
  const winnerScore = scored[0].s;
  const agreers = new Set(
    cands.filter((c) => norm(c.album) && norm(c.album) === norm(winner.album)).map((c) => c.source)
  );
  const { confidence, status } = confidenceFor(winnerScore, agreers.size);

  // 5. Persist: artist -> release -> track -> artwork candidates.
  let artist = artistRow;
  if (!artist) {
    const { data, error } = await supabase.from("artists").insert({
      canonical_name: winner.artist || input.artist,
      aliases: norm(winner.artist || "") !== norm(input.artist) ? [input.artist.toLowerCase()] : [],
      spotify_id: null, apple_id: winner.ids.artistId || null,
      deezer_id: winner.ids.artistId && winner.source === "deezer" ? winner.ids.artistId : null,
      mbid: winner.source === "musicbrainz" ? winner.ids.recordingId || null : null,
      genres: winner.genre ? [winner.genre] : [],
      confidence: status, status,
    }).select("*").single();
    if (error) throw error;
    artist = data;
  } else if (norm(artist.canonical_name) !== norm(input.artist) &&
             !(artist.aliases || []).includes(input.artist.toLowerCase())) {
    await supabase.from("artists").update({
      aliases: [...(artist.aliases || []), input.artist.toLowerCase()],
    }).eq("id", artist.id);
  }

  const edition = detectEdition(winner.album);
  let release = await findRelease(supabase, artist.id, winner.album, edition);
  if (!release) {
    const { data, error } = await supabase.from("releases").insert({
      artist_id: artist.id,
      title: winner.album || input.album || "Unknown Album",
      release_type: detectReleaseType(winner.album),
      edition,
      release_year: winner.year ? parseInt(winner.year, 10) || null : (input.year ? parseInt(input.year, 10) || null : null),
      label: null,
      spotify_id: null,
      apple_id: winner.source === "apple" ? winner.ids.collectionId || null : null,
      deezer_id: winner.source === "deezer" ? winner.ids.albumId || null : null,
      mbid: winner.source === "musicbrainz" ? winner.ids.releaseId || null : null,
      confidence: status, status,
    }).select("*").single();
    if (error) throw error;
    release = data;
  }

  let track = await findTrack(supabase, release.id, winner.title);
  if (!track) {
    const { data, error } = await supabase.from("tracks").insert({
      release_id: release.id,
      artist_id: artist.id,
      title: winner.title || input.title,
      track_number: winner.trackNo,
      disc_number: winner.discNo || 1,
      isrc: winner.isrc,
      duration_ms: winner.duration_ms,
      apple_id: winner.source === "apple" ? winner.ids.trackId || null : null,
      deezer_id: winner.source === "deezer" ? winner.ids.trackId || null : null,
      mbid: winner.source === "musicbrainz" ? winner.ids.recordingId || null : null,
      confidence: status, status,
    }).select("*").single();
    if (error) throw error;
    track = data;
  }

  // Artwork candidates (canonical selection is Phase 3's job).
  const artUrls = new Map<string, Candidate>();
  for (const { c } of scored.slice(0, 6)) {
    if (c.artUrl && !artUrls.has(c.artUrl)) artUrls.set(c.artUrl, c);
  }
  for (const [url, c] of artUrls) {
    await supabase.from("artwork").insert({
      release_id: release.id,
      source_url: url,
      source: c.source,
      role: "candidate",
      edition_label: edition !== "original" ? edition : null,
      confidence: status, status,
    });
  }

  const verification_id = await persistVerification(supabase, {
    input, winner, winnerScore, status, confidence,
    candidates: cands, rawPayloads: {},
    artistRow: artist, releaseRow: release, trackRow: track,
  });

  return {
    db_hit: false, status, confidence,
    artist, release, track,
    artwork_url: winner.artUrl,
    artwork_source: winner.source,
    artwork_note: "Candidate artwork from the winning source; canonical selection is Phase 3.",
    sources_queried: ["apple", "deezer", "musicbrainz"],
    sources_agreeing: [...agreers],
    verification_id,
  };
}

/* ---------------- artist verification --------------------------------------- */

async function verifyArtist(supabase: any, name: string): Promise<any> {
  const [appleArtists, mbArtists] = await Promise.all([
    appleArtistSearch(name), mbArtistSearch(name),
  ]);

  await storeSourceResults(supabase, "artist", name, {
    apple: (appleArtists || []).slice(0, 5).map((a: any) => ({ name: a.artistName, id: a.artistId })),
    musicbrainz: (mbArtists || []).slice(0, 5).map((a: any) => ({ name: a.name, id: a.id, disambiguation: a.disambiguation })),
  });

  let best: { name: string; source: string; ids: Record<string, string>; score: number } | null = null;
  for (const a of appleArtists || []) {
    const s = strSim(a.artistName || "", name);
    if (!best || s > best.score) {
      best = { name: a.artistName, source: "apple", ids: { artistId: String(a.artistId || "") }, score: s };
    }
  }
  for (const a of mbArtists || []) {
    const s = strSim(a.name || "", name);
    if (!best || s > best.score) {
      best = { name: a.name, source: "musicbrainz", ids: { mbid: a.id || "" }, score: s };
    }
  }

  if (!best || best.score < 0.7) {
    const { data } = await supabase.from("verifications").insert({
      entity_type: "artist", input: { artist: name }, decision: null,
      rationale: "No source returned a confident artist match.",
      overall_confidence: "unknown", status: "unknown",
      model: "heuristic", created_by: "verify-function",
    }).select("id").single();
    return { db_hit: false, status: "unknown", confidence: best?.score || 0, input: { artist: name }, verification_id: data?.id || null };
  }

  const { confidence, status } = best.score >= 0.95
    ? { confidence: best.score, status: "high_confidence" }
    : { confidence: best.score, status: "needs_review" };

  let artist = await findArtist(supabase, best.name);
  if (!artist) {
    const { data, error } = await supabase.from("artists").insert({
      canonical_name: best.name,
      aliases: norm(best.name) !== norm(name) ? [name.toLowerCase()] : [],
      mbid: best.ids.mbid || null,
      apple_id: best.ids.artistId || null,
      confidence: status, status,
    }).select("*").single();
    if (error) throw error;
    artist = data;
  }

  const { data: v } = await supabase.from("verifications").insert({
    entity_type: "artist", entity_id: artist.id,
    input: { artist: name },
    candidates: [
      ...(appleArtists || []).slice(0, 5).map((a: any) => ({ source: "apple", name: a.artistName, score: strSim(a.artistName || "", name) })),
      ...(mbArtists || []).slice(0, 5).map((a: any) => ({ source: "musicbrainz", name: a.name, score: strSim(a.name || "", name) })),
    ],
    decision: { source: best.source, name: best.name, ids: best.ids },
    rationale: `Heuristic pick: ${best.source} name similarity ${best.score.toFixed(3)}. No AI adjudication yet (Phase 2).`,
    field_confidence: { name: best.score },
    overall_confidence: status, status,
    model: "heuristic", created_by: "verify-function",
  }).select("id").single();

  return { db_hit: false, status, confidence, artist, releases: [], verification_id: v?.id || null };
}
