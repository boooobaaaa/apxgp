/* Public website — single-page app with hash routing. */
'use strict';

const S = { settings: {}, statFields: [], me: null, cleanup: [], data: null, gachaReady: false };
const STAT_FIELDS = [
  { key: 'starts', label: 'Race Starts' }, { key: 'wins', label: 'Wins' }, { key: 'podiums', label: 'Podiums' },
  { key: 'poles', label: 'Pole Positions' }, { key: 'fastest_laps', label: 'Fastest Laps' }, { key: 'points', label: 'Career Points' },
  { key: 'championships', label: 'Championships' }, { key: 'best_finish', label: 'Best Finish', lowerBetter: true },
  { key: 'avg_finish', label: 'Avg. Finish', lowerBetter: true }, { key: 'dnfs', label: 'DNFs', lowerBetter: true },
];
const color = () => S.settings.primary_color || '#857452';
const app = $('#app');

// ---- data (all site content lives in data/site.json, published from the admin console)
const D = () => S.data;
const isOn = (v) => v === true || v === 1 || v === '1';
const DATA = {
  members: () => [...(D().members || [])].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)),
  member: (id) => (D().members || []).find((m) => m.id === id),
  races: () => D().races || [],
  standings: () => ({
    drivers: [...(D().drivers || [])].sort((a, b) => (a.pos || 99) - (b.pos || 99)),
    constructors: [...(D().constructors || [])].sort((a, b) => (a.pos || 99) - (b.pos || 99)),
  }),
  news: () => (D().news || []).filter((n) => isOn(n.published)).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))),
  media: () => D().media || [],
  withImage: (c) => ({ ...c, image: c.image || DATA.member(c.member_id)?.photo || '' }),
  cards: () => (D().cards || []).filter((c) => isOn(c.active)).map(DATA.withImage)
    .sort((a, b) => RARS.indexOf(a.rarity) - RARS.indexOf(b.rarity)),
  allCards: () => (D().cards || []).map(DATA.withImage),
  packs: () => (D().packs || []).filter((p) => isOn(p.active)).sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)),
};
const RARS = ['common', 'rare', 'circuit', 'signature'];
const onCleanup = (fn) => S.cleanup.push(fn);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    S.data = await fetchJson(`data/site.json?v=${Date.now()}`);
    S.settings = S.data.settings || {}; S.statFields = STAT_FIELDS;
  } catch (e) { app.innerHTML = `<div class="wrap empty">Couldn't load the site content. ${esc(e.message)}</div>`; return; }
  applyTheme();
  renderAccount();
  initSearch();
  initMusic();
  Gacha.onChange((st) => {
    const sig = `${st.user ? st.user.uid : ''}|${st.profile ? 1 : 0}|${st.error || ''}`;
    const changed = sig !== S.authSig; S.authSig = sig;
    S.me = st.profile;
    renderAccount();
    const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
    if (['packs', 'collection', 'login'].includes(route) && (changed || !S.gachaReady)) router();
    S.gachaReady = true;
  });
  Gacha.init();
  $('#burger').addEventListener('click', () => document.body.classList.toggle('menu-open'));
  window.addEventListener('scroll', () => $('#nav').classList.toggle('scrolled', scrollY > 10), { passive: true });
  window.addEventListener('hashchange', router);
  router();
}

function applyTheme() {
  const s = S.settings, r = document.documentElement.style;
  r.setProperty('--accent', s.primary_color || '#857452');
  r.setProperty('--accent-2', s.secondary_color || '#c9b98f');
  if (s.background_color) r.setProperty('--bg', s.background_color);
  document.title = s.team_name || 'Team';
  const logo = safeUrl(s.logo);
  $('#brand').classList.toggle('logo-only', !!logo);
  $('#brand').innerHTML = logo
    ? `<img src="${esc(logo)}" alt="${esc(s.team_name)}"><span>${esc(s.short_name || s.team_name)}</span>`
    : `<span class="brand-mark">${esc((s.short_name || s.team_name || 'T').slice(0, 1))}</span><span>${esc(s.short_name || s.team_name)}</span>`;
  const socials = ['instagram', 'twitter', 'youtube', 'twitch'].filter((k) => safeUrl(s[k]))
    .map((k) => `<a href="${esc(s[k])}" target="_blank" rel="noopener">${k === 'twitter' ? 'X / Twitter' : k[0].toUpperCase() + k.slice(1)}</a>`).join('');
  $('#footer').innerHTML = `<div class="wrap footer-inner">
    <div>${logo ? `<img class="footer-logo" src="${esc(logo)}" alt="">` : ''}<div class="footer-brand">${esc(s.team_name)}</div><div class="muted">${esc(s.tagline)}</div></div>
    <div class="footer-links">${socials}</div>
    <div class="muted small footer-meta">© ${new Date().getFullYear()} ${esc(s.team_name)} · <a href="admin.html" class="footer-admin">Team admin</a></div></div>`;
}

function renderAccount() {
  const el = $('#navAccount'), mob = $('#navMobileAcct');
  const isAdmin = !!(Gacha.state && Gacha.state.isAdmin);
  if (!Gacha.enabled) { el.innerHTML = ''; mob.innerHTML = ''; return; }
  if (!S.me) {
    el.innerHTML = `<a href="#/login" class="btn btn-sm btn-ghost">Sign in</a>`;
    mob.innerHTML = `<a href="#/login">Sign in</a>`;
    return;
  }
  el.innerHTML = `
    ${isAdmin ? '<a href="admin.html" class="btn btn-sm btn-primary admin-btn">Admin console</a>' : ''}
    <a href="#/packs" class="coin-pill" title="Your coins"><span class="coin"></span><b id="coinCount">${S.me.coins.toLocaleString()}</b></a>
    <div class="acct-menu">
      <button class="acct-btn">${esc(S.me.username)} ▾</button>
      <div class="acct-drop">
        <a href="#/collection">My collection</a>
        ${isAdmin ? '<a href="admin.html">Admin console</a>' : ''}
        <button class="logout-btn">Sign out</button>
      </div>
    </div>`;
  mob.innerHTML = `<a href="#/collection">My collection</a>${isAdmin ? '<a href="admin.html">Admin console</a>' : ''}<a href="#" class="logout-btn">Sign out (${esc(S.me.username)})</a>`;
  $$('.logout-btn').forEach((b) => (b.onclick = async (e) => { e.preventDefault(); await Gacha.signOut(); toast('Signed out'); }));
}
function setCoins(n) { if (S.me) { S.me.coins = n; const c = $('#coinCount'); if (c) c.textContent = n.toLocaleString(); } }

// ------------------------------------------------------------------ router
const ROUTES = { '': home, home, schedule, team, news, media, compare, packs, collection, login };
async function router() {
  S.cleanup.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); S.cleanup = [];
  document.body.classList.remove('menu-open', 'modal-open');
  const [pathPart, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, ...args] = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  $$('#navLinks a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name || 'home') || (name === 'collection' && a.dataset.route === 'packs')));
  const view = ROUTES[name || ''] || notFound;
  app.innerHTML = '<div class="loading"><span></span></div>';
  try { await view(args, params); }
  catch (e) { app.innerHTML = `<div class="wrap empty"><h2>Hmm.</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back home</a></div>`; }
  if (!params.has('keep')) window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
}
function notFound() { app.innerHTML = `<div class="wrap empty"><h2>Off track!</h2><p>That page doesn't exist.</p><a class="btn btn-primary" href="#/">Back to the pits</a></div>`; }

const pageHead = (eyebrow, title, sub = '') => `<section class="page-head"><div class="wrap">
  <div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub ? `<p class="lede">${sub}</p>` : ''}</div></section>`;

// ------------------------------------------------------------------ helpers
const raceTime = (r) => new Date(`${r.date}T${r.time || '14:00'}`);
function nextRace(races) {
  const now = Date.now();
  return [...races].filter((r) => r.status !== 'completed' && r.date && raceTime(r).getTime() > now - 3 * 3600e3)
    .sort((a, b) => raceTime(a) - raceTime(b))[0];
}
function countdownHtml(r) {
  return `<div class="countdown" data-target="${raceTime(r).toISOString()}">
    ${['Days', 'Hrs', 'Min', 'Sec'].map((l) => `<div><b>--</b><span>${l}</span></div>`).join('')}</div>`;
}
function startCountdowns() {
  const tick = () => $$('.countdown').forEach((el) => {
    let d = Math.max(0, new Date(el.dataset.target) - Date.now()) / 1000;
    const parts = [Math.floor(d / 86400), Math.floor(d / 3600) % 24, Math.floor(d / 60) % 60, Math.floor(d) % 60];
    $$('b', el).forEach((b, i) => (b.textContent = String(parts[i]).padStart(2, '0')));
  });
  tick();
  const t = setInterval(tick, 1000); onCleanup(() => clearInterval(t));
}

// ------------------------------------------------------------------ HOME
async function home() {
  const members = DATA.members(), races = DATA.races(), standings = DATA.standings(), newsList = DATA.news(), media = DATA.media();
  const s = S.settings;
  const drivers = members.filter((m) => m.is_driver);
  const next = nextRace(races);
  const ourTeam = standings.constructors.find((c) => c.is_ours);
  const ourDrivers = standings.drivers.filter((d) => d.is_ours);
  const last = [...races].filter((r) => r.status === 'completed').sort((a, b) => raceTime(b) - raceTime(a))[0];
  const hero = safeUrl(s.hero_image);

  app.innerHTML = `
  <section class="hero ${hero ? 'has-img' : ''}" ${hero ? `style="--hero:url('${esc(hero)}')"` : ''}>
    <div class="hero-speed"></div>
    <div class="wrap hero-inner">
      <div class="eyebrow">Season ${esc(s.season)}</div>
      ${safeUrl(s.logo)
        ? `<h1 class="hero-logo"><img src="${esc(s.logo)}" alt="${esc(s.team_name)}"></h1><div class="hero-fullname">${esc(s.team_name)}</div>`
        : `<h1 class="hero-title">${esc(s.team_name)}</h1>`}
      <p class="hero-tag">${esc(s.tagline)}</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#/schedule">Schedule &amp; standings</a>
        <a class="btn btn-ghost" href="#/team">Meet the team</a>
      </div>
    </div>
  </section>

  <section class="wrap strip">
    <div class="panel next-race">
      ${next ? `<div class="panel-label">Next race · Round ${esc(next.round)}</div>
        <h3>${esc(next.name)}</h3>
        <div class="muted">${esc(next.circuit)} · ${fmtDate(next.date, { weekday: 'short', day: 'numeric', month: 'long' })}</div>
        ${countdownHtml(next)}` : `<div class="panel-label">Next race</div><h3>Season complete</h3><div class="muted">See you next year.</div>`}
    </div>
    <div class="panel">
      <div class="panel-label">Constructors' championship</div>
      ${ourTeam ? `<div class="big-pos">P${esc(ourTeam.pos)}</div><div class="muted">${esc(ourTeam.points)} pts</div>` : '<div class="muted">Standings coming soon</div>'}
      <a class="link-arrow" href="#/schedule?tab=constructors">Full standings</a>
    </div>
    <div class="panel">
      <div class="panel-label">Drivers' championship</div>
      ${ourDrivers.length ? ourDrivers.map((d) => `<div class="mini-row"><span class="mini-pos">P${esc(d.pos)}</span><span>${esc(d.driver)}</span><b>${esc(d.points)}</b></div>`).join('') : '<div class="muted">Standings coming soon</div>'}
      ${last ? `<div class="last-result"><span class="panel-label">Last race · ${esc(last.name)}</span><div>${esc(last.result || '—')}</div></div>` : ''}
    </div>
  </section>

  ${drivers.length ? `<section class="wrap section">
    <div class="section-head"><h2>Our drivers</h2><a class="link-arrow" href="#/compare">Compare drivers</a></div>
    <div class="driver-tiles">${drivers.map((d) => `
      <a class="driver-tile" href="#/team/${d.id}">
        <img src="${esc(photoOf(d, color()))}" alt="${esc(d.name)}" loading="lazy">
        <span class="driver-tile-num">${esc(d.number || '')}</span>
        <div class="driver-tile-body"><div class="small muted">${esc(d.role || '')}</div><h3>${esc(d.name)}</h3><div class="small">${esc(d.nationality || '')}</div></div>
      </a>`).join('')}</div>
  </section>` : ''}

  ${newsList.length ? `<section class="wrap section">
    <div class="section-head"><h2>Latest news</h2><a class="link-arrow" href="#/news">All news</a></div>
    <div class="news-grid">${newsList.slice(0, 3).map(newsCard).join('')}</div>
  </section>` : ''}

  <section class="packs-band">
    <div class="wrap packs-band-inner">
      <div>
        <div class="eyebrow">Collect the team</div>
        <h2>Open Paddock Packs</h2>
        <p class="lede">Pull team cards across four rarities — from Commons to ultra-rare signed Signature cards. Free coins every day.</p>
        <a class="btn btn-primary" href="#/packs">Open packs</a>
      </div>
      <div class="band-cards" id="bandCards"></div>
    </div>
  </section>

  ${media.length ? `<section class="wrap section">
    <div class="section-head"><h2>Gallery</h2><a class="link-arrow" href="#/media">All photos</a></div>
    <div class="media-teaser">${media.slice(0, 6).map((m) => `<a href="#/media"><img src="${esc(m.file)}" alt="${esc(m.caption || '')}" loading="lazy"></a>`).join('')}</div>
  </section>` : ''}

  ${s.about ? `<section class="wrap section about"><h2>About the team</h2><div class="prose">${md(s.about)}</div></section>` : ''}`;

  if (next) startCountdowns();
  // fan of sample cards in the band
  const pick = RARS.map((r) => DATA.cards().find((c) => c.rarity === r)).filter(Boolean);
  const band = $('#bandCards'); if (band) { band.innerHTML = pick.map((c) => renderCard(c, { color: color() })).join(''); enableTilt(band); }
}

function newsCard(n, i, feature) {
  const cover = safeUrl(n.cover);
  return `<a class="news-card ${feature === true ? 'feature' : ''}" href="#/news/${encodeURIComponent(n.slug)}">
    <div class="news-img" ${cover ? `style="background-image:url('${esc(cover)}')"` : ''}>${cover ? '' : `<span>${esc(S.settings.short_name || '')}</span>`}</div>
    <div class="news-body"><div class="small muted">${fmtDate(n.published_at)}</div><h3>${esc(n.title)}</h3><p>${esc(n.excerpt || '')}</p></div>
  </a>`;
}

// ------------------------------------------------------------------ SCHEDULE & STANDINGS
async function schedule(_args, params) {
  const races = DATA.races(), standings = DATA.standings();
  let tab = params.get('tab') || 'calendar';
  let highlight = store.get('highlightOurs', true);
  const next = nextRace(races);
  const sorted = [...races].sort((a, b) => (a.round || 0) - (b.round || 0) || raceTime(a) - raceTime(b));

  const standingsTable = (rows, kind) => {
    const max = Math.max(1, ...rows.map((r) => Number(r.points) || 0));
    if (!rows.length) return '<div class="empty small">No standings published yet.</div>';
    return `<div class="table-wrap"><table class="standings">
      <thead><tr><th>Pos</th><th>${kind === 'drivers' ? 'Driver' : 'Team'}</th>${kind === 'drivers' ? '<th class="hide-sm">Team</th>' : ''}<th class="num">Pts</th><th class="hide-sm bar-col"></th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.is_ours ? 'ours' : ''}">
        <td class="pos">${esc(r.pos)}</td>
        <td class="name">${esc(kind === 'drivers' ? r.driver : r.team)}${r.is_ours ? '<span class="ours-tag">Our team</span>' : ''}</td>
        ${kind === 'drivers' ? `<td class="hide-sm muted">${esc(r.team || '')}</td>` : ''}
        <td class="num"><b>${esc(r.points)}</b></td>
        <td class="hide-sm bar-col"><div class="pts-bar"><i style="width:${(Number(r.points) / max) * 100}%"></i></div></td>
      </tr>`).join('')}</tbody></table></div>`;
  };

  app.innerHTML = `${pageHead(`Season ${esc(S.settings.season)}`, 'Schedule &amp; Standings')}
  <section class="wrap section">
    <div class="toolbar">
      <div class="tabs" role="tablist">
        ${[['calendar', 'Race calendar'], ['drivers', 'Drivers'], ['constructors', 'Constructors']].map(([k, l]) => `<button class="tab" data-tab="${k}" role="tab">${l}</button>`).join('')}
      </div>
      <label class="switch" id="hlSwitch"><input type="checkbox" ${highlight ? 'checked' : ''}><span class="switch-ui"></span>Highlight my team</label>
    </div>
    <div class="tab-panel" data-panel="calendar">
      ${sorted.length ? `<div class="race-list">${sorted.map((r) => {
        const done = r.status === 'completed', isNext = next && next.id === r.id;
        const d = r.date ? new Date(r.date + 'T12:00:00') : null;
        return `<div class="race-row ${done ? 'done' : ''} ${isNext ? 'is-next' : ''}">
          <div class="race-date">${d ? `<b>${d.getDate()}</b><span>${d.toLocaleDateString(undefined, { month: 'short' })}</span>` : '<b>TBC</b>'}</div>
          <div class="race-round">R${esc(r.round || '–')}</div>
          <div class="race-main"><h3>${esc(r.name)}</h3><div class="muted small">${esc([r.circuit, r.country].filter(Boolean).join(' · '))}${r.time && !done ? ` · ${esc(r.time)}` : ''}</div></div>
          <div class="race-status">${done ? `<span class="pill">Completed</span>${r.result ? `<div class="race-result">${esc(r.result)}</div>` : ''}` : isNext ? `<span class="pill pill-live">Next race</span>${countdownHtml(r)}` : `<span class="pill pill-up">Upcoming</span>`}</div>
        </div>`;
      }).join('')}</div>` : '<div class="empty">The calendar hasn\'t been published yet.</div>'}
    </div>
    <div class="tab-panel" data-panel="drivers">${standingsTable(standings.drivers, 'drivers')}</div>
    <div class="tab-panel" data-panel="constructors">${standingsTable(standings.constructors, 'constructors')}</div>
  </section>`;

  const setTab = (t) => {
    tab = t;
    $$('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t));
    $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== t));
  };
  $$('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  setTab(tab);
  const applyHl = () => app.classList.toggle('hl-ours', highlight);
  applyHl(); onCleanup(() => app.classList.remove('hl-ours'));
  $('#hlSwitch input').onchange = (e) => { highlight = e.target.checked; store.set('highlightOurs', highlight); applyHl(); };
  if (next) startCountdowns();
}

// ------------------------------------------------------------------ TEAM (carousel)
async function team(args) {
  const members = DATA.members();
  if (args[0]) return profile(members, decodeURIComponent(args[0]));
  let filter = 'all', idx = 0;

  app.innerHTML = `${pageHead('The people behind the car', 'Our Team')}
  <section class="section team-section">
    <div class="wrap toolbar center">
      <div class="tabs">${[['all', 'Everyone'], ['drivers', 'Drivers'], ['crew', 'Team & crew']].map(([k, l]) => `<button class="tab" data-f="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="carousel" id="carousel">
      <button class="car-arrow prev" aria-label="Previous">‹</button>
      <div class="car-viewport"><div class="car-track" id="track"></div></div>
      <button class="car-arrow next" aria-label="Next">›</button>
    </div>
    <div class="car-dots" id="dots"></div>
    <p class="center muted small car-hint">Swipe, drag or use ← → to browse</p>
  </section>`;

  const track = $('#track'), viewport = $('.car-viewport');
  let list = [];
  const build = () => {
    list = members.filter((m) => filter === 'all' || (filter === 'drivers' ? m.is_driver : !m.is_driver));
    idx = Math.min(idx, Math.max(0, list.length - 1));
    track.innerHTML = list.length ? list.map((m, i) => `
      <article class="slide" data-i="${i}">
        <div class="slide-photo"><img src="${esc(photoOf(m, color()))}" alt="${esc(m.name)}" draggable="false">${m.number ? `<span class="slide-num">${esc(m.number)}</span>` : ''}</div>
        <div class="slide-body">
          <div class="slide-role">${esc(m.role || '')}</div>
          <h3>${esc(m.name)}</h3>
          <div class="muted small">${esc(m.nationality || '')}</div>
          <a class="btn btn-primary btn-sm" href="#/team/${m.id}">View profile</a>
        </div>
      </article>`).join('') : '<div class="empty">No one here yet.</div>';
    $('#dots').innerHTML = list.map((_, i) => `<button aria-label="Go to ${i + 1}" data-i="${i}"></button>`).join('');
    $$('.tabs .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.f === filter));
    layout(false);
  };
  let drag = 0;
  const layout = (animate = true) => {
    const slides = $$('.slide', track);
    if (!slides.length) { track.style.transform = ''; return; }
    const w = slides[0].offsetWidth, gap = parseFloat(getComputedStyle(track).gap) || 24;
    const x = viewport.offsetWidth / 2 - (idx * (w + gap) + w / 2) + drag;
    track.style.transition = animate && !drag ? '' : 'none';
    track.style.transform = `translateX(${x}px)`;
    slides.forEach((s, i) => { s.classList.toggle('active', i === idx); s.classList.toggle('near', Math.abs(i - idx) === 1); });
    $$('#dots button').forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  const go = (i) => { idx = Math.max(0, Math.min(list.length - 1, i)); layout(); };

  $('.car-arrow.prev').onclick = () => go(idx - 1);
  $('.car-arrow.next').onclick = () => go(idx + 1);
  $('#dots').onclick = (e) => { const b = e.target.closest('button'); if (b) go(Number(b.dataset.i)); };
  $$('.tabs .tab').forEach((b) => (b.onclick = () => { filter = b.dataset.f; idx = 0; build(); }));

  // drag / swipe
  let startX = null, moved = false;
  viewport.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; startX = e.clientX; moved = false; });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  function onMove(e) { if (startX === null) return; drag = e.clientX - startX; if (Math.abs(drag) > 6) { moved = true; viewport.classList.add('dragging'); } if (moved) layout(); }
  function onUp(e) {
    if (startX === null) return;
    const dx = drag; startX = null; drag = 0; viewport.classList.remove('dragging');
    if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(dx) / 300)));
    else if (!moved) { const s = e.target.closest?.('.slide'); if (s && !e.target.closest('a')) go(Number(s.dataset.i)); else layout(); }
    else layout();
  }
  viewport.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  const onKey = (e) => { if (e.key === 'ArrowLeft') go(idx - 1); if (e.key === 'ArrowRight') go(idx + 1); };
  const onResize = () => layout(false);
  window.addEventListener('keydown', onKey); window.addEventListener('resize', onResize);
  onCleanup(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); });

  build();
  requestAnimationFrame(() => layout(false));
  // images can change slide width once loaded on some layouts
  setTimeout(() => layout(false), 300);
}

async function profile(members, id) {
  const found = DATA.member(id);
  if (!found) throw new Error('That team member could not be found.');
  const m = { ...found, cards: DATA.cards().filter((c) => c.member_id === id) };
  const i = members.findIndex((x) => x.id === id);
  const prev = members[(i - 1 + members.length) % members.length], nxt = members[(i + 1) % members.length];
  const age = ageFrom(m.birthdate);
  const stats = m.stats || {};
  const hasStats = m.is_driver && S.statFields.some((f) => stats[f.key] !== undefined && stats[f.key] !== '');
  const teammate = members.find((x) => x.is_driver && x.id !== m.id);
  const facts = [
    ['Role', m.role], ['Number', m.number], ['Nationality', m.nationality], ['Hometown', m.hometown],
    ['Born', m.birthdate ? `${fmtDate(m.birthdate, { day: 'numeric', month: 'long', year: 'numeric' })}${age !== null ? ` (${age})` : ''}` : ''],
  ].filter(([, v]) => v);
  const socials = [['Instagram', m.instagram], ['X / Twitter', m.twitter]].filter(([, u]) => safeUrl(u));

  app.innerHTML = `
  <section class="profile-hero">
    <div class="wrap profile-grid">
      <div class="profile-photo"><img src="${esc(photoOf(m, color()))}" alt="${esc(m.name)}">${m.number ? `<span class="profile-num">${esc(m.number)}</span>` : ''}</div>
      <div class="profile-info">
        <a class="link-back" href="#/team">← All team members</a>
        <div class="eyebrow">${esc(m.role || '')}</div>
        <h1>${esc(m.name)}</h1>
        <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="profile-actions">
          ${socials.map(([l, u]) => `<a class="btn btn-ghost btn-sm" href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join('')}
          ${m.is_driver && teammate ? `<a class="btn btn-primary btn-sm" href="#/compare?ids=${m.id},${teammate.id}">Compare with ${esc(teammate.name.split(' ')[0])}</a>` : ''}
        </div>
      </div>
    </div>
  </section>
  <section class="wrap section profile-body">
    <div>
      <h2>Biography</h2>
      <div class="prose">${m.bio ? md(m.bio) : '<p class="muted">Biography coming soon.</p>'}</div>
    </div>
    ${hasStats ? `<aside><h2>Career stats</h2><div class="stat-grid">${S.statFields.filter((f) => stats[f.key] !== undefined && stats[f.key] !== '').map((f) =>
      `<div class="stat"><b>${esc(stats[f.key])}</b><span>${esc(f.label)}</span></div>`).join('')}</div></aside>` : ''}
  </section>
  ${m.cards?.length ? `<section class="wrap section"><div class="section-head"><h2>Collectible cards</h2><a class="link-arrow" href="#/packs">Open packs</a></div>
    <div class="card-row" id="profCards">${m.cards.map((c) => renderCard(c, { color: color() })).join('')}</div></section>` : ''}
  ${members.length > 1 ? `<section class="wrap profile-pager">
    <a href="#/team/${prev.id}">← ${esc(prev.name)}</a><a href="#/team/${nxt.id}">${esc(nxt.name)} →</a></section>` : ''}`;
  if ($('#profCards')) enableTilt($('#profCards'));
}

// ------------------------------------------------------------------ NEWS
async function news(args) {
  if (args[0]) return article(decodeURIComponent(args[0]));
  const list = DATA.news();
  app.innerHTML = `${pageHead('Team news', 'News')}
  <section class="wrap section">
    ${list.length ? `${newsCard(list[0], 0, true)}<div class="news-grid">${list.slice(1).map((n) => newsCard(n)).join('')}</div>`
      : '<div class="empty">No articles yet — check back soon.</div>'}
  </section>`;
}
async function article(slug) {
  const n = DATA.news().find((x) => x.slug === slug);
  if (!n) throw new Error('Article not found.');
  const cover = safeUrl(n.cover);
  app.innerHTML = `<article class="article">
    <div class="wrap narrow">
      <a class="link-back" href="#/news">← All news</a>
      <div class="small muted">${fmtDate(n.published_at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${n.author ? ` · ${esc(n.author)}` : ''}</div>
      <h1>${esc(n.title)}</h1>
      ${n.excerpt ? `<p class="lede">${esc(n.excerpt)}</p>` : ''}
    </div>
    ${cover ? `<div class="wrap article-cover"><img src="${esc(cover)}" alt=""></div>` : ''}
    <div class="wrap narrow prose">${md(n.body)}</div>
  </article>`;
  document.title = `${n.title} · ${S.settings.team_name}`;
  onCleanup(() => (document.title = S.settings.team_name));
}

// ------------------------------------------------------------------ MEDIA
async function media() {
  const items = DATA.media();
  const albums = [...new Set(items.map((m) => m.album).filter(Boolean))];
  let album = '', shown = items;
  app.innerHTML = `${pageHead('Behind the scenes', 'Media')}
  <section class="wrap section">
    ${albums.length ? `<div class="toolbar"><div class="tabs chips" id="albums">
      <button class="tab" data-a="">All photos</button>${albums.map((a) => `<button class="tab" data-a="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>` : ''}
    <div class="masonry" id="grid"></div>
  </section>
  <div class="lightbox" id="lb" hidden>
    <button class="lb-close" aria-label="Close">×</button>
    <button class="lb-nav lb-prev" aria-label="Previous">‹</button>
    <figure><img id="lbImg" alt=""><figcaption id="lbCap"></figcaption></figure>
    <button class="lb-nav lb-next" aria-label="Next">›</button>
  </div>`;
  const grid = $('#grid');
  const draw = () => {
    shown = items.filter((m) => !album || m.album === album);
    grid.innerHTML = shown.length ? shown.map((m, i) => `<figure class="m-item" data-i="${i}"><img src="${esc(m.file)}" alt="${esc(m.caption || '')}" loading="lazy">${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`).join('')
      : '<div class="empty">No photos uploaded yet.</div>';
    $$('#albums .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.a === album));
  };
  draw();
  $('#albums')?.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { album = b.dataset.a; draw(); } });

  let cur = 0; const lb = $('#lb');
  const show = (i) => { cur = (i + shown.length) % shown.length; $('#lbImg').src = shown[cur].file; $('#lbCap').textContent = [shown[cur].caption, shown[cur].album].filter(Boolean).join(' · '); };
  const open = (i) => { show(i); lb.hidden = false; document.body.classList.add('modal-open'); };
  const close = () => { lb.hidden = true; document.body.classList.remove('modal-open'); };
  grid.onclick = (e) => { const f = e.target.closest('.m-item'); if (f) open(Number(f.dataset.i)); };
  $('.lb-close').onclick = close; $('.lb-prev').onclick = () => show(cur - 1); $('.lb-next').onclick = () => show(cur + 1);
  lb.onclick = (e) => { if (e.target === lb) close(); };
  let sx = null;
  lb.addEventListener('pointerdown', (e) => (sx = e.clientX));
  lb.addEventListener('pointerup', (e) => { if (sx !== null && Math.abs(e.clientX - sx) > 50) show(cur + (e.clientX < sx ? 1 : -1)); sx = null; });
  const key = (e) => { if (lb.hidden) return; if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') show(cur - 1); if (e.key === 'ArrowRight') show(cur + 1); };
  window.addEventListener('keydown', key); onCleanup(() => window.removeEventListener('keydown', key));
}

// ------------------------------------------------------------------ COMPARE
async function compare(_args, params) {
  const drivers = DATA.members().filter((m) => m.is_driver);
  if (drivers.length < 2) { app.innerHTML = `${pageHead('Head to head', 'Compare drivers')}<div class="wrap empty">Add at least two drivers in the admin console to compare them.</div>`; return; }
  let sel = (params.get('ids') || '').split(',').filter((id) => drivers.some((d) => d.id === id));
  if (sel.length < 2) sel = drivers.slice(0, 2).map((d) => d.id);

  app.innerHTML = `${pageHead('Head to head', 'Compare drivers', 'Pick two to four drivers to compare their stats side by side.')}
  <section class="wrap section">
    <div class="picker" id="picker">${drivers.map((d) => `<button class="pick" data-id="${esc(d.id)}"><img src="${esc(photoOf(d, color()))}" alt=""><span>${esc(d.name)}</span>${d.number ? `<b>#${esc(d.number)}</b>` : ''}</button>`).join('')}</div>
    <div id="cmp"></div>
  </section>`;

  const draw = () => {
    $$('.pick').forEach((b) => b.classList.toggle('on', sel.includes(b.dataset.id)));
    const ds = sel.map((id) => drivers.find((d) => d.id === id));
    const leads = new Map(ds.map((d) => [d.id, 0]));
    const rows = S.statFields.map((f) => {
      const vals = ds.map((d) => { const v = parseFloat(d.stats?.[f.key]); return isNaN(v) ? null : v; });
      const valid = vals.filter((v) => v !== null);
      const best = valid.length ? (f.lowerBetter ? Math.min(...valid) : Math.max(...valid)) : null;
      const max = Math.max(...valid, 0) || 1;
      const unique = valid.filter((v) => v === best).length === 1;
      if (best !== null && unique) ds.forEach((d, i) => { if (vals[i] === best) leads.set(d.id, leads.get(d.id) + 1); });
      return `<div class="cmp-row"><div class="cmp-label">${esc(f.label)}${f.lowerBetter ? '<span class="small muted"> (lower is better)</span>' : ''}</div>
        ${vals.map((v) => `<div class="cmp-cell ${v !== null && v === best ? 'best' : ''}"><b>${v === null ? '–' : esc(v)}</b>
          <div class="cmp-bar"><i style="width:${v === null ? 0 : f.lowerBetter ? (v > 0 ? (Math.min(...valid) / v) * 100 : 100) : (v / max) * 100}%"></i></div></div>`).join('')}
      </div>`;
    }).join('');
    $('#cmp').innerHTML = `<div class="cmp" style="--cols:${ds.length}">
      <div class="cmp-row cmp-head"><div></div>${ds.map((d) => `<a class="cmp-driver" href="#/team/${d.id}">
        <img src="${esc(photoOf(d, color()))}" alt=""><div><b>${esc(d.name)}</b><span>${d.number ? `#${esc(d.number)} · ` : ''}${leads.get(d.id)} stat${leads.get(d.id) === 1 ? '' : 's'} led</span></div></a>`).join('')}</div>
      ${rows}</div>`;
  };
  $('#picker').onclick = (e) => {
    const b = e.target.closest('.pick'); if (!b) return;
    const id = b.dataset.id;
    if (sel.includes(id)) { if (sel.length <= 2) return toast('Pick at least two drivers'); sel = sel.filter((x) => x !== id); }
    else { if (sel.length >= 4) return toast('You can compare up to four drivers'); sel.push(id); }
    history.replaceState(null, '', `#/compare?ids=${sel.join(',')}`);
    draw();
  };
  draw();
}

// ------------------------------------------------------------------ AUTH (Firebase)
function authForm(intro = '') {
  return `<div class="auth-card">
    ${intro}
    <div class="tabs auth-tabs"><button class="tab" data-m="login" aria-selected="true">Sign in</button><button class="tab" data-m="register">Create account</button></div>
    <form id="authForm">
      <label class="reg-only" hidden>Username<input name="username" autocomplete="nickname" minlength="3" maxlength="24" placeholder="Shown on your collection"></label>
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required minlength="6"></label>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      ${Gacha.googleEnabled ? '<button class="btn btn-ghost btn-block google-btn" type="button" id="googleBtn">Continue with Google</button>' : ''}
      <p class="small muted form-note"><button type="button" class="link-btn" id="forgotBtn">Forgot password?</button> · New accounts start with ${esc(S.settings.starting_coins)} coins.</p>
    </form></div>`;
}
function wireAuth() {
  let mode = 'login';
  const form = $('#authForm');
  $$('.auth-tabs .tab').forEach((b) => (b.onclick = () => {
    mode = b.dataset.m;
    $$('.auth-tabs .tab').forEach((x) => x.setAttribute('aria-selected', x === b));
    $('button[type=submit]', form).textContent = mode === 'login' ? 'Sign in' : 'Create account';
    $('.reg-only', form).hidden = mode === 'login';
    form.username.required = mode === 'register';
    form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  }));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      if (mode === 'login') await Gacha.signIn(form.email.value.trim(), form.password.value);
      else await Gacha.register(form.username.value.trim(), form.email.value.trim(), form.password.value);
      toast(mode === 'login' ? 'Welcome back!' : 'Welcome aboard!', 'ok');
      if (location.hash.startsWith('#/login')) location.hash = new URLSearchParams(location.hash.split('?')[1] || '').get('next') || '#/packs';
    } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  };
  $('#googleBtn')?.addEventListener('click', async () => { try { await Gacha.google(); } catch (err) { toast(err.message, 'err'); } });
  $('#forgotBtn').onclick = async () => {
    const email = form.email.value.trim();
    if (!email) return toast('Type your email above first', 'err');
    try { await Gacha.resetPassword(email); toast('Password reset email sent', 'ok'); } catch (err) { toast(err.message, 'err'); }
  };
}
function gachaUnavailable() {
  return `${pageHead('Collect the team', 'Paddock Packs')}<section class="wrap section"><div class="empty panel">
    <h2>Packs are coming soon</h2><p>Card packs aren't switched on yet — check back soon!</p></div></section>`;
}
async function login() {
  if (!Gacha.enabled) { app.innerHTML = gachaUnavailable(); return; }
  if (S.me) { location.hash = '#/packs'; return; }
  app.innerHTML = `${pageHead('Fan account', 'Sign in')}<section class="wrap section center-col">${authForm()}</section>`;
  wireAuth();
}

// ------------------------------------------------------------------ PACKS (gacha)
const packBrand = () => safeUrl(S.settings.logo)
  ? `<img class="pack-logo" src="${esc(S.settings.logo)}" alt="">`
  : `<span class="pack-brand">${esc(S.settings.short_name)}</span>`;
function fmtWait(ms) { const t = Math.max(1, Math.ceil(ms / 60e3)), h = Math.floor(t / 60), m = t % 60; return h ? `${h}h ${m}m` : `${m}m`; }

async function packs() {
  if (!Gacha.enabled) { app.innerHTML = gachaUnavailable(); return; }
  const list = DATA.packs(), cards = DATA.cards();
  const counts = cards.reduce((a, c) => ((a[c.rarity] = (a[c.rarity] || 0) + 1), a), {});
  const st = Gacha.state;
  const wallet = () => {
    if (!st.ready) return '<div class="wallet"><span class="muted">Loading your account…</span></div>';
    if (st.user && !S.me) return `<div class="wallet"><span class="muted">${esc(st.error || 'Setting up your account…')}</span></div>`;
    if (!S.me) return `<div class="center-col">${authForm('<h3 class="center">Sign in to open packs</h3><p class="center muted small">Free account · free coins every day</p>')}</div>`;
    const can = S.me.canClaimDaily;
    return `<div class="wallet">
      <div class="wallet-coins"><span class="coin big"></span><div><b id="walletCoins">${S.me.coins.toLocaleString()}</b><span class="small muted">coins</span></div></div>
      <button class="btn ${can ? 'btn-primary' : 'btn-ghost'}" id="dailyBtn" ${can ? '' : 'disabled'}>${can ? `Claim ${esc(S.settings.daily_coins)} free coins` : `Free coins again in ${fmtWait(S.me.nextDailyAt - Date.now())}`}</button>
      <a class="btn btn-ghost" href="#/collection">My collection →</a>
    </div>`;
  };

  app.innerHTML = `${pageHead('Collect the team', 'Paddock Packs', 'Open packs to collect team cards. Four rarities, one goal: complete the set.')}
  <section class="wrap section">
    ${wallet()}
    <div class="rarity-legend">${RARS.map((r) => `<div class="leg leg-${r}"><i></i><b>${RARITY_LABEL[r]}</b><span>${counts[r] || 0} cards</span></div>`).join('')}</div>
    <div class="pack-grid">${list.map((p) => {
      const total = Object.values(p.odds || {}).reduce((a, b) => a + (Number(b) || 0), 0) || 1;
      return `<div class="pack-tile">
        <div class="pack-art pa-${(Number(p.sort) || 0) % 3}"><div class="pack-art-inner">${packBrand()}<span class="pack-name">${esc(p.name)}</span><span class="pack-size">${esc(p.size)} cards</span></div></div>
        <div class="pack-info">
          <h3>${esc(p.name)}</h3><p class="muted small">${esc(p.description || '')}</p>
          <ul class="odds">${RARS.filter((r) => Number(p.odds?.[r]) > 0).map((r) => `<li class="o-${r}"><span>${RARITY_LABEL[r]}</span><b>${((Number(p.odds[r]) / total) * 100).toFixed(1).replace(/\.0$/, '')}%</b></li>`).join('')}</ul>
          ${p.guaranteed ? `<div class="small guarantee">★ ${RARITY_LABEL[p.guaranteed]} or better guaranteed</div>` : ''}
          <button class="btn btn-primary btn-block open-btn" data-id="${esc(p.id)}" ${S.me ? '' : 'disabled'}><span class="coin"></span>${esc(p.cost)} — Open</button>
        </div></div>`;
    }).join('') || '<div class="empty">No packs available right now.</div>'}</div>
  </section>`;

  if (!S.me) { if ($('#authForm')) wireAuth(); return; }
  $('#dailyBtn').onclick = async (e) => {
    e.target.disabled = true;
    try { const amount = await Gacha.claimDaily(); toast(`+${amount} coins!`, 'ok'); router(); }
    catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  };
  $$('.open-btn').forEach((b) => (b.onclick = () => openPackFlow(list.find((p) => p.id === b.dataset.id))));
}

async function openPackFlow(pack) {
  if (S.me.coins < pack.cost) return toast(`You need ${pack.cost} coins — claim your free coins or come back later!`, 'err');
  document.body.classList.add('modal-open');
  const ov = document.createElement('div');
  ov.className = 'opening';
  ov.innerHTML = `<div class="opening-stage"><div class="pack-art big pa-${(Number(pack.sort) || 0) % 3} shaking"><div class="pack-art-inner">${packBrand()}<span class="pack-name">${esc(pack.name)}</span><span class="pack-size">Opening…</span></div></div></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.body.classList.remove('modal-open'); window.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape' && ov.dataset.done) close(); };
  window.addEventListener('keydown', esc_);
  onCleanup(close);

  let result;
  try { [result] = await Promise.all([Gacha.openPack(pack, DATA.cards()), new Promise((r) => setTimeout(r, 1100))]); }
  catch (e) { close(); return toast(e.message, 'err'); }
  setCoins(result.coins); const wc = $('#walletCoins'); if (wc) wc.textContent = result.coins.toLocaleString();

  $('.pack-art', ov).classList.add('torn');
  await new Promise((r) => setTimeout(r, 450));
  const best = Math.max(...result.cards.map((c) => RARS.indexOf(c.rarity)));
  ov.innerHTML = `<div class="opening-stage">
    <div class="reveal-row" style="--n:${result.cards.length}">${result.cards.map((c, i) => `
      <button class="flip r-${esc(c.rarity)}" style="--d:${i * 90}ms" aria-label="Reveal card ${i + 1}">
        <div class="flip-inner"><div class="flip-back">${safeUrl(S.settings.logo) ? `<img src="${esc(S.settings.logo)}" alt="">` : `<span>${esc(S.settings.short_name)}</span>`}</div><div class="flip-front">${renderCard(c, { color: color(), isNew: c.isNew })}</div></div>
      </button>`).join('')}</div>
    <div class="reveal-actions">
      <button class="btn btn-ghost" id="revealAll">Reveal all</button>
      <button class="btn btn-ghost" id="againBtn" hidden><span class="coin"></span>${esc(pack.cost)} — Open another</button>
      <a class="btn btn-ghost" href="#/collection" id="toColl" hidden>View collection</a>
      <button class="btn btn-primary" id="doneBtn" hidden>Done</button>
    </div></div>`;
  enableTilt(ov);
  const flips = $$('.flip', ov);
  const check = () => {
    if (flips.every((f) => f.classList.contains('flipped'))) {
      ov.dataset.done = '1';
      $('#revealAll', ov).hidden = true; ['#againBtn', '#toColl', '#doneBtn'].forEach((s) => ($(s, ov).hidden = false));
      if (best >= 2) ov.classList.add(best === 3 ? 'burst-sig' : 'burst-circ');
    }
  };
  flips.forEach((f) => (f.onclick = () => { f.classList.add('flipped'); check(); }));
  $('#revealAll', ov).onclick = () => { flips.forEach((f, i) => setTimeout(() => { f.classList.add('flipped'); check(); }, i * 160)); };
  $('#doneBtn', ov).onclick = () => { close(); if (location.hash.startsWith('#/packs')) router(); };
  $('#toColl', ov).onclick = close;
  $('#againBtn', ov).onclick = () => { close(); openPackFlow(pack); };
}

// ------------------------------------------------------------------ COLLECTION
async function collection() {
  if (!Gacha.enabled) { app.innerHTML = gachaUnavailable(); return; }
  if (!Gacha.state.ready) { app.innerHTML = '<div class="loading"><span></span></div>'; return; } // re-rendered when auth is ready
  if (!S.me) { location.hash = '#/login?next=' + encodeURIComponent('#/collection'); return; }
  const mine = S.me.cards || {};
  const cards = DATA.allCards()
    .filter((c) => isOn(c.active) || mine[c.id])
    .map((c) => ({ ...c, owned: mine[c.id] || 0 }))
    .sort((a, b) => RARS.indexOf(a.rarity) - RARS.indexOf(b.rarity));
  let filter = 'all';
  const owned = cards.filter((c) => c.owned);
  const pct = cards.length ? Math.round((owned.length / cards.length) * 100) : 0;

  app.innerHTML = `${pageHead(`${esc(S.me.username)}'s garage`, 'My Collection')}
  <section class="wrap section">
    <div class="coll-summary">
      <div class="coll-total"><b>${owned.length}<span>/${cards.length}</span></b><span class="muted small">unique cards · ${pct}% complete · ${S.me.pulled} pulled</span>
        <div class="progress"><i style="width:${pct}%"></i></div></div>
      ${RARS.map((r) => { const all = cards.filter((c) => c.rarity === r); const o = all.filter((c) => c.owned).length;
        return `<div class="coll-r leg-${r}"><i></i><b>${o}/${all.length}</b><span>${RARITY_LABEL[r]}</span></div>`; }).join('')}
    </div>
    <div class="toolbar"><div class="tabs chips" id="cf">${[['all', 'All'], ['owned', 'Owned'], ...RARS.map((r) => [r, RARITY_LABEL[r]])].map(([k, l]) => `<button class="tab" data-f="${k}">${l}</button>`).join('')}</div>
      <a class="btn btn-primary btn-sm" href="#/packs">Open packs</a></div>
    <div class="card-grid" id="cg"></div>
  </section>
  <div class="card-zoom" id="zoom" hidden></div>`;

  const draw = () => {
    const list = cards.filter((c) => filter === 'all' || (filter === 'owned' ? c.owned : c.rarity === filter));
    $('#cg').innerHTML = list.map((c) => renderCard(c, { locked: !c.owned, count: c.owned, color: color() })).join('') || '<div class="empty">Nothing here yet.</div>';
    $$('#cf .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.f === filter));
  };
  $('#cf').onclick = (e) => { const b = e.target.closest('.tab'); if (b) { filter = b.dataset.f; draw(); } };
  draw(); enableTilt($('#cg'));

  const zoom = $('#zoom');
  $('#cg').onclick = (e) => {
    const el = e.target.closest('.tcard:not(.locked)'); if (!el) return;
    const c = cards.find((x) => x.id === el.dataset.card);
    zoom.innerHTML = `<div class="zoom-inner">${renderCard(c, { color: color() })}<div class="zoom-info"><div class="eyebrow">${RARITY_LABEL[c.rarity]}</div><h2>${esc(c.name)}</h2><p>${esc(c.subtitle || '')}</p>${c.flavor ? `<p class="muted"><em>${esc(c.flavor)}</em></p>` : ''}<p class="small muted">You own ${c.owned}</p>${c.member_id ? `<a class="btn btn-ghost btn-sm" href="#/team/${esc(c.member_id)}">View profile</a>` : ''}</div></div>`;
    zoom.hidden = false; document.body.classList.add('modal-open'); enableTilt(zoom);
  };
  zoom.onclick = (e) => { if (!e.target.closest('a') && !e.target.closest('.tcard')) { zoom.hidden = true; document.body.classList.remove('modal-open'); } };
}

// ------------------------------------------------------------------ BACKGROUND MUSIC (mute / unmute only)
const ICON_SOUND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function initMusic() {
  const file = safeUrl(S.settings.music_file);
  if (!file) return;
  const audio = new Audio(file);
  audio.loop = true; audio.preload = 'auto';
  audio.volume = Math.min(1, Math.max(0, (Number(S.settings.music_volume ?? 35) || 0) / 100));
  let muted = store.get('musicMuted', false), started = false;
  audio.muted = muted;

  const btn = document.createElement('button');
  btn.className = 'fab music-fab';
  btn.innerHTML = `<span class="fab-icon"></span><span class="eq"><i></i><i></i><i></i></span>`;
  document.body.appendChild(btn);
  const render = () => {
    btn.classList.toggle('muted', muted);
    btn.classList.toggle('waiting', !started && !muted);
    $('.fab-icon', btn).innerHTML = muted ? ICON_MUTED : ICON_SOUND;
    const label = muted ? 'Unmute music' : 'Mute music';
    btn.setAttribute('aria-label', label);
    btn.title = `${label}${S.settings.music_title ? ` — ♪ ${S.settings.music_title}` : ''}${!started && !muted ? ' (starts when you interact with the page)' : ''}`;
  };
  // Browsers block sound until the visitor interacts with the page, so the track starts
  // on the first click / key / tap. After that the button only mutes and unmutes.
  const start = () => {
    if (started) return;
    audio.play().then(() => { started = true; render(); unhook(); }).catch(() => { /* still blocked */ });
  };
  const kick = (e) => { if (e.target.closest && e.target.closest('.music-fab')) return; start(); };
  const evs = ['pointerdown', 'keydown', 'touchstart'];
  const unhook = () => evs.forEach((ev) => window.removeEventListener(ev, kick, true));
  evs.forEach((ev) => window.addEventListener(ev, kick, { capture: true, passive: true }));
  btn.onclick = () => {
    muted = !muted; audio.muted = muted; store.set('musicMuted', muted);
    start(); render();
  };
  render(); start();
}

// ------------------------------------------------------------------ SEARCH (bottom-right button)
const TYPE_WEIGHT = { Team: 8, Page: 6, News: 5, Race: 4, Standings: 3, Pack: 2, Card: 1, Photo: 1 };
function buildSearchIndex() {
  const items = [];
  const strip = (t) => String(t || '').replace(/[#>*_`!\[\]()-]/g, ' ');
  const add = (type, title, sub, href, extra = '', thumb = '') =>
    items.push({ type, title: String(title || ''), sub: String(sub || ''), href, thumb, hay: `${title} ${sub} ${extra}`.toLowerCase() });
  [['Home', '#/', 'home page latest'], ['Schedule & Standings', '#/schedule', 'calendar races championship table points'],
    ['Team', '#/team', 'drivers crew staff people'], ['News', '#/news', 'articles updates'], ['Media', '#/media', 'photos gallery pictures'],
    ['Compare drivers', '#/compare', 'head to head stats'], ['Paddock Packs', '#/packs', 'cards gacha coins open'], ['My collection', '#/collection', 'cards binder']]
    .forEach(([t, h, x]) => add('Page', t, '', h, x));
  DATA.members().forEach((m) => add('Team', m.name, [m.role, m.number ? `#${m.number}` : '', m.nationality].filter(Boolean).join(' · '), `#/team/${encodeURIComponent(m.id)}`, `${m.hometown || ''} ${strip(m.bio)}`, photoOf(m, color())));
  DATA.news().forEach((n) => add('News', n.title, [fmtDate(n.published_at), n.excerpt].filter(Boolean).join(' — '), `#/news/${encodeURIComponent(n.slug)}`, `${n.author || ''} ${strip(n.body)}`, safeUrl(n.cover)));
  DATA.races().forEach((r) => add('Race', r.name, [r.round ? `Round ${r.round}` : '', r.circuit, fmtDate(r.date), r.result].filter(Boolean).join(' · '), '#/schedule', `${r.country || ''} ${r.status || ''}`));
  const st = DATA.standings();
  st.drivers.forEach((d) => add('Standings', d.driver, `P${d.pos} · ${d.points} pts${d.team ? ` · ${d.team}` : ''}`, '#/schedule?tab=drivers', 'drivers championship'));
  st.constructors.forEach((c) => add('Standings', c.team, `P${c.pos} · ${c.points} pts · Constructors`, '#/schedule?tab=constructors', 'constructors championship team'));
  DATA.cards().forEach((c) => add('Card', c.name, [RARITY_LABEL[c.rarity], c.subtitle].filter(Boolean).join(' · '), S.me ? '#/collection' : '#/packs', `${c.circuit || ''} ${c.flavor || ''} ${c.rarity}`));
  DATA.packs().forEach((p) => add('Pack', p.name, `${p.cost} coins · ${p.size} cards`, '#/packs', p.description || ''));
  DATA.media().forEach((m) => add('Photo', m.caption || 'Photo', m.album || 'Gallery', '#/media', '', safeUrl(m.file)));
  return items;
}
function initSearch() {
  const fab = document.createElement('button');
  fab.className = 'fab search-fab';
  fab.setAttribute('aria-label', 'Search the site');
  fab.title = 'Search (Ctrl+K)';
  fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  const panel = document.createElement('div');
  panel.className = 'search-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Search');
  panel.innerHTML = `<div class="search-box">
      <div class="search-input"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input type="text" enterkeyhint="search" aria-label="Search" placeholder="Search drivers, news, races, cards…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="search-results" role="listbox"></div></div>`;
  document.body.append(fab, panel);
  const input = $('input', panel), out = $('.search-results', panel);
  let index = null, sel = 0, results = [];

  const hl = (text, terms) => {
    let h = esc(text);
    terms.forEach((t) => { const e = esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); if (e) h = h.replace(new RegExp(`(${e})`, 'ig'), '<mark>$1</mark>'); });
    return h;
  };
  const run = () => {
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.length) {
      results = index.filter((i) => i.type === 'Page');
    } else {
      results = index.filter((i) => terms.every((t) => i.hay.includes(t)))
        .map((i) => { const tl = i.title.toLowerCase(); return { i, score: (tl.startsWith(q) ? 3 : 0) + (tl.includes(q) ? 20 : 0) + terms.filter((t) => tl.includes(t)).length * 5 + (TYPE_WEIGHT[i.type] || 0) * 2 }; })
        .sort((a, b) => b.score - a.score).map((x) => x.i);
      // keep the list readable: at most a few of each kind (cards & photos can be numerous)
      const per = {}, cap = { Card: 4, Photo: 6, Standings: 4 };
      results = results.filter((r) => (per[r.type] = (per[r.type] || 0) + 1) <= (cap[r.type] || 8)).slice(0, 30);
      // group by type, in order of each group's best match
      const order = [...new Set(results.map((r) => r.type))];
      results.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    }
    sel = 0;
    if (!results.length) { out.innerHTML = `<div class="search-empty">No results for “${esc(input.value.trim())}”</div>`; return; }
    let last = '';
    out.innerHTML = results.map((r, n) => {
      const group = r.type !== last ? `<div class="search-group">${terms.length ? r.type : 'Jump to'}</div>` : ''; last = r.type;
      return `${group}<a class="search-item" href="${esc(r.href)}" data-n="${n}" role="option">
        ${r.thumb ? `<span class="search-thumb" style="background-image:url('${esc(r.thumb)}')"></span>` : `<span class="search-thumb type-${r.type.toLowerCase()}">${esc(r.type[0])}</span>`}
        <span class="search-text"><b>${hl(r.title, terms)}</b>${r.sub ? `<small>${hl(r.sub, terms)}</small>` : ''}</span><span class="search-type">${esc(r.type)}</span></a>`;
    }).join('');
    mark();
  };
  const mark = () => $$('.search-item', out).forEach((a) => { const on = Number(a.dataset.n) === sel; a.classList.toggle('on', on); if (on) a.scrollIntoView({ block: 'nearest' }); });
  const open = () => {
    if (!S.data) return;
    index = buildSearchIndex();
    panel.hidden = false; fab.classList.add('active'); document.body.classList.add('search-open');
    input.value = ''; run(); setTimeout(() => input.focus(), 30);
  };
  const close = () => { panel.hidden = true; fab.classList.remove('active'); document.body.classList.remove('search-open'); };
  fab.onclick = () => (panel.hidden ? open() : close());
  input.oninput = run;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); location.hash = results[sel].href; close(); }
  };
  out.onclick = (e) => { if (e.target.closest('.search-item')) close(); };
  panel.onclick = (e) => { if (e.target === panel) close(); };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) { e.preventDefault(); panel.hidden ? open() : input.focus(); }
  });
  window.addEventListener('hashchange', close);
}

boot();
