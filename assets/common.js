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
const POINTS = { race: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], sprint: [8, 7, 6, 5, 4, 3, 2, 1] };
const TYRES = { S: ['Soft', '#e10600'], M: ['Medium', '#f5c400'], H: ['Hard', '#f2f2f2'], I: ['Intermediate', '#39b54a'], W: ['Wet', '#2a7fff'] };
const STATUS = { fin: 'Finished', dnf: 'DNF', dns: 'DNS', dsq: 'DSQ' };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const sessionsFor = (race) => SESSIONS.filter((s) => !s.sprint || race.has_sprint);
const hasResults = (race) => !!race.results && SESSIONS.some((s) => (race.results[s.key] || []).length);

function rowPoints(key, pos, row, settings = {}) {
  if (row.st && row.st !== 'fin') return 0;
  const table = POINTS[key];
  if (!table) return 0;
  let p = table[pos - 1] || 0;
  if (key === 'race' && row.fl && settings.fastest_lap_point && pos <= 10) p += 1;
  return p;
}

/** Season stats for one driver, calculated from every race that has results entered. */
function computeStats(races, name, settings = {}) {
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
      s.points += rowPoints('race', gp.pos, gp.row, settings);
    }
    const sp = find('sprint');
    if (sp) {
      any = true;
      if ((sp.row.st || 'fin') === 'fin') { if (sp.pos === 1) s.sprint_wins++; if (sp.pos <= 3) s.sprint_podiums++; }
      s.points += rowPoints('sprint', sp.pos, sp.row, settings);
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
