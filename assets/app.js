/* Public website — single-page app with hash routing. */
'use strict';

const S = { settings: {}, statFields: [], cleanup: [], data: null };
const color = () => S.settings.primary_color || '#857452';
const app = $('#app');

// ---- data (all site content lives in data/site.json, published from the admin console)
const D = () => S.data;
const isOn = (v) => v === true || v === 1 || v === '1';
const DATA = {
  members: () => [...(D().members || [])].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)),
  member: (id) => (D().members || []).find((m) => m.id === id),
  races: () => D().races || [],
  // calculated from the race results + the points system (see common.js)
  standings: () => (S._standings ||= computeStandings(D())),
  started: () => anyResults(D()),
  points: () => D().points || DEFAULT_POINTS,
  news: () => (D().news || []).filter((n) => isOn(n.published)).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))),
  media: () => D().media || [],
};
const onCleanup = (fn) => S.cleanup.push(fn);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Driver stats are calculated from the race results entered in the admin console
const driverStats = (m) => ({ ...computeStats(DATA.races(), m.name, DATA.points()), championships: m.stats?.championships });

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    S.data = migrateData(await fetchJson(`data/site.json?v=${Date.now()}`));
    S.settings = S.data.settings || {}; S.statFields = STAT_FIELDS;
  } catch (e) { app.innerHTML = `<div class="wrap empty">Couldn't load the site content. ${esc(e.message)}</div>`; return; }
  applyTheme();
  renderAccount();
  initSearch();
  initMusic();
  $('#burger').addEventListener('click', () => document.body.classList.toggle('menu-open'));
  window.addEventListener('scroll', () => $('#nav').classList.toggle('scrolled', scrollY > 10), { passive: true });
  window.addEventListener('hashchange', router);
  router();
}

function applyTheme() {
  const s = S.settings, r = document.documentElement.style;
  r.setProperty('--accent', s.primary_color || '#857452');
  r.setProperty('--accent-2', s.secondary_color || '#c9b98f');
  if (s.background_color) r.setProperty('--bg-dark', s.background_color);
  document.title = s.team_name || 'Team';
  const logo = safeUrl(s.logo);
  $('#brand').classList.toggle('logo-only', !!logo);
  $('#brand').innerHTML = logo
    ? `${logoImg(s.team_name)}<span>${esc(s.short_name || s.team_name)}</span>`
    : `<span class="brand-mark">${esc((s.short_name || s.team_name || 'T').slice(0, 1))}</span><span>${esc(s.short_name || s.team_name)}</span>`;
  const socials = ['instagram', 'twitter', 'youtube', 'twitch'].filter((k) => safeUrl(s[k]))
    .map((k) => `<a href="${esc(s[k])}" target="_blank" rel="noopener">${k === 'twitter' ? 'X / Twitter' : k[0].toUpperCase() + k.slice(1)}</a>`).join('');
  $('#footer').innerHTML = `<div class="wrap footer-inner">
    <div>${logo ? logoImg('', 'footer-logo') : ''}<div class="footer-brand">${esc(s.team_name)}</div><div class="muted">${esc(s.tagline)}</div></div>
    <div class="footer-links">${socials}</div>
    <div class="muted small footer-meta">© ${new Date().getFullYear()} ${esc(s.team_name)}</div></div>`;
}

// ------------------------------------------------------------------ header buttons: light/dark + admin console
const ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" fill="currentColor"/></svg>';
const theme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
// Logo <img> that swaps to the light-mode logo (or is darkened) in light mode
function logoImg(alt = '', cls = '') {
  const s = S.settings, light = safeUrl(s.logo_light);
  const src = theme() === 'light' && light ? light : s.logo;
  return `<img class="theme-logo ${light ? 'has-light' : ''} ${cls}" src="${esc(src)}" data-dark="${esc(s.logo)}" data-light="${esc(light || s.logo)}" alt="${esc(alt)}">`;
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('apx_theme', t);
  $$('img.theme-logo').forEach((im) => (im.src = t === 'light' ? im.dataset.light : im.dataset.dark));
  renderAccount();
}
function renderAccount() {
  const light = theme() === 'light';
  $('#navAccount').innerHTML = `
    <button class="theme-btn" id="themeBtn" aria-label="Switch to ${light ? 'dark' : 'light'} mode" title="Switch to ${light ? 'dark' : 'light'} mode">${light ? ICON_MOON : ICON_SUN}</button>
    <a href="admin.html" class="btn btn-sm btn-primary admin-btn">Admin Console</a>`;
  $('#navMobileAcct').innerHTML = '';
  $('#themeBtn').onclick = () => setTheme(light ? 'dark' : 'light');
  // remember this page so leaving the admin console brings you straight back here
  $('.admin-btn').onclick = () => { try { sessionStorage.setItem('apx_return', location.hash || '#/'); } catch { /* ignore */ } };
}

// ------------------------------------------------------------------ router
const ROUTES = { '': home, home, schedule, team, news, media, compare, race };
async function router() {
  S.cleanup.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); S.cleanup = [];
  document.body.classList.remove('menu-open', 'modal-open');
  const [pathPart, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, ...args] = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  $$('#navLinks a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'race' ? 'schedule' : name || 'home')));
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
  const started = DATA.started();
  const ourTeam = started && standings.constructors.find((c) => c.is_ours);
  const ourDrivers = started ? standings.drivers.filter((d) => d.is_ours) : [];
  const last = [...races].filter((r) => r.status === 'completed').sort((a, b) => raceTime(b) - raceTime(a))[0];
  const hero = safeUrl(s.hero_image);

  app.innerHTML = `
  <section class="hero ${hero ? 'has-img' : ''}" ${hero ? `style="--hero:url('${esc(hero)}')"` : ''}>
    <div class="hero-speed"></div>
    <div class="wrap hero-inner">
      <div class="eyebrow">Season ${esc(s.season)}</div>
      ${safeUrl(s.logo)
        ? `<h1 class="hero-logo">${logoImg(s.team_name)}</h1><div class="hero-fullname">${esc(s.team_name)}</div>`
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
      ${ourTeam ? `<div class="big-pos">P${esc(ourTeam.pos)}</div><div class="muted">${esc(ourTeam.points)} pts</div>` : '<div class="muted">Standings appear after the first race</div>'}
      <a class="link-arrow" href="#/schedule?tab=constructors">Full standings</a>
    </div>
    <div class="panel">
      <div class="panel-label">Drivers' championship</div>
      ${ourDrivers.length ? ourDrivers.map((d) => `<div class="mini-row"><span class="mini-pos">P${esc(d.pos)}</span><span>${esc(d.driver)}</span><b>${esc(d.points)}</b></div>`).join('') : '<div class="muted">Standings appear after the first race</div>'}
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

  ${media.length ? `<section class="wrap section">
    <div class="section-head"><h2>Gallery</h2><a class="link-arrow" href="#/media">All photos</a></div>
    <div class="media-teaser">${media.slice(0, 6).map((m) => `<a href="#/media"><img src="${esc(m.file)}" alt="${esc(m.caption || '')}" loading="lazy"></a>`).join('')}</div>
  </section>` : ''}

  ${s.about ? `<section class="wrap section about"><h2>About the team</h2><div class="prose">${md(s.about)}</div></section>` : ''}`;

  if (next) startCountdowns();
  // fan of sample cards in the band

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
    if (!rows.length) return '<div class="empty small">No drivers or teams have been added yet.</div>';
    const started = DATA.started();
    return `${started ? '' : '<p class="muted small standings-note">The season hasn\'t started yet — the championship fills in automatically as race results are added.</p>'}<div class="table-wrap"><table class="standings">
      <thead><tr><th>Pos</th><th>${kind === 'drivers' ? 'Driver' : 'Team'}</th>${kind === 'drivers' ? '<th class="hide-sm">Team</th>' : ''}<th class="num">Pts</th><th class="hide-sm bar-col"></th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.is_ours ? 'ours' : ''}">
        <td class="pos">${started ? esc(r.pos) : '–'}</td>
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
        const res = hasResults(r);
        return `<${res ? `a href="#/race/${encodeURIComponent(r.id)}"` : 'div'} class="race-row ${done ? 'done' : ''} ${isNext ? 'is-next' : ''} ${res ? 'has-results' : ''}">
          <div class="race-date">${d ? `<b>${d.getDate()}</b><span>${d.toLocaleDateString(undefined, { month: 'short' })}</span>` : '<b>TBC</b>'}</div>
          <div class="race-round">R${esc(r.round || '–')}</div>
          <div class="race-main"><h3>${esc(r.name)}</h3><div class="muted small">${esc([r.circuit, r.country].filter(Boolean).join(' · '))}${r.time && !done ? ` · ${esc(r.time)}` : ''}</div></div>
          <div class="race-status">${done ? `<span class="pill">Completed</span>${r.result ? `<div class="race-result">${esc(r.result)}</div>` : ''}${(() => { const f = (r.results?.race || []).find((x) => x.fl); return f ? `<div class="race-fl">⏱ Fastest lap: ${esc(f.d)}</div>` : ''; })()}` : isNext ? `<span class="pill pill-live">Next race</span>${countdownHtml(r)}` : `<span class="pill pill-up">Upcoming</span>`}${res ? '<div class="race-link">Full results →</div>' : ''}</div>
        </${res ? 'a' : 'div'}>`;
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

// ------------------------------------------------------------------ RACE RESULTS
async function race(args, params) {
  const r = DATA.races().find((x) => x.id === decodeURIComponent(args[0] || ''));
  if (!r) throw new Error('Race not found.');
  const sess = sessionsFor(r).filter((s) => (r.results?.[s.key] || []).length);
  if (!sess.length) throw new Error('Results for this race haven\'t been added yet.');
  let cur = params.get('s') && sess.some((s) => s.key === params.get('s')) ? params.get('s') : sess[sess.length - 1].key;
  const ours = new Set([...DATA.members().filter((m) => m.is_driver).map((m) => normName(m.name)),
    ...D().grid.drivers.filter((d) => D().grid.teams.find((t) => t.id === d.team_id)?.is_ours).map((d) => normName(d.name))]);
  const P = DATA.points();
  const highlight = store.get('highlightOurs', true);
  app.innerHTML = `${pageHead(`Round ${esc(r.round || '–')} · ${esc(fmtDate(r.date, { day: 'numeric', month: 'long', year: 'numeric' }))}`, esc(r.name), esc([r.circuit, r.country].filter(Boolean).join(' · ')))}
  <section class="wrap section">
    <a class="link-back" href="#/schedule">← Race calendar</a>
    <div class="toolbar"><div class="tabs" id="sessTabs">${sess.map((s) => `<button class="tab" data-s="${s.key}">${s.label}</button>`).join('')}</div></div>
    <div id="sessBody"></div>
  </section>`;
  app.classList.toggle('hl-ours', highlight); onCleanup(() => app.classList.remove('hl-ours'));
  const draw = () => {
    const S2 = SESSIONS.find((s) => s.key === cur), rows = r.results[cur] || [];
    const isRace = S2.kind === 'race';
    const anyTyres = rows.some((x) => x.ty);
    $$('#sessTabs .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.s === cur));
    $('#sessBody').innerHTML = `<div class="table-wrap"><table class="standings results">
      <thead><tr><th>Pos</th><th>Driver</th><th class="hide-sm">Team</th><th>${isRace ? 'Time / Gap' : 'Best lap'}</th>${anyTyres ? '<th>Tyres</th>' : ''}${isRace ? '<th class="num">Pts</th>' : ''}</tr></thead>
      <tbody>${rows.map((x, i) => {
        const st = x.st || 'fin', isOurs = ours.has(normName(x.d)), pts = isRace ? rowPoints(cur, i + 1, x, P) : 0, flp = isRace ? flBonus(cur, i + 1, x, P) : 0;
        return `<tr class="${isOurs ? 'ours' : ''} ${st !== 'fin' ? 'out' : ''}">
          <td class="pos">${st === 'fin' ? i + 1 : `<span class="st-tag">${STATUS[st]}</span>`}</td>
          <td class="name">${esc(x.d)}${isOurs ? '<span class="ours-tag">Our team</span>' : ''}${x.fl ? `<span class="fl-tag" title="Fastest lap">⏱ Fastest lap${flp ? ` +${flp}` : ''}</span>` : ''}<div class="show-sm muted small">${esc(x.t || '')}</div></td>
          <td class="hide-sm muted">${esc(x.t || '')}</td>
          <td class="mono">${esc(x.time || (st !== 'fin' ? '—' : ''))}</td>
          ${anyTyres ? `<td class="tyres">${tyreChips(x.ty)}</td>` : ''}
          ${isRace ? `<td class="num"><b>${pts || ''}</b></td>` : ''}</tr>`;
      }).join('')}</tbody></table></div>`;
  };
  $('#sessTabs').onclick = (e) => { const b = e.target.closest('.tab'); if (b) { cur = b.dataset.s; history.replaceState(null, '', `#/race/${encodeURIComponent(r.id)}?s=${cur}`); draw(); } };
  draw();
}

// ------------------------------------------------------------------ TEAM (carousel)
async function team(args) {
  const members = DATA.members();
  if (args[0]) return profile(members, decodeURIComponent(args[0]));
  let filter = 'all', idx = 0;

  app.innerHTML = `${pageHead('The people behind the car', 'Our Team')}
  <section class="section team-section">
    <div class="wrap toolbar center">
      <div class="tabs">${[['all', 'Everyone'], ['crew', 'Trackside'], ['drivers', 'Drivers']].map(([k, l]) => `<button class="tab" data-f="${k}">${l}</button>`).join('')}</div>
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
    list = members.filter((m) => filter === 'all' || (filter === 'drivers' ? m.is_driver : !m.is_driver))
      .sort((a, b) => (a.is_driver ? 1 : 0) - (b.is_driver ? 1 : 0)); // Trackside first, then Drivers
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
  const m = found;
  const i = members.findIndex((x) => x.id === id);
  const prev = members[(i - 1 + members.length) % members.length], nxt = members[(i + 1) % members.length];
  const age = ageFrom(m.birthdate);
  const stats = m.is_driver ? driverStats(m) : {};
  const hasStats = m.is_driver && stats.hasResults;
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
    ${hasStats ? `<aside><h2>Season stats</h2><div class="stat-grid">${S.statFields.filter((f) => stats[f.key] !== undefined && stats[f.key] !== '').map((f) =>
      `<div class="stat"><b>${esc(stats[f.key])}</b><span>${esc(f.label)}</span></div>`).join('')}</div></aside>` : ''}
  </section>
  ${members.length > 1 ? `<section class="wrap profile-pager">
    <a href="#/team/${prev.id}">← ${esc(prev.name)}</a><a href="#/team/${nxt.id}">${esc(nxt.name)} →</a></section>` : ''}`;
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
    const st = new Map(ds.map((d) => [d.id, driverStats(d)]));
    const leads = new Map(ds.map((d) => [d.id, 0]));
    let h2h = '';
    if (ds.length === 2) {
      const races = DATA.races();
      h2h = [['quali', 'Qualifying head-to-head'], ['race', 'Race head-to-head']].map(([k, label]) => {
        const [a, b] = headToHead(races, ds[0].name, ds[1].name, k), tot = a + b;
        if (!tot) return '';
        return `<div class="cmp-row h2h-row"><div class="cmp-label">${label}</div>${[a, b].map((v, i) => `<div class="cmp-cell ${v > [a, b][1 - i] ? 'best' : ''}"><b>${v}</b><div class="cmp-bar"><i style="width:${(v / tot) * 100}%"></i></div></div>`).join('')}</div>`;
      }).join('');
    }
    const rows = S.statFields.map((f) => {
      const vals = ds.map((d) => { const v = parseFloat(st.get(d.id)[f.key]); return isNaN(v) ? null : v; });
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
      ${h2h}${rows}</div>
      ${ds.some((d) => st.get(d.id).hasResults) ? '' : '<p class="muted small center cmp-note">Stats fill in automatically as race results are added.</p>'}`;
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
const TYPE_WEIGHT = { Team: 8, Page: 6, News: 5, Race: 4, Standings: 3, Photo: 1 };
function buildSearchIndex() {
  const items = [];
  const strip = (t) => String(t || '').replace(/[#>*_`!\[\]()-]/g, ' ');
  const add = (type, title, sub, href, extra = '', thumb = '') =>
    items.push({ type, title: String(title || ''), sub: String(sub || ''), href, thumb, hay: `${title} ${sub} ${extra}`.toLowerCase() });
  [['Home', '#/', 'home page latest'], ['Schedule & Standings', '#/schedule', 'calendar races championship table points'],
    ['Team', '#/team', 'drivers crew staff people'], ['News', '#/news', 'articles updates'], ['Media', '#/media', 'photos gallery pictures'],
    ['Compare drivers', '#/compare', 'head to head stats']]
    .forEach(([t, h, x]) => add('Page', t, '', h, x));
  DATA.members().forEach((m) => add('Team', m.name, [m.role, m.number ? `#${m.number}` : '', m.nationality].filter(Boolean).join(' · '), `#/team/${encodeURIComponent(m.id)}`, `${m.hometown || ''} ${strip(m.bio)}`, photoOf(m, color())));
  DATA.news().forEach((n) => add('News', n.title, [fmtDate(n.published_at), n.excerpt].filter(Boolean).join(' — '), `#/news/${encodeURIComponent(n.slug)}`, `${n.author || ''} ${strip(n.body)}`, safeUrl(n.cover)));
  DATA.races().forEach((r) => add('Race', r.name, [r.round ? `Round ${r.round}` : '', r.circuit, fmtDate(r.date), r.result].filter(Boolean).join(' · '), hasResults(r) ? `#/race/${encodeURIComponent(r.id)}` : '#/schedule', `${r.country || ''} ${r.status || ''}`));
  const st = DATA.standings();
  st.drivers.forEach((d) => add('Standings', d.driver, `P${d.pos} · ${d.points} pts${d.team ? ` · ${d.team}` : ''}`, '#/schedule?tab=drivers', 'drivers championship'));
  st.constructors.forEach((c) => add('Standings', c.team, `P${c.pos} · ${c.points} pts · Constructors`, '#/schedule?tab=constructors', 'constructors championship team'));
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
        <input type="text" enterkeyhint="search" aria-label="Search" placeholder="Search drivers, news, races, photos…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
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
      const per = {}, cap = { Photo: 6, Standings: 4 };
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
