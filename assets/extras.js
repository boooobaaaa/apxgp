/* =========================================================
   EXTRAS — background music player + past-season archive viewer
   ========================================================= */
(() => {
'use strict';
const LG = window.LG;
const { esc, toast } = LG;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
const ssGet = k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
const ssSet = (k, v) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { } };

/* =========================================================
   MUSIC
   ========================================================= */
const MKEY = 'league.music';
const M = { audio: null, el: null, sig: '', tracks: [], idx: 0, open: false, waiting: false, cfg: {} };
const prefs = () => { try { return Object.assign({ muted: false, off: false, vol: null }, JSON.parse(lsGet(MKEY) || '{}')); } catch (e) { return { muted: false, off: false, vol: null }; } };
const savePrefs = p => lsSet(MKEY, JSON.stringify(p));
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 5h2v14h-2zM4 5l11 7-11 7z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9v6h4l5 5V4L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9v6h4l5 5V4L8 9zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>'
};
function musicSync(d) {
  const c = Object.assign({ enabled: false, tracks: [], volume: 35, shuffle: false, autoplay: true, loop: true }, d.music || {});
  const tracks = (c.tracks || []).filter(t => t && t.src);
  M.cfg = c;
  if (!c.enabled || !tracks.length) { if (M.audio) M.audio.pause(); if (M.el) M.el.hidden = true; return; }
  if (!M.audio) {
    M.audio = new Audio(); M.audio.preload = 'none';
    M.audio.addEventListener('ended', () => { if (M.cfg.loop === false && M.idx >= M.tracks.length - 1) { M.idx = 0; load(); ui(); return; } step(1, true); });
    M.audio.addEventListener('play', ui); M.audio.addEventListener('pause', ui);
    M.audio.addEventListener('error', () => { if (M.tracks.length > 1 && !M.audio.paused) step(1, true); ui(); });
    M.el = document.createElement('div'); M.el.id = 'music'; M.el.className = 'music';
    document.body.appendChild(M.el);
    M.el.addEventListener('click', onClick);
    M.el.addEventListener('input', e => { if (e.target.dataset.mu === 'vol') { const p = prefs(); p.vol = Number(e.target.value) / 100; p.muted = p.vol === 0; savePrefs(p); applyVol(); ui(); } });
    document.addEventListener('click', e => { if (M.open && M.el && e.target.isConnected && !M.el.contains(e.target)) { M.open = false; ui(); } });
  }
  M.el.hidden = false;
  const sig = JSON.stringify(tracks.map(t => t.src)) + c.shuffle;
  if (sig !== M.sig) {
    M.sig = sig; M.tracks = tracks.slice();
    if (c.shuffle) for (let i = M.tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [M.tracks[i], M.tracks[j]] = [M.tracks[j], M.tracks[i]]; }
    M.idx = 0; const wasPlaying = !M.audio.paused; load(); if (wasPlaying) play();
    else autostart();
  }
  M.audio.loop = M.cfg.loop !== false && M.tracks.length === 1;
  applyVol(); ui();
}
function load() { const t = M.tracks[M.idx]; if (!t) return; const src = LG.asset(t.src); if (M.audio.src !== new URL(src, location.href).href) M.audio.src = src; }
function applyVol() { if (!M.audio) return; const p = prefs(); const v = p.vol === null ? (Number(M.cfg.volume) || 35) / 100 : p.vol; M.audio.volume = Math.max(0, Math.min(1, v)); M.audio.muted = !!p.muted; }
function play() { load(); applyVol(); return M.audio.play().then(() => true).catch(() => false); }
function autostart() {
  const p = prefs();
  if (M.cfg.autoplay === false || p.off || p.muted) return;
  play().then(okd => {
    if (okd || M.waiting) return;
    // Browsers block sound until the visitor interacts. Phones only count a finished tap (click/touchend),
    // so keep listening on every interaction until playback actually starts.
    M.waiting = true; ui();
    const EVENTS = ['click', 'touchend', 'pointerup', 'keydown'];
    const stop = () => { EVENTS.forEach(t => document.removeEventListener(t, go, true)); M.waiting = false; };
    const go = e => {
      if (M.el && M.el.contains(e.target) && !e.target.closest('[data-mu="fab"]')) { stop(); return; }
      const q = prefs(); if (q.off || q.muted || !M.audio.paused) { stop(); return; }
      play().then(started => { if (started) { stop(); ui(); } });
    };
    EVENTS.forEach(t => document.addEventListener(t, go, true));
  });
}
function step(dir, auto) {
  if (!M.tracks.length) return;
  M.idx = (M.idx + dir + M.tracks.length) % M.tracks.length;
  const was = auto || !M.audio.paused; M.audio.src = LG.asset(M.tracks[M.idx].src);
  if (was) play(); ui();
}
function onClick(e) {
  const b = e.target.closest('[data-mu]'); if (!b) return;
  const k = b.dataset.mu, p = prefs();
  if (k === 'fab') { M.open = !M.open; return ui(); }
  if (k === 'toggle') { if (M.audio.paused) { p.off = false; if (p.muted) { p.muted = false; if (p.vol === 0) p.vol = (Number(M.cfg.volume) || 35) / 100; } savePrefs(p); play(); } else { p.off = true; savePrefs(p); M.audio.pause(); } return ui(); }
  if (k === 'mute') { p.muted = !p.muted; if (!p.muted && p.vol === 0) p.vol = (Number(M.cfg.volume) || 35) / 100; savePrefs(p); applyVol(); if (!p.muted && M.audio.paused && !p.off) play(); return ui(); }
  if (k === 'prev') return step(-1);
  if (k === 'next') return step(1);
}
function ui() {
  if (!M.el || M.el.hidden) return;
  const p = prefs(), playing = M.audio && !M.audio.paused, muted = p.muted, t = M.tracks[M.idx] || {};
  const vol = Math.round((p.vol === null ? (Number(M.cfg.volume) || 35) / 100 : p.vol) * 100);
  const hint = M.waiting && !playing && !muted && !p.off && !M.open ? `<button class="mu-hint" data-mu="fab">🎵 Tap anywhere for music</button>` : '';
  const html = `${hint}<button class="mu-fab ${playing && !muted ? 'on' : ''} ${muted ? 'muted' : ''}" data-mu="fab" aria-label="Music" title="Music">
      ${playing && !muted ? '<span class="mu-eq"><i></i><i></i><i></i><i></i></span>' : muted ? ICON.mute : '<span class="mu-note">♪</span>'}</button>
    <div class="mu-panel" ${M.open ? '' : 'hidden'}>
      <div class="mu-h"><span class="mu-lbl">${esc(M.cfg.label || 'Now playing')}</span><b class="mu-t">${esc(t.title || 'Untitled track')}</b>${M.tracks.length > 1 ? `<small class="muted">${M.idx + 1} / ${M.tracks.length}</small>` : ''}</div>
      <div class="mu-ctl">${M.tracks.length > 1 ? `<button data-mu="prev" aria-label="Previous">${ICON.prev}</button>` : ''}<button class="mu-play" data-mu="toggle" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? ICON.pause : ICON.play}</button>${M.tracks.length > 1 ? `<button data-mu="next" aria-label="Next">${ICON.next}</button>` : ''}</div>
      <div class="mu-vol"><button data-mu="mute" aria-label="${muted ? 'Unmute' : 'Mute'}" title="${muted ? 'Unmute' : 'Mute'}">${muted ? ICON.mute : ICON.vol}</button><input type="range" min="0" max="100" value="${muted ? 0 : vol}" data-mu="vol" aria-label="Volume"></div>
      <p class="mu-note-s">Your choice is remembered on this device.</p>
    </div>`;
  const sl = M.el.querySelector('[data-mu="vol"]');
  if (sl && document.activeElement === sl) return;
  M.el.innerHTML = html;
}

/* =========================================================
   SEASON ARCHIVES
   ========================================================= */
const AKEY = 'league.viewSeason';
const LIVE_ROUTES = /^(admin|fantasy|griddraft|portal|seasons|search)/;
const seasonsIndex = d => (d.seasons || []).filter(x => x && x.id && x.file).sort((a, b) => String(b.label).localeCompare(String(a.label), undefined, { numeric: true }));
async function openArchive(d, id, go) {
  const s = seasonsIndex(d).find(x => x.id === id);
  if (!s) { toast('That season archive wasn’t found', 'err'); return false; }
  try {
    const r = await fetch(s.file + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'not uploaded yet — publish from the admin first' : r.status);
    const data = LG.normalize(await r.json());
    LG.S.archive = { id: s.id, label: s.label, data };
    ssSet(AKEY, s.id);
    if (go) location.hash = go; else LG.render(false);
    return true;
  } catch (e) { toast(`Couldn’t open Season ${s.label}: ${e.message}`, 'err'); return false; }
}
function closeArchive(go) { LG.S.archive = null; ssSet(AKEY, null); if (go) location.hash = go; else LG.render(false); }
function banner(path) {
  let el = document.getElementById('season-banner');
  const A = LG.S.archive;
  if (!A || LIVE_ROUTES.test(path)) { if (el) el.hidden = true; return; }
  if (!el) { el = document.createElement('div'); el.id = 'season-banner'; el.className = 'season-banner'; document.querySelector('.topbar').after(el); }
  const list = seasonsIndex(LG.S.data);
  el.hidden = false;
  el.innerHTML = `<span>📁 You're viewing the <b>Season ${esc(A.label)}</b> archive</span>
    ${list.length > 1 ? `<select data-sb="switch" aria-label="Switch season">${list.map(s => `<option value="${esc(s.id)}" ${s.id === A.id ? 'selected' : ''}>Season ${esc(s.label)}</option>`).join('')}</select>` : ''}
    <button class="btn xs primary" data-sb="exit">Back to Season ${esc(LG.S.data.league.season)}</button>`;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-sb="exit"]'); if (b) closeArchive(); const o = e.target.closest('[data-season-open]'); if (o) { e.preventDefault(); openArchive(LG.S.data, o.dataset.seasonOpen, '#/standings'); } const c = e.target.closest('[data-season-current]'); if (c) { e.preventDefault(); closeArchive('#/standings'); } });
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.sb === 'switch') openArchive(LG.S.data, e.target.value); });

function pageSeasons(d, sub, id) {
  if (sub === 'view' && id) { setTimeout(() => openArchive(d, id, '#/standings'), 0); return '<div class="page"><div class="loading">Opening season…</div></div>'; }
  const list = seasonsIndex(d);
  const hofOnly = (d.history || []).filter(h => !list.some(s => String(s.label) === String(h.season)));
  const st = LG.computeStandings(d);
  const lead = st.drivers[0] ? LG.byId(d.drivers, st.drivers[0].id) : null;
  const done = LG.rounds(d).filter(r => LG.isDone(d, r)).length, total = d.calendar.filter(r => !r.cancelled).length;
  const card = (label, sub2, champ, btn, cur) => `<div class="sea-card ${cur ? 'cur' : ''}"><div class="sea-yr">${esc(label)}</div><div class="sea-info"><b>${champ}</b><small class="muted">${sub2}</small></div>${btn}</div>`;
  return `<div class="page">
    <div class="page-head"><div class="eyebrow">Archive</div><h1>Seasons</h1><p class="sub">Open any past season to browse its calendar, race-by-race results, standings, drivers and teams exactly as they finished.</p></div>
    <div class="sea-list">
      ${card(d.league.season, `Current season · ${done}/${total} rounds`, lead ? `Leader: ${esc(lead.name)}` : 'Season underway', `<a class="btn sm ${LG.S.archive ? 'primary' : ''}" href="#/standings" data-season-current>${LG.S.archive ? 'Switch back' : 'You’re here'}</a>`, true)}
      ${list.map(s => card(s.label, `${s.rounds ? s.rounds + ' rounds · ' : ''}archived ${s.savedAt ? LG.fmtDate(s.savedAt) : ''}`, s.champion ? `🏆 ${esc(s.champion)}` : 'Full season archive', `<button class="btn sm primary" data-season-open="${esc(s.id)}">${LG.S.archive && LG.S.archive.id === s.id ? 'Viewing' : 'View season'} →</button>`)).join('')}
      ${hofOnly.map(h => card(h.season, 'Final standings only', h.driverChampion ? `🏆 ${esc(h.driverChampion)}` : '—', h.standings ? `<a class="btn sm" href="#/history/${esc(h.id)}">Final standings →</a>` : '<a class="btn sm" href="#/history">Hall of fame →</a>')).join('')}
    </div>
    ${!list.length && !hofOnly.length ? '<div class="empty"><b>No past seasons yet</b><p>When a season ends, the admins archive it here.</p></div>' : ''}
  </div>`;
}

/* restore an open archive after refresh */
let restored = false;
function afterRender(path) {
  musicSync(LG.S.data);
  banner(path);
  if (!restored) { restored = true; const id = ssGet(AKEY); if (id && !LG.S.archive) openArchive(LG.S.data, id); }
}

window.Extras = { afterRender, pageSeasons, openArchive, closeArchive, seasonsIndex, LIVE_ROUTES, musicSync, M };
})();
