/* utag-fixer demo: wire the library to a plain page. Pick files, run the
   fixer, review the uncertain ones, edit by hand. */

import { createFixer, createIndexedDB } from '../src/index.js';
import { compute as computeFingerprint } from './fingerprint.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let fixer = null;
let tracks = [];
let byId = new Map();
let reviewItems = [];
let running = false;
let skipHandle = null;

function initFixer() {
  fixer = createFixer({
    storage: createIndexedDB('utag-fixer-demo'),
    fingerprint: computeFingerprint,
    acoustIdKey: () => ($('acoustid').value || '').trim(),
    fanartKey: () => ($('fanart').value || '').trim(),
    onPersist: t => paintRow(t.id),
    onLog: (...a) => console.warn('[utag]', ...a),
  });
}

function saveKeys() {
  try {
    localStorage.setItem('utag-acoustid', $('acoustid').value || '');
    localStorage.setItem('utag-fanart', $('fanart').value || '');
  } catch (e) {}
}
function loadKeys() {
  try {
    $('acoustid').value = localStorage.getItem('utag-acoustid') || '';
    $('fanart').value = localStorage.getItem('utag-fanart') || '';
  } catch (e) {}
}

const STATUS_LABEL = {
  scanning: 'Fixing', fingerprinting: 'Fingerprinting', fixed: 'Fixed',
  review: 'Review', ok: 'Checked', nomatch: 'No match', skipped: 'Skipped',
};

function trackSub(t) {
  return [t.artist, t.album].filter(x => x && x !== 'Unknown Artist' && x !== 'Unknown Album').join(' - ') || 'Unknown';
}

function rowHtml(t) {
  const st = t._status || '';
  const badge = st ? `<span class="badge ${st}">${STATUS_LABEL[st] || st}</span>` : '';
  const note = t._note ? `<div class="tnote">${esc(t._note)}</div>` : '';
  return `<div class="tmeta">
      <div class="ttitle">${esc(t.title || 'Unknown Title')}</div>
      <div class="tsub">${esc(trackSub(t))}</div>${note}</div>
    <div class="tbtns">${badge}
      <button class="small" data-edit="${t.id}">Edit</button>
      <button class="small" data-skip="${t.id}">${t._skipped ? 'Unskip' : 'Skip'}</button>
    </div>`;
}

function renderList() {
  const box = $('tracklist');
  if (!tracks.length) { box.innerHTML = '<p class="sub" style="margin:0">No files yet. Pick some audio files above.</p>'; return; }
  box.innerHTML = tracks.map(t =>
    `<div class="track" id="row-${t.id}">${rowHtml(t)}<div class="editorwrap hidden" id="edit-${t.id}"></div></div>`
  ).join('');
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit));
  box.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => toggleSkip(b.dataset.skip));
}

function paintRow(id) {
  const t = byId.get(id);
  const el = $('row-' + id);
  if (!t || !el) return;
  const wasOpen = el.querySelector('.editorwrap') && !el.querySelector('.editorwrap').classList.contains('hidden');
  el.innerHTML = rowHtml(t) + `<div class="editorwrap${wasOpen ? '' : ' hidden'}" id="edit-${t.id}"></div>`;
  el.querySelector('[data-edit]').onclick = () => openEditor(t.id);
  el.querySelector('[data-skip]').onclick = () => toggleSkip(t.id);
  if (wasOpen) buildEditor(t.id); // re-render the open form after a repaint
}

function setStatus(t, status, note) {
  t._status = status;
  t._note = note || '';
  paintRow(t.id);
}

function buildEditor(id) {
  const t = byId.get(id);
  const box = $('edit-' + id);
  if (!t || !box) return;
  const F = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo'];
  box.innerHTML = `<div class="card" style="margin:8px 0 0"><div class="editor">` +
    F.map(f => `<div><label>${f}</label><input type="text" data-f="${f}" value="${esc(t[f] == null ? '' : t[f])}"></div>`).join('') +
    `</div><div class="row" style="margin-top:8px">
      <button class="small primary" data-save="${id}">Save</button>
      <button class="small" data-cancel="${id}">Cancel</button></div></div>`;
  box.classList.remove('hidden');
  box.querySelector('[data-cancel]').onclick = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  box.querySelector('[data-save]').onclick = () => saveEditor(id);
}

async function saveEditor(id) {
  const t = byId.get(id);
  const box = $('edit-' + id);
  if (!t || !box) return;
  const before = { ...t };
  box.querySelectorAll('[data-f]').forEach(i => {
    const f = i.dataset.f;
    let v = i.value.trim();
    if (f === 'year' || f === 'trackNo' || f === 'discNo') v = parseInt(v, 10) || 0;
    t[f] = v;
  });
  t.tagged = true;
  t.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'manual';
  await fixer.learn(before, t); // hand edits teach the fixer too
  box.classList.add('hidden'); box.innerHTML = '';
  setStatus(t, 'fixed', 'edited by hand');
}

function openEditor(id) {
  const box = $('edit-' + id);
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  buildEditor(id);
}

async function toggleSkip(id) {
  const t = byId.get(id);
  if (!t) return;
  const skipped = await fixer.isSkipped(t);
  if (skipped) {
    await fixer.unskip(t);
    t._skipped = false;
    setStatus(t, '', '');
  } else {
    await fixer.skip(t);
    t._skipped = true;
    try { if (skipHandle && skipHandle.now) skipHandle.now(t.id); } catch (e) {} // interrupt mid-run
    setStatus(t, 'skipped', 'skipped');
  }
}

function renderReview() {
  const box = $('review');
  $('review-count').textContent = reviewItems.length ? `(${reviewItems.length})` : '';
  if (!reviewItems.length) {
    box.innerHTML = '<p class="sub" style="margin:0">Uncertain corrections land here, highest confidence first. Approving teaches the fixer; next run it just knows.</p>';
    return;
  }
  box.innerHTML = `<div class="row" style="margin-bottom:8px"><button class="small primary" id="approve-all">Approve all</button></div>` +
    reviewItems.map((it, i) => {
      const p = it.proposal;
      const conf = Math.round((p.confidence || 0) * 100);
      return `<div class="rev" id="rev-${i}">
        <div><b>${esc(it.title)}</b> <span class="tsub">${esc(it.artist)}</span></div>
        <div class="p">${esc(p.field)}: ${esc(String(p.from))} &rarr; <b>${esc(String(p.to))}</b></div>
        <div class="conf">${esc(p.source)} &middot; ${conf}% confident</div>
        <div class="row" style="margin-top:6px">
          <button class="small primary" data-approve="${i}">Approve</button>
          <button class="small" data-reject="${i}">Reject</button>
        </div></div>`;
    }).join('');
  $('approve-all').onclick = approveAll;
  box.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => approveItem(Number(b.dataset.approve)));
  box.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => rejectItem(Number(b.dataset.reject)));
}

async function approveItem(i) {
  const it = reviewItems[i];
  if (!it) return;
  const t = byId.get(it.trackId);
  try {
    await fixer.approveReview(it, t);
    if (t) setStatus(t, 'fixed', 'reviewed: ' + it.proposal.field);
  } catch (e) { console.warn('approve failed', e); }
  reviewItems.splice(i, 1);
  renderReview();
}

async function rejectItem(i) {
  const it = reviewItems[i];
  if (!it) return;
  await fixer.skipReview(it);
  reviewItems.splice(i, 1);
  renderReview();
}

async function approveAll() {
  for (const it of [...reviewItems]) {
    const t = byId.get(it.trackId);
    try { await fixer.approveReview(it, t); if (t) setStatus(t, 'fixed', 'reviewed: ' + it.proposal.field); } catch (e) {}
  }
  reviewItems = [];
  renderReview();
}

function setStats(s) {
  $('stats').innerHTML = s
    ? `<span>Scanned <b>${s.scanned}</b></span><span>Fixed <b>${s.fixed}</b></span>` +
      `<span>Matched <b>${s.matched}</b></span><span>Review <b>${s.review.length}</b></span>` +
      `<span>Via: Apple ${s.via.apple}, Deezer ${s.via.deezer}, MusicBrainz ${s.via.musicbrainz}, memory ${s.via.memory}, AcoustID ${s.via.acoustid}</span>`
    : '';
}

async function refreshSkipFlags() {
  for (const t of tracks) t._skipped = await fixer.isSkipped(t);
}

$('picker').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  $('fixall').disabled = true;
  $('healbtn').disabled = true;
  $('progress').textContent = 'Reading tags...';
  tracks = await fixer.scan(files, {
    onProgress: (i, n) => { $('progress').textContent = `Reading tags... ${i} of ${n}`; },
  });
  byId = new Map(tracks.map(t => [t.id, t]));
  reviewItems = [];
  renderReview();
  await refreshSkipFlags();
  renderList();
  $('progress').textContent = `${tracks.length} file${tracks.length === 1 ? '' : 's'} ready.`;
  setStats(null);
  const need = tracks.filter(t => fixer.needsFix(t)).length;
  $('fixall').disabled = running || !need;
  $('healbtn').disabled = running || !tracks.length;
  if (!need) $('progress').textContent = 'All tags already look complete.';
});

$('fixall').addEventListener('click', async () => {
  if (running || !tracks.length) return;
  running = true;
  $('fixall').disabled = true;
  $('healbtn').disabled = true;
  skipHandle = {}; // live during the run: the Skip button interrupts mid-flight
  const roster = [...new Set(tracks.map(t => t.artist).filter(a => a && a !== 'Unknown Artist'))];
  const albums = [...new Map(tracks.filter(t => t.album && t.album !== 'Unknown Album')
    .map(t => [t.album + '|||' + t.artist, { name: t.album, artist: t.artist }])).values()];
  tracks.forEach(t => setStatus(t, '', ''));
  try {
    const res = await fixer.fixAll(tracks, {
      roster,
      albums,
      artists: roster,
      skipHandle,
      onTrack: (t, status, note) => setStatus(t, status, note),
    });
    reviewItems = res.review;
    renderReview();
    setStats(res);
    $('progress').textContent = `Fixed ${res.fixed} of ${res.scanned} tracks` +
      (res.review.length ? `, ${res.review.length} to review` : ', nothing to review') + '.';
  } catch (e) {
    console.warn('fixAll failed', e);
    $('progress').textContent = 'The run failed: ' + (e && e.message ? e.message : e);
  } finally {
    running = false;
    skipHandle = null;
    $('fixall').disabled = !tracks.some(t => fixer.needsFix(t));
    $('healbtn').disabled = !tracks.length;
  }
});

$('healbtn').addEventListener('click', async () => {
  if (running || !tracks.length) return;
  running = true;
  $('healbtn').disabled = true;
  $('progress').textContent = 'Quiet heal running...';
  try {
    const r = await fixer.heal(tracks);
    $('progress').textContent = `Heal: ${r.fixed} fixed, ${r.changed} touched.`;
    tracks.forEach(t => paintRow(t.id));
  } catch (e) {
    $('progress').textContent = 'Heal failed: ' + (e && e.message ? e.message : e);
  } finally {
    running = false;
    $('healbtn').disabled = false;
    $('fixall').disabled = !tracks.some(t => fixer.needsFix(t));
  }
});

$('acoustid').addEventListener('change', saveKeys);
$('fanart').addEventListener('change', saveKeys);

$('curated').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const list = JSON.parse(await f.text());
    fixer.setCurated(list);
    $('curated-count').textContent = `${fixer.curatedCount()} curated ${fixer.curatedCount() === 1 ? 'fix' : 'fixes'} loaded. Applies to files picked from now on.`;
  } catch (err) {
    $('curated-count').textContent = 'Could not read that file.';
  }
});

loadKeys();
initFixer();
