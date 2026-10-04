/* utag-fixer: audio file -> track record.
   Parses embedded tags with music-metadata (vendor/mm.js exposes
   window.mm.parseBlob; pass your own `reader` or it is picked up
   automatically). Falls back to the file name when the reader is missing
   or a file will not parse. Curated fixes are applied at parse time.
   Audio metadata is read on-device; nothing is uploaded. */

import { splitArtistTitle, baseTitle } from './utils.js';

function defaultReader() {
  if (typeof window !== 'undefined' && window.mm && window.mm.parseBlob) {
    return (file, opts) => window.mm.parseBlob(file, opts);
  }
  return null;
}

export async function parseAudioFile(file, { id, reader, curated } = {}) {
  const parseBlob = reader || defaultReader();
  let common = {}, format = {};
  let diag = 'reader-ok';
  try {
    if (parseBlob) {
      const md = await parseBlob(file, { duration: true });
      common = (md && md.common) || {};
      format = (md && md.format) || {};
    } else {
      diag = 'reader-missing (no metadata reader configured)';
    }
  } catch (e) {
    diag = 'parse-error: ' + ((e && e.message) || String(e));
  }

  const fb = splitArtistTitle(file.name);
  let art = null;
  const pic = common.picture && common.picture[0];
  if (pic && pic.data) {
    try { art = new Blob([pic.data], { type: pic.format || 'image/jpeg' }); } catch (e) {}
  }

  const artist0 = (common.artist || common.albumartist || fb.artist || 'Unknown Artist').toString();
  const title0 = (common.title || fb.title || 'Unknown Title').toString();

  // Curated metadata fixes: repair known-mangled tags at parse time.
  let artist = artist0, title = title0, tagsVia = null;
  try {
    const mf = curated && curated.get(artist0, title0);
    if (mf) {
      if (mf.fa) artist = mf.fa;
      if (mf.ft) title = mf.ft;
      tagsVia = 'Curated';
    }
  } catch (e) {}

  const tagged = !!(common.title || common.artist || common.albumartist || common.album || pic);

  return {
    id: id !== undefined ? id : null,
    title, artist, tagsVia,
    album: (common.album || 'Unknown Album').toString(),
    albumArtist: (common.albumartist || artist).toString(),
    genre: (common.genre && common.genre[0]) || '',
    year: common.year || (common.date || '').toString().slice(0, 4) || '',
    trackNo: (common.track && common.track.no) || 0,
    discNo: (common.disk && common.disk.no) || 0,
    duration: format.duration || 0,
    fileName: file.name,
    fileSize: file.size,
    filePath: file.webkitRelativePath || '',
    file,
    art, artSource: null, artManual: false,
    tagged, diag,
    dateAdded: Date.now(),
  };
}
