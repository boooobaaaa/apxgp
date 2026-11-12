/* =========================================================
   Fantasy league
   Fans build a team in their browser → copy an entry code →
   post it in Discord → an admin imports it → leaderboard updates.
   ========================================================= */
(() => {
'use strict';
const LG = window.LG;
const { esc, byId, flag, nameHTML, teamColor, toast, fmtPts, fmtDate } = LG;
const MY_KEY = 'league.fantasy.myteam';
const CODE_PREFIX = 'FTSY1.';

const DEFAULTS = {
  enabled: false, budget: 100, captainMult: 2, pole: 1, fastestLap: 1, fastestLapTopN: 10,
  positions: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], sprint: [], dnf: 0,
  principalPct: 100, engineerPct: 50, reservePct: 100,
  maxEngineers: 2, submitUrl: '', intro: '', prices: {}, entries: [],
  tpMult: { enabled: true, cap: 2.5, oneTwo: 2.5, win: 2.0, podium: 1.75, bothPoints: 1.5, onePoints: 1.25, none: 1.0, bonus: 0.25 },
  engMult: { enabled: true, cap: 2.5, win: 2.5, podium: 2.0, top5: 1.75, points: 1.5, none: 1.0, fl: 0.25, gained: 0.25, gainedN: 5 }
};
const cfg = d => { d.fantasy = Object.assign({}, DEFAULTS, d.fantasy || {}); d.fantasy.tpMult = Object.assign({}, DEFAULTS.tpMult, d.fantasy.tpMult || {}); d.fantasy.engMult = Object.assign({}, DEFAULTS.engMult, d.fantasy.engMult || {}); d.fantasy.prices = d.fantasy.prices || {}; d.fantasy.entries = d.fantasy.entries || []; return d.fantasy; };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const money = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'M';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };

/* ---------------- the market: everything you can sign ---------------- */
function assets(d) {
  const f = cfg(d), out = [];
  const st = LG.computeStandings(d);
  const rank = id => (st.D[id] || {}).position || 99;
  const autoDriver = id => Math.max(6, Math.round((32 - (rank(id) - 1) * 1.6) * 2) / 2);
  d.drivers.filter(x => x.active !== false).forEach(x => {
    const t = byId(d.teams, x.teamId);
    out.push({ id: x.id, kind: 'driver', name: x.name, team: t, drv: x, price: Number(x.fantasyValue) || Number(f.prices[x.id]) || autoDriver(x.id) });
  });
  const reserveIds = new Set();
  d.teams.forEach(t => {
    const S = t.staff || {};
    const tp = S.principal && S.principal.name ? S.principal : (t.principal ? { name: t.principal } : null);
    const tr = (st.T[t.id] || {}).position || 10;
    if (tp) { const id = 'tp:' + t.id; out.push({ id, kind: 'principal', name: tp.name, team: t, photo: tp.photo, country: tp.country, price: Number(f.prices[id]) || Math.max(8, 26 - (tr - 1) * 2) }); }
    (S.race || []).filter(x => x && x.name).forEach(x => {
      const id = `re:${t.id}:${slug(x.name)}`;
      out.push({ id, kind: 'engineer', name: x.name, team: t, photo: x.photo, country: x.country, worksWith: x.driverId, price: Number(f.prices[id]) || Math.max(3, 9 - (tr - 1) * 0.6) });
    });
    (S.reserves || []).filter(x => x && x.driverId).forEach(x => reserveIds.add(x.driverId + '|' + t.id));
  });
  d.drivers.filter(x => x.active === false).forEach(x => reserveIds.add(x.id + '|'));
  const seen = new Set();
  [...reserveIds].forEach(k => {
    const [id, tid] = k.split('|'); if (seen.has(id)) return; seen.add(id);
    const x = byId(d.drivers, id); if (!x) return;
    out.push({ id: 'rs:' + id, driverId: id, kind: 'reserve', name: x.name, team: byId(d.teams, tid) || byId(d.teams, x.teamId), drv: x, price: Number(f.prices['rs:' + id]) || 5 });
  });
  return out;
}
const KIND_LABEL = { driver: 'Driver', principal: 'Team principal', engineer: 'Race engineer', reserve: 'Reserve driver' };

/* ---------------- scoring ---------------- */
function driverRoundPts(d, f, rid, did) {
  let pts = 0, raced = false;
  const pole = LG.poleDriver(d, rid);
  const race = LG.classify(LG.session(d, rid, 'race'), 'race', d.scoring, pole);
  const e = race.find(x => x.driverId === did);
  if (e) {
    raced = true;
    if (e.pos) pts += Number(f.positions[e.pos - 1]) || 0;
    if (e.status === 'DNF' || e.status === 'DSQ') pts += Number(f.dnf) || 0;
    if (e.fastestLap && e.pos && (!Number(f.fastestLapTopN) || e.pos <= Number(f.fastestLapTopN))) pts += Number(f.fastestLap) || 0;
  }
  if (pole === did) pts += Number(f.pole) || 0;
  if ((f.sprint || []).length) {
    const sp = LG.classify(LG.session(d, rid, 'sprint'), 'sprint', d.scoring).find(x => x.driverId === did);
    if (sp) { raced = true; if (sp.pos) pts += Number(f.sprint[sp.pos - 1]) || 0; }
  }
  return { pts, raced };
}
/* success multipliers — worked out per race, capped (default 2.5×) */
function raceInfo(d, rid) {
  const pole = LG.poleDriver(d, rid);
  const cl = LG.classify(LG.session(d, rid, 'race'), 'race', d.scoring, pole);
  const q = LG.classify(LG.session(d, rid, 'quali'), 'quali', d.scoring);
  const grid = {}; q.forEach((e, i) => { grid[e.driverId] = i + 1; });
  return { pole, cl, grid };
}
function tpMultiplier(f, info, teamId) {
  const m = f.tpMult; if (!m.enabled) return { x: 1, why: '' };
  const es = info.cl.filter(e => e.teamId === teamId);
  const ps = es.map(e => e.pos).filter(Boolean).sort((a, b) => a - b);
  let x, why;
  if (ps[0] === 1 && ps[1] === 2) { x = +m.oneTwo; why = '1-2 finish'; }
  else if (ps[0] === 1) { x = +m.win; why = 'Win'; }
  else if (ps[0] <= 3) { x = +m.podium; why = 'Podium'; }
  else if (ps.filter(p => p <= 10).length >= 2) { x = +m.bothPoints; why = 'Both cars in the points'; }
  else if (ps.filter(p => p <= 10).length === 1) { x = +m.onePoints; why = 'One car in the points'; }
  else { x = +m.none; why = 'No points'; }
  if (+m.bonus && es.some(e => e.driverId === info.pole || e.fastestLap)) { x += +m.bonus; why += ' + pole/fastest lap'; }
  return { x: Math.min(+m.cap || 2.5, Math.max(0, x || 1)), why };
}
function engMultiplier(f, info, driverId) {
  const m = f.engMult; if (!m.enabled) return { x: 1, why: '' };
  const e = info.cl.find(z => z.driverId === driverId);
  if (!e) return { x: +m.none || 1, why: "Driver didn't race" };
  let x, why;
  if (e.pos === 1) { x = +m.win; why = 'Win'; }
  else if (e.pos && e.pos <= 3) { x = +m.podium; why = 'Podium'; }
  else if (e.pos && e.pos <= 5) { x = +m.top5; why = 'Top 5'; }
  else if (e.pos && e.pos <= 10) { x = +m.points; why = 'Points finish'; }
  else { x = +m.none; why = e.pos ? 'Outside the points' : e.status; }
  if (+m.fl && e.fastestLap) { x += +m.fl; why += ' + fastest lap'; }
  const g = info.grid[driverId];
  if (+m.gained && g && e.pos && g - e.pos >= (+m.gainedN || 5)) { x += +m.gained; why += ` + gained ${g - e.pos} places`; }
  return { x: Math.min(+m.cap || 2.5, Math.max(0, x || 1)), why };
}
const fmtX = x => '×' + (Math.round(x * 100) / 100).toString();

function picksAt(entry, roundIdx, order) {
  let cur = null;
  (entry.history || []).forEach(h => { const i = h.from === '' || h.from === undefined ? 0 : order.indexOf(h.from); if (i >= 0 && i <= roundIdx) cur = h.picks; });
  return cur;
}
function standings(d) {
  const f = cfg(d);
  const rs = LG.rounds(d).filter(r => !r.cancelled);
  const order = rs.map(r => r.id);
  const done = rs.filter(r => LG.isDone(d, r));
  const A = assets(d), aById = {}; A.forEach(a => { aById[a.id] = a; });
  const cache = {};
  const dp = (rid, did) => { const k = rid + '|' + did; return cache[k] || (cache[k] = driverRoundPts(d, f, rid, did)); };
  const teamDrivers = (rid, tid) => {
    const ids = new Set();
    LG.session(d, rid, 'race').forEach(e => { if (e.teamId === tid) ids.add(e.driverId); });
    return [...ids];
  };
  const assetPts = {}; // asset id -> { total, rounds }
  const infoC = {};
  const info = rid => infoC[rid] || (infoC[rid] = raceInfo(d, rid));
  const scoreAsset = (rid, id) => {
    const a = aById[id];
    let v = 0, mult = null;
    if (!a) {
      if (id.startsWith('rs:')) v = dp(rid, id.slice(3)).pts * (Number(f.reservePct) / 100);
      else if (byId(d.drivers, id)) v = dp(rid, id).pts;
    } else if (a.kind === 'driver') v = dp(rid, a.id).pts;
    else if (a.kind === 'reserve') v = dp(rid, a.driverId).pts * (Number(f.reservePct) / 100);
    else if (a.kind === 'principal') { mult = tpMultiplier(f, info(rid), a.team.id); v = teamDrivers(rid, a.team.id).reduce((s, x) => s + dp(rid, x).pts, 0) * (Number(f.principalPct) / 100) * mult.x; }
    else if (a.kind === 'engineer') {
      const tds = teamDrivers(rid, a.team.id);
      const base = a.worksWith && tds.includes(a.worksWith) ? dp(rid, a.worksWith).pts : (tds.length ? tds.reduce((s, x) => s + dp(rid, x).pts, 0) / tds.length : 0);
      if (a.worksWith && tds.includes(a.worksWith)) mult = engMultiplier(f, info(rid), a.worksWith);
      else { const ms = tds.map(x => engMultiplier(f, info(rid), x)).sort((p, q) => q.x - p.x); mult = ms[0] || { x: 1, why: '' }; }
      v = base * (Number(f.engineerPct) / 100) * mult.x;
    }
    v = Math.round(v * 10) / 10;
    const rec = assetPts[id] || (assetPts[id] = { total: 0, rounds: {}, mult: {} });
    if (rec.rounds[rid] === undefined) { rec.rounds[rid] = v; rec.total += v; if (mult) rec.mult[rid] = mult; }
    return v;
  };
  done.forEach(r => A.forEach(a => scoreAsset(r.id, a.id)));
  const table = f.entries.map(en => {
    let total = 0; const per = {}; let last = 0;
    done.forEach(r => {
      const p = picksAt(en, order.indexOf(r.id), order);
      if (!p) { per[r.id] = null; return; }
      let s = 0;
      (p.d || []).forEach(id => { const v = scoreAsset(r.id, id); s += id === p.c ? v * (Number(f.captainMult) || 1) : v; });
      if (p.tp) s += scoreAsset(r.id, p.tp);
      (p.re || []).forEach(id => { s += scoreAsset(r.id, id); });
      if (p.rs) s += scoreAsset(r.id, p.rs);
      s = Math.round(s * 10) / 10;
      per[r.id] = s; total += s; last = s;
    });
    const cur = (en.history || []).length ? en.history[en.history.length - 1].picks : null;
    return { entry: en, total: Math.round(total * 10) / 10, last, per, picks: cur, value: cur ? teamCost(cur, aById) : 0 };
  }).sort((a, b) => b.total - a.total || b.last - a.last);
  table.forEach((x, i) => { x.rank = i + 1; });
  const own = {};
  table.forEach(x => { const p = x.picks; if (!p) return; [...(p.d || []), p.tp, ...(p.re || []), p.rs].filter(Boolean).forEach(id => { own[id] = (own[id] || 0) + 1; }); });
  return { table, done, order, assets: A, aById, assetPts, own, f };
}
function teamCost(p, aById) { return [...(p.d || []), p.tp, ...(p.re || []), p.rs].filter(Boolean).reduce((s, id) => s + (aById[id] ? aById[id].price : 0), 0); }

/* ---------------- deadlines ---------------- */
function nextLock(d) {
  const now = Date.now();
  return LG.rounds(d).find(r => !r.cancelled && !LG.isDone(d, r) && r.start && new Date(r.start) > now) || null;
}
function effectiveRoundFor(d, ts) {
  const t = new Date(ts || Date.now()).getTime();
  const r = LG.rounds(d).find(x => !x.cancelled && !LG.isDone(d, x) && (!x.start || new Date(x.start).getTime() > t));
  return r ? r.id : '__after__';
}

/* ---------------- entry codes ---------------- */
const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
function makeCode(team) { return CODE_PREFIX + b64e(JSON.stringify({ m: team.manager, t: team.name, dc: team.discord, p: team.picks, ts: new Date().toISOString() })); }
function readCodes(text) {
  const out = [];
  (String(text).match(/FTSY1\.[A-Za-z0-9_-]+/g) || []).forEach(c => { try { out.push(JSON.parse(b64d(c.slice(CODE_PREFIX.length)))); } catch (e) { } });
  return out;
}
function validate(d, p) {
  const f = cfg(d), A = assets(d), byA = {}; A.forEach(a => { byA[a.id] = a; });
  const errs = [];
  const ds = (p.d || []).filter(Boolean);
  if (ds.length !== 2) errs.push('pick 2 main drivers');
  if (ds.some(id => !byA[id] || byA[id].kind !== 'driver')) errs.push('a main driver is no longer on the grid');
  if (new Set(ds).size !== ds.length) errs.push('the two drivers must be different');
  if (!p.tp) errs.push('pick a team principal'); else if (!byA[p.tp]) errs.push('that team principal is no longer available');
  if ((p.re || []).length > (Number(f.maxEngineers) || 2)) errs.push('too many race engineers');
  (p.re || []).forEach(id => { if (!byA[id]) errs.push('a race engineer is no longer available'); });
  if (p.rs && !byA[p.rs]) errs.push('that reserve driver is no longer available');
  if (p.c && !ds.includes(p.c)) errs.push('captain must be one of your main drivers');
  const cost = teamCost(p, byA);
  if (cost > Number(f.budget) + 1e-9) errs.push(`over budget (${money(cost)} of ${money(f.budget)})`);
  return { ok: !errs.length, errs, cost };
}

/* ---------------- my team (browser) ---------------- */
function myTeam() { try { return JSON.parse(lsGet(MY_KEY) || 'null') || { manager: '', name: '', discord: '', picks: { d: [], c: '', tp: '', re: [], rs: '' } }; } catch (e) { return { manager: '', name: '', discord: '', picks: { d: [], c: '', tp: '', re: [], rs: '' } }; } }
const saveMy = t => lsSet(MY_KEY, JSON.stringify(t));
let PICKER = null; // which slot is being filled

/* ---------------- rendering helpers ---------------- */
const head = (eyebrow, title, sub) => `<div class="page-head"><div class="eyebrow">${esc(eyebrow)}</div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>`;
const emptyBox = (t, s) => `<div class="empty"><b>${esc(t)}</b>${s || ''}</div>`;
function assetFace(a) {
  if (!a) return '<span class="avatar">?</span>';
  if (a.drv) return LG.avatar(a.drv, a.team);
  const ini = String(a.name || '').split(/\s+/).map(z => z[0] || '').join('').slice(0, 2).toUpperCase();
  return `<span class="avatar" style="--tc:${esc(teamColor(a.team))}">${a.photo ? `<img src="${esc(LG.asset(a.photo))}" alt="" onerror="this.remove()">` : esc(ini)}</span>`;
}

function slotCard(d, a, slot, label, extra = '') {
  return `<button class="ft-slot ${a ? 'filled' : ''}" data-ft-slot="${slot}" style="--tc:${esc(a ? teamColor(a.team) : 'var(--line-strong)')}">
    <span class="ft-slot-l">${esc(label)}</span>
    ${a ? `${assetFace(a)}<span class="ft-slot-n">${nameHTML(a.name)}</span><span class="ft-slot-t">${esc(a.team ? a.team.name : '')}</span><span class="ft-price">${money(a.price)}</span>${extra}`
      : `<span class="ft-plus">+</span><span class="ft-slot-t">Tap to sign</span>`}
  </button>`;
}

function builder(d, S) {
  const f = S.f, me = myTeam(), p = me.picks, A = S.aById;
  const cost = teamCost(p, A), left = Number(f.budget) - cost;
  const v = validate(d, Object.assign({}, p, { d: (p.d || []).filter(Boolean), re: (p.re || []).filter(Boolean) }));
  const lock = nextLock(d);
  const existing = f.entries.find(e => slug(e.manager) === slug(me.manager) && me.manager);
  const kindFor = slot => slot.startsWith('d') ? 'driver' : slot === 'tp' ? 'principal' : slot.startsWith('re') ? 'engineer' : 'reserve';
  let market = '';
  if (PICKER) {
    const kind = kindFor(PICKER);
    const taken = new Set([...(p.d || []), p.tp, ...(p.re || []), p.rs].filter(Boolean));
    const curId = PICKER === 'd0' ? p.d[0] : PICKER === 'd1' ? p.d[1] : PICKER === 'tp' ? p.tp : PICKER === 're0' ? (p.re || [])[0] : PICKER === 're1' ? (p.re || [])[1] : p.rs;
    const list = S.assets.filter(a => a.kind === kind).sort((x, y) => y.price - x.price);
    market = `<div class="ft-market card"><div class="card-title"><h3>Sign a ${KIND_LABEL[kind].toLowerCase()}</h3><button class="btn xs ghost" data-ft="close">Close</button></div>
      ${list.length ? `<div class="ft-list">${list.map(a => {
        const isCur = a.id === curId, dis = !isCur && taken.has(a.id);
        const afford = (a.price - (curId && A[curId] ? A[curId].price : 0)) <= left + 1e-9;
        const pts = (S.assetPts[a.id] || {}).total || 0;
        return `<button class="ft-row ${isCur ? 'cur' : ''}" data-ft-pick="${esc(a.id)}" ${dis || (!afford && !isCur) ? 'disabled' : ''} style="--tc:${esc(teamColor(a.team))}">
          ${assetFace(a)}<span class="ft-row-n">${nameHTML(a.name)}<small>${esc(a.team ? a.team.name : '')}${a.kind === 'engineer' && a.worksWith && byId(d.drivers, a.worksWith) ? ' · with ' + esc(byId(d.drivers, a.worksWith).name.split(' ').pop()) : ''}</small></span>
          <span class="ft-row-pts mono">${fmtPts(pts)}<small>${(() => { const mm = (S.assetPts[a.id] || {}).mult || {}; const last = S.done.slice().reverse().find(r => mm[r.id]); return last ? `last ${fmtX(mm[last.id].x)}` : 'pts'; })()}</small></span><span class="ft-price">${money(a.price)}</span>
          <span class="ft-row-act">${isCur ? 'Remove' : dis ? 'Signed' : !afford ? 'Too pricey' : 'Sign'}</span></button>`;
      }).join('')}</div>` : '<p class="muted">Nobody in this role yet — the admin adds them under each team.</p>'}</div>`;
  }
  return `<div class="ft-builder">
    <div class="ft-budget card">
      <div class="ft-bud-top"><div><span class="ft-lbl">Budget remaining</span><b class="mono ${left < 0 ? 'neg' : ''}">${money(left)}</b></div><div style="text-align:right"><span class="ft-lbl">Team value</span><b class="mono">${money(cost)}</b></div></div>
      <div class="ft-bud-bar"><i style="width:${Math.min(100, cost / Number(f.budget) * 100)}%"></i></div>
      ${lock ? `<p class="ft-lock">🔒 Picks lock at <b>R${esc(lock.round)} ${esc(lock.name)}</b> — ${esc(fmtDate(lock.start, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}. Codes sent after that count from the next round.</p>` : ''}
    </div>
    <div class="ft-slots">
      <div class="ft-group"><h4>Main drivers <small>tap ★ to make captain (${esc(f.captainMult)}× points)</small></h4><div class="ft-row2">
        ${[0, 1].map(i => { const a = A[p.d[i]]; return slotCard(d, a, 'd' + i, 'Driver ' + (i + 1), a ? `<span class="ft-cap ${p.c === a.id ? 'on' : ''}" data-ft-cap="${esc(a.id)}" title="Make captain">★</span>` : ''); }).join('')}</div></div>
      <div class="ft-group"><h4>Team principal</h4><div class="ft-row1">${slotCard(d, A[p.tp], 'tp', 'Team principal')}</div></div>
      <div class="ft-group"><h4>Race engineers <small>optional · up to ${esc(f.maxEngineers)}</small></h4><div class="ft-row2">${Array.from({ length: Number(f.maxEngineers) || 2 }, (_, i) => slotCard(d, A[(p.re || [])[i]], 're' + i, 'Race engineer ' + (i + 1))).join('')}</div></div>
      <div class="ft-group"><h4>Reserve driver <small>optional · scores when they race</small></h4><div class="ft-row1">${slotCard(d, A[p.rs], 'rs', 'Reserve')}</div></div>
    </div>
    ${market}
    <div class="ft-submit card">
      <h3>Enter the league</h3>
      <div class="pform">
        <label class="fld"><span>Your name or nickname</span><input id="ft-m" type="text" value="${esc(me.manager)}" placeholder="Name or nickname"></label>
        <label class="fld"><span>Fantasy team name</span><input id="ft-t" type="text" value="${esc(me.name)}" placeholder="e.g. Leek Speed Racing"></label>
        <label class="fld"><span>Discord username</span><input id="ft-dc" type="text" value="${esc(me.discord)}" placeholder="so the admin knows it's you"></label>
      </div>
      ${v.ok ? '<p class="ok-note" style="margin:14px 0 0">✓ Team is valid.</p>' : `<p class="warn" style="margin:14px 0 0">To finish: ${esc(v.errs.join(' · '))}</p>`}
      <div class="toolbar" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px"><button class="btn primary" data-ft="code" ${v.ok ? '' : 'disabled'}>Get my entry code</button>${f.submitUrl || (d.league.links || {}).discord ? `<a class="btn" href="${esc(f.submitUrl || d.league.links.discord)}" target="_blank" rel="noopener">Open Discord ↗</a>` : ''}<button class="btn ghost" data-ft="reset">Clear team</button></div>
      <div id="ft-code" hidden><p class="hint">Copied! Paste this whole code in the fantasy channel on Discord — an admin adds it to the leaderboard.</p><textarea readonly rows="3" class="ft-codebox"></textarea></div>
      ${existing ? `<p class="hint">You're on the leaderboard as <b>${esc(existing.team || existing.manager)}</b>. Sending a new code replaces your picks from the next round.</p>` : ''}
    </div>
  </div>`;
}

function leaderboard(d, S) {
  if (!S.table.length) return emptyBox('No teams yet', '<p>Be the first — build your team in <b>My team</b> and send your entry code.</p>');
  const open = PICKER && PICKER.startsWith('lb:') ? PICKER.slice(3) : '';
  return `<div class="table-wrap"><table class="tbl ft-lb"><thead><tr><th>Rank</th><th>Team</th><th class="hide-sm">Manager</th><th class="r hide-sm">Last rd</th><th class="r hide-sm">Value</th><th class="r">Pts</th></tr></thead><tbody>
    ${S.table.map(x => {
      const p = x.picks || {};
      const det = open === x.entry.id ? `<tr class="ft-det"><td colspan="6"><div class="ft-det-in">
        ${[...(p.d || []).map(id => [id, id === p.c ? 'Captain' : 'Driver']), [p.tp, 'Principal'], ...(p.re || []).map(id => [id, 'Engineer']), [p.rs, 'Reserve']].filter(([id]) => id).map(([id, r]) => { const a = S.aById[id]; return `<span class="ft-chip" style="--tc:${esc(teamColor(a && a.team))}">${assetFace(a)}<span><small>${r}</small>${esc(a ? a.name : 'Unavailable')}</span><b class="mono">${fmtPts((S.assetPts[id] || {}).total || 0)}</b>${(() => { const mm = (S.assetPts[id] || {}).mult || {}; const last = S.done.slice().reverse().find(r => mm[r.id]); return last ? `<em class="ft-x" title="Last race: ${esc(mm[last.id].why)}">${fmtX(mm[last.id].x)}</em>` : ''; })()}</span>`; }).join('')}
        <div class="ft-per">${S.done.map(r => `<span title="${esc(r.name)}"><small>R${esc(r.round)}</small><b class="mono">${x.per[r.id] === null ? '–' : fmtPts(x.per[r.id])}</b></span>`).join('')}</div></div></td></tr>` : '';
      return `<tr class="${x.rank <= 3 ? 'top' + x.rank : ''} ft-lbrow" data-ft-open="${esc(x.entry.id)}"><td class="pos">${x.rank}</td><td><b>${esc(x.entry.team || 'Unnamed team')}</b><small class="muted ft-sm-m"> · ${esc(x.entry.manager || '')}</small></td><td class="hide-sm muted">${esc(x.entry.manager || '')}</td><td class="r mono hide-sm">${fmtPts(x.last)}</td><td class="r mono hide-sm">${money(x.value)}</td><td class="pts">${fmtPts(x.total)}</td></tr>${det}`;
    }).join('')}</tbody></table></div><p class="hint" style="margin-top:10px">Tap a team to see its picks and round-by-round score.</p>`;
}

function marketTable(d, S) {
  const kinds = ['driver', 'principal', 'engineer', 'reserve'];
  const n = S.table.length || 1;
  return kinds.map(k => {
    const list = S.assets.filter(a => a.kind === k).sort((a, b) => b.price - a.price);
    if (!list.length) return '';
    return `<section><div class="section-title"><h2>${KIND_LABEL[k]}s</h2></div><div class="table-wrap"><table class="tbl"><thead><tr><th>${KIND_LABEL[k]}</th><th class="hide-sm">Team</th><th class="r">Price</th><th class="r">Pts</th><th class="r hide-sm">Pts / M</th><th class="r hide-sm">Picked by</th></tr></thead><tbody>
      ${list.map(a => { const pts = (S.assetPts[a.id] || {}).total || 0; return `<tr><td>${assetFace(a).replace('class="avatar', 'class="avatar sm')}${nameHTML(a.name)}</td><td class="hide-sm"><span class="swatch" style="--tc:${esc(teamColor(a.team))}"></span><span class="team-name">${esc(a.team ? a.team.name : '')}</span></td><td class="r mono">${money(a.price)}</td><td class="pts">${fmtPts(pts)}</td><td class="r mono hide-sm">${a.price ? fmtPts(Math.round(pts / a.price * 10) / 10) : '–'}</td><td class="r mono hide-sm">${Math.round((S.own[a.id] || 0) / n * 100)}%</td></tr>`; }).join('')}
    </tbody></table></div></section>`;
  }).join('');
}

function scoringInfo(d, f) {
  const row = (l, v, gold) => `<div class="ft-sc-row"><span>${l}</span><b class="${gold ? 'gold' : ''}">${v}</b></div>`;
  const pos = f.positions || [];
  return `<div class="ft-scoring card">
    <h2>Fantasy scoring system</h2><p class="muted" style="margin:-4px 0 18px">Points are calculated automatically when official race results are published.</p>
    <div class="ft-sc-grid">
      <div><h3>Finishing position points</h3>
        ${pos.slice(0, 5).map((v, i) => row(['1st Place (Winner)', '2nd Place', '3rd Place', '4th Place', '5th Place'][i], `${fmtPts(v)} PTS`)).join('')}
        ${pos.length > 5 ? row(`6th to ${pos.length}th Place`, `${pos.slice(5).map(fmtPts).join(', ')} PTS`) : ''}
        ${(f.sprint || []).length ? row('Sprint (1st, 2nd, …)', `${f.sprint.map(fmtPts).join(', ')} PTS`) : ''}
        ${Number(f.dnf) ? row('DNF / DSQ', `${fmtPts(f.dnf)} PTS`) : ''}
      </div>
      <div><h3>Bonus & multiplier achievements</h3>
        ${row('Captain multiplier', `${fmtPts(f.captainMult)}x Total Driver Points`, true)}
        ${Number(f.pole) ? row('Pole position', `+${fmtPts(f.pole)} Bonus PT${Number(f.pole) === 1 ? '' : 'S'}`) : ''}
        ${Number(f.fastestLap) ? row(`Fastest lap${Number(f.fastestLapTopN) ? ` (Top ${esc(f.fastestLapTopN)})` : ''}`, `+${fmtPts(f.fastestLap)} Bonus PT${Number(f.fastestLap) === 1 ? '' : 'S'}`) : ''}
        ${row('Team principal', (Number(f.principalPct) === 100 ? 'Sum of Both Drivers\' PTS' : `${fmtPts(f.principalPct)}% of Both Drivers' PTS`) + (f.tpMult.enabled ? ` × up to ${fmtX(f.tpMult.cap).slice(1)}` : ''))}
        ${row('Race engineer', `${fmtPts(f.engineerPct)}% of Their Driver's PTS` + (f.engMult.enabled ? ` × up to ${fmtX(f.engMult.cap).slice(1)}` : ''))}
        ${row('Reserve driver', Number(f.reservePct) === 100 ? 'Their PTS When They Race' : `${fmtPts(f.reservePct)}% of Their PTS`)}
      </div>
    </div>
    ${f.tpMult.enabled || f.engMult.enabled ? `<div class="ft-sc-grid ft-sc-mult">
      ${f.tpMult.enabled ? `<div><h3>Team principal success multiplier</h3><p class="muted" style="margin:-6px 0 10px;font-size:13px">Multiplies the principal's points each race, based on how their team did — up to ${fmtX(f.tpMult.cap)}.</p>
        ${row('1-2 finish', fmtX(f.tpMult.oneTwo), true)}${row('Race win', fmtX(f.tpMult.win))}${row('Podium', fmtX(f.tpMult.podium))}${row('Both cars in the points', fmtX(f.tpMult.bothPoints))}${row('One car in the points', fmtX(f.tpMult.onePoints))}${row('No points', fmtX(f.tpMult.none))}${+f.tpMult.bonus ? row('Team takes pole or fastest lap', '+' + fmtX(f.tpMult.bonus).slice(1) + ' extra') : ''}</div>` : '<div></div>'}
      ${f.engMult.enabled ? `<div><h3>Race engineer success multiplier</h3><p class="muted" style="margin:-6px 0 10px;font-size:13px">Multiplies the engineer's points each race, based on how their driver did — up to ${fmtX(f.engMult.cap)}.</p>
        ${row('Driver wins', fmtX(f.engMult.win), true)}${row('Podium', fmtX(f.engMult.podium))}${row('Top 5', fmtX(f.engMult.top5))}${row('Points finish (top 10)', fmtX(f.engMult.points))}${row('Outside the points / DNF', fmtX(f.engMult.none))}${+f.engMult.fl ? row('Driver sets fastest lap', '+' + fmtX(f.engMult.fl).slice(1) + ' extra') : ''}${+f.engMult.gained ? row(`Driver gains ${esc(f.engMult.gainedN)}+ places from the grid`, '+' + fmtX(f.engMult.gained).slice(1) + ' extra') : ''}</div>` : ''}
    </div>` : ''}
    <div class="ft-sc-foot muted">Budget ${money(f.budget)} · 2 main drivers + 1 team principal required · up to ${esc(f.maxEngineers)} race engineers and 1 reserve optional · picks lock at each race start.</div>
  </div>`;
}

let TAB = null;
function page(d, tab) {
  const f = cfg(d);
  if (!f.enabled) return `<div class="page">${head('Fantasy', 'Fantasy league', '')}${emptyBox('Fantasy is coming soon', '<p>Check back once the admins open the market.</p>')}</div>`;
  const S = standings(d);
  tab = ['leaderboard', 'team', 'market', 'scoring'].includes(tab) ? tab : (TAB || 'leaderboard');
  TAB = tab;
  const me = myTeam(), mine = S.table.find(x => me.manager && slug(x.entry.manager) === slug(me.manager));
  const tabs = [['leaderboard', 'Leaderboard'], ['team', 'My team'], ['market', 'Driver market'], ['scoring', 'Scoring']];
  const lock = nextLock(d);
  return `<div class="page ft">
    ${head('Season ' + d.league.season, 'Fantasy league', f.intro ? esc(f.intro) : `Build a ${money(f.budget)} team, pick a captain and climb the global leaderboard.`)}
    <div class="ft-stats">
      <div class="stat"><b>${S.table.length}</b><span>Teams entered</span></div>
      <div class="stat"><b>${S.table[0] ? esc(S.table[0].entry.team || '—') : '—'}</b><span>Leader${S.table[0] ? ' · ' + fmtPts(S.table[0].total) + ' pts' : ''}</span></div>
      <div class="stat"><b>${mine ? 'P' + mine.rank : '—'}</b><span>Your rank${mine ? ' · ' + fmtPts(mine.total) + ' pts' : ''}</span></div>
      <div class="stat"><b>${lock ? 'R' + esc(lock.round) : '—'}</b><span>${lock ? 'Next lock · ' + esc(fmtDate(lock.start, { day: 'numeric', month: 'short' })) : 'Season over'}</span></div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/fantasy/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${tab === 'leaderboard' ? leaderboard(d, S) : tab === 'team' ? builder(d, S) : tab === 'market' ? marketTable(d, S) : scoringInfo(d, f)}
  </div>`;
}

/* ---------------- events ---------------- */
function rerender() { LG.render(false); }
document.addEventListener('click', e => {
  if (!e.target.closest('.page.ft')) return;
  const d = LG.S.data;
  const slot = e.target.closest('[data-ft-slot]'), pick = e.target.closest('[data-ft-pick]'), cap = e.target.closest('[data-ft-cap]'), act = e.target.closest('[data-ft]'), op = e.target.closest('[data-ft-open]');
  if (cap) { e.stopPropagation(); const t = myTeam(); t.picks.c = cap.dataset.ftCap; saveMy(t); return rerender(); }
  if (slot) { PICKER = PICKER === slot.dataset.ftSlot ? null : slot.dataset.ftSlot; rerender(); const m = document.querySelector('.ft-market'); if (m) m.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
  if (pick) {
    const t = myTeam(), p = t.picks, id = pick.dataset.ftPick;
    const set = (cur, v) => cur === id ? '' : v;
    if (PICKER === 'd0' || PICKER === 'd1') { const i = +PICKER[1]; p.d = p.d || []; const was = p.d[i]; p.d[i] = set(was, id); if (p.c === was) p.c = ''; if (!p.c && p.d.filter(Boolean).length) p.c = p.d.filter(Boolean)[0]; }
    else if (PICKER === 'tp') p.tp = set(p.tp, id);
    else if (PICKER === 're0' || PICKER === 're1') { const i = +PICKER[2]; p.re = p.re || []; p.re[i] = set(p.re[i], id); p.re = p.re.map(x => x || ''); }
    else if (PICKER === 'rs') p.rs = set(p.rs, id);
    p.d = (p.d || []).map(x => x || ''); p.re = (p.re || []).filter((x, k, arr) => x || k < arr.length);
    saveMy(t); PICKER = null; return rerender();
  }
  if (op) { PICKER = PICKER === 'lb:' + op.dataset.ftOpen ? null : 'lb:' + op.dataset.ftOpen; return rerender(); }
  if (act) {
    const k = act.dataset.ft;
    if (k === 'close') { PICKER = null; return rerender(); }
    if (k === 'reset') { if (confirm('Clear your fantasy team in this browser?')) { saveMy({ manager: '', name: '', discord: '', picks: { d: [], c: '', tp: '', re: [], rs: '' } }); rerender(); } return; }
    if (k === 'code') {
      const t = myTeam(); t.manager = document.getElementById('ft-m').value.trim(); t.name = document.getElementById('ft-t').value.trim(); t.discord = document.getElementById('ft-dc').value.trim();
      if (!t.manager || !t.name) return toast('Add your name and a team name first', 'err');
      saveMy(t);
      const p = Object.assign({}, t.picks, { d: t.picks.d.filter(Boolean), re: (t.picks.re || []).filter(Boolean) });
      const v = validate(d, p); if (!v.ok) return toast('Team not valid: ' + v.errs.join(', '), 'err');
      const code = makeCode(Object.assign({}, t, { picks: p }));
      const box = document.getElementById('ft-code'); box.hidden = false; box.querySelector('textarea').value = code;
      (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(() => toast('Entry code copied — paste it in Discord')).catch(() => { box.querySelector('textarea').select(); toast('Copy the code below and paste it in Discord'); });
    }
  }
});
document.addEventListener('input', e => {
  if (!['ft-m', 'ft-t', 'ft-dc'].includes(e.target.id)) return;
  const t = myTeam(); t.manager = document.getElementById('ft-m').value; t.name = document.getElementById('ft-t').value; t.discord = document.getElementById('ft-dc').value; saveMy(t);
});

window.Fantasy = { page, standings, fmtX, assets, cfg, readCodes, validate, effectiveRoundFor, money, DEFAULTS, KIND_LABEL, slug };
})();
