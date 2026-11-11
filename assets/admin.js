/*
 * Admin console for the GitHub Pages build.
 * Edits are kept in memory; "Publish" writes data/site.json + any new images to the
 * GitHub repository as ONE commit. GitHub Pages then rebuilds the live site (~1 minute).
 */
'use strict';

const A = {
  data: null, baseText: '', baseSha: '', gh: null,
  previews: new Map(),   // path -> blob URL (so new images show before Pages rebuilds)
  pending: new Map(),    // path -> Blob (new images not yet committed)
  dirty: false, section: 'dashboard',
};
const root = $('#admin');
const STAT_FIELDS = [
  { key: 'starts', label: 'Race Starts' }, { key: 'wins', label: 'Wins' }, { key: 'podiums', label: 'Podiums' },
  { key: 'poles', label: 'Pole Positions' }, { key: 'fastest_laps', label: 'Fastest Laps' }, { key: 'points', label: 'Career Points' },
  { key: 'championships', label: 'Championships' }, { key: 'best_finish', label: 'Best Finish' },
  { key: 'avg_finish', label: 'Avg. Finish' }, { key: 'dnfs', label: 'DNFs' },
];
const src = (p) => (p && A.previews.get(p)) || p || '';
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const store = {
  get(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch { return null; } },
  set(k, v, persist) { try { (persist ? localStorage : sessionStorage).setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// ================================================================ GitHub API
const GH = {
  detect() {
    const c = (window.SITE_CONFIG && SITE_CONFIG.github) || {};
    let owner = c.owner || store.get('apx_gh_owner') || '', repo = c.repo || store.get('apx_gh_repo') || '';
    if ((!owner || !repo) && location.hostname.endsWith('.github.io')) {
      owner = owner || location.hostname.split('.')[0];
      const seg = location.pathname.split('/').filter(Boolean)[0];
      repo = repo || (seg && !/\.html?$/.test(seg) ? seg : `${owner}.github.io`);
    }
    return { owner, repo, branch: c.branch || '' };
  },
  async req(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method, cache: 'no-store',
      headers: {
        Authorization: `Bearer ${A.gh.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json()).message; } catch { /* empty */ }
      if (res.status === 401) throw new Error('GitHub rejected the token — it may be wrong or expired.');
      if (res.status === 403 && /rate limit/i.test(msg)) throw new Error('GitHub rate limit reached — wait a few minutes.');
      if (res.status === 403) throw new Error('This token doesn\'t have write access. Give it "Contents: Read and write" on this repository.');
      if (res.status === 404) throw new Error(`Not found on GitHub (${path.split('?')[0]}). Check the owner/repo names and that the token can access this repository.`);
      const err = new Error(msg || `GitHub error ${res.status}`); err.status = res.status; throw err;
    }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  },
  repoPath() { return `/repos/${encodeURIComponent(A.gh.owner)}/${encodeURIComponent(A.gh.repo)}`; },
  async connect() {
    const info = await GH.req(GH.repoPath());
    if (!info.permissions || !info.permissions.push) throw new Error('This token can read the repository but not write to it. Give it "Contents: Read and write".');
    A.gh.branch = A.gh.branch || info.default_branch;
    A.gh.pagesUrl = info.has_pages ? `https://${A.gh.owner}.github.io/${info.name === `${A.gh.owner}.github.io` ? '' : info.name + '/'}` : '';
  },
  async headSha() { return (await GH.req(`${GH.repoPath()}/git/ref/heads/${encodeURIComponent(A.gh.branch)}`)).object.sha; },
  async readFile(path, ref) { return GH.req(`${GH.repoPath()}/contents/${path}?ref=${ref}`, { raw: true }); },
  async load() {
    const sha = await GH.headSha();
    const text = await GH.readFile('data/site.json', sha);
    A.baseSha = sha; A.baseText = text; A.data = JSON.parse(text);
    normalise(A.data);
  },
  blobB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  },
  async publish(message, onStep) {
    A.data._rev = { id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString() };
    const json = JSON.stringify(A.data, null, 2) + '\n';
    onStep('Checking for changes made elsewhere…');
    let head = await GH.headSha();
    if (head !== A.baseSha) {
      const remote = await GH.readFile('data/site.json', head);
      if (remote !== A.baseText && !confirm('The site content was changed somewhere else (another admin, or an edit on GitHub) since you opened the console.\n\nPublish anyway and overwrite those content changes with yours?')) {
        throw new Error('Publish cancelled. Reload the console to get the latest content.');
      }
    }
    const commit = await GH.req(`${GH.repoPath()}/git/commits/${head}`);
    const used = (t) => new Set((t.match(/uploads\/[A-Za-z0-9/_.-]+/g) || []));
    const nowUsed = used(json), wasUsed = used(A.baseText);
    const tree = [];
    let i = 0;
    const toUpload = [...A.pending].filter(([p]) => nowUsed.has(p));
    for (const [path, blob] of toUpload) {
      onStep(`Uploading image ${++i} of ${toUpload.length}…`);
      const b = await GH.req(`${GH.repoPath()}/git/blobs`, { method: 'POST', body: { content: await GH.blobB64(blob), encoding: 'base64' } });
      tree.push({ path, mode: '100644', type: 'blob', sha: b.sha });
    }
    onStep('Saving content…');
    const jb = await GH.req(`${GH.repoPath()}/git/blobs`, { method: 'POST', body: { content: json, encoding: 'utf-8' } });
    tree.push({ path: 'data/site.json', mode: '100644', type: 'blob', sha: jb.sha });
    const removed = [...wasUsed].filter((p) => !nowUsed.has(p));
    const full = await GH.req(`${GH.repoPath()}/git/trees/${commit.tree.sha}?recursive=1`);
    const exists = new Set(full.tree.map((t) => t.path));
    // only delete files that really exist in the current tree
    removed.filter((p) => exists.has(p)).forEach((path) => tree.push({ path, mode: '100644', type: 'blob', sha: null }));
    // .nojekyll makes GitHub Pages publish the files as-is (faster, and avoids Jekyll build failures)
    if (!exists.has('.nojekyll')) {
      const nj = await GH.req(`${GH.repoPath()}/git/blobs`, { method: 'POST', body: { content: '', encoding: 'utf-8' } });
      tree.push({ path: '.nojekyll', mode: '100644', type: 'blob', sha: nj.sha });
    }
    onStep('Creating commit…');
    const newTree = await GH.req(`${GH.repoPath()}/git/trees`, { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
    const newCommit = await GH.req(`${GH.repoPath()}/git/commits`, { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } });
    try {
      await GH.req(`${GH.repoPath()}/git/refs/heads/${encodeURIComponent(A.gh.branch)}`, { method: 'PATCH', body: { sha: newCommit.sha, force: false } });
    } catch (e) {
      if (e.status === 422) throw new Error('Someone else published at the same moment — please press Publish again.');
      throw e;
    }
    A.baseSha = newCommit.sha; A.baseText = json; A.pending.clear();
    return { uploaded: toUpload.length, removed: removed.length, rev: A.data._rev.id };
  },
};

// Fill in missing collections / defaults so older or hand-edited files still work
function normalise(d) {
  d.settings = d.settings || {};
  for (const k of ['members', 'races', 'drivers', 'constructors', 'news', 'media']) d[k] = Array.isArray(d[k]) ? d[k] : [];
  // card packs were removed from the site — tidy away their old data
  delete d.cards; delete d.packs; delete d.settings.starting_coins; delete d.settings.daily_coins;
}

// ================================================================ images
async function processImage(file) {
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) throw new Error(`"${file.name}" isn't a supported image (JPG, PNG, WebP, GIF)`);
  const extOf = (t) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[t]);
  // small enough, or animated GIF: keep the original
  if (file.size <= 1.2 * 1024 * 1024 || file.type === 'image/gif') {
    if (file.size > 15 * 1024 * 1024) throw new Error(`"${file.name}" is too large (max 15 MB)`);
    return { blob: file, ext: extOf(file.type) };
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const want = file.type === 'image/png' ? 'image/webp' : 'image/jpeg'; // webp keeps transparency
  const blob = await new Promise((r) => c.toBlob(r, want, 0.86));
  if (!blob) return { blob: file, ext: extOf(file.type) };
  return { blob, ext: extOf(blob.type) || 'jpg' };
}
async function addImage(file) {
  const { blob, ext } = await processImage(file);
  const path = `uploads/${new Date().getFullYear()}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.${ext}`;
  A.pending.set(path, blob);
  A.previews.set(path, URL.createObjectURL(blob));
  return path;
}

async function addAudio(file) {
  const ok = /^audio\/(mpeg|mp3|mp4|x-m4a|aac|ogg|wav|x-wav|webm)$/.test(file.type) || /\.(mp3|m4a|aac|ogg|oga|wav|webm)$/i.test(file.name);
  if (!ok) throw new Error(`"${file.name}" isn't a supported audio file (MP3, M4A, OGG, WAV)`);
  if (file.size > 20 * 1024 * 1024) throw new Error('That file is over 20 MB — please use a shorter or more compressed MP3 (128–192 kbps works well).');
  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, 'mp3'])[1].toLowerCase();
  const path = `uploads/audio/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.${ext}`;
  A.pending.set(path, file);
  A.previews.set(path, URL.createObjectURL(file));
  return path;
}

// ================================================================ sections
const SECTIONS = {
  dashboard: { title: 'Dashboard', icon: '◧' },
  settings: { title: 'Site settings', icon: '⚙' },
  members: {
    title: 'Team members', icon: '👤', res: 'members', singular: 'member', idp: 'm',
    help: 'Everyone shown on the Team page. Mark drivers so they appear on the home page and in Compare. Sort order controls the carousel order.',
    sort: (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0),
    cols: [['photo', 'thumb'], ['name'], ['role'], ['number', 'No.'], ['is_driver', 'Driver', 'bool'], ['sort', 'Order']],
    fields: () => [
      { k: 'name', label: 'Full name', req: true }, { k: 'role', label: 'Role / title', ph: 'Race Driver, Team Principal…' },
      { k: 'is_driver', label: 'This person is a driver', type: 'check' },
      { k: 'number', label: 'Car number', half: true }, { k: 'sort', label: 'Sort order', type: 'number', half: true },
      { k: 'nationality', label: 'Nationality', half: true }, { k: 'hometown', label: 'Hometown', half: true },
      { k: 'birthdate', label: 'Date of birth', type: 'date', half: true }, { k: 'photo', label: 'Photo', type: 'image' },
      { k: 'instagram', label: 'Instagram URL', half: true }, { k: 'twitter', label: 'X / Twitter URL', half: true },
      { k: 'bio', label: 'Biography', type: 'markdown', rows: 8 },
      { k: 'stats', label: 'Driver stats (used on profile + Compare)', type: 'stats' },
    ],
  },
  races: {
    title: 'Race schedule', icon: '🏁', res: 'races', singular: 'race', idp: 'r',
    help: 'Set status to Completed and add a short result line after each race. The next upcoming race gets a live countdown.',
    sort: (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.round || 0) - (b.round || 0),
    cols: [['round', 'Rnd'], ['name'], ['circuit'], ['date', 'Date', 'date'], ['status', 'Status', 'status'], ['result']],
    fields: () => [
      { k: 'name', label: 'Race name', req: true, ph: 'Italian Grand Prix' }, { k: 'round', label: 'Round', type: 'number', half: true },
      { k: 'status', label: 'Status', type: 'select', half: true, opts: [['upcoming', 'Upcoming'], ['completed', 'Completed']] },
      { k: 'circuit', label: 'Circuit', half: true }, { k: 'country', label: 'Country', half: true },
      { k: 'date', label: 'Race date', type: 'date', half: true }, { k: 'time', label: 'Start time (local)', type: 'time', half: true },
      { k: 'result', label: 'Result summary', ph: 'P1 Mercer · P4 Ruiz' },
    ],
  },
  drivers: {
    title: "Drivers' standings", icon: '🏆', res: 'drivers', singular: 'driver entry', idp: 'd', standings: true,
    help: 'Tick "Our team" on your drivers — they get highlighted on the Standings page.',
    sort: (a, b) => (a.pos || 99) - (b.pos || 99),
    cols: [['pos', 'Pos'], ['driver'], ['team'], ['points', 'Pts'], ['is_ours', 'Our team', 'bool']],
    fields: () => [
      { k: 'driver', label: 'Driver', req: true }, { k: 'team', label: 'Team' },
      { k: 'pos', label: 'Position', type: 'number', half: true }, { k: 'points', label: 'Points', type: 'number', step: 'any', half: true },
      { k: 'is_ours', label: 'Our team (highlight)', type: 'check' },
    ],
  },
  constructors: {
    title: "Constructors' standings", icon: '🏭', res: 'constructors', singular: 'team entry', idp: 't', standings: true,
    help: 'Tick "Our team" on your constructor entry to highlight it.',
    sort: (a, b) => (a.pos || 99) - (b.pos || 99),
    cols: [['pos', 'Pos'], ['team'], ['points', 'Pts'], ['is_ours', 'Our team', 'bool']],
    fields: () => [
      { k: 'team', label: 'Team', req: true },
      { k: 'pos', label: 'Position', type: 'number', half: true }, { k: 'points', label: 'Points', type: 'number', step: 'any', half: true },
      { k: 'is_ours', label: 'Our team (highlight)', type: 'check' },
    ],
  },
  news: {
    title: 'News', icon: '📰', res: 'news', singular: 'article', idp: 'n',
    help: 'Drafts stay hidden on the site. Tick Published to put an article live. Body formatting: ## headings, **bold**, *italic*, - lists, > quotes, [links](https://…) and images via "Insert image".',
    sort: (a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')),
    cols: [['cover', 'thumb'], ['title'], ['published', 'Live', 'bool'], ['published_at', 'Date', 'date'], ['author']],
    fields: () => [
      { k: 'title', label: 'Headline', req: true }, { k: 'excerpt', label: 'Summary (shown on cards)', type: 'textarea', rows: 2 },
      { k: 'cover', label: 'Cover image', type: 'image' },
      { k: 'body', label: 'Article body', type: 'markdown', rows: 14, uploadInsert: true },
      { k: 'author', label: 'Author', half: true }, { k: 'published_at', label: 'Publish date', type: 'datetime-local', half: true },
      { k: 'slug', label: 'URL slug (auto-generated if blank)', half: true },
      { k: 'published', label: 'Published (visible on site)', type: 'check' },
    ],
  },
  media: { title: 'Media library', icon: '🖼', help: 'Add photos for the Media page. Group them with albums — the site shows album filters automatically. Large photos are resized automatically.' },
  fans: { title: 'Admins', icon: '👥', help: 'Who can sign in to this console, and the GitHub connection used for publishing.' },
};

// ================================================================ boot / login
// Two modes:
//  • Firebase configured (normal): admins sign in with their website account. The console
//    checks /admins in Firestore, then uses the GitHub token stored once in /secrets/github.
//  • No Firebase yet: fall back to pasting a GitHub token directly.
const authShell = (inner) => `<div class="admin-auth"><div class="auth-card wide">
  <div class="brand"><img src="brand/apx-gp-logo.png" alt="" class="adm-logo"><span>Admin</span></div>${inner}
  <p class="small center back-link"><a class="muted" href="./">← Back to site</a></p></div></div>`;
const loadingScreen = (msg = '') => { root.innerHTML = `<div class="admin-auth"><div class="center-col"><div class="loading"><span></span></div><p class="muted small">${esc(msg)}</p></div></div>`; };

const TOKEN_HELP = `<details class="help small"><summary>How do I get a token?</summary><ol>
  <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Fine-grained tokens → Generate new token</a>.</li>
  <li>Name it e.g. "APX GP website" and pick the longest expiration you're comfortable with.</li>
  <li><b>Repository access</b> → <i>Only select repositories</i> → choose this site's repository.</li>
  <li><b>Permissions</b> → Repository permissions → <b>Contents: Read and write</b>.</li>
  <li>Generate, copy it and paste it here.</li></ol></details>`;

function boot() {
  if (Auth.enabled) return firebaseBoot();
  const det = GH.detect();
  const token = store.get('apx_gh_token');
  if (token && det.owner && det.repo) { A.gh = { ...det, token }; return connect((err) => tokenScreen(det, err)); }
  tokenScreen(det);
}

let bootUid = null;
async function firebaseBoot() {
  loadingScreen('Checking your account…');
  await Auth.init();
  const st = await Auth.whenReady();
  bootUid = st.user ? st.user.uid : null;
  // re-run whenever the signed-in account changes (sign in / sign out)
  if (!firebaseBoot.watching) {
    firebaseBoot.watching = true;
    Auth.onChange((s) => { const id = s.user ? s.user.uid : null; if (id !== bootUid && !A.data) firebaseBoot(); });
  }
  if (!st.user) return adminSignIn();
  if (!(await Auth.isAdmin())) return notAdminScreen(st.user);
  let gh = null;
  try { gh = await Auth.getGithub(); } catch (e) { console.error(e); }
  const det = GH.detect();
  if (!gh || !gh.token) return githubSetup(det);
  A.gh = { owner: gh.owner || det.owner, repo: gh.repo || det.repo, branch: gh.branch || det.branch, token: gh.token };
  connect((err) => githubSetup({ owner: A.gh.owner, repo: A.gh.repo, branch: A.gh.branch }, err));
}

function adminSignIn(error = '', mode = 'login') {
  const reg = mode === 'register';
  root.innerHTML = authShell(`<h2>${reg ? 'Create an account' : 'Admin sign in'}</h2>
    <p class="muted small">${reg ? 'Create an account, then ask an existing admin to switch on admin access for you.' : 'Sign in with your APX GP account. Only accounts that have been given admin access can open the console.'}</p>
    ${error ? `<div class="alert">${esc(error)}</div>` : ''}
    <form id="f">${reg ? '<label>Your name<input name="name" required maxlength="32" autocomplete="name"></label>' : ''}
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <label>Password<input name="password" type="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
    <button class="btn btn-primary btn-block">${reg ? 'Create account' : 'Sign in'}</button>
    ${Auth.googleEnabled ? '<button type="button" class="btn btn-ghost btn-block google-btn" id="g">Continue with Google</button>' : ''}</form>
    <p class="small muted center">${reg ? 'Already have an account?' : 'No account yet?'} <button type="button" class="link-btn" id="swap">${reg ? 'Sign in' : 'Create account'}</button>
    ${reg ? '' : ' · <button type="button" class="link-btn" id="forgot">Forgot password?</button>'}</p>`);
  $('#swap').onclick = () => adminSignIn('', reg ? 'login' : 'register');
  $('#forgot')?.addEventListener('click', async () => {
    const email = $('#f').email.value.trim();
    if (!email) return toast('Type your email first', 'err');
    try { await Auth.resetPassword(email); toast('Password reset email sent', 'ok'); } catch (err) { toast(err.message, 'err'); }
  });
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, b = $('#f button.btn-primary'); b.disabled = true; b.textContent = reg ? 'Creating…' : 'Signing in…';
    try {
      if (reg) await Auth.register(f.name.value, f.email.value.trim(), f.password.value);
      else await Auth.signIn(f.email.value.trim(), f.password.value);
    } catch (err) { adminSignIn(err.message, mode); }
  };
  $('#g')?.addEventListener('click', async () => { try { await Auth.google(); } catch (err) { adminSignIn(err.message, mode); } });
}

function notAdminScreen(user) {
  root.innerHTML = authShell(`<h2>No admin access</h2>
    <p class="small">You're signed in as <b>${esc(user.email || user.uid)}</b>, but this account hasn't been given admin access.</p>
    <p class="small muted">Ask an existing admin to open <b>Admins</b> in the console and switch on "Admin" next to your name.</p>
    <details class="help small"><summary>Setting up the very first admin?</summary>
      <p>In the Firebase console → <b>Firestore Database</b> → <b>Start collection</b> <code>admins</code> → Document ID:</p>
      <div class="uid-box"><code id="uid">${esc(user.uid)}</code><button class="btn btn-sm btn-ghost" id="cpy" type="button">Copy</button></div>
      <p>Add a field <code>note</code> = <code>owner</code>, save, then reload this page.</p></details>
    <button class="btn btn-ghost btn-block" id="so">Sign in with a different account</button>`);
  $('#cpy').onclick = () => navigator.clipboard?.writeText(user.uid).then(() => toast('Copied', 'ok'));
  $('#so').onclick = () => Auth.signOut();
}

function githubSetup(det, error = '') {
  root.innerHTML = authShell(`<h2>Connect GitHub <span class="pill">one-time</span></h2>
    <p class="muted small">The console publishes your changes to the GitHub repository that hosts the site. Paste a token once — it's stored securely in Firebase (only admins can read it), so you and other admins won't be asked again.</p>
    ${error ? `<div class="alert">${esc(error)}</div>` : ''}
    <form id="f"><div class="fgrid">
      <label class="field half">GitHub username / org<input name="owner" required value="${esc(det.owner || '')}"></label>
      <label class="field half">Repository name<input name="repo" required value="${esc(det.repo || '')}"></label></div>
    <label>Access token<input name="token" type="password" required autocomplete="off" placeholder="github_pat_…"></label>
    <button class="btn btn-primary btn-block">Connect &amp; save</button></form>
    ${TOKEN_HELP}
    <button class="link-btn small" id="so" type="button">Sign out</button>`);
  $('#so').onclick = () => Auth.signOut();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    A.gh = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: det.branch || '', token: f.token.value.trim() };
    loadingScreen('Connecting to GitHub…');
    try {
      await GH.connect();
      await Auth.setGithub({ owner: A.gh.owner, repo: A.gh.repo, token: A.gh.token });
      await GH.load();
      shell();
      toast('GitHub connected — saved for all admins', 'ok');
    } catch (err) { githubSetup(A.gh, err.message); }
  };
}

function tokenScreen(det, error = '') {
  root.innerHTML = authShell(`<h2>Connect to GitHub</h2>
    <p class="muted small">Firebase isn't set up yet, so the console needs a GitHub token directly. Once Firebase is added (README Step 4) you'll sign in with your website account instead.</p>
    ${error ? `<div class="alert">${esc(error)}</div>` : ''}
    <form id="f"><div class="fgrid">
      <label class="field half">GitHub username / org<input name="owner" required value="${esc(det.owner || '')}"></label>
      <label class="field half">Repository name<input name="repo" required value="${esc(det.repo || '')}"></label></div>
    <label>Access token<input name="token" type="password" required autocomplete="off" placeholder="github_pat_…"></label>
    <label class="field check"><input type="checkbox" name="remember" checked> Remember on this device</label>
    <button class="btn btn-primary btn-block">Connect</button></form>
    ${TOKEN_HELP}`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    A.gh = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: det.branch || '', token: f.token.value.trim() };
    store.set('apx_gh_owner', A.gh.owner, true); store.set('apx_gh_repo', A.gh.repo, true);
    store.del('apx_gh_token'); store.set('apx_gh_token', A.gh.token, f.remember.checked);
    connect((err) => tokenScreen(A.gh, err));
  };
}

async function connect(onFail) {
  loadingScreen('Loading site content…');
  try {
    await GH.connect();
    await GH.load();
    shell();
  } catch (e) { onFail(e.message); }
}

function applyTheme() {
  const r = document.documentElement.style, s = A.data.settings;
  r.setProperty('--accent', s.primary_color || '#857452');
  r.setProperty('--accent-2', s.secondary_color || '#c9b98f');
  if (s.background_color) r.setProperty('--bg', s.background_color);
}
const brandHtml = () => safeUrl(A.data.settings.logo)
  ? `<img src="${esc(src(A.data.settings.logo))}" alt="" class="adm-logo">`
  : `<span class="brand-mark">${esc((A.data.settings.short_name || 'T')[0])}</span><span>${esc(A.data.settings.short_name)}</span>`;

function shell() {
  applyTheme();
  const site = A.gh.pagesUrl || './';
  root.innerHTML = `<div class="adm">
    <aside class="adm-side">
      <a class="brand" href="${esc(site)}" target="_blank" title="View site">${brandHtml()}</a>
      <nav id="side">${Object.entries(SECTIONS).map(([k, s]) => `<a href="#${k}" data-s="${k}"><i>${s.icon}</i>${s.title}</a>`).join('')}</nav>
      <div id="liveStatus" class="live-status"></div>
      <div class="adm-user"><span class="muted small">${Auth.enabled ? 'Signed in as' : 'Connected to'}</span><b>${esc(Auth.enabled ? (Auth.state.profile?.username || Auth.state.user?.email || '') : `${A.gh.owner}/${A.gh.repo}`)}</b>
        <div class="adm-user-actions"><a class="btn btn-sm btn-ghost" href="${esc(site)}" target="_blank">View site ↗</a><button class="btn btn-sm btn-ghost" id="out">Sign out</button></div></div>
    </aside>
    <main class="adm-main" id="main"></main>
    <div class="publish-bar" id="pubBar" hidden>
      <span><b>Unpublished changes</b> <span class="muted small">— visitors won't see them until you publish</span></span>
      <span class="grow"></span>
      <button class="btn btn-ghost btn-sm" id="discard">Discard</button>
      <button class="btn btn-primary" id="publish">Publish to site</button>
    </div>
    <div class="drawer" id="drawer" hidden><div class="drawer-bg"></div><div class="drawer-panel" id="drawerPanel"></div></div>
  </div>`;
  $('#out').onclick = async () => {
    if (A.dirty && !confirm('Discard unpublished changes and sign out?')) return;
    A.dirty = false;
    if (Auth.enabled) await Auth.signOut(); else store.del('apx_gh_token');
    location.reload();
  };
  $('#publish').onclick = publish;
  $('#discard').onclick = () => {
    if (!confirm('Throw away all unpublished changes?')) return;
    A.data = JSON.parse(A.baseText); normalise(A.data); A.pending.clear(); setDirty(false); applyTheme(); route();
  };
  checkLiveOnOpen();
  setInterval(renderLive, 1000);
  window.onhashchange = route;
  window.onbeforeunload = (e) => { if (A.dirty) { e.preventDefault(); e.returnValue = ''; } };
  route();
}

// ---------------------------------------------------------------- live-site status
// After publishing, GitHub Pages needs to redeploy. We poll the live data file and report.
const LIVE = { timer: null, state: 'unknown', since: 0, rev: '' };
const ghLinks = () => ({
  actions: `https://github.com/${encodeURIComponent(A.gh.owner)}/${encodeURIComponent(A.gh.repo)}/actions`,
  pages: `https://github.com/${encodeURIComponent(A.gh.owner)}/${encodeURIComponent(A.gh.repo)}/settings/pages`,
});
async function liveRev() {
  // admin.html lives next to index.html, so this reads exactly what visitors get
  const r = await fetch(`data/site.json?live=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d._rev ? d._rev.id : '';
}
function renderLive() {
  const el = $('#liveStatus'); if (!el) return;
  const secs = Math.round((Date.now() - LIVE.since) / 1000);
  const t = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const L = ghLinks();
  el.className = `live-status ls-${LIVE.state}`;
  el.innerHTML = {
    unknown: '',
    live: '<b>● Live site is up to date</b>',
    deploying: `<b>◌ Updating live site… ${t}</b><span>GitHub Pages usually takes 1–3 minutes.</span>`,
    stuck: `<b>⚠ Live site hasn't updated after ${t}</b><span>Your changes are saved on GitHub, but Pages hasn't deployed them. Check the <a href="${L.actions}" target="_blank" rel="noopener">Actions tab</a> for a failed "pages build and deployment" run, and that <a href="${L.pages}" target="_blank" rel="noopener">Settings → Pages</a> is set to <i>Deploy from a branch → main → / (root)</i>.</span>`,
    offline: `<b>⚠ Couldn't read the live site</b><span>Open the console from your live site address to see deploy status.</span>`,
  }[LIVE.state];
}
function watchLive(rev) {
  clearInterval(LIVE.timer);
  LIVE.rev = rev; LIVE.since = Date.now(); LIVE.state = 'deploying'; renderLive();
  const tick = async () => {
    try {
      const now = await liveRev();
      if (now === LIVE.rev) { LIVE.state = 'live'; clearInterval(LIVE.timer); toast('Your changes are now live on the site ✓', 'ok'); }
      else if (Date.now() - LIVE.since > 6 * 60e3) LIVE.state = 'stuck';
    } catch { LIVE.state = 'offline'; clearInterval(LIVE.timer); }
    renderLive();
  };
  LIVE.timer = setInterval(tick, 8000);
  setTimeout(tick, 4000);
}
async function checkLiveOnOpen() {
  const repoRev = A.data._rev ? A.data._rev.id : '';
  try {
    const live = await liveRev();
    if (live === repoRev) { LIVE.state = 'live'; renderLive(); }
    else watchLive(repoRev);
  } catch { LIVE.state = 'offline'; renderLive(); }
}

function setDirty(v = true) { A.dirty = v; const b = $('#pubBar'); if (b) b.hidden = !v; document.body.classList.toggle('has-pubbar', v); }

async function publish() {
  const btn = $('#publish');
  const msg = prompt('Short description of your changes (for the history):', 'Update site content');
  if (msg === null) return;
  btn.disabled = true;
  try {
    const r = await GH.publish(msg || 'Update site content', (s) => (btn.textContent = s));
    setDirty(false);
    toast(`Saved to GitHub${r.uploaded ? ` (${r.uploaded} file${r.uploaded > 1 ? 's' : ''} uploaded)` : ''} — the live site updates in 1–3 minutes. Watch the status in the sidebar.`, 'ok');
    watchLive(r.rev);
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = 'Publish to site';
}

function route() {
  const key = location.hash.slice(1) || 'dashboard';
  A.section = SECTIONS[key] ? key : 'dashboard';
  $$('#side a').forEach((a) => a.classList.toggle('on', a.dataset.s === A.section));
  closeDrawer();
  const main = $('#main');
  try {
    const s = SECTIONS[A.section];
    if (A.section === 'dashboard') dashboard(main);
    else if (A.section === 'settings') settingsView(main);
    else if (A.section === 'media') mediaView(main);
    else if (A.section === 'fans') fansView(main);
    else listView(main, s);
  } catch (e) { console.error(e); main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

const head = (s, actions = '') => `<div class="adm-head"><div><h1>${s.title}</h1>${s.help ? `<p class="muted small">${esc(s.help)}</p>` : ''}</div><div class="adm-actions">${actions}</div></div>`;

// ================================================================ dashboard
function dashboard(main) {
  const d = A.data;
  const drafts = d.news.filter((n) => !n.published).length;
  const tiles = [['members', 'Team members', d.members.length], ['races', 'Races', d.races.length],
    ['news', 'Articles', `${d.news.length}${drafts ? ` <small>(${drafts} draft${drafts > 1 ? 's' : ''})</small>` : ''}`],
    ['media', 'Photos', d.media.length]];
  main.innerHTML = `${head({ title: 'Dashboard' })}
  <div class="dash-tiles">${tiles.map(([k, l, v]) => `<a class="dash-tile" href="#${k}"><b>${v}</b><span>${l}</span></a>`).join('')}</div>
  <div class="dash-cols">
    <div class="panel"><h3>Quick actions</h3><div class="quick">
      <button class="btn btn-primary" data-go="news">Write an article</button>
      <a class="btn btn-ghost" href="#media">Add photos</a>
      <a class="btn btn-ghost" href="#races">Update race results</a>
      <a class="btn btn-ghost" href="#drivers">Update standings</a>
    </div></div>
    <div class="panel"><h3>How publishing works</h3><ol class="small checklist">
      <li>Make as many edits as you like — they're kept in this browser tab.</li>
      <li>Press <b>Publish to site</b> (bottom bar). Everything is saved to GitHub as one commit.</li>
      <li>GitHub Pages rebuilds the live site in about a minute.</li>
      <li>Every publish is in your repository history, so nothing is ever lost.</li>
    </ol>
</div>
  </div>`;
  $$('[data-go]', main).forEach((b) => (b.onclick = () => { location.hash = b.dataset.go; setTimeout(() => openForm(SECTIONS[b.dataset.go], null), 50); }));
}

// ================================================================ settings
function settingsView(main) {
  const s = A.data.settings;
  const groups = [
    ['Identity', [{ k: 'team_name', label: 'Team name', req: true }, { k: 'short_name', label: 'Short name / abbreviation', half: true }, { k: 'season', label: 'Season', half: true },
      { k: 'tagline', label: 'Tagline' },
      { k: 'primary_color', label: 'Accent colour (buttons, highlights)', type: 'color', half: true }, { k: 'secondary_color', label: 'Secondary accent (best stats, progress)', type: 'color', half: true },
      { k: 'background_color', label: 'Background colour (panels are derived from it)', type: 'color', half: true }]],
    ['Images', [{ k: 'logo', label: 'Logo (white/transparent works best)', type: 'image' }, { k: 'hero_image', label: 'Home page hero image', type: 'image' }]],
    ['About', [{ k: 'about', label: 'About the team (home page)', type: 'markdown', rows: 6 }]],
    ['Social links', [{ k: 'instagram', label: 'Instagram URL', half: true }, { k: 'twitter', label: 'X / Twitter URL', half: true }, { k: 'youtube', label: 'YouTube URL', half: true }, { k: 'twitch', label: 'Twitch URL', half: true }]],
    ['Background music', [{ k: 'music_file', label: 'Music file (loops on the site; visitors can mute it)', type: 'audio' },
      { k: 'music_volume', label: 'Volume (0–100)', type: 'number', half: true, def: 35 },
      { k: 'music_title', label: 'Track name (shown on hover, optional)', half: true }]],
  ];
  main.innerHTML = `${head(SECTIONS.settings, '<span class="muted small">Changes apply as you type — press <b>Publish to site</b> when ready.</span>')}
    <form id="sf" class="settings-form">${groups.map(([t, fs]) => `<fieldset class="panel"><legend>${t}</legend><div class="fgrid">${fs.map((f) => fieldHtml(f, s[f.k])).join('')}</div></fieldset>`).join('')}</form>`;
  const fields = groups.flatMap((g) => g[1]);
  const save = () => {
    const vals = collect($('#sf'), fields.map((f) => ({ ...f, req: false })));
    const before = JSON.stringify(A.data.settings);
    Object.assign(A.data.settings, vals);
    if (JSON.stringify(A.data.settings) !== before) { applyTheme(); setDirty(); $('.adm-side .brand').innerHTML = brandHtml(); }
  };
  wireFields($('#sf'), save);
  $('#sf').addEventListener('change', save);
  $('#sf').onsubmit = (e) => { e.preventDefault(); save(); };
}

// ================================================================ generic list
function listView(main, s) {
  const rows = s.sort ? [...A.data[s.res]].sort(s.sort) : A.data[s.res];
  let actions = `<button class="btn btn-primary" id="new">+ New ${s.singular}</button>`;
  if (s.standings) actions = `<button class="btn btn-ghost" id="reorder" title="Re-number positions by points">Auto-rank by points</button>` + actions;

  const body = rows.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr>${s.cols.map(([k, l]) => `<th class="${l === 'thumb' ? 'th-thumb' : ''}">${l === 'thumb' ? '' : esc(l || k[0].toUpperCase() + k.slice(1))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${s.cols.map(([k, l, t]) => `<td>${cell(r[k], l === 'thumb' ? 'thumb' : t)}</td>`).join('')}
        <td class="row-actions"><button class="btn btn-sm btn-ghost" data-edit="${esc(r.id)}">Edit</button><button class="btn btn-sm btn-ghost danger" data-del="${esc(r.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty panel">Nothing here yet. <button class="btn btn-primary btn-sm" id="new2">Add the first ${s.singular}</button></div>`;
  main.innerHTML = head(s, actions) + body;
  $('#new').onclick = () => openForm(s, null);
  $('#new2')?.addEventListener('click', () => openForm(s, null));
  $$('[data-edit]', main).forEach((b) => (b.onclick = () => openForm(s, A.data[s.res].find((r) => r.id === b.dataset.edit))));
  $$('[data-del]', main).forEach((b) => (b.onclick = () => {
    const list = A.data[s.res], r = list.find((x) => x.id === b.dataset.del);
    if (!confirm(`Delete "${r.name || r.title || r.driver || r.team}"?`)) return;
    list.splice(list.indexOf(r), 1);
    setDirty(); toast('Deleted — publish to make it live', 'ok'); route();
  }));
  $('#reorder')?.addEventListener('click', () => {
    [...A.data[s.res]].sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0)).forEach((r, i) => (r.pos = i + 1));
    setDirty(); toast('Positions updated', 'ok'); route();
  });
}

function cell(v, type) {
  if (type === 'thumb') return `<div class="thumb" ${safeUrl(v) ? `style="background-image:url('${esc(src(v))}')"` : ''}></div>`;
  if (type === 'bool') return v ? '<span class="yes">✓</span>' : '<span class="muted">—</span>';
  if (type === 'date') return esc(fmtDate(v));
  if (type === 'status') return `<span class="pill ${v === 'completed' ? '' : 'pill-up'}">${esc(v || 'upcoming')}</span>`;
  const s = String(v ?? '');
  return esc(s.length > 60 ? s.slice(0, 60) + '…' : s);
}

// ================================================================ forms
function fieldHtml(f, v) {
  const id = `f_${f.k}`;
  const cls = `field ${f.half ? 'half' : ''} ${f.type === 'check' ? 'check' : ''}`;
  const val = v ?? f.def ?? '';
  const lab = `${esc(f.label)}${f.req ? ' <span class="req">*</span>' : ''}`;
  switch (f.type) {
    case 'textarea': return `<label class="${cls}">${lab}<textarea id="${id}" name="${f.k}" rows="${f.rows || 4}">${esc(val)}</textarea></label>`;
    case 'markdown': return `<div class="${cls}"><div class="md-head"><label for="${id}">${lab}</label><div class="md-tools">
        ${f.uploadInsert ? `<label class="btn btn-sm btn-ghost">+ Insert image<input type="file" accept="image/*" data-insert="${id}" hidden></label>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-preview="${id}">Preview</button></div></div>
        <textarea id="${id}" name="${f.k}" rows="${f.rows || 6}">${esc(val)}</textarea><div class="md-preview prose" id="${id}_pv" hidden></div></div>`;
    case 'check': return `<label class="${cls}"><input type="checkbox" id="${id}" name="${f.k}" ${val === true || Number(val) ? 'checked' : ''}> ${lab}</label>`;
    case 'select': return `<label class="${cls}">${lab}<select id="${id}" name="${f.k}">${f.opts.map(([o, l]) => `<option value="${esc(o)}" ${String(o) === String(val ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    case 'color': return `<label class="${cls}">${lab}<div class="color-row"><input type="color" id="${id}" name="${f.k}" value="${esc(val || '#857452')}"><code>${esc(val)}</code></div></label>`;
    case 'image': return `<div class="${cls} img-field" data-k="${f.k}"><span class="flabel">${lab}</span>
        <div class="img-row"><div class="img-prev" ${safeUrl(val) ? `style="background-image:url('${esc(src(val))}')"` : ''}>${val ? '' : '<span>No image</span>'}</div>
        <div class="img-ctrls"><label class="btn btn-sm btn-ghost">Choose image<input type="file" accept="image/*" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost danger" data-clear ${val ? '' : 'hidden'}>Remove</button>
          <input type="text" name="${f.k}" value="${esc(val)}" placeholder="…or paste an image URL"></div></div></div>`;
    case 'audio': return `<div class="${cls} audio-field img-field-like"><span class="flabel">${lab}</span>
        <div class="img-ctrls"><label class="btn btn-sm btn-ghost">Choose audio file<input type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost danger" data-clear ${val ? '' : 'hidden'}>Remove music</button>
          <input type="text" name="${f.k}" value="${esc(val)}" placeholder="No music — choose a file" readonly></div>
        <audio controls preload="none" ${val ? `src="${esc(src(val))}"` : 'hidden'}></audio></div>`;
    case 'stats': {
      const st = (v && typeof v === 'object') ? v : {};
      return `<fieldset class="field sub-fs"><legend>${esc(f.label)}</legend><div class="stats-grid">${STAT_FIELDS.map((s) =>
        `<label>${esc(s.label)}<input type="number" step="any" data-stat="${s.key}" value="${esc(st[s.key] ?? '')}"></label>`).join('')}</div></fieldset>`;
    }
    default: return `<label class="${cls}">${lab}<input type="${f.type || 'text'}" id="${id}" name="${f.k}" value="${esc(val)}" ${f.step ? `step="${f.step}"` : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.req ? 'required' : ''}></label>`;
  }
}

function wireFields(form, onChange) {
  $$('.img-field', form).forEach((w) => {
    const input = $('input[type=text]', w), prev = $('.img-prev', w), clear = $('[data-clear]', w);
    const set = (path) => {
      input.value = path;
      prev.style.backgroundImage = safeUrl(path) ? `url('${src(path)}')` : '';
      prev.innerHTML = path ? '' : '<span>No image</span>'; clear.hidden = !path; onChange?.();
    };
    $('input[type=file]', w).onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      prev.innerHTML = '<span>Processing…</span>';
      try { set(await addImage(file)); } catch (err) { toast(err.message, 'err'); set(input.value); }
      e.target.value = '';
    };
    clear.onclick = () => set('');
    input.oninput = () => set(input.value.trim());
  });
  $$('.audio-field', form).forEach((w) => {
    const input = $('input[type=text]', w), player = $('audio', w), clear = $('[data-clear]', w);
    const set = (path) => { input.value = path; player.hidden = !path; if (path) player.src = src(path); else player.removeAttribute('src'); clear.hidden = !path; onChange?.(); };
    $('input[type=file]', w).onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { set(await addAudio(file)); toast('Music added — press Publish to put it live', 'ok'); } catch (err) { toast(err.message, 'err'); }
      e.target.value = '';
    };
    clear.onclick = () => set('');
  });
  $$('[data-preview]', form).forEach((b) => (b.onclick = () => {
    const ta = $('#' + b.dataset.preview, form), pv = $('#' + b.dataset.preview + '_pv', form);
    const showing = !pv.hidden;
    pv.hidden = showing; ta.hidden = !showing; b.textContent = showing ? 'Preview' : 'Edit';
    if (!showing) {
      pv.innerHTML = md(ta.value) || '<p class="muted">Nothing to preview.</p>';
      $$('img', pv).forEach((im) => { const p = im.getAttribute('src'); if (A.previews.has(p)) im.src = A.previews.get(p); });
    }
  }));
  $$('[data-insert]', form).forEach((inp) => (inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const path = await addImage(file), ta = $('#' + inp.dataset.insert, form);
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + `\n\n![](${path})\n\n` + ta.value.slice(pos);
      toast('Image inserted', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    inp.value = '';
  }));
  $$('input[type=color]', form).forEach((c) => (c.oninput = () => (c.nextElementSibling.textContent = c.value)));
  if (onChange) form.addEventListener('input', onChange);
}

function collect(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'stats') { out[f.k] = {}; $$('[data-stat]', form).forEach((i) => { if (i.value !== '') out[f.k][i.dataset.stat] = Number(i.value); }); continue; }
    const el = form.elements[f.k];
    if (!el) continue;
    if (f.type === 'check') out[f.k] = el.checked;
    else if (f.type === 'number') out[f.k] = el.value === '' ? null : Number(el.value);
    else out[f.k] = el.value.trim();
    if (f.req && !out[f.k]) throw new Error(`${f.label} is required`);
  }
  return out;
}

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'post';

function openForm(s, row) {
  const fields = s.fields();
  const panel = $('#drawerPanel');
  panel.innerHTML = `<form id="ef" novalidate>
    <div class="drawer-head"><h2>${row ? 'Edit' : 'New'} ${esc(s.singular)}</h2><button type="button" class="x" id="dx" aria-label="Close">×</button></div>
    <div class="drawer-body"><div class="fgrid">${fields.map((f) => fieldHtml(f, row?.[f.k])).join('')}</div></div>
    <div class="drawer-foot"><span class="grow"></span><button type="button" class="btn btn-ghost" id="dc">Cancel</button><button class="btn btn-primary">Done</button></div>
  </form>`;
  const form = $('#ef');
  wireFields(form);
  $('#drawer').hidden = false; document.body.classList.add('modal-open');
  setTimeout(() => form.querySelector('input:not([type=hidden]):not([type=file]):not([type=checkbox]),textarea')?.focus(), 50);
  $('#dx').onclick = $('#dc').onclick = closeDrawer;
  $('.drawer-bg').onclick = closeDrawer;
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      const body = collect(form, fields);
      for (const k of Object.keys(body)) if (body[k] === null || body[k] === '') delete body[k];
      if (s.res === 'news') {
        let base = slugify(body.slug || body.title), slug = base, i = 2;
        while (A.data.news.some((n) => n.slug === slug && n.id !== row?.id)) slug = `${base}-${i++}`;
        body.slug = slug;
        if (body.published && !body.published_at) body.published_at = new Date().toISOString().slice(0, 16);
      }
      if (row) {
        for (const f of fields) if (!(f.k in body) && f.type !== 'stats') delete row[f.k];
        Object.assign(row, body);
      } else A.data[s.res].push({ id: newId(s.idp), ...body });
      setDirty(); closeDrawer(); route();
      toast('Saved — press Publish to put it live', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}
function closeDrawer() { const d = $('#drawer'); if (d) d.hidden = true; document.body.classList.remove('modal-open'); }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ================================================================ media
function mediaView(main) {
  const items = A.data.media;
  const albums = [...new Set(items.map((m) => m.album).filter(Boolean))];
  main.innerHTML = `${head(SECTIONS.media)}
  <div class="panel upload-zone" id="drop">
    <div><b>Drop photos here</b> or <label class="link-like">browse<input type="file" accept="image/*" multiple hidden id="pick"></label></div>
    <label class="album-in">Album (optional)<input list="albums" id="albumIn" placeholder="e.g. Monza 2026"><datalist id="albums">${albums.map((a) => `<option value="${esc(a)}">`).join('')}</datalist></label>
    <div class="up-progress small muted" id="prog"></div>
  </div>
  <div class="adm-media">${items.map((m) => `<div class="adm-m" data-id="${esc(m.id)}">
    <img src="${esc(src(m.file))}" alt="" loading="lazy">
    <input data-f="caption" value="${esc(m.caption || '')}" placeholder="Caption">
    <input data-f="album" value="${esc(m.album || '')}" placeholder="Album" list="albums">
    <div class="adm-m-actions"><button class="btn btn-sm btn-ghost" data-copy="${esc(m.file)}">Copy path</button><button class="btn btn-sm btn-ghost danger" data-del>Delete</button></div>
  </div>`).join('') || '<p class="muted">No photos yet.</p>'}</div>`;

  const add = async (files) => {
    files = [...files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const album = $('#albumIn').value.trim();
    let done = 0;
    for (const f of files) {
      $('#prog').textContent = `Processing ${done + 1} of ${files.length}…`;
      try {
        const path = await addImage(f);
        A.data.media.unshift({ id: newId('g'), file: path, caption: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), ...(album ? { album } : {}) });
        done++;
      } catch (e) { toast(e.message, 'err'); }
    }
    if (done) setDirty();
    toast(`Added ${done} photo${done === 1 ? '' : 's'} — press Publish to upload them`, 'ok'); route();
  };
  $('#pick').onchange = (e) => add(e.target.files);
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => add(e.dataTransfer.files));
  $$('.adm-m').forEach((el) => {
    const m = A.data.media.find((x) => x.id === el.dataset.id);
    $$('input[data-f]', el).forEach((i) => (i.onchange = () => { const v = i.value.trim(); if (v) m[i.dataset.f] = v; else delete m[i.dataset.f]; setDirty(); }));
    $('[data-del]', el).onclick = () => { if (!confirm('Delete this photo?')) return; A.data.media.splice(A.data.media.indexOf(m), 1); setDirty(); el.remove(); toast('Deleted — publish to remove it from the site', 'ok'); };
    $('[data-copy]', el).onclick = (e) => navigator.clipboard?.writeText(e.target.dataset.copy).then(() => toast('Path copied — paste it into any image field', 'ok'), () => toast(e.target.dataset.copy));
  });
}

// ================================================================ admins (Firebase)
async function fansView(main) {
  if (!Auth.enabled) {
    main.innerHTML = `${head(SECTIONS.fans)}<div class="panel"><h3>Firebase isn't connected yet</h3>
      <p class="small">Admin logins need a free Firebase project. Follow <b>Step 3</b> in the README, then paste your Firebase config into <code>config.js</code>.</p></div>`;
    return;
  }
  main.innerHTML = `${head(SECTIONS.fans)}<div class="loading"><span></span></div>`;
  let users = [], admins = [];
  try { [users, admins] = await Promise.all([Auth.listUsers(), Auth.listAdmins()]); } catch (e) { toast(e.message, 'err'); }
  const adminSet = new Set(admins);
  const me = Auth.state.user.uid;
  users.sort((a, b) => (adminSet.has(b.uid) - adminSet.has(a.uid)) || (b.created || 0) - (a.created || 0));
  main.innerHTML = `${head(SECTIONS.fans)}
    <div class="dash-cols fans-top">
      <div class="panel"><h3>Adding an admin</h3><ol class="small checklist">
        <li>They open <b>Admin Console</b> (footer of the site) and choose <b>Create account</b>.</li>
        <li>Their name appears in the list below — switch on <b>Admin</b>.</li>
        <li>They reload the console and they're in.</li></ol></div>
      <div class="panel"><h3>GitHub connection</h3><p class="small muted">Publishing goes to <b>${esc(A.gh.owner)}/${esc(A.gh.repo)}</b>. If the token expires, paste a new one here.</p>
        <button class="btn btn-ghost btn-sm" id="newTok">Replace GitHub token</button></div>
    </div>
    ${users.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Email</th><th>Admin</th><th>Joined</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr data-uid="${esc(u.uid)}">
      <td><b>${esc(u.username || '—')}</b>${u.uid === me ? ' <span class="pill">you</span>' : ''}</td>
      <td class="muted small">${esc(u.email || '')}</td>
      <td><label class="switch sm"><input type="checkbox" class="adm-toggle" ${adminSet.has(u.uid) ? 'checked' : ''} ${u.uid === me ? 'disabled' : ''}><span class="switch-ui"></span></label></td>
      <td class="muted small">${u.created ? esc(fmtDate(new Date(u.created).toISOString().slice(0, 10))) : '—'}</td>
      <td class="row-actions">${u.uid === me ? '' : '<button class="btn btn-sm btn-ghost danger" data-del>Remove</button>'}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty panel">No accounts yet.</div>'}`;
  $('#newTok').onclick = () => {
    if (A.dirty && !confirm('You have unpublished changes. Replacing the token reloads the console and discards them. Continue?')) return;
    A.dirty = false; A.data = null; githubSetup({ owner: A.gh.owner, repo: A.gh.repo, branch: A.gh.branch });
  };
  $$('tr[data-uid]', main).forEach((tr) => {
    const uid = tr.dataset.uid, name = $('b', tr).textContent;
    $('.adm-toggle', tr).onchange = async (e) => {
      const on = e.target.checked;
      if (on && !confirm(`Give ${name} admin access? They'll be able to edit and publish the whole site.`)) { e.target.checked = false; return; }
      try { await Auth.setAdmin(uid, on); toast(on ? `${name} is now an admin` : `Removed admin access from ${name}`, 'ok'); }
      catch (err) { e.target.checked = !on; toast(err.message, 'err'); }
    };
    $('[data-del]', tr)?.addEventListener('click', async () => {
      if (!confirm(`Remove ${name} from this list? This also removes their admin access. (Their login itself can be deleted in Firebase → Authentication.)`)) return;
      try { if (adminSet.has(uid)) await Auth.setAdmin(uid, false); await Auth.deleteUser(uid); tr.remove(); toast('Removed', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
  });
}

boot();
