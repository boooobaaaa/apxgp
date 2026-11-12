/* =========================================================
   GRID DRAFT — pick Driver 1 (×1.5), Driver 2 and a Constructor
   from pairs of cards; score = real championship points.
   Data: the league's own drivers/teams/results + Hall of Fame snapshots.
   Players/attempts/leaderboard: Firebase (Google sign-in + Firestore),
   protected by the security rules generated in the admin.
   ========================================================= */
(() => {
'use strict';
const LG = window.LG;
const { esc, byId, flag, nameHTML, teamColor, fmtPts, toast } = LG;
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const RARITIES = ['icon', 'prime', 'elite', 'advanced', 'basic'];
const R_LABEL = { icon: 'Icon', prime: 'Prime', elite: 'Elite', advanced: 'Advanced', basic: 'Basic' };
const STAGES = ['d1', 'd2', 'c'];
const STAGE_LABEL = { d1: 'Driver 1', d2: 'Driver 2', c: 'Constructor', done: 'Team reveal' };
const D1_MULT = 1.5;

const DEFAULTS = {
  enabled: false, firebase: null, admins: '', attempts: 10, periodHours: 10, cooldownSec: 3,
  iconGap: 10, primeCount: 3, elitePct: 25, advancedPct: 50, smoothing: 0.05, minProb: 0.5, maxProb: 25
};
const cfg = d => Object.assign({}, DEFAULTS, d.gridDraft || {});
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
const hasVal = v => v !== '' && v !== null && v !== undefined;

/* =========================================================
   ENGINE — cards, rarity, probabilities, scoring (pure)
   ========================================================= */
function buildCards(d) {
  const c = cfg(d);
  const st = LG.computeStandings(d);
  const curLabel = String(d.league.season || 'Current');
  // seasons: archived snapshots (with real standings) + the live season
  const seasons = [];
  (d.history || []).filter(h => h && h.standings && (h.standings.drivers || []).length && String(h.season) !== curLabel)
    .forEach(h => seasons.push({ label: String(h.season), hist: h }));
  seasons.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  seasons.push({ label: curLabel, current: true });
  seasons.forEach((s, i) => { s.num = i + 1; s.key = slug(s.label); });

  const byName = {};
  d.drivers.forEach(x => { byName[String(x.name || '').trim().toLowerCase()] = x; });
  const drivers = [];
  seasons.forEach(s => {
    let rows = [];
    if (s.current) {
      const raced = {};
      LG.rounds(d).forEach(r => ['race', 'sprint'].forEach(ss => LG.session(d, r.id, ss).forEach(e => {
        if (!e.driverId) return;
        const t = raced[e.driverId] || (raced[e.driverId] = []);
        if (e.teamId && !t.includes(e.teamId)) t.push(e.teamId);
      })));
      rows = st.drivers.filter(x => raced[x.id]).map(x => {
        const m = byId(d.drivers, x.id) || {};
        const teams = raced[x.id].map(id => byId(d.teams, id)).filter(Boolean).map(t => ({ name: t.name, color: teamColor(t) }));
        return { key: x.id, master: m, name: m.name || 'Unknown driver', country: m.country, points: x.points, teams };
      });
    } else {
      rows = s.hist.standings.drivers.map(x => {
        const m = byName[String(x.name || '').trim().toLowerCase()];
        return { key: m ? m.id : 'n-' + slug(x.name), master: m || null, name: x.name, country: x.country || (m && m.country), points: Number(x.points) || 0, teams: x.team ? [{ name: x.team, color: x.color || '#39c5bb' }] : [] };
      });
    }
    const total = rows.reduce((a, r) => a + Math.max(0, r.points), 0);
    rows.forEach(r => drivers.push({
      id: `d:${r.key}:${s.key}`, type: 'driver', key: r.key, season: s.label, seasonNum: s.num, name: r.name, country: r.country,
      photo: r.master ? (r.master.photo || '') : '', headshot: r.master ? (r.master.headshot || r.master.photo || '') : '',
      number: r.master ? r.master.number : '', rating: r.master && hasVal(r.master.rating) ? r.master.rating : null,
      teams: r.teams, color: r.teams[0] ? r.teams[0].color : '#39c5bb',
      points: Math.round(r.points * 10) / 10, share: total > 0 ? Math.max(0, r.points) / total : 0
    }));
  });
  seasons.forEach(s => assignRarity(drivers.filter(x => x.season === s.label), c));

  const cons = d.teams.map(t => {
    const pts = hasVal(t.gdPoints) ? Number(t.gdPoints) : ((st.T[t.id] || {}).points || 0);
    return { id: `c:${t.id}`, type: 'constructor', key: t.id, name: t.name, logo: t.logo || '', country: t.country || '', color: teamColor(t), car: t.carImage || '', points: Math.round(pts * 10) / 10 };
  });
  const ctot = cons.reduce((a, x) => a + Math.max(0, x.points), 0);
  cons.forEach(x => { x.share = ctot > 0 ? Math.max(0, x.points) / ctot : 0; });
  assignRarity(cons, c);

  probabilities(drivers, c);
  probabilities(cons, c);
  const all = {}; [...drivers, ...cons].forEach(x => { all[x.id] = x; });
  return { drivers, constructors: cons, byId: all, seasons };
}

function takeWithTies(list, n) {
  if (n <= 0 || !list.length) return [];
  let k = Math.min(n, list.length);
  while (k < list.length && list[k].points === list[k - 1].points) k++;
  return list.slice(0, k);
}
function assignRarity(items, c) {
  items.forEach(x => { x.rarity = 'basic'; });
  const pos = items.filter(x => x.points > 0).sort((a, b) => b.points - a.points);
  if (!pos.length) return;
  const leader = pos[0].points;
  let icon = pos.filter(x => x.points === leader);
  if (icon.length === 1 && pos[1]) {
    const gap = (leader - pos[1].points) / leader * 100;
    if (gap <= Number(c.iconGap)) icon = pos.filter(x => x.points >= pos[1].points);
  }
  icon.forEach(x => { x.rarity = 'icon'; });
  let rest = pos.slice(icon.length);
  const prime = takeWithTies(rest, Number(c.primeCount) || 3);
  prime.forEach(x => { x.rarity = 'prime'; });
  rest = rest.slice(prime.length);
  const m = rest.length;
  let eN = Math.round(m * Number(c.elitePct) / 100); if (m >= 3 && eN < 1) eN = 1;
  const elite = takeWithTies(rest, eN); elite.forEach(x => { x.rarity = 'elite'; });
  rest = rest.slice(elite.length);
  let aN = Math.round(m * (Number(c.elitePct) + Number(c.advancedPct)) / 100) - elite.length; if (rest.length >= 2 && aN < 1) aN = 1; if (aN >= rest.length && rest.length >= 3) aN = rest.length - 1;
  takeWithTies(rest, aN).forEach(x => { x.rarity = 'advanced'; });
}
/* higher share → lower chance. weight = 1/(share + smoothing), then min/max caps */
function probabilities(items, c) {
  const n = items.length; if (!n) return;
  const sm = Math.max(0.001, Number(c.smoothing) || 0.05);
  let min = Math.max(0, Number(c.minProb) / 100), max = Math.min(1, Number(c.maxProb) / 100);
  if (min * n > 1) min = 1 / n; if (max * n < 1) max = 1 / n;
  const w = items.map(x => 1 / (x.share + sm));
  const fixed = new Array(n).fill(null);
  for (let it = 0; it < 50; it++) {
    const freeIdx = [...Array(n).keys()].filter(i => fixed[i] === null);
    const left = 1 - fixed.reduce((a, v) => a + (v || 0), 0);
    const wsum = freeIdx.reduce((a, i) => a + w[i], 0) || 1;
    let changed = false;
    freeIdx.forEach(i => {
      const p = left * w[i] / wsum;
      if (p > max + 1e-12) { fixed[i] = max; changed = true; } else if (p < min - 1e-12) { fixed[i] = min; changed = true; }
    });
    if (!changed) { freeIdx.forEach(i => { items[i].prob = left * w[i] / wsum; }); break; }
  }
  items.forEach((x, i) => { if (fixed[i] !== null) x.prob = fixed[i]; });
  const s = items.reduce((a, x) => a + (x.prob || 0), 0) || 1;
  items.forEach(x => { x.prob = (x.prob || 0) / s; });
}
function rand() { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 4294967296; }
/* two distinct options, weighted; drivers must be different people */
function drawPair(pool, exclude = [], excludeKey = '') {
  const ex = new Set(exclude);
  let cand = pool.filter(x => !ex.has(x.id) && (!excludeKey || x.key !== excludeKey) && x.prob > 0);
  const pick = list => { const tot = list.reduce((a, x) => a + x.prob, 0); let r = rand() * tot; for (const x of list) { r -= x.prob; if (r <= 0) return x; } return list[list.length - 1]; };
  if (cand.length < 2) return null;
  const a = pick(cand);
  cand = cand.filter(x => x.id !== a.id && (a.type !== 'driver' || x.key !== a.key));
  if (!cand.length) return null;
  const b = pick(cand);
  return [a.id, b.id];
}
function cardPts(cards, id) { const x = cards.byId[id]; return x ? x.points : 0; }
function teamScore(cards, t) {
  if (!t) return null;
  const p1 = cardPts(cards, t.d1), p2 = cardPts(cards, t.d2), pc = cardPts(cards, t.c);
  return { p1, p2, pc, c1: Math.round(p1 * D1_MULT * 10) / 10, total: Math.round((p1 * D1_MULT + p2 + pc) * 10) / 10 };
}

/* =========================================================
   FIRESTORE SECURITY RULES (generated from the admin settings)
   ========================================================= */
function rulesText(d) {
  const c = cfg(d);
  const admins = String(c.admins || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /@/.test(x));
  const period = Math.round((Number(c.periodHours) || 10) * 3600000);
  return `rules_version = '2';
// Grid Draft + Team portal rules — generated by your league admin. Re-copy after changing attempts, cooldown, reset hours or admins.
service cloud.firestore {
  match /databases/{db}/documents {
    function signedIn() { return request.auth != null; }
    function isAdmin() { return signedIn() && request.auth.token.email_verified == true && request.auth.token.email.lower() in ${JSON.stringify(admins)}; }
    function resetN() { return exists(/databases/$(db)/documents/gd_meta/state) ? get(/databases/$(db)/documents/gd_meta/state).data.reset : 0; }
    function periodKey() { return string(int(request.time.toMillis() / ${period})) + '-' + string(resetN()); }
    function dkey(id) { return id.split(':')[1]; }
    function validOffers(o, stg, ex) {
      return o is list && o.size() == 2 && o[0] is string && o[1] is string && o[0] != o[1]
        && (stg == 'c'
            ? (o[0].matches('c:.+') && o[1].matches('c:.+'))
            : (o[0].matches('d:.+:.+') && o[1].matches('d:.+:.+') && dkey(o[0]) != dkey(o[1])))
        && (ex == '' || (dkey(o[0]) != dkey(ex) && dkey(o[1]) != dkey(ex)));
    }
    function nextStage(st) { return st == 'd1' ? 'd2' : (st == 'd2' ? 'c' : 'done'); }

    match /gd_meta/{doc} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /gd_users/{uid} {
      function validName(n) { return n is string && n.size() >= 2 && n.size() <= 24; }
      function renameOnly() { return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name']) && validName(request.resource.data.name); }
      function seenOnly() { return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['seen']) && request.resource.data.seen == request.time; }
      function startDraft() {
        let nd = request.resource.data;
        let od = resource.data;
        return nd.diff(od).affectedKeys().hasOnly(['period', 'attempts', 'lastStart', 'active'])
          && nd.lastStart == request.time
          && request.time > od.lastStart + duration.value(${Number(c.cooldownSec) || 3}, 's')
          && nd.period == periodKey()
          && (od.period == nd.period ? (od.attempts < ${Number(c.attempts) || 10} && nd.attempts == od.attempts + 1) : nd.attempts == 1)
          && nd.active is string && nd.active.size() > 0
          && !exists(/databases/$(db)/documents/gd_drafts/$(nd.active))
          && getAfter(/databases/$(db)/documents/gd_drafts/$(nd.active)).data.uid == uid;
      }
      function draftDone(id) {
        let dr = getAfter(/databases/$(db)/documents/gd_drafts/$(id)).data;
        return dr.uid == uid && dr.stage == 'done' && dr.completedAt == request.time
          && request.resource.data.team == {'d1': dr.picks.d1, 'd2': dr.picks.d2, 'c': dr.picks.c, 'draft': id};
      }
      function completeDraft() {
        return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['team', 'teamAt'])
          && request.resource.data.teamAt == request.time
          && resource.data.active is string && resource.data.active.size() > 0
          && draftDone(resource.data.active);
      }
      allow read: if true;
      allow create: if signedIn() && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['name', 'period', 'attempts', 'lastStart', 'active', 'team', 'teamAt', 'seen'])
        && validName(request.resource.data.name)
        && request.resource.data.period == '' && request.resource.data.attempts == 0
        && request.resource.data.lastStart == request.time && request.resource.data.seen == request.time
        && request.resource.data.active == '' && request.resource.data.team == null && request.resource.data.teamAt == null;
      allow update: if signedIn() && request.auth.uid == uid && (renameOnly() || seenOnly() || startDraft() || completeDraft());
      allow delete: if isAdmin();
    }

    match /gd_drafts/{id} {
      function reroll() {
        let st = resource.data.stage;
        let nd = request.resource.data;
        return nd.diff(resource.data).affectedKeys().hasOnly(['offers', 'rerolled'])
          && resource.data.rerolled[st] == false && nd.rerolled[st] == true
          && nd.rerolled.diff(resource.data.rerolled).affectedKeys().hasOnly([st])
          && nd.offers.diff(resource.data.offers).affectedKeys().hasOnly([st])
          && validOffers(nd.offers[st], st, st == 'd2' ? resource.data.picks.d1 : '')
          && !nd.offers[st].hasAny(resource.data.offers[st]);
      }
      function pick() {
        let st = resource.data.stage;
        let nx = nextStage(st);
        let nd = request.resource.data;
        let v = nd.picks[st];
        return nd.diff(resource.data).affectedKeys().hasOnly(['picks', 'stage', 'offers', 'completedAt'])
          && nd.picks.diff(resource.data.picks).affectedKeys().hasOnly([st])
          && v in resource.data.offers[st]
          && (st != 'd2' || dkey(v) != dkey(resource.data.picks.d1))
          && nd.stage == nx
          && (nx == 'done'
              ? (nd.offers == resource.data.offers && nd.completedAt == request.time)
              : (nd.offers.diff(resource.data.offers).affectedKeys().hasOnly([nx]) && validOffers(nd.offers[nx], nx, nx == 'd2' ? v : '') && nd.completedAt == null));
      }
      allow read: if signedIn() && (resource.data.uid == request.auth.uid || resource.data.stage == 'done' || isAdmin());
      allow create: if signedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.keys().hasOnly(['uid', 'period', 'createdAt', 'stage', 'offers', 'rerolled', 'picks', 'completedAt'])
        && request.resource.data.createdAt == request.time
        && request.resource.data.period == periodKey()
        && request.resource.data.stage == 'd1'
        && request.resource.data.offers.keys().hasOnly(['d1'])
        && validOffers(request.resource.data.offers.d1, 'd1', '')
        && request.resource.data.rerolled == {'d1': false, 'd2': false, 'c': false}
        && request.resource.data.picks == {}
        && request.resource.data.completedAt == null
        && getAfter(/databases/$(db)/documents/gd_users/$(request.auth.uid)).data.active == id;
      allow update: if signedIn() && resource.data.uid == request.auth.uid
        && resource.data.period == periodKey()
        && resource.data.stage in ['d1', 'd2', 'c']
        && (reroll() || pick());
      allow delete: if isAdmin();
    }
${window.Portal ? window.Portal.RULES : ''}  }
}
`;
}

/* =========================================================
   STORE — Firebase adapter (tests can inject window.GD_TEST_STORE)
   ========================================================= */
function parseFirebaseConfig(text) {
  const out = {};
  ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'].forEach(k => {
    const m = String(text || '').match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`));
    if (m) out[k] = m[1];
  });
  return out.apiKey && out.projectId && out.appId ? out : null;
}
function firebaseStore(conf) {
  let fb = null, A = null, F = null, auth = null, db = null;
  const s = { user: null, profile: null, meta: { reset: 0 }, skew: 0, ready: false, error: '', listeners: [] };
  const emit = () => s.listeners.forEach(f => { try { f(); } catch (e) { } });
  const now = () => Date.now() + s.skew;
  async function init() {
    try {
      const [app, au, fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
      A = au; F = fs;
      fb = app.getApps().length ? app.getApp() : app.initializeApp(conf);
      auth = A.getAuth(fb); db = F.getFirestore(fb);
      F.onSnapshot(F.doc(db, 'gd_meta', 'state'), snap => { s.meta = snap.exists() ? snap.data() : { reset: 0 }; emit(); }, () => { });
      A.onAuthStateChanged(auth, async u => {
        s.user = u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;
        s.profile = null;
        if (u) { await loadProfile(); }
        s.ready = true; emit();
      });
    } catch (e) { s.error = 'Could not load Firebase: ' + e.message; s.ready = true; emit(); }
  }
  async function loadProfile() {
    const ref = F.doc(db, 'gd_users', s.user.uid);
    let snap = await F.getDoc(ref);
    if (snap.exists()) {
      try { await F.updateDoc(ref, { seen: F.serverTimestamp() }); snap = await F.getDoc(ref); } catch (e) { }
      const p = snap.data();
      if (p.seen && p.seen.toMillis) s.skew = p.seen.toMillis() - Date.now();
      s.profile = conv(p);
    }
  }
  const conv = p => p ? Object.assign({}, p, { lastStart: p.lastStart && p.lastStart.toMillis ? p.lastStart.toMillis() : 0, teamAt: p.teamAt && p.teamAt.toMillis ? p.teamAt.toMillis() : 0 }) : null;
  const convD = (id, x) => Object.assign({ id }, x, { createdAt: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0, completedAt: x.completedAt && x.completedAt.toMillis ? x.completedAt.toMillis() : null });
  Object.assign(s, {
    kind: 'firebase', now,
    on(f) { s.listeners.push(f); },
    async signIn() {
      const p = new A.GoogleAuthProvider();
      try { await A.signInWithPopup(auth, p); }
      catch (e) { if (/popup-blocked|operation-not-supported/.test(e.code || '')) return A.signInWithRedirect(auth, p); throw e; }
    },
    async signOut() { await A.signOut(auth); },
    async createProfile(name) {
      await F.setDoc(F.doc(db, 'gd_users', s.user.uid), { name, period: '', attempts: 0, lastStart: F.serverTimestamp(), active: '', team: null, teamAt: null, seen: F.serverTimestamp() });
      await loadProfile(); emit();
    },
    async rename(name) { await F.updateDoc(F.doc(db, 'gd_users', s.user.uid), { name }); s.profile.name = name; emit(); },
    async start(period, attempts, pair) {
      const uref = F.doc(db, 'gd_users', s.user.uid), dref = F.doc(F.collection(db, 'gd_drafts'));
      const b = F.writeBatch(db);
      b.set(dref, { uid: s.user.uid, period, createdAt: F.serverTimestamp(), stage: 'd1', offers: { d1: pair }, rerolled: { d1: false, d2: false, c: false }, picks: {}, completedAt: null });
      b.update(uref, { period, attempts, lastStart: F.serverTimestamp(), active: dref.id });
      await b.commit();
      await loadProfile(); emit();
      return dref.id;
    },
    async getDraft(id) { const x = await F.getDoc(F.doc(db, 'gd_drafts', id)); return x.exists() ? convD(id, x.data()) : null; },
    async reroll(draft, pair) { await F.updateDoc(F.doc(db, 'gd_drafts', draft.id), { ['offers.' + draft.stage]: pair, ['rerolled.' + draft.stage]: true }); },
    async pick(draft, cardId, nextPair) {
      const st = draft.stage, nx = st === 'd1' ? 'd2' : st === 'd2' ? 'c' : 'done';
      const dref = F.doc(db, 'gd_drafts', draft.id);
      if (nx !== 'done') { await F.updateDoc(dref, { ['picks.' + st]: cardId, stage: nx, ['offers.' + nx]: nextPair }); return; }
      const b = F.writeBatch(db);
      b.update(dref, { ['picks.' + st]: cardId, stage: 'done', completedAt: F.serverTimestamp() });
      b.update(F.doc(db, 'gd_users', s.user.uid), { team: { d1: draft.picks.d1, d2: draft.picks.d2, c: cardId, draft: draft.id }, teamAt: F.serverTimestamp() });
      await b.commit(); await loadProfile(); emit();
    },
    async myDrafts() { const q = await F.getDocs(F.query(F.collection(db, 'gd_drafts'), F.where('uid', '==', s.user.uid))); return q.docs.map(x => convD(x.id, x.data())); },
    async players() { const q = await F.getDocs(F.collection(db, 'gd_users')); return q.docs.map(x => Object.assign({ uid: x.id }, conv(x.data()))); },
    async allDrafts() { const q = await F.getDocs(F.collection(db, 'gd_drafts')); return q.docs.map(x => convD(x.id, x.data())); },
    async adminReset() { await F.setDoc(F.doc(db, 'gd_meta', 'state'), { reset: (Number(s.meta.reset) || 0) + 1 }, { merge: true }); },
    async test() { await F.getDoc(F.doc(db, 'gd_meta', 'state')); return true; }
  });
  init();
  return s;
}
let STORE = null, STORE_KEY = '';
function hook(s) { if (s && !s.__hooked) { s.__hooked = true; s.on(() => { if (/^#\/(griddraft|admin\/griddraft)/.test(location.hash)) LG.render(false); }); } return s; }
function store(d) {
  if (window.GD_TEST_STORE) return hook(window.GD_TEST_STORE);
  const c = cfg(d);
  const conf = c.firebase && c.firebase.apiKey ? c.firebase : null;
  if (!conf) return null;
  const k = JSON.stringify(conf);
  if (!STORE || STORE_KEY !== k) { STORE = firebaseStore(conf); STORE_KEY = k; }
  return hook(STORE);
}

/* =========================================================
   GAME STATE + UI
   ========================================================= */
const G = { draft: null, draftFor: '', loading: false, busy: false, sel: null, anim: '', reveal: false, lb: null, lbAt: 0, hist: null, open: '', pack: false, opening: false };
function periodInfo(d, s) {
  const c = cfg(d), ms = (Number(c.periodHours) || 10) * 3600000, now = s.now();
  const idx = Math.floor(now / ms);
  return { key: `${idx}-${Number(s.meta.reset) || 0}`, next: (idx + 1) * ms, now };
}
function attemptsLeft(d, s) {
  const c = cfg(d), p = s.profile; if (!p) return Number(c.attempts);
  return p.period === periodInfo(d, s).key ? Math.max(0, Number(c.attempts) - (p.attempts || 0)) : Number(c.attempts);
}
function cooldownLeft(d, s) { const p = s.profile; if (!p) return 0; return Math.max(0, (p.lastStart || 0) + (Number(cfg(d).cooldownSec) || 3) * 1000 - s.now()); }
const fmtCountdown = ms => { ms = Math.max(0, ms); const h = Math.floor(ms / 36e5), m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1e3) % 60; return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`; };

async function loadActiveDraft(s) {
  const p = s.profile;
  if (!p || !p.active) { G.draft = null; G.draftFor = ''; return; }
  if (G.draftFor === p.active && G.draft) return;
  G.loading = true;
  try { G.draft = await s.getDraft(p.active); G.draftFor = p.active; } catch (e) { G.draft = null; }
  G.loading = false;
}
const rarityBadge = r => `<span class="gd-rar r-${r}">${R_LABEL[r] || ''}</span>`;
const SAKURA_PETAL = 'M0 0C-7.5-5-9-14.5-4.2-20.5L0-17.2L4.2-20.5C9-14.5 7.5-5 0 0Z';
const sakuraMark = (cls = '') => `<svg class="gd-sakura ${cls}" viewBox="-24 -24 48 48" aria-hidden="true">${[0, 72, 144, 216, 288].map(a => `<path d="${SAKURA_PETAL}" transform="rotate(${a})"/>`).join('')}<circle r="3.4"/></svg>`;
const cardBack = () => `<div class="gd-back" aria-hidden="true"><div class="gd-back-in">${sakuraMark()}<b>GRID<br>DRAFT</b><span>${esc((LG.S.data.league || {}).name || '')}</span></div></div>`;
const R_ORDER = { icon: 5, prime: 4, elite: 3, advanced: 2, basic: 1 };
function cardHTML(x, opts = {}) {
  if (!x) return `<div class="gd-card missing"><div class="gd-card-in"><p class="muted">This card is no longer available.</p></div></div>`;
  const pts = opts.showPts ? `<div class="gd-pts"><b>${fmtPts(x.points)}</b><span>PTS</span>${opts.mult ? `<em>×${opts.mult}</em>` : ''}</div>` : `<div class="gd-pts hidden"><b>???</b><span>PTS</span></div>`;
  const tag = opts.button ? 'button' : 'div';
  const attrs = opts.button ? `data-gd-pick="${esc(x.id)}" ${opts.selected ? 'aria-pressed="true"' : ''}` : '';
  if (x.type === 'driver') {
    return `<${tag} class="gd-card r-${x.rarity} ${opts.selected ? 'sel' : ''} ${opts.cls || ''}" style="--tc:${esc(x.color)}" ${attrs}>${cardBack()}
      <div class="gd-card-in"><i class="gd-holo"></i>
        <div class="gd-top">${rarityBadge(x.rarity)}<span class="gd-season">Season ${esc(x.seasonNum)} · ${esc(x.season)}</span></div>
        <div class="gd-photo">${x.photo ? `<img src="${esc(LG.asset(x.photo))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
        <div class="gd-info">
          <div class="gd-name">${nameHTML(x.name)}${hasVal(x.number) ? `<span class="gd-no">#${esc(x.number)}</span>` : ''}</div>
          <div class="gd-meta">${flag(x.country)}${x.country ? `<span>${esc(String(x.country).toUpperCase())}</span>` : ''}${x.rating !== null ? `<span class="gd-rating">${esc(x.rating)} OVR</span>` : ''}</div>
          <div class="gd-team">${x.teams.map(t => `<span><i style="background:${esc(t.color)}"></i>${esc(t.name)}</span>`).join('') || '<span class="muted">—</span>'}</div>
          ${pts}
        </div>
      </div></${tag}>`;
  }
  return `<${tag} class="gd-card con r-${x.rarity} ${opts.selected ? 'sel' : ''} ${opts.cls || ''}" style="--tc:${esc(x.color)}" ${attrs}>${cardBack()}
    <div class="gd-card-in"><i class="gd-holo"></i>
      <div class="gd-top">${rarityBadge(x.rarity)}<span class="gd-season">Constructor</span></div>
      <div class="gd-photo con">${x.logo ? `<img class="gd-logo" src="${esc(LG.asset(x.logo))}" alt="" loading="lazy" onerror="this.remove()">` : ''}${x.car ? `<img class="gd-car" src="${esc(LG.asset(x.car))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
      <div class="gd-info">
        <div class="gd-name con">${esc(x.name)}</div>
        <div class="gd-meta">${flag(x.country)}${x.country ? `<span>${esc(String(x.country).toUpperCase())}</span>` : ''}</div>
        ${pts}
      </div>
    </div></${tag}>`;
}
const head = (eyebrow, title, sub) => `<div class="page-head"><div class="eyebrow">${esc(eyebrow)}</div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>`;
const emptyBox = (t, sub) => `<div class="empty"><b>${esc(t)}</b>${sub || ''}</div>`;
const progress = stage => `<div class="gd-prog">${['d1', 'd2', 'c', 'done'].map((k, i) => { const cur = ['d1', 'd2', 'c', 'done'].indexOf(stage); return `<div class="gd-step ${i < cur ? 'past' : i === cur ? 'cur' : ''}"><span>${i + 1}</span>${STAGE_LABEL[k]}</div>`; }).join('<i></i>')}</div>`;

function teamPanel(cards, t, opts = {}) {
  const sc = teamScore(cards, t);
  if (!sc) return '';
  const x1 = cards.byId[t.d1], x2 = cards.byId[t.d2], xc = cards.byId[t.c];
  return `<div class="gd-team-panel ${opts.reveal ? 'reveal' : ''}">
    <div class="gd-trio">
      <div class="gd-slot"><div class="gd-slot-l">Driver 1 <b>×${D1_MULT}</b></div>${cardHTML(x1, { showPts: true, mult: D1_MULT, cls: opts.reveal ? 'flip d0' : '' })}<div class="gd-contrib">${fmtPts(sc.p1)} × ${D1_MULT} = <b>${fmtPts(sc.c1)}</b></div></div>
      <div class="gd-slot"><div class="gd-slot-l">Driver 2</div>${cardHTML(x2, { showPts: true, cls: opts.reveal ? 'flip d1' : '' })}<div class="gd-contrib"><b>${fmtPts(sc.p2)}</b></div></div>
      <div class="gd-slot"><div class="gd-slot-l">Constructor</div>${cardHTML(xc, { showPts: true, cls: opts.reveal ? 'flip d2' : '' })}<div class="gd-contrib"><b>${fmtPts(sc.pc)}</b></div></div>
    </div>
    <div class="gd-total"><span>Grid Draft score</span><b class="mono" ${opts.reveal ? `data-countup="${sc.total}"` : ''}>${opts.reveal ? '0' : fmtPts(sc.total)}</b></div>
  </div>`;
}

function rankOf(list, uid) { const me = list.find(x => x.uid === uid); return me ? me.rank : null; }
async function loadLeaderboard(d, s, force) {
  if (!force && G.lb && Date.now() - G.lbAt < 20000) return;
  try {
    const cards = buildCards(d);
    const ps = (await s.players()).filter(p => p.team && p.team.d1);
    const rows = ps.map(p => Object.assign({}, p, { score: teamScore(cards, p.team).total })).sort((a, b) => b.score - a.score || (a.teamAt || 0) - (b.teamAt || 0));
    rows.forEach((r, i) => { r.rank = i && rows[i - 1].score === r.score ? rows[i - 1].rank : i + 1; });
    G.lb = rows; G.lbAt = Date.now();
  } catch (e) { G.lb = G.lb || []; G.lbErr = e.message; }
}

function page(d, sub) {
  const c = cfg(d);
  if (!c.enabled) return `<div class="page">${head('Mini-game', 'Grid Draft', '')}${emptyBox('Grid Draft is coming soon', '<p>Check back once the admins switch it on.</p>')}</div>`;
  const s = store(d);
  if (!s) return `<div class="page">${head('Mini-game', 'Grid Draft', '')}${emptyBox('Grid Draft isn’t connected yet', '<p>An admin needs to finish the Firebase setup in the admin console.</p>')}</div>`;
  if (s.error) return `<div class="page">${head('Mini-game', 'Grid Draft', '')}${emptyBox('Grid Draft can’t connect right now', `<p>${esc(s.error)}</p>`)}</div>`;
  if (!s.ready) return `<div class="page gd">${head('Mini-game', 'Grid Draft', '')}<div class="loading">Warming up the grid…</div></div>`;
  const cards = buildCards(d);
  if (sub === 'leaderboard') return leaderboardPage(d, s, cards);
  if (sub === 'history') return historyPage(d, s, cards);
  if (sub === 'play') return playPage(d, s, cards);
  return landing(d, s, cards);
}

function landing(d, s, cards) {
  const c = cfg(d), p = s.profile, pi = periodInfo(d, s);
  const noCards = cards.drivers.length < 3 || cards.constructors.length < 2;
  const left = attemptsLeft(d, s), cd = cooldownLeft(d, s);
  if (s.user && p && G.lb === null) loadLeaderboard(d, s).then(() => LG.render(false));
  if (s.user && p && p.active && G.draftFor !== p.active && !G.loading) loadActiveDraft(s).then(() => LG.render(false));
  const inProg = G.draft && G.draft.id === (p && p.active) && G.draft.stage !== 'done' && G.draft.period === pi.key;
  const rank = p && G.lb ? rankOf(G.lb, s.user.uid) : null;
  const sc = p && p.team ? teamScore(cards, p.team) : null;
  let cta;
  if (noCards) cta = `<button class="btn gd-play" disabled>PLAY</button><p class="muted">Grid Draft opens once there are race results to draft from.</p>`;
  else if (!s.user) cta = `<button class="btn gd-play" data-gd="signin">Sign in with Google to play</button><p class="muted gd-small">Only your public username is shown — never your email.</p>`;
  else if (!p) cta = `<form class="gd-name-form" data-form="gd-name"><label class="fld"><span>Pick a public username</span><input name="n" maxlength="24" minlength="2" required value="${esc(String(s.user.displayName || '').split(' ')[0])}"></label><button class="btn primary">Save & continue</button></form>`;
  else cta = `${inProg ? `<button class="btn gd-play" data-gd="resume">RESUME DRAFT</button>` : ''}
    <button class="btn gd-play ${inProg ? 'alt' : ''}" data-gd="play" ${left <= 0 || cd > 0 || G.busy ? 'disabled' : ''}>${left <= 0 ? 'NO ATTEMPTS LEFT' : inProg ? 'START A NEW DRAFT' : 'PLAY'}</button>
    ${cd > 0 && left > 0 ? `<p class="muted gd-small" data-gd-cd="${p.lastStart + (Number(c.cooldownSec) || 3) * 1000}">Ready in a moment…</p>` : ''}
    ${inProg ? '<p class="muted gd-small">Starting a new draft uses an attempt; your current team stays until a new draft is completed.</p>' : ''}`;
  return `<div class="page gd">
    <section class="gd-hero">
      <div class="gd-hero-txt">
        <div class="gd-logo-word"><span>GRID</span><b>DRAFT</b></div>
        <p>Two cards. One choice. Three times. Draft <b>Driver 1</b> (worth ×${D1_MULT}), <b>Driver 2</b> and a <b>Constructor</b> — their real championship points are hidden until the reveal. Use your rerolls wisely and chase the top of the global leaderboard.</p>
        <div class="gd-cta">${cta}</div>
      </div>
      <div class="gd-hero-cards" aria-hidden="true"><span class="gd-fan r-icon"></span><span class="gd-fan r-prime"></span><span class="gd-fan r-elite"></span></div>
    </section>
    <div class="gd-stats">
      <div class="stat"><b>${sc ? fmtPts(sc.total) : '—'}</b><span>Your score</span></div>
      <div class="stat"><b>${rank ? 'P' + rank : '—'}</b><span>Global rank${G.lb ? ` · ${G.lb.length} players` : ''}</span></div>
      <div class="stat"><b>${s.user && p ? `${left}/${c.attempts}` : c.attempts}</b><span>Attempts left</span></div>
      <div class="stat"><b class="mono" data-gd-reset="${pi.next}">${fmtCountdown(pi.next - pi.now)}</b><span>Next global reset</span></div>
    </div>
    ${sc ? `<section><div class="section-title"><h2>Your current team</h2><span class="muted">Latest completed draft</span></div>${teamPanel(cards, p.team)}</section>` : ''}
    <section class="gd-links"><a class="btn" href="#/griddraft/leaderboard">🏆 Global leaderboard</a>${s.user && p ? '<a class="btn" href="#/griddraft/history">🕘 My previous drafts</a>' : ''}
      ${s.user ? `<span class="gd-me muted">Signed in as <b>${esc(p ? p.name : '…')}</b>${p ? ' · <button class="linkish" data-gd="rename">change name</button>' : ''} · <button class="linkish" data-gd="signout">sign out</button></span>` : ''}</section>
    <section class="card gd-how"><h3>How it works</h3><ol>
      <li><b>Driver 1</b> — pick one of two seasonal driver cards. Their points count <b>×${D1_MULT}</b>.</li>
      <li><b>Driver 2</b> — pick one of two more (never the same driver again).</li>
      <li><b>Constructor</b> — pick one of two teams.</li>
      <li>Each stage has <b>one reroll</b> that swaps both options. Rarer, higher-scoring cards appear less often.</li>
      <li>You get <b>${c.attempts} drafts every ${c.periodHours} hours</b> (everyone resets together). Your <b>latest completed team</b> is your leaderboard score.</li></ol>
      <div class="gd-legend">${RARITIES.map(r => rarityBadge(r)).join('')}</div></section>
  </div>`;
}

function playPage(d, s, cards) {
  const p = s.profile;
  if (!s.user || !p) { location.hash = '#/griddraft'; return ''; }
  const pi = periodInfo(d, s);
  if (p.active && G.draftFor !== p.active && !G.loading) { loadActiveDraft(s).then(() => LG.render(false)); }
  if (!p.active) { location.hash = '#/griddraft'; return ''; }
  const dr = G.draft;
  if (!dr || G.loading) return `<div class="page gd"><div class="loading">Shuffling the deck…</div></div>`;
  if (dr.stage !== 'done' && dr.period !== pi.key) return `<div class="page gd">${emptyBox('This draft expired at the global reset', '<p><a class="btn" href="#/griddraft">Back to Grid Draft</a></p>')}</div>`;
  if (dr.stage === 'done') {
    const t = { d1: dr.picks.d1, d2: dr.picks.d2, c: dr.picks.c };
    const left = attemptsLeft(d, s);
    const reveal = G.reveal; G.reveal = false;
    return `<div class="page gd">${progress('done')}
      <div class="gd-stage-h"><h1>Your team</h1><p class="muted">Points revealed — here's how your picks performed.</p></div>
      ${teamPanel(cards, t, { reveal })}
      <div class="gd-after"><button class="btn gd-play" data-gd="play" ${left <= 0 || cooldownLeft(d, s) > 0 ? 'disabled' : ''} ${cooldownLeft(d, s) > 0 ? `data-gd-cdbtn="${(p.lastStart || 0) + (Number(cfg(d).cooldownSec) || 3) * 1000}"` : ''}>${left > 0 ? `PLAY AGAIN · ${left} LEFT` : 'NO ATTEMPTS LEFT'}</button><a class="btn" href="#/griddraft/leaderboard">See the leaderboard</a><a class="btn ghost" href="#/griddraft">Done</a></div>
    </div>`;
  }
  const st = dr.stage, offers = (dr.offers || {})[st] || [];
  const used = dr.rerolled && dr.rerolled[st];
  const anim = G.anim; G.anim = '';
  return `<div class="page gd">${progress(st)}
    <div class="gd-stage-h"><div class="eyebrow">Stage ${STAGES.indexOf(st) + 1} of 3</div><h1>Choose your ${STAGE_LABEL[st]}${st === 'd1' ? ` <span class="gd-x">×${D1_MULT}</span>` : ''}</h1>
      <p class="muted">${st === 'd1' ? `This driver's points count one and a half times.` : st === 'd2' ? 'Points count once. You can’t pick the same driver twice.' : 'Pick the team whose points complete your score.'} Points stay hidden until the reveal.</p></div>
    ${dr.picks && (dr.picks.d1 || dr.picks.d2) ? `<div class="gd-picked">${['d1', 'd2'].filter(k => dr.picks[k]).map(k => { const x = cards.byId[dr.picks[k]]; return `<span class="gd-mini r-${x ? x.rarity : 'basic'}"><small>${STAGE_LABEL[k]}</small>${x ? esc(x.name) : '—'}</span>`; }).join('')}</div>` : ''}
    ${G.pack ? packHTML(st, offers.map(id => cards.byId[id]).filter(Boolean)) : `<div class="gd-pair ${anim}">${offers.map(id => cardHTML(cards.byId[id], { button: true, selected: G.sel === id })).join('<div class="gd-or">OR</div>')}</div>`}
    <div class="gd-actions ${G.pack ? 'hide' : ''}">
      <button class="gd-reroll" data-gd="reroll" ${used || G.busy ? 'disabled' : ''}>${used ? 'REROLL USED' : '<span class="gd-ric">⟳</span> REROLL BOTH OPTIONS · 1 LEFT'}</button>
      <button class="btn primary gd-lock" data-gd="lock" ${!G.sel || G.busy ? 'disabled' : ''}>${G.sel && cards.byId[G.sel] ? `LOCK IN ${esc(cards.byId[G.sel].name.toUpperCase())}` : 'TAP A CARD TO CHOOSE'}</button>
    </div>
  </div>`;
}

function packHTML(st, list) {
  const best = list.map(x => x.rarity).sort((a, b) => (R_ORDER[b] || 0) - (R_ORDER[a] || 0))[0] || 'basic';
  return `<div class="gd-packwrap"><button class="gd-pack r-${best}" data-gd="openpack" aria-label="Open the pack">
      <span class="gd-pack-crimp top"></span><span class="gd-pack-tear"></span>
      <span class="gd-pack-body">
        <span class="gd-pack-glow"></span>
        ${sakuraMark('big')}${sakuraMark('s1')}${sakuraMark('s2')}${sakuraMark('s3')}
        <span class="gd-pack-brand"><small>${esc((LG.S.data.league || {}).name || 'Grid Draft')}</small><b>GRID DRAFT</b><em>${st === 'c' ? 'Constructor pack' : STAGE_LABEL[st] + ' pack'} · 2 cards</em></span>
      </span><span class="gd-pack-crimp bottom"></span><span class="gd-pack-shine"></span></button>
    <p class="gd-pack-hint">Tap the pack to open it</p></div>`;
}
function petalBurst(el, n = 46) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect(), box = document.createElement('div');
  box.className = 'gd-burst'; box.style.left = (r.left + r.width / 2) + 'px'; box.style.top = (r.top + r.height * .32) + 'px';
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 260, p = document.createElement('i');
    p.style.cssText = `--dx:${Math.cos(a) * dist}px;--dy:${Math.sin(a) * dist * .8 - 60}px;--fall:${140 + Math.random() * 220}px;--r:${Math.random() * 720 - 360}deg;--s:${8 + Math.random() * 12}px;--t:${1.1 + Math.random() * .9}s;--dl:${Math.random() * .12}s`;
    box.appendChild(p);
  }
  document.body.appendChild(box); setTimeout(() => box.remove(), 2400);
}
function openPack(btn) {
  if (G.opening) return; G.opening = true;
  btn.classList.add('opening');
  setTimeout(() => petalBurst(btn), 380);
  setTimeout(() => { G.pack = false; G.opening = false; G.anim = 'spin'; LG.render(false); }, 820);
}
/* gentle 3D tilt on hover (desktop) */
document.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const c = e.target.closest && e.target.closest('button.gd-card, .gd-pack'); if (!c) return;
  const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
  c.style.setProperty('--ry', (x * 14).toFixed(2) + 'deg'); c.style.setProperty('--rx', (-y * 14).toFixed(2) + 'deg');
  c.style.setProperty('--mx', ((x + .5) * 100).toFixed(1) + '%'); c.style.setProperty('--my', ((y + .5) * 100).toFixed(1) + '%');
});
document.addEventListener('pointerout', e => { const c = e.target.closest && e.target.closest('button.gd-card, .gd-pack'); if (c && !c.contains(e.relatedTarget)) { c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); } });

function leaderboardPage(d, s, cards) {
  if (G.lb === null || Date.now() - G.lbAt > 20000) loadLeaderboard(d, s, true).then(() => LG.render(false));
  const rows = G.lb;
  const me = s.user && s.user.uid;
  const chip = id => { const x = cards.byId[id]; return x ? `<span class="gd-chip r-${x.rarity}" title="${R_LABEL[x.rarity]}"><i></i>${esc(x.type === 'driver' ? x.name.split(' ').pop() : x.name)}${x.type === 'driver' ? `<small>S${x.seasonNum}</small>` : ''}</span>` : '<span class="muted">—</span>'; };
  return `<div class="page gd">${head('Grid Draft', 'Global leaderboard', 'Ranked by each player’s latest completed team.')}
    <p><a class="btn sm" href="#/griddraft">← Back to Grid Draft</a></p>
    ${rows === null ? '<div class="loading">Loading players…</div>' : !rows.length ? emptyBox('No completed drafts yet', '<p>Be the first on the board.</p>') : `<div class="table-wrap"><table class="tbl gd-lb"><thead><tr><th>Pos</th><th>Player</th><th class="hide-sm">Driver 1 ×${D1_MULT}</th><th class="hide-sm">Driver 2</th><th class="hide-sm">Constructor</th><th class="r">Score</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.rank <= 3 ? 'top' + r.rank : ''} ${r.uid === me ? 'gd-me-row' : ''} gd-lbrow" data-gd-open="${esc(r.uid)}"><td class="pos">${r.rank}</td><td><b>${esc(r.name)}</b>${r.uid === me ? ' <span class="chip">you</span>' : ''}</td><td class="hide-sm">${chip(r.team.d1)}</td><td class="hide-sm">${chip(r.team.d2)}</td><td class="hide-sm">${chip(r.team.c)}</td><td class="pts">${fmtPts(r.score)}</td></tr>
        ${G.open === r.uid ? `<tr class="gd-open"><td colspan="6">${teamPanel(cards, r.team)}</td></tr>` : ''}`).join('')}
    </tbody></table></div><p class="hint">Tap a player to see their team.</p>`}
  </div>`;
}

function historyPage(d, s, cards) {
  if (!s.user || !s.profile) { location.hash = '#/griddraft'; return ''; }
  if (G.hist === null) { G.hist = 'loading'; s.myDrafts().then(x => { G.hist = x.sort((a, b) => b.createdAt - a.createdAt); LG.render(false); }).catch(() => { G.hist = []; LG.render(false); }); }
  const list = Array.isArray(G.hist) ? G.hist : null;
  const curDraft = s.profile.team && s.profile.team.draft;
  return `<div class="page gd">${head('Grid Draft', 'My previous drafts', 'Past drafts are kept for your history only — your leaderboard score is always your latest completed team.')}
    <p><a class="btn sm" href="#/griddraft">← Back to Grid Draft</a></p>
    ${!list ? '<div class="loading">Loading…</div>' : !list.length ? emptyBox('No drafts yet') : `<div class="gd-hist">${list.map(x => {
      const done = x.stage === 'done', t = done ? { d1: x.picks.d1, d2: x.picks.d2, c: x.picks.c } : null, sc = t ? teamScore(cards, t) : null;
      return `<div class="gd-hrow ${x.id === curDraft ? 'cur' : ''}"><span class="mono muted">${x.createdAt ? new Date(x.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}</span>
        <span class="gd-hpicks">${done ? ['d1', 'd2', 'c'].map(k => { const c2 = cards.byId[x.picks[k]]; return `<span class="gd-chip r-${c2 ? c2.rarity : 'basic'}"><i></i>${esc(c2 ? (c2.type === 'driver' ? c2.name.split(' ').pop() : c2.name) : '—')}</span>`; }).join('') : `<span class="muted">${x.period === periodInfo(d, s).key ? 'In progress' : 'Not finished (expired)'}</span>`}</span>
        <b class="mono">${sc ? fmtPts(sc.total) : '—'}</b>${x.id === curDraft ? '<span class="chip">current team</span>' : ''}</div>`;
    }).join('')}</div>`}
  </div>`;
}

/* ---------------- actions ---------------- */
async function act(kind, el) {
  const d = LG.S.data, s = store(d); if (!s) return;
  const cards = buildCards(d);
  const fail = e => { G.busy = false; const m = String(e && (e.code || e.message) || e); toast(/permission/i.test(m) ? 'The server said no — you may be out of attempts, too quick (wait a few seconds), or the draft expired. Refresh and try again.' : 'Something went wrong: ' + m, 'err'); LG.render(false); };
  try {
    if (kind === 'signin') { await s.signIn(); return; }
    if (kind === 'signout') { await s.signOut(); G.lb = null; G.hist = null; G.draft = null; G.draftFor = ''; return LG.render(false); }
    if (kind === 'rename') { const n = prompt('New public username (2–24 characters):', s.profile.name || ''); if (n && n.trim().length >= 2) { await s.rename(n.trim().slice(0, 24)); G.lb = null; } return LG.render(false); }
    if (kind === 'resume') { location.hash = '#/griddraft/play'; return; }
    if (kind === 'openpack') { openPack(el); return; }
    if (kind === 'play') {
      const pi = periodInfo(d, s), left = attemptsLeft(d, s);
      if (left <= 0) return toast('No attempts left — they reset for everyone at the next global reset.', 'err');
      if (cooldownLeft(d, s) > 0) return toast('Just a moment before your next draft…', 'err');
      const pair = drawPair(cards.drivers);
      if (!pair) return toast('Not enough driver cards to play yet.', 'err');
      G.busy = true; LG.render(false);
      const used = s.profile.period === pi.key ? (s.profile.attempts || 0) : 0;
      const id = await s.start(pi.key, used + 1, pair);
      G.draft = await s.getDraft(id); G.draftFor = id; G.sel = null; G.anim = 'deal'; G.pack = true; G.busy = false; G.hist = null;
      if (location.hash !== '#/griddraft/play') location.hash = '#/griddraft/play'; else LG.render(false);
      return;
    }
    const dr = G.draft; if (!dr) return;
    if (kind === 'reroll') {
      const st = dr.stage; if (dr.rerolled[st]) return;
      const pool = st === 'c' ? cards.constructors : cards.drivers;
      const exKey = st === 'd2' && cards.byId[dr.picks.d1] ? cards.byId[dr.picks.d1].key : (st === 'd2' ? String(dr.picks.d1 || '').split(':')[1] : '');
      const pair = drawPair(pool, dr.offers[st], exKey);
      if (!pair) return toast('There aren’t enough other cards to reroll into.', 'err');
      G.busy = true; G.anim = 'out'; LG.render(false);
      await new Promise(r => setTimeout(r, 260));
      await s.reroll(dr, pair);
      dr.offers[st] = pair; dr.rerolled[st] = true; G.sel = null; G.busy = false; G.anim = 'deal'; G.pack = true; LG.render(false);
      return;
    }
    if (kind === 'lock') {
      const st = dr.stage, v = G.sel; if (!v || !dr.offers[st].includes(v)) return;
      let next = null;
      if (st === 'd1') next = drawPair(cards.drivers, [], cards.byId[v] ? cards.byId[v].key : v.split(':')[1]);
      if (st === 'd2') next = drawPair(cards.constructors);
      if (st !== 'c' && !next) return toast('Not enough cards left for the next stage.', 'err');
      G.busy = true; LG.render(false);
      await s.pick(dr, v, next);
      dr.picks[st] = v;
      if (st === 'c') { dr.stage = 'done'; G.reveal = true; G.lb = null; G.hist = null; }
      else { const nx = st === 'd1' ? 'd2' : 'c'; dr.stage = nx; dr.offers[nx] = next; G.anim = 'deal'; G.pack = true; }
      G.sel = null; G.busy = false; LG.render(false);
      if (st === 'c') runCountUp();
    }
  } catch (e) { fail(e); }
}
function runCountUp() {
  const el = document.querySelector('[data-countup]'); if (!el) return;
  const target = Number(el.dataset.countup), t0 = performance.now(), dur = 1400, delay = 900;
  const step = now => { const k = Math.min(1, Math.max(0, (now - t0 - delay) / dur)); const e = 1 - Math.pow(1 - k, 3); el.textContent = fmtPts(Math.round(target * e * 10) / 10); if (k < 1) requestAnimationFrame(step); else el.classList.add('done'); };
  requestAnimationFrame(step);
}
document.addEventListener('click', e => {
  if (!e.target.closest || !e.target.closest('.page.gd')) return;
  const p = e.target.closest('[data-gd-pick]');
  if (p) { if (G.busy) return; G.sel = p.dataset.gdPick; LG.render(false); return; }
  const a = e.target.closest('[data-gd]');
  if (a) { e.preventDefault(); act(a.dataset.gd, a); return; }
  const o = e.target.closest('[data-gd-open]');
  if (o) { G.open = G.open === o.dataset.gdOpen ? '' : o.dataset.gdOpen; LG.render(false); }
});
document.addEventListener('submit', async e => {
  if (e.target.dataset.form !== 'gd-name') return;
  e.preventDefault();
  const n = e.target.n.value.trim().slice(0, 24);
  if (n.length < 2) return toast('Pick a username with at least 2 characters', 'err');
  try { await store(LG.S.data).createProfile(n); LG.render(false); } catch (err) { toast('Couldn’t save: ' + (err.code || err.message), 'err'); }
});
setInterval(() => {
  document.querySelectorAll('[data-gd-reset]').forEach(el => {
    const s = store(LG.S.data); if (!s) return;
    const ms = Number(el.dataset.gdReset) - s.now();
    if (ms <= 0) { LG.render(false); return; }
    el.textContent = fmtCountdown(ms);
  });
  document.querySelectorAll('[data-gd-cd], [data-gd-cdbtn]').forEach(el => {
    const s = store(LG.S.data); if (!s) return;
    if (Number(el.dataset.gdCd || el.dataset.gdCdbtn) <= s.now()) { delete el.dataset.gdCd; delete el.dataset.gdCdbtn; LG.render(false); }
  });
}, 1000);
window.addEventListener('hashchange', () => { if (/^#\/griddraft\/?$/.test(location.hash)) { G.lb = null; } if (/^#\/griddraft\/history/.test(location.hash)) G.hist = null; });

window.GridDraft = { page, buildCards, assignRarity, probabilities, drawPair, teamScore, rulesText, parseFirebaseConfig, store, cfg, DEFAULTS, R_LABEL, RARITIES, periodInfo, G };
})();
