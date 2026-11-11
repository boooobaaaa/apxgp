/*
 * Fan accounts, coins and card packs — backed by Firebase (Auth + Firestore).
 * The Firestore security rules in /firebase/firestore.rules enforce the coin economy:
 * fans can only gain coins via the daily claim, and opening a pack must deduct its real price.
 */
'use strict';
(function () {
  const CFG = window.SITE_CONFIG || {};
  const fbConfig = CFG.firebase;
  const BASE = `https://www.gstatic.com/firebasejs/${CFG.firebaseVersion || '12.15.0'}`;
  const DAILY_COOLDOWN_MS = 20 * 3600e3; // must match firestore.rules
  const RARITIES = ['common', 'rare', 'circuit', 'signature'];

  let A = null, F = null, auth = null, db = null; // auth module, firestore module, instances
  const listeners = [];
  const state = { ready: false, user: null, profile: null, error: null, isAdmin: false };
  let pendingUsername = null;
  let initPromise = null;

  const emit = () => listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : t ? Number(t) : 0);
  const cleanName = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24);

  function niceError(e) {
    const code = e && e.code ? String(e.code) : '';
    const map = {
      'auth/invalid-email': 'That email address looks wrong.',
      'auth/email-already-in-use': 'An account with that email already exists — try signing in.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/wrong-password': 'Wrong email or password.',
      'auth/user-not-found': 'Wrong email or password.',
      'auth/too-many-requests': 'Too many attempts — try again in a few minutes.',
      'auth/popup-closed-by-user': 'Sign-in window was closed.',
      'auth/unauthorized-domain': 'This domain isn\'t authorised in Firebase yet (Authentication → Settings → Authorized domains).',
      'permission-denied': 'That action was blocked by the server rules.',
    };
    return new Error(map[code] || (e && e.message) || 'Something went wrong');
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!G.enabled) { state.ready = true; emit(); return; }
      try {
        const [appMod, authMod, fsMod] = await Promise.all([
          import(`${BASE}/firebase-app.js`), import(`${BASE}/firebase-auth.js`), import(`${BASE}/firebase-firestore.js`),
        ]);
        A = authMod; F = fsMod;
        const app = appMod.initializeApp(fbConfig);
        auth = A.getAuth(app); db = F.getFirestore(app);
        A.onAuthStateChanged(auth, async (u) => {
          state.user = u;
          state.isAdmin = u ? await checkAdmin(u.uid) : false;
          try { state.profile = u ? await loadProfile(u) : null; state.error = null; }
          catch (e) { state.profile = null; state.error = niceError(e).message; console.error(e); }
          state.ready = true; emit();
        });
      } catch (e) {
        console.error('Firebase failed to load', e);
        state.error = 'Packs are temporarily unavailable.'; state.ready = true; emit();
      }
    })();
    return initPromise;
  }

  const userRef = (uid) => F.doc(db, 'users', uid);

  function toProfile(uid, d) {
    const last = ms(d.lastDaily);
    return {
      uid, username: d.username, coins: d.coins || 0, pulled: d.pulled || 0, cards: d.cards || {},
      lastDaily: last, nextDailyAt: last ? last + DAILY_COOLDOWN_MS : 0,
      get canClaimDaily() { return !this.nextDailyAt || Date.now() >= this.nextDailyAt; },
    };
  }

  async function getConfig() {
    const s = await F.getDoc(F.doc(db, 'config', 'gacha'));
    if (!s.exists()) throw new Error('Packs aren\'t set up yet — an admin needs to sync them from the admin console.');
    return s.data();
  }

  async function loadProfile(u) {
    const ref = userRef(u.uid);
    let snap = await F.getDoc(ref);
    if (!snap.exists()) {
      const cfg = await getConfig();
      const username = cleanName(pendingUsername || u.displayName || (u.email || '').split('@')[0]) || `fan${u.uid.slice(0, 6)}`;
      await F.setDoc(ref, {
        username: username.length >= 3 ? username : `${username}fan`.slice(0, 24),
        coins: Number(cfg.startingCoins) || 0, lastDaily: null, pulled: 0, cards: {}, created: F.serverTimestamp(),
      });
      pendingUsername = null;
      snap = await F.getDoc(ref);
    }
    return toProfile(u.uid, snap.data());
  }

  async function refresh() {
    if (!state.user) return null;
    state.profile = await loadProfile(state.user);
    emit();
    return state.profile;
  }

  // ---------------------------------------------------------------- auth
  async function register(username, email, password) {
    await init();
    const name = cleanName(username);
    if (name.length < 3) throw new Error('Username must be 3–24 letters, numbers, _ . or -');
    pendingUsername = name;
    try {
      const cred = await A.createUserWithEmailAndPassword(auth, email, password);
      try { await A.updateProfile(cred.user, { displayName: name }); } catch { /* non-fatal */ }
      return cred.user;
    } catch (e) { pendingUsername = null; throw niceError(e); }
  }
  async function signIn(email, password) {
    await init();
    try { return (await A.signInWithEmailAndPassword(auth, email, password)).user; } catch (e) { throw niceError(e); }
  }
  async function google() {
    await init();
    try { return (await A.signInWithPopup(auth, new A.GoogleAuthProvider())).user; } catch (e) { throw niceError(e); }
  }
  async function resetPassword(email) {
    await init();
    try { await A.sendPasswordResetEmail(auth, email); } catch (e) { throw niceError(e); }
  }
  async function signOut() { await init(); if (auth) await A.signOut(auth); }

  // ---------------------------------------------------------------- gacha
  async function claimDaily() {
    const u = state.user; if (!u) throw new Error('Please sign in');
    const cfg = await getConfig();
    const amount = Number(cfg.dailyCoins) || 0;
    try {
      await F.runTransaction(db, async (tx) => {
        const s = await tx.get(userRef(u.uid));
        const d = s.data();
        const last = ms(d.lastDaily);
        if (last && Date.now() < last + DAILY_COOLDOWN_MS) throw new Error('Already claimed — come back later!');
        tx.update(userRef(u.uid), { coins: (d.coins || 0) + amount, lastDaily: F.serverTimestamp() });
      });
    } catch (e) { throw e.code ? niceError(e) : e; }
    await refresh();
    return amount;
  }

  function rand(n) { // unbiased random int in [0, n)
    const max = Math.floor(0xffffffff / n) * n, buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= max);
    return buf[0] % n;
  }
  function rollRarity(odds, available, minIndex) {
    const pool = RARITIES.filter((r, i) => i >= minIndex && available[r] && available[r].length);
    if (!pool.length) return minIndex > 0 ? rollRarity(odds, available, 0) : null;
    const w = pool.map((r) => Math.max(0, Number(odds && odds[r]) || 0));
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) return pool[rand(pool.length)];
    let roll = (rand(1e6) / 1e6) * total;
    for (let i = 0; i < pool.length; i++) { roll -= w[i]; if (roll < 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  /** Opens a pack. `pack` comes from site.json; price & size are verified against Firestore. */
  async function openPack(pack, activeCards) {
    const u = state.user; if (!u) throw new Error('Please sign in');
    const available = {};
    for (const c of activeCards) (available[c.rarity] = available[c.rarity] || []).push(c);
    if (!activeCards.length) throw new Error('No cards are available yet — check back soon!');
    const gIndex = pack.guaranteed ? RARITIES.indexOf(pack.guaranteed) : -1;
    let result;
    try {
      await F.runTransaction(db, async (tx) => {
        const packSnap = await tx.get(F.doc(db, 'packs', pack.id));
        if (!packSnap.exists() || !packSnap.data().active) throw new Error('This pack isn\'t available right now.');
        const live = packSnap.data();
        const s = await tx.get(userRef(u.uid));
        const d = s.data();
        if ((d.coins || 0) < live.cost) throw new Error(`You need ${live.cost} coins to open this pack`);
        const size = Math.min(Math.max(Number(live.size) || 1, 1), 10);
        const owned = new Set(Object.keys(d.cards || {}).filter((k) => d.cards[k] > 0));
        const cards = { ...(d.cards || {}) };
        const pulls = [];
        for (let i = 0; i < size; i++) {
          const r = rollRarity(pack.odds, available, i === size - 1 && gIndex > 0 ? gIndex : 0);
          const list = available[r];
          const c = list[rand(list.length)];
          pulls.push({ ...c, isNew: !owned.has(c.id) });
          owned.add(c.id);
          cards[c.id] = (cards[c.id] || 0) + 1;
        }
        tx.update(userRef(u.uid), { coins: d.coins - live.cost, pulled: (d.pulled || 0) + size, cards, lastPack: pack.id });
        result = { cards: pulls, coins: d.coins - live.cost };
      });
    } catch (e) { throw e.code ? niceError(e) : e; }
    await refresh();
    return result;
  }

  // ---------------------------------------------------------------- admin helpers
  async function checkAdmin(uid) {
    try { return (await F.getDoc(F.doc(db, 'admins', uid))).exists(); } catch { return false; }
  }
  async function isAdmin() {
    if (!state.user) return false;
    state.isAdmin = await checkAdmin(state.user.uid);
    return state.isAdmin;
  }
  function whenReady() {
    return new Promise((resolve) => {
      if (state.ready) return resolve(state);
      const fn = (st) => { if (st.ready) { listeners.splice(listeners.indexOf(fn), 1); resolve(st); } };
      listeners.push(fn);
    });
  }
  // GitHub connection shared by all admins (readable by admins only — see firestore.rules)
  async function getGithub() { const s = await F.getDoc(F.doc(db, 'secrets', 'github')); return s.exists() ? s.data() : null; }
  async function setGithub(data) { await F.setDoc(F.doc(db, 'secrets', 'github'), { ...data, updated: F.serverTimestamp(), updatedBy: state.user.uid }); }
  async function listAdmins() { return (await F.getDocs(F.collection(db, 'admins'))).docs.map((d) => d.id); }
  async function setAdmin(uid, on) {
    const ref = F.doc(db, 'admins', uid);
    if (on) await F.setDoc(ref, { note: 'granted in admin console', grantedBy: state.user.uid, at: F.serverTimestamp() });
    else await F.deleteDoc(ref);
  }
  /** Mirror pack prices/sizes and the coin economy into Firestore so the rules can enforce them. */
  async function syncCatalog(packs, settings) {
    const existing = await F.getDocs(F.collection(db, 'packs'));
    const batch = F.writeBatch(db);
    const ids = new Set(packs.map((p) => p.id));
    existing.docs.forEach((d) => { if (!ids.has(d.id)) batch.delete(d.ref); });
    packs.forEach((p) => batch.set(F.doc(db, 'packs', p.id), {
      name: p.name || '', cost: Math.max(0, Math.floor(Number(p.cost) || 0)), size: Math.min(Math.max(Math.floor(Number(p.size) || 1), 1), 10), active: !!p.active,
    }));
    batch.set(F.doc(db, 'config', 'gacha'), {
      startingCoins: Math.max(0, Math.floor(Number(settings.starting_coins) || 0)),
      dailyCoins: Math.max(0, Math.floor(Number(settings.daily_coins) || 0)),
    });
    await batch.commit();
  }
  async function listUsers() {
    const snap = await F.getDocs(F.collection(db, 'users'));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data(), lastDaily: ms(d.data().lastDaily), created: ms(d.data().created) }));
  }
  async function setCoins(uid, coins) { await F.updateDoc(userRef(uid), { coins: Math.max(0, Math.floor(Number(coins) || 0)) }); }
  async function deleteFan(uid) { await F.deleteDoc(userRef(uid)); }

  const G = window.Gacha = {
    enabled: !!(fbConfig && fbConfig.apiKey && fbConfig.projectId),
    googleEnabled: !!CFG.googleSignIn,
    get state() { return state; },
    onChange(fn) { listeners.push(fn); if (state.ready) fn(state); },
    init, whenReady, register, signIn, google, resetPassword, signOut, refresh,
    claimDaily, openPack, isAdmin, syncCatalog, listUsers, setCoins, deleteFan,
    getGithub, setGithub, listAdmins, setAdmin,
    DAILY_COOLDOWN_MS,
  };
})();
