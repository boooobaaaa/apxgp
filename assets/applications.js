/* =========================================================
   APPLICATIONS — custom application forms.
   Visitors sign in with Google, fill a form; it's stored in Firebase
   (same project as Grid Draft) and posted to a Discord channel.
   Admins accept / waitlist / deny in Admin → Applications, and the
   applicant sees the result on #/apply → My applications.
   ========================================================= */
(() => {
'use strict';
const LG = window.LG;
const { esc, toast } = LG;

const APP_STATUS = {
  pending: ['Under review', 'ap-pending', '⏳'],
  offer: ['Contract to sign', 'ap-offer', '📜'],
  signed: ['Contract signed', 'ap-signed', '✍️'],
  accepted: ['Accepted', 'ap-accepted', '✅'],
  waitlist: ['Waitlisted', 'ap-waitlist', '🕓'],
  denied: ['Not accepted', 'ap-denied', '✖']
};
const badge = st => { const s = APP_STATUS[st] || APP_STATUS.pending; return `<span class="ap-badge ${s[1]}">${s[2]} ${s[0]}</span>`; };
const Q_TYPES = [['short', 'Short answer'], ['long', 'Paragraph'], ['choice', 'One choice (dropdown)'], ['multi', 'Checkboxes (pick any)'], ['number', 'Number'], ['team', 'Pick a team'], ['driver', 'Pick a driver']];
const TEMPLATES = {
  driver: { title: 'Driver application', description: 'Want a seat on the grid? Tell us about yourself — we review every application and you\'ll see the result here.',
    questions: [
      { label: 'Discord username', type: 'short', required: true },
      { label: 'In-game / Roblox username', type: 'short', required: true },
      { label: 'Time zone', type: 'short', required: true, help: 'e.g. CST, GMT+1' },
      { label: 'Racing experience', type: 'long', required: true, help: 'Leagues you\'ve raced in, results, how long you\'ve been racing' },
      { label: 'Preferred team', type: 'team', required: false },
      { label: 'Preferred race number', type: 'number', required: false },
      { label: 'Which races can you attend?', type: 'choice', options: ['All of them', 'Most of them', 'About half', 'Not sure yet'], required: true },
      { label: 'Why do you want to join?', type: 'long', required: true }
    ] },
  staff: { title: 'Staff application', description: 'Help run the league — stewarding, media, broadcast and more.',
    questions: [
      { label: 'Discord username', type: 'short', required: true },
      { label: 'Role(s) you\'re applying for', type: 'multi', options: ['Steward', 'Media & graphics', 'Broadcast / commentary', 'Photographer', 'Moderator'], required: true },
      { label: 'Time zone', type: 'short', required: true },
      { label: 'Relevant experience', type: 'long', required: true },
      { label: 'How many hours a week can you give?', type: 'number', required: false }
    ] },
  team: { title: 'Team staff application', description: 'Apply for a team principal, engineer or management role.',
    questions: [
      { label: 'Discord username', type: 'short', required: true },
      { label: 'Role', type: 'choice', options: ['Team Principal', 'Race Engineer', 'Performance Engineer', 'Team Manager', 'Reserve Driver'], required: true },
      { label: 'Team you\'d like to join', type: 'team', required: false },
      { label: 'Experience', type: 'long', required: true }
    ] }
};
const uidOf = p => p + '-' + Math.random().toString(36).slice(2, 8);
function fromTemplate(k) {
  const t = TEMPLATES[k] || TEMPLATES.driver;
  return { id: uidOf('form'), title: t.title, description: t.description, open: false, questions: t.questions.map(q => Object.assign({ id: uidOf('q'), options: [], help: '', required: false }, JSON.parse(JSON.stringify(q)))) };
}
const forms = d => ((d.applications || {}).forms || []).filter(f => f && f.id);
/* phase 2: the contract a form uses after approval (null = accept straight away) */
function contractFor(d, f) {
  const C = (d.applications || {}).contract || {};
  if (!f || f.contract === 'none') return null;
  if (f.contract === 'custom' && String(f.contractTerms || '').trim()) return { title: f.contractTitle || C.title || 'Terms & Conditions', terms: f.contractTerms, agree: C.agree };
  if (!C.enabled || !String(C.terms || '').trim()) return null;
  return { title: C.title || 'Terms & Conditions', terms: C.terms, agree: C.agree };
}
const openForms = d => forms(d).filter(f => f.open);

/* ---------- answers → text ---------- */
function answerText(d, q, v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (q.type === 'team') { const t = LG.byId(d.teams, v); return t ? t.name : String(v); }
  if (q.type === 'driver') { const x = LG.byId(d.drivers, v); return x ? x.name : String(v); }
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/* ---------- Discord: posts as a "container" (Components V2), falls back to an embed ---------- */
const site = () => location.href.split('#')[0];
const reviewUrl = () => site() + '#/admin/applications';
function container(accent, blocks, button) {
  let budget = 3900;
  const comps = [];
  blocks.filter(b => b != null && b !== '').forEach(b => {
    if (b === '---') return comps.push({ type: 14, divider: true, spacing: 1 });
    const t = String(b).slice(0, Math.max(0, budget)); budget -= t.length;
    if (t) comps.push({ type: 10, content: t });
  });
  const out = { flags: 1 << 15, components: [{ type: 17, accent_color: accent, components: comps }] };
  if (button && /^https:\/\//.test(button.url)) out.components.push({ type: 1, components: [{ type: 2, style: 5, label: button.label, url: button.url }] });
  return out;
}
async function discordPost(s, d, payload) {
  try {
    const cfg = await s.appHook(); if (!cfg || !cfg.url) return false;
    const p = payload(cfg); if (!p) return false;
    const name = { username: (d.league.name || 'League').slice(0, 60) + ' Applications' };
    const send = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, name, body)) });
    const v2url = cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'with_components=true';
    let r = await send(v2url, p.v2);
    if (!r.ok && p.v2.components && (p.v2.embeds || p.v2.components.length > 1)) r = await send(v2url, Object.assign({}, p.v2, { components: p.v2.embeds ? undefined : [p.v2.components[0]] }));
    if (!r.ok && p.legacy) r = await send(cfg.url, p.legacy);
    return r.ok;
  } catch (e) { return false; }
}
const quote = t => String(t).split('\n').map(l => '> ' + l).join('\n');
const hexColor = (h, dflt) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); return m ? parseInt(m[1], 16) : dflt; };
const brand = d => hexColor((d.applications || {}).discordColor, 0xf6cde5);
const styleOf = d => (d.applications || {}).discordStyle || 'columns';
/* two-column card: an embed with inline fields, two per row (a blank spacer fills the 3rd slot);
   paragraph answers span the full width. Link button sent alongside. */
function columnsCard(color, title, desc, pairs, footer, button) {
  const fields = [];
  let row = 0;
  pairs.forEach(([name, value, wide]) => {
    const v = String(value || '—').slice(0, 1000), n = String(name || '—').slice(0, 250);
    if (wide || v.length > 60 || v.includes('\n')) {
      if (row % 2 === 1) fields.push({ name: '​', value: '​', inline: true });
      row = 0; fields.push({ name: n, value: v.length > 60 || v.includes('\n') ? quote(v) : v, inline: false });
    } else {
      fields.push({ name: n, value: v, inline: true }); row++;
      if (row % 2 === 0) fields.push({ name: '​', value: '​', inline: true });
    }
  });
  const out = { embeds: [{ title: title.slice(0, 250), description: desc || undefined, color, fields: fields.slice(0, 25), footer: { text: footer || '' }, timestamp: new Date().toISOString() }] };
  if (button && /^https:\/\//.test(button.url)) out.components = [{ type: 1, components: [{ type: 2, style: 5, label: button.label, url: button.url }] }];
  return out;
}
function notifyNew(s, d, form, app, edited) {
  const title = edited ? '✏️ Application Updated' : '📝 New Application';
  const pairs = [[form.nameLabel || 'Name', app.applicant], ...form.questions.map(q => [q.label || 'Question', answerText(d, q, app.answers[q.id]) || '—', q.type === 'long'])];
  const btn = { label: 'Review Application', url: reviewUrl() };
  const ping = cfg => cfg.ping ? String(cfg.ping).slice(0, 300) : '';
  return discordPost(s, d, cfg => ({
    v2: styleOf(d) === 'columns' ? Object.assign({ content: ping(cfg) || undefined }, columnsCard(brand(d), title, `**${form.title}** · from **${app.applicant}**`, pairs, d.league.name || '', btn))
      : container(brand(d), [
        ping(cfg),
        `## ${title}\n**${form.title}** · from **${app.applicant}**`,
        '---',
        pairs.map(([n, v]) => `**${n}**\n${String(v).length > 80 || String(v).includes('\n') ? quote(String(v).slice(0, 900)) : v}`).join('\n\n'),
        '---',
        `-# ${d.league.name || ''} · <t:${Math.floor(Date.now() / 1000)}:f>`
      ], btn),
    legacy: Object.assign({ content: ping(cfg) || undefined }, columnsCard(brand(d), title, `**${form.title}** · from **${app.applicant}**`, pairs, d.league.name || ''))
  }));
}
const DECISION_COLOR = { accepted: 0x2ecc71, denied: 0xe12885, waitlist: 0x39c5bb, offer: 0xf3d27a, signed: 0xb18cff };
const DECISION_TITLE = { accepted: '✅ Accepted', denied: '✖ Not Accepted', waitlist: '🕓 Waitlisted', offer: '📜 Contract Sent', signed: '✍️ Contract Signed' };
function notifyDecision(s, d, app, status, note, reviewer, extra) {
  const title = `${DECISION_TITLE[status] || status} — ${app.applicant}`, color = DECISION_COLOR[status] || brand(d);
  const btn = status === 'signed' ? { label: 'Confirm in Admin', url: reviewUrl() } : null;
  const desc = `${app.formTitle || 'Application'}${reviewer ? ` · by ${reviewer}` : ''}${extra ? '\n' + extra : ''}${note ? '\n\n' + quote(String(note).slice(0, 1500)) : ''}`;
  return discordPost(s, d, cfg => cfg.decisions === false && status !== 'signed' ? null : ({
    v2: styleOf(d) === 'columns' ? columnsCard(color, title, desc, [], d.league.name || '', btn)
      : container(color, [`## ${title}`, desc, `-# ${d.league.name || ''} · <t:${Math.floor(Date.now() / 1000)}:f>`], btn),
    legacy: columnsCard(color, title, desc, [], d.league.name || '')
  })).catch(() => false);
}

/* ---------- public page ---------- */
const P = { mine: null, loading: false, err: '', tab: '', busy: false };
const draftKey = id => 'league.apply.draft.' + id;
const getDraft = id => { try { return JSON.parse(localStorage.getItem(draftKey(id))) || {}; } catch (e) { return {}; } };
const setDraft = (id, v) => { try { localStorage.setItem(draftKey(id), JSON.stringify(v)); } catch (e) { } };
const clearDraft = id => { try { localStorage.removeItem(draftKey(id)); } catch (e) { } };
window.addEventListener('hashchange', () => { if (/^#\/(apply|join)/.test(location.hash) && !P.loading && !P.busy) { P.mine = null; setTimeout(() => LG.render(false), 0); } });

function field(d, q, v) {
  const nm = 'q_' + q.id, req = q.required ? 'required' : '';
  const lab = `<span>${esc(q.label || 'Question')}${q.required ? ' <b class="ap-req">*</b>' : ''}</span><small class="ap-help">${esc(q.help || '')}</small>`;
  const opts = (q.options || []).filter(Boolean);
  if (q.type === 'long') return `<label class="fld wide">${lab}<textarea name="${nm}" rows="5" maxlength="4000" ${req}>${esc(v || '')}</textarea></label>`;
  if (q.type === 'number') return `<label class="fld">${lab}<input type="number" name="${nm}" value="${esc(v ?? '')}" ${req}></label>`;
  if (q.type === 'choice') return `<label class="fld">${lab}<select name="${nm}" ${req}><option value="">— Choose —</option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  if (q.type === 'team') return `<label class="fld">${lab}<select name="${nm}" ${req}><option value="">— Choose a team —</option>${d.teams.map(t => `<option value="${esc(t.id)}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>`;
  if (q.type === 'driver') return `<label class="fld">${lab}<select name="${nm}" ${req}><option value="">— Choose a driver —</option>${d.drivers.filter(x => x.active !== false).map(x => `<option value="${esc(x.id)}" ${x.id === v ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`;
  if (q.type === 'multi') return `<div class="fld wide" data-q="${esc(q.id)}" role="group">${lab}<div class="ap-multi">${opts.map(o => `<label class="ap-check"><input type="checkbox" name="${nm}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div></div>`;
  return `<label class="fld">${lab}<textarea class="ap-grow" name="${nm}" rows="1" maxlength="1000" ${req}>${esc(v || '')}</textarea></label>`;
}
/* short answers grow as you type, and Enter adds a new line instead of sending the form */
const grow = el => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; };
document.addEventListener('input', e => { if (e.target.classList && e.target.classList.contains('ap-grow')) grow(e.target); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  if (e.target.closest('[data-ap-form], [data-ap-sign]')) e.preventDefault();
});
new MutationObserver(() => document.querySelectorAll('textarea.ap-grow').forEach(el => { if (!el.dataset.g) { el.dataset.g = 1; requestAnimationFrame(() => grow(el)); } })).observe(document.documentElement, { childList: true, subtree: true });

function page(d, sub, mode) {
  const all = openForms(d), s = window.Portal && window.Portal.store(d);
  const head = (t, sub2) => `<div class="page-head"><div class="eyebrow">${esc(d.league.name || '')}</div><h1>${t}</h1>${sub2 ? `<p class="lead">${sub2}</p>` : ''}</div>`;
  if (!s) return `<div class="page">${head('Applications')}<div class="card"><p class="muted">Applications aren't set up on this site yet.</p></div></div>`;
  if (!s.ready) return `<div class="page">${head('Applications')}<p class="muted">Loading…</p></div>`;
  const signedIn = !!s.user;
  if ((P.uid || '') !== (signedIn ? s.user.uid : '')) { P.uid = signedIn ? s.user.uid : ''; P.mine = null; P.tab = ''; }
  if (signedIn && P.mine === null && !P.loading) {
    P.loading = true;
    s.myApps().then(x => { P.mine = x.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); P.err = ''; }).catch(e => { P.mine = []; P.err = e.code || e.message; }).finally(() => { P.loading = false; LG.render(false); });
  }
  const mine = signedIn ? (P.mine || []) : [];
  const mineFor = id => mine.find(a => a.formId === id);
  const who = signedIn ? `<div class="ap-who">Signed in as <b>${esc(s.user.email)}</b> · <a href="javascript:void 0" data-ap="signout">Sign out</a></div>` : '';

  // ----- a single form -----
  const f = sub && sub !== 'status' ? forms(d).find(x => x.id === sub) : null;
  if (f) {
    const ex = mineFor(f.id);
    const canEdit = !ex || ex.status === 'pending';
    if (!f.open && !ex) return `<div class="page">${head(esc(f.title))}<div class="card"><p class="muted">This application is closed right now.</p><a class="btn" href="#/join">← Join the league</a></div></div>`;
    if (!signedIn) return `<div class="page"><a class="back" href="#/join">← Join the league</a>${head(esc(f.title), f.description ? '' : '')}
      ${f.description ? `<div class="card prose" style="margin-bottom:16px">${LG.md(f.description)}</div>` : ''}
      <div class="card ap-signin"><h3>Sign in to apply</h3><p class="muted">We use your Google account so you can come back and check your application's status. Your email is only visible to league admins.</p><button class="btn primary" data-ap="signin">Sign in with Google</button></div></div>`;
    if (ex && mode === 'sign') return `<div class="page"><a class="back" href="#/join">← Join the league</a>${contractPage(d, f, ex)}</div>`;
    if (ex && !canEdit) return `<div class="page"><a class="back" href="#/join">← Join the league</a>${head(esc(f.title))}${statusCard(d, ex, f)}</div>`;
    const dr = ex && !Object.keys(getDraft(f.id)).length ? Object.assign({ __applicant: ex.applicant }, ex.answers) : getDraft(f.id);
    return `<div class="page"><a class="back" href="#/join">← Join the league</a>${head(esc(f.title))}${who}
      ${ex ? `<div class="ok-note">You've already applied — ${badge(ex.status)}. You can still update your answers while it's under review.</div>` : ''}
      ${f.description ? `<div class="card prose" style="margin:14px 0 16px">${LG.md(f.description)}</div>` : ''}
      <form class="card ap-form" data-ap-form="${esc(f.id)}" novalidate>
        <div class="fgrid">
          <label class="fld"><span>${esc(f.nameLabel || 'Your name / nickname')} <b class="ap-req">*</b></span><small class="ap-help">${esc(f.nameLabel ? (f.nameHelp || '') : (f.nameHelp || 'Shown to the admins and in Discord'))}</small><input name="__applicant" value="${esc(dr.__applicant || '')}" maxlength="80" required></label>
          ${f.questions.map(q => field(d, q, dr[q.id])).join('')}
        </div>
        <div class="toolbar" style="margin-top:16px"><button class="btn primary" ${P.busy ? 'disabled' : ''}>${ex ? 'Update my application' : 'Submit application'}</button><span class="hint" style="margin:0">Your answers are saved on this device as you type.</span></div>
      </form></div>`;
  }

  return `<div class="page">${hub(d, sub)}</div>`;
}
/* the "apply + my applications" block — shown on the Join page */
function hub(d, sub) {
  const all = openForms(d), s = window.Portal && window.Portal.store(d);
  if (!s || !forms(d).length) return '';
  if (!s.ready) return '<p class="muted">Loading applications…</p>';
  const signedIn = !!s.user;
  if ((P.uid || '') !== (signedIn ? s.user.uid : '')) { P.uid = signedIn ? s.user.uid : ''; P.mine = null; P.tab = ''; }
  if (signedIn && P.mine === null && !P.loading) {
    P.loading = true;
    s.myApps().then(x => { P.mine = x.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); P.err = ''; }).catch(e => { P.mine = []; P.err = e.code || e.message; }).finally(() => { P.loading = false; LG.render(false); });
  }
  if (sub === 'status') P.tab = 'mine';
  const mine = signedIn ? (P.mine || []) : [], mineFor = id => mine.find(a => a.formId === id);
  const tab = signedIn ? (P.tab || 'open') : 'open';
  const tabs = signedIn ? `<div class="tabs"><button data-ap-tab="open" class="${tab === 'open' ? 'active' : ''}">Apply</button><button data-ap-tab="mine" class="${tab === 'mine' ? 'active' : ''}">My applications${mine.length ? ` <span class="muted">${mine.length}</span>` : ''}</button></div>` : '';
  const list = all.length ? `<div class="ap-list">${all.map(x => { const ex = mineFor(x.id); return `<a class="ap-card" href="#/apply/${esc(x.id)}">
      <div><h4>${esc(x.title)}</h4>${x.description ? `<p class="muted">${esc(LG.plain ? LG.plain(x.description).slice(0, 140) : x.description.slice(0, 140))}</p>` : ''}</div>
      <div class="ap-card-r">${ex ? badge(ex.status) : '<span class="btn primary sm">Apply →</span>'}</div></a>`; }).join('')}</div>` : `<p class="muted">No applications are open right now — check back soon or keep an eye on Discord.</p>`;
  const mineHTML = P.err ? `<div class="warn">${esc(P.err)}</div>` : P.mine === null ? '<p class="muted">Loading your applications…</p>' : mine.length ? mine.map(a => statusCard(d, a, forms(d).find(x => x.id === a.formId))).join('') : '<p class="muted">You haven\'t applied for anything yet.</p>';
  return `<div class="ap-hub">
    ${signedIn ? `<div class="ap-who">Signed in as <b>${esc(s.user.email)}</b> · <a href="javascript:void 0" data-ap="signout">Sign out</a></div>` : ''}
    ${tabs}${tab === 'mine' ? mineHTML : list}
    ${!signedIn ? `<div class="ap-signin-sm"><span class="muted">Already applied?</span><button class="btn sm" data-ap="signin">Sign in to check your status</button></div>` : ''}
  </div>`;
}
function statusCard(d, a, f) {
  const C = contractFor(d, f) || (['offer', 'signed'].includes(a.status) ? {} : null);
  const st = a.status;
  let steps, at;
  if (C && !['denied', 'waitlist'].includes(st)) {
    steps = ['Submitted', 'Under review', st === 'offer' ? 'Sign contract' : 'Contract signed', 'Accepted'];
    at = { pending: 1, offer: 2, signed: 3, accepted: 4 }[st] ?? 1;
  } else {
    steps = ['Submitted', 'Under review', st === 'accepted' ? 'Accepted' : st === 'denied' ? 'Not accepted' : st === 'waitlist' ? 'Waitlisted' : 'Decision'];
    at = st === 'pending' ? 1 : 3;
  }
  const when = t => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `<div class="card ap-status st-${esc(st)}">
    <div class="ap-status-h"><div><div class="eyebrow">${esc(a.formTitle || (f && f.title) || 'Application')}</div><h3>${esc(a.applicant)}</h3></div>${badge(st)}</div>
    <ol class="ap-steps" style="grid-template-columns:repeat(${steps.length},1fr)">${steps.map((x, k) => `<li class="${k < at ? 'done' : k === at ? 'now' : ''}"><span></span>${esc(x)}</li>`).join('')}</ol>
    <p class="muted" style="font-size:13px;margin:6px 0 0">Sent ${esc(when(a.createdAt))}${a.updatedAt && a.updatedAt - a.createdAt > 60000 ? ` · updated ${esc(when(a.updatedAt))}` : ''}${a.signedAt ? ` · signed ${esc(when(a.signedAt))}` : ''}${a.reviewedAt && !['pending', 'offer', 'signed'].includes(st) ? ` · decided ${esc(when(a.reviewedAt))}` : ''}</p>
    ${st === 'offer' && f ? `<div class="ap-action"><div><b>📜 You've been approved!</b><span>Read and sign your contract to finish joining.</span></div><a class="btn primary" href="#/apply/${esc(f.id)}/sign">Read &amp; sign contract</a></div>` : ''}
    ${st === 'signed' ? `<div class="ap-note"><b>Contract signed</b><div>Signed as <span class="ap-sig">${esc(a.signature || '')}</span> — the league will confirm your place shortly.</div></div>` : ''}
    ${a.note && st !== 'pending' ? `<div class="ap-note"><b>Message from the league</b><div class="prose">${LG.md(a.note)}</div></div>` : ''}
    ${a.contract && ['signed', 'accepted'].includes(st) ? `<details class="ap-contract-copy"><summary>View the contract you signed</summary><div class="prose">${LG.md(a.contract)}</div><p class="muted" style="font-size:13px">Signed as <span class="ap-sig">${esc(a.signature || '')}</span>${a.signedAt ? ' on ' + esc(when(a.signedAt)) : ''}</p></details>` : ''}
    <div class="toolbar" style="margin-top:12px">
      ${st === 'pending' && f ? `<a class="btn sm" href="#/apply/${esc(f.id)}">Edit answers</a>` : ''}
      ${['pending', 'denied'].includes(st) ? `<button class="btn sm ghost" data-ap="withdraw" data-id="${esc(a.id)}">${st === 'pending' ? 'Withdraw' : 'Remove so I can reapply'}</button>` : ''}
    </div></div>`;
}
function contractPage(d, f, a) {
  const C = contractFor(d, f) || { title: 'Terms & Conditions', terms: '' };
  if (a.status !== 'offer') return statusCard(d, a, f);
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  return `<div class="contract card">
    <div class="ct-head">${d.league.logo ? `<img src="${esc(LG.asset(d.league.logo))}" alt="" onerror="this.remove()">` : ''}<div><div class="eyebrow">${esc(d.league.name || '')}</div><h1>${esc(C.title)}</h1>
      <p class="muted">Between <b>${esc(d.league.name || 'the league')}</b> and <b>${esc(a.applicant)}</b> · ${esc(a.formTitle || f.title)}</p></div></div>
    ${a.note ? `<div class="ap-note"><b>Message from the league</b><div class="prose">${LG.md(a.note)}</div></div>` : ''}
    <div class="ct-terms prose">${C.terms ? LG.md(C.terms) : '<p class="muted">No terms have been written yet — ask the league admins.</p>'}</div>
    <form class="ct-sign" data-ap-sign="${esc(a.id)}" data-form="${esc(f.id)}">
      <label class="ap-check ct-agree"><input type="checkbox" name="agree" required> <span>${esc(C.agree || 'I have read, understood and agree to the Terms & Conditions above.')}</span></label>
      <div class="ct-sigrow">
        <label class="fld"><span>Type your name to sign</span><input name="signature" maxlength="80" autocomplete="off" placeholder="${esc(a.applicant)}" required></label>
        <div class="ct-sigline"><span class="ap-sig ct-preview">&nbsp;</span><small>Signature · ${esc(today)}</small></div>
      </div>
      <div class="toolbar"><button class="btn primary" ${P.busy ? 'disabled' : ''}>Sign contract</button><span class="hint" style="margin:0">Once signed it's sent to the league for final confirmation.</span></div>
    </form></div>`;
}

function collect(form, f) {
  const fd = new FormData(form), ans = {};
  f.questions.forEach(q => {
    if (q.type === 'multi') ans[q.id] = fd.getAll('q_' + q.id).map(String);
    else if (q.type === 'number') { const v = String(fd.get('q_' + q.id) || '').trim(); ans[q.id] = v === '' ? '' : Number(v); }
    else ans[q.id] = String(fd.get('q_' + q.id) || '').trim().slice(0, q.type === 'long' ? 4000 : 1000);
  });
  return { applicant: String(fd.get('__applicant') || '').trim().slice(0, 80), answers: ans };
}
document.addEventListener('input', e => {
  if (e.target.name === 'signature' && e.target.closest('[data-ap-sign]')) { const p = e.target.closest('form').querySelector('.ct-preview'); if (p) p.textContent = e.target.value || '\u00a0'; return; }
  const form = e.target.closest && e.target.closest('[data-ap-form]'); if (!form) return;
  const f = forms(LG.S.data).find(x => x.id === form.dataset.apForm); if (!f) return;
  const c = collect(form, f); setDraft(f.id, Object.assign({ __applicant: c.applicant }, c.answers));
});
document.addEventListener('change', e => { const form = e.target.closest && e.target.closest('[data-ap-form]'); if (form) form.dispatchEvent(new Event('input', { bubbles: true })); });
document.addEventListener('submit', async e => {
  const sf = e.target.closest && e.target.closest('[data-ap-sign]');
  if (sf) {
    e.preventDefault();
    const d = LG.S.data, s = window.Portal.store(d), f = forms(d).find(x => x.id === sf.dataset.form), a = (P.mine || []).find(x => x.id === sf.dataset.apSign);
    if (!s || !s.user || !f || !a || P.busy) return;
    const sig = String(sf.signature.value || '').trim().slice(0, 80);
    if (!sf.agree.checked) return toast('Tick the box to agree to the terms first', 'err');
    if (sig.length < 2) return toast('Type your name to sign', 'err');
    const C = contractFor(d, f) || { title: 'Terms & Conditions', terms: '' };
    const text = `# ${C.title}\n\n${C.terms || ''}\n\n---\n${C.agree || 'I have read, understood and agree to the Terms & Conditions above.'}`.slice(0, 30000);
    P.busy = true; LG.render(false);
    try {
      await s.signApp(a.id, sig, text);
      notifyDecision(s, d, a, 'signed', '', '', `Signed as **${sig}**`);
      toast('Contract signed ✍️ — the league will confirm your place shortly');
      P.mine = null; P.tab = 'mine'; location.hash = '#/join';
    } catch (err) { toast('Could not sign: ' + (err.code || err.message) + (/permission/.test(err.code || err.message) ? ' — the site admin needs to update the Firebase rules.' : ''), 'err'); }
    P.busy = false; LG.render(false); return;
  }
  const form = e.target.closest && e.target.closest('[data-ap-form]'); if (!form) return;
  e.preventDefault();
  const d = LG.S.data, s = window.Portal.store(d), f = forms(d).find(x => x.id === form.dataset.apForm);
  if (!s || !s.user || !f || P.busy) return;
  const c = collect(form, f);
  const missing = [!c.applicant && `“${f.nameLabel || 'your name'}”`, ...f.questions.filter(q => q.required && (c.answers[q.id] === '' || (Array.isArray(c.answers[q.id]) && !c.answers[q.id].length))).map(q => `“${q.label}”`)].filter(Boolean);
  if (missing.length) return toast('Please fill in ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? '…' : ''), 'err');
  const id = f.id + '_' + s.user.uid, ex = (P.mine || []).find(a => a.id === id);
  P.busy = true; LG.render(false);
  try {
    const app = { formId: f.id, formTitle: f.title, applicant: c.applicant, answers: c.answers };
    if (ex) await s.editApp(id, app); else await s.submitApp(id, app);
    clearDraft(f.id);
    notifyNew(s, d, f, app, !!ex);
    toast(ex ? 'Application updated ✓' : 'Application sent! You\'ll see the result under My applications. 🏁');
    P.mine = null; P.tab = 'mine'; location.hash = '#/join';
  } catch (err) { toast('Could not send: ' + (err.code || err.message) + (/permission/.test(err.code || err.message) ? ' — this form may have closed, or the site admin needs to update the Firebase rules.' : ''), 'err'); }
  P.busy = false; LG.render(false);
});
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('[data-ap-tab]');
  if (t) { P.tab = t.dataset.apTab; if (P.tab === 'mine') P.mine = null; return LG.render(false); }
  const b = e.target.closest && e.target.closest('[data-ap]'); if (!b) return;
  e.preventDefault();
  const d = LG.S.data, s = window.Portal && window.Portal.store(d); if (!s) return;
  const k = b.dataset.ap;
  try {
    if (k === 'signin') { await s.signIn(); P.mine = null; }
    if (k === 'signout') { await s.signOut(); P.mine = null; P.tab = ''; }
    if (k === 'withdraw') { if (!confirm('Withdraw this application? This can\'t be undone.')) return; await s.withdrawApp(b.dataset.id); toast('Application withdrawn'); P.mine = null; }
  } catch (err) { toast((err.code || err.message), 'err'); }
  LG.render(false);
});

window.Apps = { page, hub, badge, APP_STATUS, Q_TYPES, TEMPLATES, fromTemplate, forms, openForms, answerText, notifyDecision, uidOf, contractFor };
})();
