/* utag-fixer: curated metadata fixes.
   Mechanism only, no personal data. Repairs known-mangled tags, e.g. a
   file named "Band Name (Demo - Unfinished).mp3" that a tag reader split
   on " - " into artist "Band Name (Demo" and title "Unfinished)".
   Format (curated.json):
     [ { "match": { "artist": "Band Name (Demo", "title": "Unfinished)" },
         "fix":   { "artist": "Band Name",     "title": "Song Title" } } ]
   Matching is exact on the trimmed, lowercased pair. See
   curated.sample.json for examples. */

export function createCurated() {
  let list = [];

  function normalize(items) {
    const out = [];
    for (const it of (items || [])) {
      const m = (it && it.match) || {};
      const f = (it && it.fix) || {};
      // Accept the generated {a,t,fa,ft} shape too, for convenience.
      const ma = String(m.artist || it.a || '').trim().toLowerCase();
      const mt = String(m.title || it.t || '').trim().toLowerCase();
      if (!ma && !mt) continue;
      out.push({
        a: ma,
        t: mt,
        fa: (f.artist || it.fa || null),
        ft: (f.title || it.ft || null),
      });
    }
    return out;
  }

  return {
    // Replace the curated list (array of {match, fix}).
    set(items) { list = normalize(items); },
    count() { return list.length; },
    // Returns {fa, ft} or null. Applied at parse time and in heal().
    get(artist, title) {
      if (!list.length) return null;
      const a = String(artist || '').trim().toLowerCase();
      const t = String(title || '').trim().toLowerCase();
      for (const m of list) {
        if (m.a === a && m.t === t) return m;
      }
      return null;
    },
  };
}
