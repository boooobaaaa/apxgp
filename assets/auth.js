/*
 * Accounts for the admin console — backed by Firebase Authentication + Firestore.
 * Website accounts are only used to sign in to the admin console; who is an admin
 * is stored in Firestore (/admins). See /firebase/firestore.rules.
 */
'use strict';
(function () {
  const CFG = window.SITE_CONFIG || {};
  const fbConfig = CFG.firebase;
  const BASE = `https://www.gstatic.com/firebasejs/${CFG.firebaseVersion || '12.15.0'}`;

  let A = null, F = null, auth = null, db = null; // auth module, firestore module, instances
  const listeners = [];
  const state = { ready: false, user: null, profile: null, error: null, isAdmin: false };
  let pendingUsername = null;
  let initPromise = null;

  const emit = () => listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : t ? Number(t) : 0);
  const cleanName = (s) => String(s || '').replace(/[^A-Za-z0-9_. -]/g, '').trim().slice(0, 32);

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
      'auth/unauthorized-domain': 'This website address isn\'t authorised in Firebase yet (Authentication → Settings → Authorized domains).',
      'permission-denied': 'That action was blocked by the security rules.',
    };
    return new Error(map[code] || (e && e.message) || 'Something went wrong');
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!Auth.enabled) { state.ready = true; emit(); return; }
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
        state.error = 'Sign-in is temporarily unavailable.'; state.ready = true; emit();
      }
    })();
    return initPromise;
  }

  const userRef = (uid) => F.doc(db, 'users', uid);

  // A small profile doc so admins can see who has an account (and grant admin access).
  async function loadProfile(u) {
    const ref = userRef(u.uid);
    let snap = await F.getDoc(ref);
    if (!snap.exists()) {
      const username = cleanName(pendingUsername || u.displayName || (u.email || '').split('@')[0]) || 'Team member';
      await F.setDoc(ref, { username, email: u.email || '', created: F.serverTimestamp() });
      pendingUsername = null;
      snap = await F.getDoc(ref);
    }
    const d = snap.data();
    return { uid: u.uid, username: d.username, email: d.email };
  }

  async function register(name, email, password) {
    await init();
    const n = cleanName(name);
    if (n.length < 2) throw new Error('Please enter your name');
    pendingUsername = n;
    try {
      const cred = await A.createUserWithEmailAndPassword(auth, email, password);
      try { await A.updateProfile(cred.user, { displayName: n }); } catch { /* non-fatal */ }
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

  function whenReady() {
    return new Promise((resolve) => {
      if (state.ready) return resolve(state);
      const fn = (st) => { if (st.ready) { listeners.splice(listeners.indexOf(fn), 1); resolve(st); } };
      listeners.push(fn);
    });
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
  // GitHub connection shared by all admins (readable by admins only — see firestore.rules)
  async function getGithub() { const s = await F.getDoc(F.doc(db, 'secrets', 'github')); return s.exists() ? s.data() : null; }
  async function setGithub(data) { await F.setDoc(F.doc(db, 'secrets', 'github'), { ...data, updated: F.serverTimestamp(), updatedBy: state.user.uid }); }
  async function listAdmins() { return (await F.getDocs(F.collection(db, 'admins'))).docs.map((d) => d.id); }
  async function setAdmin(uid, on) {
    const ref = F.doc(db, 'admins', uid);
    if (on) await F.setDoc(ref, { note: 'granted in admin console', grantedBy: state.user.uid, at: F.serverTimestamp() });
    else await F.deleteDoc(ref);
  }
  async function listUsers() {
    const snap = await F.getDocs(F.collection(db, 'users'));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data(), created: ms(d.data().created) }));
  }
  async function deleteUser(uid) { await F.deleteDoc(userRef(uid)); }

  const Auth = window.Auth = {
    enabled: !!(fbConfig && fbConfig.apiKey && fbConfig.projectId),
    googleEnabled: !!CFG.googleSignIn,
    get state() { return state; },
    onChange(fn) { listeners.push(fn); if (state.ready) fn(state); },
    init, whenReady, register, signIn, google, resetPassword, signOut,
    isAdmin, getGithub, setGithub, listAdmins, setAdmin, listUsers, deleteUser,
  };
})();
