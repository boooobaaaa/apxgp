/* Shared helpers for the public site and the admin console. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Only allow safe URLs in href/src: relative paths, http(s), mailto, blob previews and inline images
function safeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^(https?:|mailto:|blob:|data:image\/[a-z+]+[;,])/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ''; // any other scheme (javascript:, etc.) is rejected
  return u;
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
  return res.json();
}

function toast(msg, kind = '') {
  const t = $('#toast');
  if (!t) return alert(msg);
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 3200);
}

const fmtDate = (d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? d + 'T12:00:00' : d);
  return isNaN(dt) ? d : dt.toLocaleDateString(undefined, opts);
};
function ageFrom(b) {
  if (!b) return null;
  const d = new Date(b + 'T12:00:00'), n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--;
  return isNaN(a) ? null : a;
}
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

// Generated placeholder portrait when no photo is uploaded
function avatar(name, color = '#857452', number = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1a1a1a"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><text x="380" y="140" text-anchor="end" font-family="Titillium Web,Arial" font-weight="900" font-style="italic" font-size="150" fill="#fff" opacity=".12">${esc(number)}</text><circle cx="200" cy="215" r="82" fill="#fff" opacity=".14"/><path d="M60 500c0-90 63-150 140-150s140 60 140 150z" fill="#fff" opacity=".14"/><text x="200" y="238" text-anchor="middle" font-family="Titillium Web,Arial" font-weight="900" font-size="64" fill="#fff" opacity=".85">${esc(initials(name))}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
const photoOf = (m, color) => safeUrl(m.photo || m.image) || avatar(m.name, color, m.number);

// Tiny, safe markdown: headings, bold, italics, links, images, lists, quotes, paragraphs
function md(src) {
  const inline = (s) => esc(s)
    // (text is already HTML-escaped at this point, so captured URLs are attribute-safe)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => safeUrl(u) ? `<img src="${u}" alt="${a}" loading="lazy">` : '')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => safeUrl(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  const out = []; let list = null, para = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (list) { out.push(`<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; }
  };
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if (!line) { flush(); continue; }
    if ((m = /^(#{1,3})\s+(.*)/.exec(line))) { flush(); const l = m[1].length + 1; out.push(`<h${l}>${inline(m[2])}</h${l}>`); continue; }
    if ((m = /^>\s?(.*)/.exec(line))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = /^[-*]\s+(.*)/.exec(line)) || (m = /^\d+[.)]\s+(.*)/.exec(line))) {
      const t = /^\d/.test(line) ? 'ol' : 'ul';
      if (para.length) flush();
      if (!list || list.t !== t) { flush(); list = { t, items: [] }; }
      list.items.push(m[1]); continue;
    }
    if (list) flush();
    para.push(line);
  }
  flush();
  return out.join('\n');
}

// ================================================================ race results & stats
// Shared by the website (results pages, Compare, profiles) and the admin console.
// race.results = { sprint_quali: [row…], sprint: [row…], quali: [row…], race: [row…] }
// row = { d: driver name, t: team, time: '1:29.708' | '+5.123', st: 'fin'|'dnf'|'dns'|'dsq', ty: 'SMH' (tyre stints), fl: true (fastest lap) }
const SESSIONS = [
  { key: 'sprint_quali', label: 'Sprint Qualifying', short: 'Sprint Quali', kind: 'quali', sprint: true },
  { key: 'sprint', label: 'Sprint', short: 'Sprint', kind: 'race', sprint: true },
  { key: 'quali', label: 'Qualifying', short: 'Quali', kind: 'quali' },
  { key: 'race', label: 'Grand Prix', short: 'Race', kind: 'race' },
];
// Default points system (editable in the admin console under "Points System")
const DEFAULT_POINTS = { race: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], sprint: [8, 7, 6, 5, 4, 3, 2, 1], fl_race: 1, fl_sprint: 0, fl_top: 10 };
const TYRES = { S: ['Soft', '#e10600'], M: ['Medium', '#f5c400'], H: ['Hard', '#f2f2f2'], I: ['Intermediate', '#39b54a'], W: ['Wet', '#2a7fff'] };
const STATUS = { fin: 'Finished', dnf: 'DNF', dns: 'DNS', dsq: 'DSQ' };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const sessionsFor = (race) => SESSIONS.filter((s) => !s.sprint || race.has_sprint);
const hasResults = (race) => !!race.results && SESSIONS.some((s) => (race.results[s.key] || []).length);

/** Fastest-lap bonus for a row (0 if not eligible). */
function flBonus(key, pos, row, pts = DEFAULT_POINTS) {
  if (!row.fl || (row.st && row.st !== 'fin')) return 0;
  const bonus = Number(key === 'race' ? pts.fl_race : key === 'sprint' ? pts.fl_sprint : 0) || 0;
  const top = Number(pts.fl_top) || 0;
  return bonus && (!top || pos <= top) ? bonus : 0;
}
/** Points scored by the driver in position `pos` of a Sprint or Grand Prix. */
function rowPoints(key, pos, row, pts = DEFAULT_POINTS) {
  if (row.st && row.st !== 'fin') return 0;
  const table = (pts && pts[key]) || DEFAULT_POINTS[key];
  if (!table) return 0;
  return (Number(table[pos - 1]) || 0) + flBonus(key, pos, row, pts);
}

/** Season stats for one driver, calculated from every race that has results entered. */
function computeStats(races, name, pts = DEFAULT_POINTS) {
  const n = normName(name);
  const s = { races: 0, wins: 0, podiums: 0, poles: 0, fastest_laps: 0, points: 0, top10: 0, sprint_wins: 0, sprint_podiums: 0, dnfs: 0 };
  const finishes = [], qualis = [];
  let any = false;
  for (const race of races || []) {
    const R = race.results || {};
    const find = (key) => { const rows = R[key] || []; const i = rows.findIndex((r) => normName(r.d) === n); return i < 0 ? null : { pos: i + 1, row: rows[i] }; };
    const gp = find('race');
    if (gp) {
      any = true;
      const st = gp.row.st || 'fin';
      if (st !== 'dns') s.races++;
      if (st === 'fin') {
        finishes.push(gp.pos);
        if (gp.pos === 1) s.wins++;
        if (gp.pos <= 3) s.podiums++;
        if (gp.pos <= 10) s.top10++;
      } else if (st === 'dnf' || st === 'dsq') s.dnfs++;
      if (gp.row.fl) s.fastest_laps++;
      s.points += rowPoints('race', gp.pos, gp.row, pts);
    }
    const sp = find('sprint');
    if (sp) {
      any = true;
      if ((sp.row.st || 'fin') === 'fin') { if (sp.pos === 1) s.sprint_wins++; if (sp.pos <= 3) s.sprint_podiums++; }
      s.points += rowPoints('sprint', sp.pos, sp.row, pts);
    }
    const q = find('quali');
    if (q) { any = true; qualis.push(q.pos); if (q.pos === 1) s.poles++; }
  }
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : undefined);
  s.best_finish = finishes.length ? Math.min(...finishes) : undefined;
  s.avg_finish = avg(finishes);
  s.avg_quali = avg(qualis);
  s.hasResults = any;
  return s;
}

/** Head-to-head between two drivers: in how many sessions each finished ahead of the other. */
function headToHead(races, a, b, key) {
  const na = normName(a), nb = normName(b);
  let wa = 0, wb = 0;
  for (const race of races || []) {
    const rows = (race.results || {})[key] || [];
    const ia = rows.findIndex((r) => normName(r.d) === na), ib = rows.findIndex((r) => normName(r.d) === nb);
    if (ia < 0 || ib < 0) continue;
    const okA = (rows[ia].st || 'fin') === 'fin', okB = (rows[ib].st || 'fin') === 'fin';
    if (key === 'race' && !okA && !okB) continue;
    if ((okA && !okB) || (okA === okB && ia < ib)) wa++; else wb++;
  }
  return [wa, wb];
}

const STAT_FIELDS = [
  { key: 'races', label: 'Grands Prix' }, { key: 'wins', label: 'Wins' }, { key: 'podiums', label: 'Podiums' },
  { key: 'poles', label: 'Pole Positions' }, { key: 'points', label: 'Points' }, { key: 'top10', label: 'Points Finishes' },
  { key: 'fastest_laps', label: 'Fastest Laps' }, { key: 'sprint_wins', label: 'Sprint Wins' }, { key: 'sprint_podiums', label: 'Sprint Podiums' },
  { key: 'avg_quali', label: 'Avg. Qualifying', lowerBetter: true }, { key: 'avg_finish', label: 'Avg. Finish', lowerBetter: true },
  { key: 'best_finish', label: 'Best Finish', lowerBetter: true }, { key: 'dnfs', label: 'DNFs', lowerBetter: true },
  { key: 'championships', label: 'Championships' },
];

const tyreChips = (ty) => [...String(ty || '')].filter((c) => TYRES[c])
  .map((c) => `<span class="tyre t-${c}" title="${TYRES[c][0]}">${c}</span>`).join('<i class="tyre-arrow">›</i>');

// ---------------------------------------------------------------- roster ("Drivers & Teams") + standings
const gid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/**
 * Brings older site.json files up to date (safe to run any number of times):
 *  • builds data.grid (teams + drivers) from the old hand-typed standings tables
 *  • adds data.points (points system)
 *  • refreshes driver/team names stored in results from the roster (so renames carry through)
 */
function migrateData(d) {
  d.settings = d.settings || {};
  d.races = d.races || []; d.members = d.members || [];
  if (!d.points) {
    d.points = JSON.parse(JSON.stringify(DEFAULT_POINTS));
    if (d.settings.fastest_lap_point === false) d.points.fl_race = 0;
  }
  delete d.settings.fastest_lap_point;
  if (!d.grid) {
    const teams = [], drivers = [], byName = new Map();
    const team = (name, ours) => {
      if (!name) return null;
      const k = normName(name);
      if (!byName.has(k)) { const t = { id: gid('tm'), name: String(name).trim(), ...(ours ? { is_ours: true } : {}) }; byName.set(k, t); teams.push(t); }
      if (ours) byName.get(k).is_ours = true;
      return byName.get(k).id;
    };
    (d.constructors || []).sort((a, b) => (a.pos || 99) - (b.pos || 99)).forEach((c) => team(c.team, c.is_ours));
    const ourTeam = teams.find((t) => t.is_ours)?.id || team(d.settings.short_name || d.settings.team_name || 'Our Team', true);
    const seen = new Set();
    (d.drivers || []).sort((a, b) => (a.pos || 99) - (b.pos || 99)).forEach((x) => {
      if (!x.driver || seen.has(normName(x.driver))) return; seen.add(normName(x.driver));
      drivers.push({ id: gid('dr'), name: x.driver.trim(), team_id: team(x.team, x.is_ours) || (x.is_ours ? ourTeam : null) });
    });
    d.members.filter((m) => m.is_driver && !seen.has(normName(m.name))).forEach((m) => {
      seen.add(normName(m.name)); drivers.push({ id: gid('dr'), name: m.name, team_id: ourTeam, ...(m.number ? { number: m.number } : {}) });
    });
    d.grid = { teams, drivers };
  }
  delete d.drivers; delete d.constructors;
  const dById = new Map(d.grid.drivers.map((x) => [x.id, x])), tById = new Map(d.grid.teams.map((x) => [x.id, x]));
  for (const r of d.races) for (const rows of Object.values(r.results || {})) for (const row of rows) {
    if (row.di && dById.has(row.di)) row.d = dById.get(row.di).name;
    if (row.ti && tById.has(row.ti)) row.t = tById.get(row.ti).name;
  }
  return d;
}

const anyResults = (d) => (d.races || []).some(hasResults);
/** Championship tables, calculated from every Sprint and Grand Prix result. */
function computeStandings(d) {
  const pts = d.points || DEFAULT_POINTS;
  const teamsById = new Map(d.grid.teams.map((t) => [t.id, t]));
  const ourTeams = new Set(d.grid.teams.filter((t) => t.is_ours).map((t) => normName(t.name)));
  const ourDrivers = new Set((d.members || []).filter((m) => m.is_driver).map((m) => normName(m.name)));
  const D = new Map(), T = new Map();
  const dEntry = (name, team) => { const k = normName(name); if (!D.has(k)) D.set(k, { driver: name, team: team || '', points: 0, fin: [] }); const e = D.get(k); if (!e.team && team) e.team = team; return e; };
  const tEntry = (name) => { const k = normName(name); if (!T.has(k)) T.set(k, { team: name, points: 0, fin: [], is_ours: ourTeams.has(k) }); return T.get(k); };
  d.grid.teams.forEach((t) => tEntry(t.name));
  d.grid.drivers.forEach((x) => dEntry(x.name, teamsById.get(x.team_id)?.name));
  for (const race of d.races || []) for (const key of ['sprint', 'race']) {
    (race.results?.[key] || []).forEach((row, i) => {
      const p = rowPoints(key, i + 1, row, pts), de = dEntry(row.d, row.t);
      de.points += p;
      if (key === 'race' && (row.st || 'fin') === 'fin') de.fin.push(i + 1);
      if (row.t) { const te = tEntry(row.t); te.points += p; if (key === 'race' && (row.st || 'fin') === 'fin') te.fin.push(i + 1); }
    });
  }
  // ties are split by countback: most wins, then most 2nd places, and so on
  const countback = (a, b) => { for (let p = 1; p <= 30; p++) { const x = a.fin.filter((f) => f === p).length, y = b.fin.filter((f) => f === p).length; if (x !== y) return y - x; } return 0; };
  const rank = (list) => list.sort((a, b) => b.points - a.points || countback(a, b)).map((e, i) => ({ ...e, pos: i + 1 }));
  return {
    drivers: rank([...D.values()]).map((e) => ({ pos: e.pos, driver: e.driver, team: e.team, points: e.points, is_ours: ourDrivers.has(normName(e.driver)) || ourTeams.has(normName(e.team)) })),
    constructors: rank([...T.values()]).map((e) => ({ pos: e.pos, team: e.team, points: e.points, is_ours: e.is_ours })),
  };
}
