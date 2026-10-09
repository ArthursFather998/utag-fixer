#!/usr/bin/env python3
"""Import UTAG's existing knowledge into the UTAG database (idempotent).

Sources (repos on this machine):
  - Splotify js/discography.json      Skyler Green's singles (ground truth)
  - queue-candidate album JSON        I Left The Roses Out Too Long, 12 tracks
  - Splotify custom_meta.json         curated tag-fix rulings
  - Splotify custom_art.json          user-supplied artwork rulings (+ files)
Everything lands with provenance: corrections (source='import') and
verifications (created_by='import'), so Hermes never overwrites a ruling.
"""
import json, os, sys, urllib.request, urllib.error

HOME = os.path.expanduser("~")
SPLOT = os.path.join(HOME, "workspace/splotify")

def load_env():
    env = {}
    with open(os.path.join(HOME, ".hermes/.env")) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env

ENV = load_env()
BASE = ENV["UTAG_SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = ENV["UTAG_SUPABASE_SERVICE_KEY"]
HDR = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

def req(method, path, body=None, extra=None, raw=None, ctype=None):
    h = dict(HDR)
    if extra: h.update(extra)
    if ctype: h["Content-Type"] = ctype
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + path if not path.startswith("http") else path,
                               data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            t = resp.read().decode()
            return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

def get(path):
    s, b = req("GET", path)
    if s != 200: raise RuntimeError(f"GET {path} -> {s}: {b}")
    return b

def insert(table, row):
    s, b = req("POST", f"/{table}", body=row, extra={"Prefer": "return=representation"})
    if s not in (200, 201): raise RuntimeError(f"POST {table} -> {s}: {b}")
    return b[0]

stats = {"artists": 0, "releases": 0, "tracks": 0, "artwork": 0, "corrections": 0, "verifications": 0, "skipped": 0}

def get_or_artist(name, confidence):
    rows = get(f"/artists?select=id,canonical_name")
    for r in rows:
        if r["canonical_name"].lower() == name.lower(): return r["id"]
    row = insert("artists", {"canonical_name": name, "confidence": confidence, "status": confidence})
    stats["artists"] += 1
    return row["id"]

def get_or_release(artist_id, title, rtype, year, extra=None, confidence="verified"):
    rows = get(f"/releases?select=id,title,edition,release_year&artist_id=eq.{artist_id}")
    for r in rows:
        if r["title"].lower() == title.lower() and r["edition"] == "original" and (r["release_year"] or 0) == (year or 0):
            return r["id"]
    row = {"artist_id": artist_id, "title": title, "release_type": rtype, "edition": "original",
           "release_year": year, "confidence": confidence, "status": confidence}
    if extra: row.update(extra)
    out = insert("releases", row)
    stats["releases"] += 1
    return out["id"]

def get_or_track(release_id, artist_id, title, num, duration_ms=None, confidence="verified", spotify_id=None):
    rows = get(f"/tracks?select=id,title,track_number,disc_number&release_id=eq.{release_id}")
    for r in rows:
        if r["title"].lower() == title.lower() and (r["track_number"] or 0) == (num or 0):
            return r["id"]
    row = {"release_id": release_id, "artist_id": artist_id, "title": title,
           "track_number": num, "disc_number": 1, "duration_ms": duration_ms,
           "confidence": confidence, "status": confidence}
    if spotify_id: row["spotify_id"] = spotify_id
    out = insert("tracks", row)
    stats["tracks"] += 1
    return out["id"]

def add_correction(entity_type, entity_id, field, old, new, note):
    rows = get(f"/corrections?select=id&entity_type=eq.{entity_type}&field=eq.{field}&new_value=eq.{urllib.parse.quote(str(new), safe='')}" if False else
               f"/corrections?select=id,entity_id,field,new_value&entity_type=eq.{entity_type}")
    for r in rows:
        if r["field"] == field and r["new_value"] == str(new) and (r["entity_id"] or "") == (entity_id or ""):
            stats["skipped"] += 1
            return
    insert("corrections", {"entity_type": entity_type, "entity_id": entity_id, "field": field,
                           "old_value": old, "new_value": str(new), "source": "import", "note": note})
    stats["corrections"] += 1

def add_verification(entity_type, entity_id, overall, rationale):
    rows = get(f"/verifications?select=id&entity_type=eq.{entity_type}&created_by=eq.import")
    for r in rows:
        if (r.get("entity_id") or "") == (entity_id or ""):
            stats["skipped"] += 1
            return
    # entity_id is not in the select above; fetch properly
    rows = get(f"/verifications?select=id,entity_id&entity_type=eq.{entity_type}&created_by=eq.import")
    for r in rows:
        if (r.get("entity_id") or "") == (entity_id or ""):
            stats["skipped"] += 1
            return
    insert("verifications", {"entity_type": entity_type, "entity_id": entity_id,
                            "input": {"source": "utag-knowledge-import"},
                            "decision": {"imported": True},
                            "rationale": rationale, "overall_confidence": overall,
                            "status": overall, "model": "utag-import", "created_by": "import"})
    stats["verifications"] += 1

def upload_art(local_path, storage_name, release_id, note):
    with open(local_path, "rb") as f:
        data = f.read()
    url = f"{ENV['UTAG_SUPABASE_URL'].rstrip('/')}/storage/v1/object/artwork/{storage_name}"
    s, b = req("POST", url, raw=data, ctype="image/jpeg",
               extra={"x-upsert": "true", "cache-control": "3600"})
    if s not in (200, 201): raise RuntimeError(f"storage upload {storage_name} -> {s}: {b}")
    rows = get(f"/artwork?select=id&release_id=eq.{release_id}&stored_path=eq.{storage_name}")
    if rows: stats["skipped"] += 1; return
    insert("artwork", {"release_id": release_id, "stored_path": storage_name,
                       "source": "user", "role": "canonical",
                       "confidence": "verified", "status": "verified"})
    stats["artwork"] += 1
    add_correction("artwork", None, "user_artwork", None, storage_name, note)

def dur_ms(s):
    m, sec = s.split(":")
    return (int(m) * 60 + int(sec)) * 1000

def main():
    # ---- Skyler Green: singles from the bundled discography ----
    disco = json.load(open(os.path.join(SPLOT, "js/discography.json")))
    skyler = get_or_artist(disco["artist"], "verified")
    for single in disco["singles"]:
        date = single["date"]
        rel = get_or_release(skyler, single["name"], "single", int(date[:4]),
                             {"release_date": date})
        for i, t in enumerate(single["tracks"], 1):
            get_or_track(rel, skyler, t["title"], i, t.get("duration_ms"))
        art_rel = os.path.join(SPLOT, single["art"])
        if os.path.exists(art_rel):
            upload_art(art_rel, f"import/{os.path.basename(art_rel)}", rel,
                       f"Artist-supplied artwork imported from Splotify discography ({single['name']}).")

    # ---- Skyler Green: the album (queue candidate, 12 tracks) ----
    cand = json.load(open(os.path.join(HOME, "workspace/utag-fixer/queue-candidate-skyler-album-2026-10-08.json")))
    album = get_or_release(skyler, cand["release"], "album", 2026,
                           {"apple_id": cand["known_ids"]["apple_collection_id"],
                            "spotify_id": cand["known_ids"]["spotify_album"].rstrip("/").split("/")[-1]})
    feats = []
    for t in cand["tracks_in_order"]:
        sid = t.get("spotify_track", "").rstrip("/").split("/")[-1] if t.get("spotify_track") else None
        get_or_track(album, skyler, t["title"], t["n"], dur_ms(t["duration"]), spotify_id=sid)
        if t.get("feat"): feats.append(f"{t['title']} (feat. {t['feat']})")
    for name in ("J3REMIAH", "Vesson"):
        get_or_artist(name, "high_confidence")
    add_verification("release", album, "verified",
                     "Imported from the UTAG queue candidate prepared 2026-10-08. Track order and durations from the BandLab album page (observed 2026-09-16) and Apple collection "
                     + cand["known_ids"]["apple_collection_id"] + " (checked 2026-10-03). Skyler's own discography is ground truth in UTAG. "
                     + ("Features: " + "; ".join(feats) + "." if feats else ""))

    # ---- Curated tag-fix rulings (Splotify custom_meta.json) ----
    for r in json.load(open(os.path.join(SPLOT, "custom_meta.json"))):
        m, f = r.get("match", {}), r.get("fix", {})
        artist_id = get_or_artist(f.get("artist") or m.get("artist", ""), "high_confidence")
        add_correction("track", None, "curated_fix",
                       f"artist={m.get('artist','')} | title={m.get('title','')}",
                       f"artist={f.get('artist','')} | title={f.get('title','')}",
                       "Curated fix ruling imported from Splotify custom_meta.json. Outranks AI decisions.")

    # ---- User-supplied artwork rulings (Splotify custom_art.json) ----
    for r in json.load(open(os.path.join(SPLOT, "custom_art.json"))):
        artist_id = get_or_artist(r["artist"], "high_confidence")
        rel = get_or_release(artist_id, r["title"], "single", None, confidence="high_confidence")
        get_or_track(rel, artist_id, r["title"], 1, confidence="high_confidence")
        local = os.path.join(SPLOT, "js/custom-art", r["file"])
        if os.path.exists(local):
            upload_art(local, f"import/{r['file']}", rel,
                       f"User-supplied cover art for {r['artist']} '{r['title']}' imported from Splotify custom_art.json. Never overwrite.")
    print(json.dumps(stats, indent=2))

if __name__ == "__main__":
    main()
