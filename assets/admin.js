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
    migrateData(A.data); // keep names in results in step with Drivers & Teams
    A.data._rev = { id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString() };
    const json = JSON.stringify(A.data, null, 2) + '\n';
    onStep('Checking for changes made elsewhere…');
    let head = await GH.headSha();
    if (head !== A.baseSha) {
      const remote = await GH.readFile('data/site.json', head);
      if (remote !== A.baseText && !(await uiConfirm('Someone else (another admin, or an edit on GitHub) changed the site since you opened the console. Publishing now will replace their content changes with yours.', { title: 'Site Was Changed Elsewhere', ok: 'Publish Mine Anyway', danger: true }))) {
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
  for (const k of ['members', 'races', 'news', 'media']) d[k] = Array.isArray(d[k]) ? d[k] : [];
  // card packs were removed from the site — tidy away their old data
  delete d.cards; delete d.packs; delete d.settings.starting_coins; delete d.settings.daily_coins;
  migrateData(d); // roster (Drivers & Teams) + points system; standings are now calculated
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

// ================================================================ race results editor
function lastName(n) { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p[p.length - 1] : p[0] || ''; }
function ourDriverSet() {
  const g = A.data.grid, ourTeams = new Set(g.teams.filter((t) => t.is_ours).map((t) => t.id));
  return new Set([...A.data.members.filter((m) => m.is_driver).map((m) => normName(m.name)),
    ...g.drivers.filter((d) => ourTeams.has(d.team_id)).map((d) => normName(d.name))]);
}
function raceSummary(race) {
  const rows = race.results?.race || [];
  const ours = ourDriverSet();
  return rows.map((r, i) => ({ r, i })).filter(({ r }) => ours.has(normName(r.d)))
    .map(({ r, i }) => `${(r.st || 'fin') === 'fin' ? `P${i + 1}` : STATUS[r.st]} ${lastName(r.d)}`).join(' · ');
}
function textDialog(title, help, placeholder) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'ui-dialog';
    ov.innerHTML = `<div class="ui-dialog-box wide"><h3>${esc(title)}</h3><p>${esc(help)}</p>
      <textarea rows="12" placeholder="${esc(placeholder)}"></textarea>
      <div class="ui-dialog-actions"><button type="button" class="btn btn-ghost" data-v="0">Cancel</button><button type="button" class="btn btn-primary" data-v="1">Add To Results</button></div></div>`;
    document.body.appendChild(ov);
    const ta = $('textarea', ov);
    const done = (v) => { window.removeEventListener('keydown', key, true); ov.remove(); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); done(null); } };
    window.addEventListener('keydown', key, true);
    ov.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1' ? ta.value : null); });
    setTimeout(() => ta.focus(), 20);
  });
}

function openResults(race) {
  const work = JSON.parse(JSON.stringify(race.results || {}));
  let hasSprint = !!race.has_sprint;
  const sessions = () => SESSIONS.filter((s) => !s.sprint || hasSprint);
  let cur = [...sessions()].reverse().find((s) => (work[s.key] || []).length)?.key || (hasSprint ? 'sprint_quali' : 'quali');
  const G = A.data.grid;
  const teamById = (id) => G.teams.find((t) => t.id === id);
  const driverById = (id) => G.drivers.find((d) => d.id === id);
  const driverByName = (n) => G.drivers.find((d) => normName(d.name) === normName(n));
  const teamByName = (n) => G.teams.find((t) => normName(t.name) === normName(n));
  // older rows saved before the roster existed: link them to roster entries by name
  for (const rows of Object.values(work)) for (const x of rows) {
    if (!x.di && x.d) { const d = driverByName(x.d); if (d) x.di = d.id; }
    if (!x.ti && x.t) { const t = teamByName(x.t); if (t) x.ti = t.id; }
  }
  const setDriver = (x, id) => { const d = driverById(id); if (!d) { delete x.di; delete x.d; return; } x.di = d.id; x.d = d.name; const t = teamById(d.team_id); if (t) { x.ti = t.id; x.t = t.name; } };
  const setTeam = (x, id) => { const t = teamById(id); if (t) { x.ti = t.id; x.t = t.name; } else { delete x.ti; delete x.t; } };
  // find a roster driver by name, adding them (and their team) to Drivers & Teams if they're new
  const ensureDriver = (name, teamName) => {
    let d = driverByName(name);
    if (!d) {
      let t = teamName ? teamByName(teamName) : null;
      if (!t && teamName) { t = { id: gid('tm'), name: teamName }; G.teams.push(t); }
      d = { id: gid('dr'), name, ...(t ? { team_id: t.id } : {}) }; G.drivers.push(d); addedToRoster++;
    }
    return d;
  };
  let addedToRoster = 0;
  const ourSet = () => ourDriverSet();
  const driverOptions = (sel, legacy) => {
    const groups = G.teams.map((t) => [t, G.drivers.filter((d) => d.team_id === t.id)]).filter(([, ds]) => ds.length);
    const loose = G.drivers.filter((d) => !teamById(d.team_id));
    const opt = (d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}${d.number ? ` #${esc(d.number)}` : ''}</option>`;
    return `<option value="">— Choose Driver —</option>${legacy ? `<option value="" selected>${esc(legacy)} (not in Drivers &amp; Teams)</option>` : ''}
      ${groups.map(([t, ds]) => `<optgroup label="${esc(t.name)}">${ds.map(opt).join('')}</optgroup>`).join('')}
      ${loose.length ? `<optgroup label="No team">${loose.map(opt).join('')}</optgroup>` : ''}`;
  };
  const teamOptions = (sel, legacy) => `<option value="">— Team —</option>${legacy ? `<option value="" selected>${esc(legacy)}</option>` : ''}${G.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;

  const panel = $('#drawerPanel');
  panel.classList.add('wide');
  const render = () => {
    const S2 = SESSIONS.find((s) => s.key === cur), rows = (work[cur] = work[cur] || []), isRace = S2.kind === 'race', ours = ourSet();
    const others = sessions().filter((s) => s.key !== cur && (work[s.key] || []).length);
    panel.innerHTML = `<form id="rf" novalidate>
      <div class="drawer-head"><h2>Results — ${esc(race.name)}</h2><button type="button" class="x" data-a="close" aria-label="Close">×</button></div>
      <div class="drawer-body">
        <label class="field check"><input type="checkbox" id="spr" ${hasSprint ? 'checked' : ''}> Sprint Weekend (adds Sprint Qualifying and Sprint)</label>
        <div class="tabs res-tabs">${sessions().map((s) => `<button type="button" class="tab" data-s="${s.key}" aria-selected="${s.key === cur}">${s.label}${(work[s.key] || []).length ? ` <small>${work[s.key].length}</small>` : ''}</button>`).join('')}</div>
        <div class="res-tools">
          ${others.length ? `<select id="copyFrom"><option value="">Copy Order From…</option>${others.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>` : ''}
          ${G.drivers.length ? '<button type="button" class="btn btn-sm btn-ghost" data-a="standings">Fill With All Drivers</button>' : ''}
          <button type="button" class="btn btn-sm btn-ghost" data-a="paste">Paste a List</button>
          ${rows.length ? '<button type="button" class="btn btn-sm btn-ghost danger" data-a="clear">Clear Session</button>' : ''}
        </div>
        ${rows.length ? `<div class="table-wrap"><table class="adm-table res-table">
          <thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th>${isRace ? 'Time / Gap' : 'Best Lap'}</th>${isRace ? '<th>Status</th>' : ''}<th title="Click a compound to add a stint; click a stint to remove it">Tyres <span class="muted">(yours)</span></th>${isRace ? '<th title="Fastest lap">FL</th>' : ''}${isRace ? '<th>Pts</th>' : ''}<th></th></tr></thead>
          <tbody>${rows.map((x, i) => {
            const mine = ours.has(normName(x.d));
            return `<tr data-i="${i}" class="${mine ? 'mine' : ''}">
              <td class="pos">${i + 1}</td>
              <td><select data-f="di">${driverOptions(x.di, !x.di && x.d ? x.d : '')}</select></td>
              <td><select data-f="ti">${teamOptions(x.ti, !x.ti && x.t ? x.t : '')}</select></td>
              <td><input data-f="time" value="${esc(x.time || '')}" placeholder="${isRace ? (i ? '+5.123' : '1:32:14.221') : '1:29.708'}" class="mono"></td>
              ${isRace ? `<td><select data-f="st">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${(x.st || 'fin') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>` : ''}
              <td class="ty-cell">${mine ? `<span class="ty-set">${[...String(x.ty || '')].map((c, k) => `<button type="button" class="tyre t-${c}" data-rmty="${k}" title="Remove ${TYRES[c]?.[0] || c}">${c}</button>`).join('')}</span>
                <span class="ty-add">${Object.entries(TYRES).map(([c, [name]]) => `<button type="button" class="tyre-add t-${c}" data-addty="${c}" title="Add a ${name} stint">${c}</button>`).join('')}</span>` : '<span class="muted">—</span>'}</td>
              ${isRace ? `<td><input type="radio" name="fl" data-fl ${x.fl ? 'checked' : ''} title="Fastest lap"></td><td class="pts">${rowPoints(cur, i + 1, x, A.data.points) || ''}${flBonus(cur, i + 1, x, A.data.points) ? '<small class="fl-mini">+FL</small>' : ''}</td>` : ''}
              <td class="row-actions"><button type="button" class="btn btn-sm btn-ghost" data-mv="-1" ${i ? '' : 'disabled'} title="Move up">↑</button><button type="button" class="btn btn-sm btn-ghost" data-mv="1" ${i < rows.length - 1 ? '' : 'disabled'} title="Move down">↓</button><button type="button" class="btn btn-sm btn-ghost danger" data-a="del" title="Remove">✕</button></td>
            </tr>`;
          }).join('')}</tbody></table></div>` : `<div class="empty panel small">No ${esc(S2.label)} results yet. Add drivers one by one, paste a list${G.drivers.length ? ', fill with all drivers' : ''}${others.length ? ' or copy the order from another session' : ''}.${G.drivers.length ? '' : ' <br>Tip: add your grid under <a href="#grid">Drivers &amp; Teams</a> first.'}</div>`}
        <button type="button" class="btn btn-ghost btn-sm add-row" data-a="add">+ Add Driver</button>
        <p class="small muted res-help">Put drivers in finishing order (use ↑ ↓ to adjust). Points come from your <a href="#points">Points System</a>${Number(A.data.points.fl_race) || Number(A.data.points.fl_sprint) ? `, including the fastest-lap bonus (+${A.data.points.fl_race}${Number(A.data.points.fl_top) ? `, top ${A.data.points.fl_top} only` : ''})` : ''}. Drivers marked DNF/DNS/DSQ score nothing. Saving updates the standings and every driver's stats automatically.</p>
      </div>
      <div class="drawer-foot"><span class="grow"></span><button type="button" class="btn btn-ghost" data-a="close">Cancel</button><button class="btn btn-primary">Save Results</button></div>
    </form>`;
  };
  const rowsNow = () => (work[cur] = work[cur] || []);

  panel.oninput = (e) => {
    const tr = e.target.closest('tr[data-i]'), f = e.target.dataset.f;
    if (tr && f === 'time') { const x = rowsNow()[Number(tr.dataset.i)]; if (e.target.value.trim()) x.time = e.target.value; else delete x.time; }
  };
  panel.onchange = (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (e.target.id === 'spr') { hasSprint = e.target.checked; if (!sessions().some((s) => s.key === cur)) cur = 'quali'; return render(); }
    if (e.target.id === 'copyFrom' && e.target.value) {
      work[cur] = (work[e.target.value] || []).map((x) => ({ d: x.d, ...(x.di ? { di: x.di } : {}), ...(x.t ? { t: x.t } : {}), ...(x.ti ? { ti: x.ti } : {}) }));
      toast(`Copied the order from ${SESSIONS.find((s) => s.key === e.target.value).label} — now adjust it`, 'ok'); return render();
    }
    if (!tr) return;
    const x = rowsNow()[Number(tr.dataset.i)];
    if (e.target.dataset.f === 'st') { if (e.target.value === 'fin') delete x.st; else x.st = e.target.value; return render(); }
    if (e.target.dataset.f === 'di') { setDriver(x, e.target.value); return render(); } // team follows the driver
    if (e.target.dataset.f === 'ti') { setTeam(x, e.target.value); return render(); }
    if (e.target.matches('[data-fl]')) { rowsNow().forEach((r) => delete r.fl); x.fl = true; return render(); }
  };
  panel.onclick = async (e) => {
    const b = e.target.closest('button, [data-s]'); if (!b) return;
    const tr = e.target.closest('tr[data-i]'), i = tr ? Number(tr.dataset.i) : -1, rows = rowsNow();
    if (b.dataset.s) { cur = b.dataset.s; return render(); }
    if (b.dataset.mv) { const j = i + Number(b.dataset.mv); [rows[i], rows[j]] = [rows[j], rows[i]]; return render(); }
    if (b.dataset.addty) { rows[i].ty = (rows[i].ty || '') + b.dataset.addty; return render(); }
    if (b.dataset.rmty !== undefined) { const t = [...rows[i].ty]; t.splice(Number(b.dataset.rmty), 1); rows[i].ty = t.join(''); if (!rows[i].ty) delete rows[i].ty; return render(); }
    switch (b.dataset.a) {
      case 'close': return closeDrawer();
      case 'del': rows.splice(i, 1); return render();
      case 'add': rows.push({}); render(); $$('#rf tr[data-i] select[data-f="di"]').pop()?.focus(); return;
      case 'clear': if (await uiConfirm(`All ${SESSIONS.find((s) => s.key === cur).label} rows will be removed.`, { title: 'Clear This Session?', ok: 'Clear', danger: true })) { work[cur] = []; render(); } return;
      case 'standings':
        work[cur] = computeStandings(A.data).drivers.map((s) => driverByName(s.driver)).filter(Boolean).map((d) => { const x = {}; setDriver(x, d.id); return x; });
        toast('Filled with every driver (in championship order) — now put them in finishing order', 'ok'); return render();
      case 'paste': {
        const txt = await textDialog('Paste a List', 'One driver per line, in finishing order. You can add the team and time after commas or tabs (straight from a spreadsheet works), e.g. "Alex Mercer, APX GP, 1:29.708". Position numbers at the start are ignored.', '1. Alex Mercer, APX GP, 1:29.708\n2. L. Fontaine, Vertex Motorsport, +0.142\n3. Mateo Ruiz');
        if (!txt) return;
        const add = txt.split(/\r?\n/).map((l) => l.replace(/^\s*(P?\d+)[.):\-\s]+/i, '').trim()).filter(Boolean).map((l) => {
          const [d, t, time] = l.split(/\t|,|;/).map((p) => p.trim());
          const dr = ensureDriver(d, t), x = {}; setDriver(x, dr.id);
          if (t) { const tm = teamByName(t); if (tm) setTeam(x, tm.id); }
          if (time) x.time = time;
          return x;
        });
        work[cur] = rows.filter((r) => r.di || r.d).concat(add);
        toast(`Added ${add.length} drivers${addedToRoster ? ` (${addedToRoster} new name${addedToRoster > 1 ? 's were' : ' was'} added to Drivers & Teams)` : ''}`, 'ok');
        if (addedToRoster) setDirty();
        addedToRoster = 0; return render();
      }
    }
  };
  panel.onsubmit = (e) => {
    e.preventDefault();
    const clean = {};
    for (const s of sessions()) {
      const rows = (work[s.key] || []).filter((x) => x.di || (x.d && x.d.trim())).map((x) => ({ ...x, d: String(x.d || '').trim() }));
      if (rows.length) clean[s.key] = rows;
    }
    if (Object.keys(clean).length) race.results = clean; else delete race.results;
    if (hasSprint) race.has_sprint = true; else delete race.has_sprint;
    if (clean.race) { race.status = 'completed'; const sum = raceSummary(race); if (sum) race.result = sum; }
    setDirty(); closeDrawer(); route();
    toast('Results saved — stats are updated. Press Publish to Site to put them live.', 'ok');
  };
  render();
  $('#drawer').hidden = false; document.body.classList.add('modal-open');
}

// ================================================================ in-console dialogs
// Styled replacement for the browser's confirm() pop-up. Resolves true / false.
function uiConfirm(message, { title = 'Are you sure?', ok = 'Confirm', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'ui-dialog';
    ov.innerHTML = `<div class="ui-dialog-box" role="alertdialog" aria-modal="true" aria-labelledby="uiDlgT">
      <h3 id="uiDlgT">${esc(title)}</h3><p>${esc(message)}</p>
      <div class="ui-dialog-actions"><button type="button" class="btn btn-ghost" data-v="0">${esc(cancel)}</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-v="1">${esc(ok)}</button></div></div>`;
    document.body.appendChild(ov);
    const done = (v) => { window.removeEventListener('keydown', key, true); ov.remove(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); done(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); done(true); }
    };
    window.addEventListener('keydown', key, true);
    ov.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1'); else if (e.target === ov) done(false); });
    setTimeout(() => $('[data-v="1"]', ov).focus(), 20);
  });
}

// Describe what changed since the last publish, e.g. "Update Team members (1 edited), News (1 added)"
function changeSummary() {
  let base = {};
  try { base = JSON.parse(A.baseText); } catch { /* first publish */ }
  const names = { members: 'Team members', races: 'Race schedule', drivers: "Drivers' standings", constructors: "Constructors' standings", news: 'News', media: 'Media' };
  const parts = [];
  for (const [k, label] of Object.entries(names)) {
    const before = new Map((base[k] || []).map((r) => [r.id, JSON.stringify(r)]));
    const after = A.data[k] || [];
    let added = 0, edited = 0;
    for (const r of after) { if (!before.has(r.id)) added++; else if (before.get(r.id) !== JSON.stringify(r)) edited++; before.delete(r.id); }
    const removed = before.size;
    const bits = [added && `${added} added`, edited && `${edited} edited`, removed && `${removed} removed`].filter(Boolean);
    if (bits.length) parts.push(`${label} (${bits.join(', ')})`);
  }
  const { _rev: _a, ...sNow } = A.data.settings || {};
  if (JSON.stringify(sNow) !== JSON.stringify(base.settings || {})) parts.push('Site settings');
  return parts.length ? `Update ${parts.join(', ')}` : 'Update site content';
}

// ================================================================ photo editor
// Crop (free or fixed ratio), rotate, flip, brightness / contrast / saturation.
// Returns a new image Blob, 'original' (keep the file as uploaded) or null (cancelled).
const ASPECTS = [['free', 'Free'], ['orig', 'Original'], ['1:1', 'Square'], ['4:5', '4:5'], ['3:4', '3:4'], ['3:2', '3:2'], ['16:9', '16:9']];
function loadImg(url) {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = url; });
}
async function photoEditor(url, opts = {}) {
  let img;
  try { img = await loadImg(url); } catch { toast('Couldn\'t open that image for editing.', 'err'); return null; }
  try { const t = document.createElement('canvas').getContext('2d'); t.drawImage(img, 0, 0, 1, 1); t.getImageData(0, 0, 1, 1); }
  catch { toast('That image is hosted on another website, so it can\'t be edited here. Download it and upload it instead.', 'err'); return null; }

  const st = { rot: 0, flip: false, aspect: opts.aspect || 'free', b: 100, c: 100, s: 100, crop: null };
  const keepAlpha = /png|webp|gif/i.test(opts.mime || '') || /\.(png|webp|gif)(\?|$)/i.test(url);
  const ov = document.createElement('div');
  ov.className = 'pe';
  ov.innerHTML = `<div class="pe-panel" role="dialog" aria-label="Adjust photo">
    <div class="drawer-head"><h2>Adjust photo</h2><button type="button" class="x" data-act="cancel" aria-label="Close">×</button></div>
    <div class="pe-body">
      <div class="pe-stage"><div class="pe-wrap"><canvas class="pe-canvas"></canvas>
        <div class="pe-crop"><span class="pe-grid"></span><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div></div>
      <div class="pe-side">
        <div class="pe-group"><span class="flabel">Crop shape</span><div class="pe-chips">${ASPECTS.map(([k, l]) => `<button type="button" data-aspect="${k}">${l}</button>`).join('')}</div>
          <p class="small muted">Drag the box to move it, drag a corner to resize.</p></div>
        <div class="pe-group"><span class="flabel">Rotate &amp; flip</span><div class="pe-row">
          <button type="button" class="btn btn-sm btn-ghost" data-act="rl" title="Rotate left">⟲ Left</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="rr" title="Rotate right">⟳ Right</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="flip" title="Mirror">⇋ Flip</button></div></div>
        <div class="pe-group"><span class="flabel">Light &amp; colour</span>
          ${[['b', 'Brightness'], ['c', 'Contrast'], ['s', 'Saturation']].map(([k, l]) => `<label class="pe-slider"><span>${l}<em data-v="${k}">0</em></span><input type="range" min="0" max="200" value="100" data-adj="${k}"></label>`).join('')}</div>
        <button type="button" class="btn btn-sm btn-ghost" data-act="reset">Reset everything</button>
      </div>
    </div>
    <div class="drawer-foot"><span class="pe-size small muted"></span><span class="grow"></span>
      ${opts.allowOriginal ? '<button type="button" class="btn btn-ghost" data-act="original">Use as uploaded</button>' : ''}
      <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="apply">Apply</button></div>
  </div>`;
  document.body.appendChild(ov);
  document.body.classList.add('modal-open');
  const canvas = $('.pe-canvas', ov), cropEl = $('.pe-crop', ov), stage = $('.pe-stage', ov), wrap = $('.pe-wrap', ov);
  let disp = 1; // display px per image px

  const dims = () => (st.rot % 180 ? [img.naturalHeight, img.naturalWidth] : [img.naturalWidth, img.naturalHeight]);
  const ratio = () => {
    if (st.aspect === 'free') return null;
    if (st.aspect === 'orig') { const [W, H] = dims(); return W / H; }
    const [a, b] = st.aspect.split(':').map(Number); return a / b;
  };
  function drawOriented(ctx, scale) {
    const [W, H] = dims();
    ctx.save();
    ctx.translate((W * scale) / 2, (H * scale) / 2);
    if (st.flip) ctx.scale(-1, 1);
    ctx.rotate((st.rot * Math.PI) / 180);
    ctx.drawImage(img, (-img.naturalWidth * scale) / 2, (-img.naturalHeight * scale) / 2, img.naturalWidth * scale, img.naturalHeight * scale);
    ctx.restore();
  }
  function fitCrop() {
    const [W, H] = dims(), r = ratio();
    let w = W, h = H;
    if (r) { if (W / H > r) w = H * r; else h = W / r; }
    st.crop = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  function redraw() {
    const [W, H] = dims();
    const pv = Math.min(1, 1400 / Math.max(W, H));
    canvas.width = Math.round(W * pv); canvas.height = Math.round(H * pv);
    drawOriented(canvas.getContext('2d'), pv);
    layout();
  }
  function layout() {
    const [W, H] = dims();
    const sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
    disp = Math.min(sw / W, sh / H);
    wrap.style.width = `${W * disp}px`; wrap.style.height = `${H * disp}px`;
    canvas.style.filter = `brightness(${st.b}%) contrast(${st.c}%) saturate(${st.s}%)`;
    placeCrop();
  }
  function placeCrop() {
    const c = st.crop;
    Object.assign(cropEl.style, { left: `${c.x * disp}px`, top: `${c.y * disp}px`, width: `${c.w * disp}px`, height: `${c.h * disp}px` });
    const k = Math.min(1, 2400 / Math.max(c.w, c.h));
    $('.pe-size', ov).textContent = `${Math.round(c.w * k)} × ${Math.round(c.h * k)} px`;
  }
  function syncControls() {
    $$('[data-aspect]', ov).forEach((b) => b.classList.toggle('on', b.dataset.aspect === st.aspect));
    $$('[data-adj]', ov).forEach((i) => { i.value = st[i.dataset.adj]; $(`[data-v="${i.dataset.adj}"]`, ov).textContent = `${st[i.dataset.adj] - 100 > 0 ? '+' : ''}${st[i.dataset.adj] - 100}`; });
  }

  // ---- crop box dragging
  let drag = null;
  cropEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const h = e.target.dataset.h, c = st.crop;
    drag = { h, sx: e.clientX, sy: e.clientY, c0: { ...c },
      ax: h ? (h.includes('w') ? c.x + c.w : c.x) : 0, ay: h ? (h.includes('n') ? c.y + c.h : c.y) : 0 };
    cropEl.setPointerCapture(e.pointerId);
  });
  cropEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [W, H] = dims();
    if (!drag.h) {
      const c = st.crop;
      c.x = Math.min(Math.max(0, drag.c0.x + (e.clientX - drag.sx) / disp), W - c.w);
      c.y = Math.min(Math.max(0, drag.c0.y + (e.clientY - drag.sy) / disp), H - c.h);
    } else {
      const r0 = wrap.getBoundingClientRect();
      const px = Math.min(Math.max(0, (e.clientX - r0.left) / disp), W), py = Math.min(Math.max(0, (e.clientY - r0.top) / disp), H);
      const min = 24 / disp, r = ratio();
      let w = Math.max(min, Math.abs(px - drag.ax)), h = Math.max(min, Math.abs(py - drag.ay));
      if (r) { if (w / h > r) w = h * r; else h = w / r; }
      const left = drag.h.includes('w'), top = drag.h.includes('n');
      // keep inside the photo
      w = Math.min(w, left ? drag.ax : W - drag.ax); h = Math.min(h, top ? drag.ay : H - drag.ay);
      if (r) { if (w / h > r) w = h * r; else h = w / r; }
      st.crop = { x: left ? drag.ax - w : drag.ax, y: top ? drag.ay - h : drag.ay, w, h };
    }
    placeCrop();
  });
  const endDrag = () => { drag = null; };
  cropEl.addEventListener('pointerup', endDrag); cropEl.addEventListener('pointercancel', endDrag);

  // ---- controls
  $$('[data-aspect]', ov).forEach((b) => (b.onclick = () => { st.aspect = b.dataset.aspect; fitCrop(); syncControls(); placeCrop(); }));
  $$('[data-adj]', ov).forEach((i) => (i.oninput = () => { st[i.dataset.adj] = Number(i.value); syncControls(); layout(); }));
  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  return new Promise((resolve) => {
    const done = (v) => { window.removeEventListener('resize', onResize); window.removeEventListener('keydown', onKey, true); ov.remove(); document.body.classList.remove('modal-open'); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); done(null); } };
    window.addEventListener('keydown', onKey, true); // capture: don't also close the form underneath
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
      if (act === 'cancel') return done(null);
      if (act === 'original') return done('original');
      if (act === 'rl' || act === 'rr') { st.rot = (st.rot + (act === 'rr' ? 90 : 270)) % 360; fitCrop(); redraw(); }
      if (act === 'flip') { st.flip = !st.flip; redraw(); }
      if (act === 'reset') { Object.assign(st, { rot: 0, flip: false, b: 100, c: 100, s: 100, aspect: opts.aspect || 'free' }); fitCrop(); syncControls(); redraw(); }
      if (act === 'apply') {
        e.target.disabled = true; e.target.textContent = 'Saving…';
        const c = st.crop, k = Math.min(1, 2400 / Math.max(c.w, c.h));
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(c.w * k)); out.height = Math.max(1, Math.round(c.h * k));
        const ctx = out.getContext('2d');
        ctx.save(); ctx.scale(k, k); ctx.translate(-c.x, -c.y); drawOriented(ctx, 1); ctx.restore();
        if (st.b !== 100 || st.c !== 100 || st.s !== 100) adjustPixels(ctx, out.width, out.height, st.b / 100, st.c / 100, st.s / 100);
        const blob = await new Promise((r) => out.toBlob(r, keepAlpha ? 'image/png' : 'image/jpeg', 0.9));
        done(blob);
      }
    });
    fitCrop(); syncControls();
    requestAnimationFrame(redraw);
  });
}
// Same maths as CSS brightness() → contrast() → saturate(), done per pixel so it works in every browser
function adjustPixels(ctx, w, h, br, ct, sa) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * br, g = d[i + 1] * br, b = d[i + 2] * br;
    r = (r - 128) * ct + 128; g = (g - 128) * ct + 128; b = (b - 128) * ct + 128;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[i] = y + (r - y) * sa; d[i + 1] = y + (g - y) * sa; d[i + 2] = y + (b - y) * sa; // Uint8Clamped clamps 0–255
  }
  ctx.putImageData(im, 0, 0);
}
// Pick → adjust → store. Used by image fields, the media library and "Insert image".
async function pickAndAdjust(file, aspect) {
  const tmp = URL.createObjectURL(file);
  try {
    const res = await photoEditor(tmp, { aspect, allowOriginal: true, mime: file.type });
    if (!res) return null;
    if (res === 'original') return addImage(file);
    return addImage(new File([res], file.name.replace(/\.[^.]+$/, '') + (res.type === 'image/png' ? '.png' : '.jpg'), { type: res.type }));
  } finally { URL.revokeObjectURL(tmp); }
}
async function adjustExisting(path, aspect) {
  const res = await photoEditor(src(path), { aspect });
  if (!res || res === 'original') return null;
  return addImage(new File([res], `edited${res.type === 'image/png' ? '.png' : '.jpg'}`, { type: res.type }));
}

// ================================================================ sections
const SECTIONS = {
  dashboard: { title: 'Dashboard', icon: '◧' },
  settings: { title: 'Site Settings', icon: '⚙' },
  members: {
    title: 'Team Members', icon: '👤', res: 'members', singular: 'Member', idp: 'm',
    help: 'Everyone shown on the Team page. Mark drivers so they appear on the home page and in Compare. Sort order controls the carousel order.',
    sort: (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0),
    cols: [['photo', 'thumb'], ['name'], ['role'], ['number', 'No.'], ['is_driver', 'Driver', 'bool'], ['sort', 'Order']],
    fields: () => [
      { k: 'name', label: 'Full name', req: true }, { k: 'role', label: 'Role / title', ph: 'Race Driver, Team Principal…' },
      { k: 'is_driver', label: 'This person is a driver', type: 'check' },
      { k: 'number', label: 'Car number', half: true }, { k: 'sort', label: 'Sort order', type: 'number', half: true },
      { k: 'nationality', label: 'Nationality', half: true }, { k: 'hometown', label: 'Hometown', half: true },
      { k: 'birthdate', label: 'Date of birth', type: 'date', half: true }, { k: 'photo', label: 'Photo', type: 'image', aspect: '4:5' },
      { k: 'instagram', label: 'Instagram URL', half: true }, { k: 'twitter', label: 'X / Twitter URL', half: true },
      { k: 'bio', label: 'Biography', type: 'markdown', rows: 8 },
      { k: 'stats', label: 'Driver stats', type: 'stats' },
    ],
  },
  races: {
    title: 'Race Schedule', icon: '🏁', res: 'races', singular: 'Race', idp: 'r',
    help: 'Add each race to the calendar, then use Add Results after the weekend. Entering results marks the race completed, writes the summary line and updates every driver\'s stats.',
    sort: (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.round || 0) - (b.round || 0),
    cols: [['round', 'Rnd'], ['name'], ['date', 'Date', 'date'], ['status', 'Status', 'status'], ['results', 'Results', 'results'], ['result', 'Summary']],
    extraAction: (r) => `<button class="btn btn-sm btn-primary" data-results="${esc(r.id)}">${r.results ? 'Edit Results' : 'Add Results'}</button>`,
    fields: () => [
      { k: 'name', label: 'Race name', req: true, ph: 'Italian Grand Prix' }, { k: 'round', label: 'Round', type: 'number', half: true },
      { k: 'status', label: 'Status', type: 'select', half: true, opts: [['upcoming', 'Upcoming'], ['completed', 'Completed']] },
      { k: 'circuit', label: 'Circuit', half: true }, { k: 'country', label: 'Country', half: true },
      { k: 'date', label: 'Race date', type: 'date', half: true }, { k: 'time', label: 'Start time (local)', type: 'time', half: true },
      { k: 'result', label: 'Result summary', ph: 'P1 Mercer · P4 Ruiz' },
    ],
  },
  grid: { title: 'Drivers & Teams', icon: '🏎', help: 'Every team and driver on the grid. These names fill the dropdowns when you enter race results — the championship standings are calculated from those results automatically.' },
  points: { title: 'Points System', icon: '🔢', help: 'How many points each finishing position is worth, plus the fastest-lap bonus. Changes recalculate the standings and every driver\'s stats instantly.' },
  news: {
    title: 'News', icon: '📰', res: 'news', singular: 'Article', idp: 'n',
    help: 'Drafts stay hidden on the site. Tick Published to put an article live. Body formatting: ## headings, **bold**, *italic*, - lists, > quotes, [links](https://…) and images via "Insert image".',
    sort: (a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')),
    cols: [['cover', 'thumb'], ['title'], ['published', 'Live', 'bool'], ['published_at', 'Date', 'date'], ['author']],
    fields: () => [
      { k: 'title', label: 'Headline', req: true }, { k: 'excerpt', label: 'Summary (shown on cards)', type: 'textarea', rows: 2 },
      { k: 'cover', label: 'Cover image', type: 'image', aspect: '16:9' },
      { k: 'body', label: 'Article body', type: 'markdown', rows: 14, uploadInsert: true },
      { k: 'author', label: 'Author', half: true }, { k: 'published_at', label: 'Publish date', type: 'datetime-local', half: true },
      { k: 'slug', label: 'URL slug (auto-generated if blank)', half: true },
      { k: 'published', label: 'Published (visible on site)', type: 'check' },
    ],
  },
  media: { title: 'Media Library', icon: '🖼', help: 'Add photos for the Media page, then use ✎ Adjust to crop, rotate or brighten any of them. Group photos with albums — the site shows album filters automatically.' },
  fans: { title: 'Admins', icon: '👥', help: 'Who can sign in to this console, and the GitHub connection used for publishing.' },
};

// ================================================================ boot / login
// Two modes:
//  • Firebase configured (normal): admins sign in with their website account. The console
//    checks /admins in Firestore, then uses the GitHub token stored once in /secrets/github.
//  • No Firebase yet: fall back to pasting a GitHub token directly.
// Where "Back to Site" goes: the page you were on when you clicked Admin Console
const siteReturnUrl = () => { let h = '#/'; try { h = sessionStorage.getItem('apx_return') || '#/'; } catch { /* ignore */ } return `./${h}`; };
const authShell = (inner) => `<div class="admin-auth"><div class="auth-card wide">
  <div class="brand"><img src="brand/apx-gp-logo.png" alt="" class="adm-logo theme-logo"><span>Admin</span></div>${inner}
  <p class="small center back-link"><a class="muted" href="${siteReturnUrl()}">← Back to Site</a></p></div></div>`;
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
  if (s.background_color) r.setProperty('--bg-dark', s.background_color);
}
const ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" fill="currentColor"/></svg>';
const isLight = () => document.documentElement.dataset.theme === 'light';
function themeBtnHtml() { return `<button class="theme-btn" id="themeBtn" type="button" title="Switch to ${isLight() ? 'dark' : 'light'} mode" aria-label="Switch to ${isLight() ? 'dark' : 'light'} mode">${isLight() ? ICON_MOON : ICON_SUN}</button>`; }
function wireThemeBtn() {
  const b = $('#themeBtn'); if (!b) return;
  b.onclick = () => {
    document.documentElement.dataset.theme = isLight() ? 'dark' : 'light';
    try { localStorage.setItem('apx_theme', JSON.stringify(document.documentElement.dataset.theme)); } catch { /* ignore */ }
    b.outerHTML = themeBtnHtml(); wireThemeBtn();
    const brand = $('.adm-side .brand'); if (brand && A.data) brand.innerHTML = brandHtml();
  };
}
const brandHtml = () => safeUrl(A.data.settings.logo)
  ? (isLight() && safeUrl(A.data.settings.logo_light)
    ? `<img src="${esc(src(A.data.settings.logo_light))}" alt="" class="adm-logo">`
    : `<img src="${esc(src(A.data.settings.logo))}" alt="" class="adm-logo theme-logo">`)
  : `<span class="brand-mark">${esc((A.data.settings.short_name || 'T')[0])}</span><span>${esc(A.data.settings.short_name)}</span>`;

function shell() {
  applyTheme();
  const site = siteReturnUrl();
  root.innerHTML = `<div class="adm">
    <aside class="adm-side">
      <a class="brand" href="${esc(site)}" title="Back to the site">${brandHtml()}</a>
      <nav id="side">${Object.entries(SECTIONS).map(([k, s]) => `<a href="#${k}" data-s="${k}"><i>${s.icon}</i>${s.title}</a>`).join('')}</nav>
      <div id="liveStatus" class="live-status"></div>
      <div class="adm-user"><span class="muted small">${Auth.enabled ? 'Signed in as' : 'Connected to'}</span><b>${esc(Auth.enabled ? (Auth.state.profile?.username || Auth.state.user?.email || '') : `${A.gh.owner}/${A.gh.repo}`)}</b>
        <div class="adm-user-actions"><a class="btn btn-sm btn-primary back-site" href="${esc(site)}">← Back to Site</a><button class="btn btn-sm btn-ghost" id="out">Sign Out</button>${themeBtnHtml()}</div></div>
    </aside>
    <main class="adm-main" id="main"></main>
    <div class="publish-bar" id="pubBar" hidden>
      <span><b>Unpublished Changes</b> <span class="muted small">— visitors won't see them until you publish</span></span>
      <span class="grow"></span>
      <button class="btn btn-ghost btn-sm" id="discard">Discard</button>
      <button class="btn btn-primary" id="publish">Publish to Site</button>
    </div>
    <div class="drawer" id="drawer" hidden><div class="drawer-bg"></div><div class="drawer-panel" id="drawerPanel"></div></div>
  </div>`;
  $('#out').onclick = async () => {
    if (A.dirty && !(await uiConfirm('You have changes that haven\'t been published yet. Signing out will throw them away.', { title: 'Sign Out?', ok: 'Sign Out', danger: true }))) return;
    A.dirty = false;
    A.dirty = false;
    if (Auth.enabled) await Auth.signOut(); else store.del('apx_gh_token');
    location.href = siteReturnUrl();
  };
  $('#publish').onclick = publish;
  $('#discard').onclick = async () => {
    if (!(await uiConfirm('All changes since your last publish will be thrown away.', { title: 'Discard Changes?', ok: 'Discard', danger: true }))) return;
    A.data = JSON.parse(A.baseText); normalise(A.data); A.pending.clear(); setDirty(false); applyTheme(); route();
  };
  wireThemeBtn();
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
  if (btn.disabled) return;
  btn.disabled = true;
  const by = Auth.enabled && Auth.state.profile ? ` — by ${Auth.state.profile.username}` : '';
  try {
    const r = await GH.publish(changeSummary() + by, (s) => (btn.textContent = s));
    setDirty(false);
    toast(`Saved to GitHub${r.uploaded ? ` (${r.uploaded} file${r.uploaded > 1 ? 's' : ''} uploaded)` : ''} — the live site updates in 1–3 minutes. Watch the status in the sidebar.`, 'ok');
    watchLive(r.rev);
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = 'Publish to Site';
}

function route() {
  const key = location.hash.slice(1) || 'dashboard';
  A.section = SECTIONS[key] ? key : 'dashboard';
  $$('#side a').forEach((a) => a.classList.toggle('on', a.dataset.s === A.section));
  closeDrawer();
  const main = $('#main');
  main.oninput = main.onchange = main.onclick = null;
  try {
    const s = SECTIONS[A.section];
    if (A.section === 'dashboard') dashboard(main);
    else if (A.section === 'settings') settingsView(main);
    else if (A.section === 'media') mediaView(main);
    else if (A.section === 'fans') fansView(main);
    else if (A.section === 'grid') gridView(main);
    else if (A.section === 'points') pointsView(main);
    else listView(main, s);
  } catch (e) { console.error(e); main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

const head = (s, actions = '') => `<div class="adm-head"><div><h1>${s.title}</h1>${s.help ? `<p class="muted small">${esc(s.help)}</p>` : ''}</div><div class="adm-actions">${actions}</div></div>`;

// ================================================================ dashboard
function dashboard(main) {
  const d = A.data;
  const drafts = d.news.filter((n) => !n.published).length;
  const tiles = [['members', 'Team Members', d.members.length], ['races', 'Races', d.races.length],
    ['news', 'Articles', `${d.news.length}${drafts ? ` <small>(${drafts} draft${drafts > 1 ? 's' : ''})</small>` : ''}`],
    ['media', 'Photos', d.media.length]];
  main.innerHTML = `${head({ title: 'Dashboard' })}
  <div class="dash-tiles">${tiles.map(([k, l, v]) => `<a class="dash-tile" href="#${k}"><b>${v}</b><span>${l}</span></a>`).join('')}</div>
  <div class="dash-cols">
    <div class="panel"><h3>Quick Actions</h3><div class="quick">
      <button class="btn btn-primary" data-go="news">Write an Article</button>
      <a class="btn btn-ghost" href="#media">Add Photos</a>
      <a class="btn btn-ghost" href="#races">Enter Race Results</a>
      <a class="btn btn-ghost" href="#grid">Drivers &amp; Teams</a>
    </div></div>
    <div class="panel"><h3>How Publishing Works</h3><ol class="small checklist">
      <li>Make as many edits as you like — they're kept in this browser tab.</li>
      <li>Press <b>Publish to Site</b> (bottom bar). Everything is saved to GitHub as one commit.</li>
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
    ['Images', [{ k: 'logo', label: 'Logo (white on transparent works best)', type: 'image' },
      { k: 'logo_light', label: 'Logo for light mode (optional — if empty, the logo is darkened automatically)', type: 'image' },
      { k: 'hero_image', label: 'Home page hero image', type: 'image', aspect: '16:9' }]],
    ['About', [{ k: 'about', label: 'About the team (home page)', type: 'markdown', rows: 6 }]],
    ['Social Links', [{ k: 'instagram', label: 'Instagram URL', half: true }, { k: 'twitter', label: 'X / Twitter URL', half: true }, { k: 'youtube', label: 'YouTube URL', half: true }, { k: 'twitch', label: 'Twitch URL', half: true }]],
    ['Background Music', [{ k: 'music_file', label: 'Music file (loops on the site; visitors can mute it)', type: 'audio' },
      { k: 'music_volume', label: 'Volume (0–100)', type: 'number', half: true, def: 35 },
      { k: 'music_title', label: 'Track name (shown on hover, optional)', half: true }]],
  ];
  main.innerHTML = `${head(SECTIONS.settings, '<span class="muted small">Changes apply as you type — press <b>Publish to Site</b> when ready.</span>')}
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
  if (s.standings) actions = `<button class="btn btn-ghost" id="reorder" title="Re-number positions by points">Auto-Rank by Points</button>` + actions;

  const body = rows.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr>${s.cols.map(([k, l]) => `<th class="${l === 'thumb' ? 'th-thumb' : ''}">${l === 'thumb' ? '' : esc(l || k[0].toUpperCase() + k.slice(1))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${s.cols.map(([k, l, t]) => `<td>${cell(r[k], l === 'thumb' ? 'thumb' : t)}</td>`).join('')}
        <td class="row-actions">${s.extraAction ? s.extraAction(r) : ''}<button class="btn btn-sm btn-ghost" data-edit="${esc(r.id)}">Edit</button><button class="btn btn-sm btn-ghost danger" data-del="${esc(r.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty panel">Nothing here yet. <button class="btn btn-primary btn-sm" id="new2">Add the First ${s.singular}</button></div>`;
  main.innerHTML = head(s, actions) + body;
  $('#new').onclick = () => openForm(s, null);
  $$('[data-results]', main).forEach((b) => (b.onclick = () => openResults(A.data.races.find((r) => r.id === b.dataset.results))));
  $('#new2')?.addEventListener('click', () => openForm(s, null));
  $$('[data-edit]', main).forEach((b) => (b.onclick = () => openForm(s, A.data[s.res].find((r) => r.id === b.dataset.edit))));
  $$('[data-del]', main).forEach((b) => (b.onclick = async () => {
    const list = A.data[s.res], r = list.find((x) => x.id === b.dataset.del);
    if (!(await uiConfirm(`"${r.name || r.title || r.driver || r.team}" will be removed when you publish.`, { title: `Delete This ${s.singular}?`, ok: 'Delete', danger: true }))) return;
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
  if (type === 'results') {
    if (!v) return '<span class="muted">—</span>';
    return SESSIONS.filter((x) => (v[x.key] || []).length).map((x) => `<span class="pill res-pill">${x.short}</span>`).join(' ');
  }
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
    case 'image': return `<div class="${cls} img-field" data-k="${f.k}" data-aspect="${esc(f.aspect || 'free')}"><span class="flabel">${lab}</span>
        <div class="img-row"><div class="img-prev" ${safeUrl(val) ? `style="background-image:url('${esc(src(val))}')"` : ''}>${val ? '' : '<span>No image</span>'}</div>
        <div class="img-ctrls"><label class="btn btn-sm btn-ghost">Choose image<input type="file" accept="image/*" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost" data-adjust ${val ? '' : 'hidden'}>✎ Adjust</button>
          <button type="button" class="btn btn-sm btn-ghost danger" data-clear ${val ? '' : 'hidden'}>Remove</button>
          <input type="text" name="${f.k}" value="${esc(val)}" placeholder="…or paste an image URL"></div></div></div>`;
    case 'audio': return `<div class="${cls} audio-field img-field-like"><span class="flabel">${lab}</span>
        <div class="img-ctrls"><label class="btn btn-sm btn-ghost">Choose audio file<input type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost danger" data-clear ${val ? '' : 'hidden'}>Remove music</button>
          <input type="text" name="${f.k}" value="${esc(val)}" placeholder="No music — choose a file" readonly></div>
        <audio controls preload="none" ${val ? `src="${esc(src(val))}"` : 'hidden'}></audio></div>`;
    case 'stats': {
      const st = (v && typeof v === 'object') ? v : {};
      return `<fieldset class="field sub-fs"><legend>${esc(f.label)}</legend>
        <p class="small muted">Wins, podiums, poles, points and the rest are <b>calculated automatically</b> from the race results you enter under <b>Race Schedule → Results</b>.</p>
        <div class="stats-grid"><label>Championships won<input type="number" min="0" step="1" data-stat="championships" value="${esc(st.championships ?? '')}"></label></div></fieldset>`;
    }
    default: return `<label class="${cls}">${lab}<input type="${f.type || 'text'}" id="${id}" name="${f.k}" value="${esc(val)}" ${f.step ? `step="${f.step}"` : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.req ? 'required' : ''}></label>`;
  }
}

function wireFields(form, onChange) {
  $$('.img-field', form).forEach((w) => {
    const input = $('input[type=text]', w), prev = $('.img-prev', w), clear = $('[data-clear]', w), adj = $('[data-adjust]', w);
    const aspect = w.dataset.aspect || 'free';
    const set = (path) => {
      input.value = path;
      prev.style.backgroundImage = safeUrl(path) ? `url('${src(path)}')` : '';
      prev.innerHTML = path ? '' : '<span>No image</span>'; clear.hidden = !path; adj.hidden = !path; onChange?.();
    };
    $('input[type=file]', w).onchange = async (e) => {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      try { const p = await pickAndAdjust(file, aspect); if (p) set(p); } catch (err) { toast(err.message, 'err'); }
    };
    adj.onclick = async () => {
      try { const p = await adjustExisting(input.value, 'free'); if (p) { set(p); toast('Photo updated', 'ok'); } } catch (err) { toast(err.message, 'err'); }
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
      const path = await pickAndAdjust(file, 'free'); if (!path) { inp.value = ''; return; }
      const ta = $('#' + inp.dataset.insert, form);
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
  closeDrawer();
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
function closeDrawer() {
  const d = $('#drawer'); if (d) d.hidden = true; document.body.classList.remove('modal-open');
  const p = $('#drawerPanel'); // reset anything the results editor attached
  if (p) { p.classList.remove('wide'); p.oninput = p.onchange = p.onclick = p.onsubmit = null; }
}
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
    <div class="adm-m-actions"><button class="btn btn-sm btn-ghost" data-adj>✎ Adjust</button><button class="btn btn-sm btn-ghost" data-copy="${esc(m.file)}">Copy path</button><button class="btn btn-sm btn-ghost danger" data-del>Delete</button></div>
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
    $('[data-adj]', el).onclick = async () => {
      try { const p = await adjustExisting(m.file, 'free'); if (p) { m.file = p; setDirty(); toast('Photo updated — press Publish to put it live', 'ok'); route(); } }
      catch (err) { toast(err.message, 'err'); }
    };
    $('[data-del]', el).onclick = async () => { if (!(await uiConfirm('It will be removed from the Media page when you publish.', { title: 'Delete This Photo?', ok: 'Delete', danger: true }))) return; A.data.media.splice(A.data.media.indexOf(m), 1); setDirty(); el.remove(); toast('Deleted — publish to remove it from the site', 'ok'); };
    $('[data-copy]', el).onclick = (e) => navigator.clipboard?.writeText(e.target.dataset.copy).then(() => toast('Path copied — paste it into any image field', 'ok'), () => toast(e.target.dataset.copy));
  });
}

// ================================================================ Drivers & Teams (roster)
function gridView(main) {
  const G = A.data.grid;
  const standings = computeStandings(A.data);
  const ptsOf = (name, kind) => (kind === 'd' ? standings.drivers.find((x) => normName(x.driver) === normName(name)) : standings.constructors.find((x) => normName(x.team) === normName(name)))?.points || 0;
  main.innerHTML = `${head(SECTIONS.grid)}
  <div class="grid-cols">
    <div class="panel">
      <div class="grid-head"><h3>Teams <span class="muted small">(${G.teams.length})</span></h3><button class="btn btn-sm btn-primary" data-a="addTeam">+ Add Team</button></div>
      ${G.teams.length ? `<table class="adm-table grid-table"><thead><tr><th>Team Name</th><th>Our Team</th><th class="num">Pts</th><th></th></tr></thead><tbody>
        ${G.teams.map((t) => `<tr data-t="${esc(t.id)}">
          <td><input data-f="name" value="${esc(t.name)}" placeholder="Team name"></td>
          <td><label class="switch sm"><input type="checkbox" data-f="is_ours" ${t.is_ours ? 'checked' : ''}><span class="switch-ui"></span></label></td>
          <td class="num muted">${ptsOf(t.name, 't')}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost danger" data-a="delTeam" title="Remove team">✕</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">No teams yet.</p>'}
    </div>
    <div class="panel">
      <div class="grid-head"><h3>Drivers <span class="muted small">(${G.drivers.length})</span></h3><button class="btn btn-sm btn-primary" data-a="addDriver">+ Add Driver</button></div>
      ${G.drivers.length ? `<table class="adm-table grid-table"><thead><tr><th>Driver Name</th><th>No.</th><th>Team</th><th class="num">Pts</th><th></th></tr></thead><tbody>
        ${G.drivers.map((d) => `<tr data-d="${esc(d.id)}">
          <td><input data-f="name" value="${esc(d.name)}" placeholder="Driver name"></td>
          <td><input data-f="number" value="${esc(d.number || '')}" class="num-in" placeholder="#"></td>
          <td><select data-f="team_id"><option value="">— No team —</option>${G.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === d.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>
          <td class="num muted">${ptsOf(d.name, 'd')}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost danger" data-a="delDriver" title="Remove driver">✕</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">No drivers yet.</p>'}
    </div>
  </div>
  <p class="small muted">Points shown here are calculated from race results using your <a href="#points">Points System</a>. Renaming a driver or team updates their name in every result. Removing someone from this list keeps them in past results and the standings.</p>`;

  main.oninput = (e) => {
    const tr = e.target.closest('tr'), f = e.target.dataset.f; if (!tr || !f || e.target.type === 'checkbox' || e.target.tagName === 'SELECT') return;
    const item = tr.dataset.t ? G.teams.find((t) => t.id === tr.dataset.t) : G.drivers.find((d) => d.id === tr.dataset.d);
    const v = e.target.value.trim(); if (v) item[f] = v; else if (f !== 'name') delete item[f];
    setDirty();
  };
  main.onchange = (e) => {
    const tr = e.target.closest('tr'), f = e.target.dataset.f; if (!tr || !f) return;
    if (tr.dataset.t && f === 'is_ours') { const t = G.teams.find((x) => x.id === tr.dataset.t); if (e.target.checked) t.is_ours = true; else delete t.is_ours; }
    if (tr.dataset.d && f === 'team_id') { const d = G.drivers.find((x) => x.id === tr.dataset.d); if (e.target.value) d.team_id = e.target.value; else delete d.team_id; }
    if (f === 'name') migrateData(A.data); // carry the new name into saved results
    setDirty();
    if (f !== 'name') gridView(main);
  };
  main.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const tr = b.closest('tr');
    if (b.dataset.a === 'addTeam') { G.teams.push({ id: gid('tm'), name: '' }); setDirty(); gridView(main); $$('tr[data-t] input[data-f="name"]', main).pop().focus(); }
    if (b.dataset.a === 'addDriver') { G.drivers.push({ id: gid('dr'), name: '' }); setDirty(); gridView(main); $$('tr[data-d] input[data-f="name"]', main).pop().focus(); }
    if (b.dataset.a === 'delTeam') {
      const t = G.teams.find((x) => x.id === tr.dataset.t), n = G.drivers.filter((d) => d.team_id === t.id).length;
      if (!(await uiConfirm(`${t.name || 'This team'} will be removed from the list${n ? ` and its ${n} driver${n > 1 ? 's' : ''} will be left without a team` : ''}. Past results keep the team name.`, { title: 'Remove Team?', ok: 'Remove', danger: true }))) return;
      G.teams.splice(G.teams.indexOf(t), 1); G.drivers.forEach((d) => { if (d.team_id === t.id) delete d.team_id; }); setDirty(); gridView(main);
    }
    if (b.dataset.a === 'delDriver') {
      const d = G.drivers.find((x) => x.id === tr.dataset.d);
      if (!(await uiConfirm(`${d.name || 'This driver'} will be removed from the list. Their past results stay as they are.`, { title: 'Remove Driver?', ok: 'Remove', danger: true }))) return;
      G.drivers.splice(G.drivers.indexOf(d), 1); setDirty(); gridView(main);
    }
  };
}

// ================================================================ Points System
function pointsView(main) {
  const P = A.data.points;
  const row = (key, label, n) => `<fieldset class="panel pts-fs"><legend>${label}</legend>
    <div class="pts-grid">${Array.from({ length: n }, (_, i) => `<label><span>P${i + 1}</span><input type="number" min="0" step="any" data-k="${key}" data-i="${i}" value="${esc(P[key][i] ?? '')}" placeholder="0"></label>`).join('')}</div></fieldset>`;
  main.innerHTML = `${head(SECTIONS.points, '<button class="btn btn-ghost" data-a="reset">Reset to F1 Defaults</button>')}
    ${row('race', 'Grand Prix — Points per Position', 20)}
    ${row('sprint', 'Sprint — Points per Position', 20)}
    <fieldset class="panel pts-fs"><legend>Fastest Lap Bonus</legend>
      <div class="fgrid">
        <label class="field half">Bonus points — Grand Prix<input type="number" min="0" step="any" data-x="fl_race" value="${esc(P.fl_race ?? 0)}"></label>
        <label class="field half">Bonus points — Sprint<input type="number" min="0" step="any" data-x="fl_sprint" value="${esc(P.fl_sprint ?? 0)}"></label>
        <label class="field half">Only if they finish in the top…<input type="number" min="0" step="1" data-x="fl_top" value="${esc(P.fl_top ?? 0)}"><small class="muted">Use 0 to award it to any finisher.</small></label>
      </div>
      <p class="small muted">Mark the fastest lap with the ⏱ column when entering results. The bonus is added to that driver's points, their team's points and the standings.</p>
    </fieldset>
    <p class="small muted pts-example" id="ptsEx"></p>`;
  const example = () => {
    const win = rowPoints('race', 1, { fl: true }, P), ten = rowPoints('race', 10, { fl: true }, P), eleven = rowPoints('race', 11, { fl: true }, P);
    $('#ptsEx').textContent = `Example: a Grand Prix win with the fastest lap scores ${win} points; P10 with fastest lap scores ${ten}; P11 with fastest lap scores ${eleven}.`;
  };
  const trim = (a) => { const out = [...a]; while (out.length && !Number(out[out.length - 1])) out.pop(); return out; };
  main.oninput = (e) => {
    const t = e.target;
    if (t.dataset.k) { const arr = [...P[t.dataset.k]]; while (arr.length < 20) arr.push(0); arr[Number(t.dataset.i)] = t.value === '' ? 0 : Number(t.value); P[t.dataset.k] = trim(arr); }
    if (t.dataset.x) P[t.dataset.x] = t.value === '' ? 0 : Number(t.value);
    setDirty(); example();
  };
  main.onclick = async (e) => {
    if (e.target.closest('[data-a="reset"]') && await uiConfirm('Grand Prix 25-18-15-12-10-8-6-4-2-1, Sprint 8-7-6-5-4-3-2-1, and +1 for the fastest lap in the Grand Prix (top 10 only).', { title: 'Reset to F1 Defaults?', ok: 'Reset' })) {
      A.data.points = JSON.parse(JSON.stringify(DEFAULT_POINTS)); setDirty(); pointsView(main);
    }
  };
  example();
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
      <div class="panel"><h3>Adding an Admin</h3><ol class="small checklist">
        <li>They open <b>Admin Console</b> (footer of the site) and choose <b>Create account</b>.</li>
        <li>Their name appears in the list below — switch on <b>Admin</b>.</li>
        <li>They reload the console and they're in.</li></ol></div>
      <div class="panel"><h3>GitHub Connection</h3><p class="small muted">Publishing goes to <b>${esc(A.gh.owner)}/${esc(A.gh.repo)}</b>. If the token expires, paste a new one here.</p>
        <button class="btn btn-ghost btn-sm" id="newTok">Replace GitHub Token</button></div>
    </div>
    ${users.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Email</th><th>Admin</th><th>Joined</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr data-uid="${esc(u.uid)}">
      <td><b>${esc(u.username || '—')}</b>${u.uid === me ? ' <span class="pill">you</span>' : ''}</td>
      <td class="muted small">${esc(u.email || '')}</td>
      <td><label class="switch sm"><input type="checkbox" class="adm-toggle" ${adminSet.has(u.uid) ? 'checked' : ''} ${u.uid === me ? 'disabled' : ''}><span class="switch-ui"></span></label></td>
      <td class="muted small">${u.created ? esc(fmtDate(new Date(u.created).toISOString().slice(0, 10))) : '—'}</td>
      <td class="row-actions">${u.uid === me ? '' : '<button class="btn btn-sm btn-ghost danger" data-del>Remove</button>'}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty panel">No accounts yet.</div>'}`;
  $('#newTok').onclick = async () => {
    if (A.dirty && !(await uiConfirm('Replacing the token reloads the console, which throws away changes you haven\'t published yet.', { title: 'Replace GitHub Token?', ok: 'Continue', danger: true }))) return;
    A.dirty = false; A.data = null; githubSetup({ owner: A.gh.owner, repo: A.gh.repo, branch: A.gh.branch });
  };
  $$('tr[data-uid]', main).forEach((tr) => {
    const uid = tr.dataset.uid, name = $('b', tr).textContent;
    $('.adm-toggle', tr).onchange = async (e) => {
      const on = e.target.checked;
      if (on && !(await uiConfirm(`${name} will be able to edit and publish the whole site.`, { title: 'Give Admin Access?', ok: 'Make Admin' }))) { e.target.checked = false; return; }
      try { await Auth.setAdmin(uid, on); toast(on ? `${name} is now an admin` : `Removed admin access from ${name}`, 'ok'); }
      catch (err) { e.target.checked = !on; toast(err.message, 'err'); }
    };
    $('[data-del]', tr)?.addEventListener('click', async () => {
      if (!(await uiConfirm(`${name} will lose admin access and be removed from this list. (Their login itself can be deleted in Firebase → Authentication.)`, { title: 'Remove This Account?', ok: 'Remove', danger: true }))) return;
      try { if (adminSet.has(uid)) await Auth.setAdmin(uid, false); await Auth.deleteUser(uid); tr.remove(); toast('Removed', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
  });
}

boot();
