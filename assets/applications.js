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
const openForms = d => forms(d).filter(f => f.open);

/* ---------- answers → text ---------- */
function answerText(d, q, v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (q.type === 'team') { const t = LG.byId(d.teams, v); return t ? t.name : String(v); }
  if (q.type === 'driver') { const x = LG.byId(d.drivers, v); return x ? x.name : String(v); }
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/* ---------- Discord ---------- */
async function discordPost(s, d, payload) {
  try {
    const cfg = await s.appHook(); if (!cfg || !cfg.url) return false;
    const body = payload(cfg); if (!body) return false;
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ username: (d.league.name || 'League').slice(0, 60) + ' Applications' }, body)) });
    return r.ok;
  } catch (e) { return false; }
}
const site = () => location.href.split('#')[0];
function notifyNew(s, d, form, app, edited) {
  return discordPost(s, d, cfg => ({
    content: cfg.ping ? String(cfg.ping).slice(0, 300) : undefined,
    embeds: [{ title: `${edited ? '✏️ Application updated' : '📝 New application'} — ${form.title}`.slice(0, 250), url: site() + '#/admin/applications', color: 0x39c5bb,
      description: `**${app.applicant}** applied${edited ? ' (edited their answers)' : ''}.\nReview it in **Admin → Applications**.`,
      fields: form.questions.slice(0, 24).map(q => ({ name: String(q.label || 'Question').slice(0, 250), value: (answerText(d, q, app.answers[q.id]) || '—').slice(0, 1000) })),
      footer: { text: d.league.name || '' }, timestamp: new Date().toISOString() }]
  }));
}
function notifyDecision(s, d, app, status, note, reviewer) {
  const st = APP_STATUS[status] || APP_STATUS.pending;
  return discordPost(s, d, cfg => cfg.decisions === false ? null : ({
    embeds: [{ title: `${st[2]} ${st[0]} — ${app.applicant}`.slice(0, 250), color: status === 'accepted' ? 0x2ecc71 : status === 'denied' ? 0xe12885 : 0xf3d27a,
      description: `${app.formTitle || 'Application'}${reviewer ? `\nReviewed by ${reviewer}` : ''}${note ? `\n\n> ${String(note).slice(0, 1500)}` : ''}`, footer: { text: d.league.name || '' }, timestamp: new Date().toISOString() }]
  })).catch(() => false);
}

/* ---------- public page ---------- */
const P = { mine: null, loading: false, err: '', tab: '', busy: false };
const draftKey = id => 'league.apply.draft.' + id;
const getDraft = id => { try { return JSON.parse(localStorage.getItem(draftKey(id))) || {}; } catch (e) { return {}; } };
const setDraft = (id, v) => { try { localStorage.setItem(draftKey(id), JSON.stringify(v)); } catch (e) { } };
const clearDraft = id => { try { localStorage.removeItem(draftKey(id)); } catch (e) { } };
window.addEventListener('hashchange', () => { if (/^#\/apply/.test(location.hash) && !P.loading && !P.busy) { P.mine = null; setTimeout(() => LG.render(false), 0); } });

function field(d, q, v) {
  const nm = 'q_' + q.id, req = q.required ? 'required' : '';
  const lab = `<span>${esc(q.label || 'Question')}${q.required ? ' <b class="ap-req">*</b>' : ''}</span>${q.help ? `<small class="ap-help">${esc(q.help)}</small>` : ''}`;
  const opts = (q.options || []).filter(Boolean);
  if (q.type === 'long') return `<label class="fld wide">${lab}<textarea name="${nm}" rows="5" maxlength="4000" ${req}>${esc(v || '')}</textarea></label>`;
  if (q.type === 'number') return `<label class="fld">${lab}<input type="number" name="${nm}" value="${esc(v ?? '')}" ${req}></label>`;
  if (q.type === 'choice') return `<label class="fld">${lab}<select name="${nm}" ${req}><option value="">— Choose —</option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  if (q.type === 'team') return `<label class="fld">${lab}<select name="${nm}" ${req}><option value="">— Choose a team —</option>${d.teams.map(t => `<option value="${esc(t.id)}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>`;
  if (q.type === 'driver') return `<label class="fld">${lab}<select name="${nm}" ${req}><option value="">— Choose a driver —</option>${d.drivers.filter(x => x.active !== false).map(x => `<option value="${esc(x.id)}" ${x.id === v ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`;
  if (q.type === 'multi') return `<fieldset class="fld wide ap-multi" data-q="${esc(q.id)}" ${q.required ? 'data-required="1"' : ''}><legend>${lab}</legend>${opts.map(o => `<label class="ap-check"><input type="checkbox" name="${nm}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</fieldset>`;
  return `<label class="fld">${lab}<input name="${nm}" value="${esc(v || '')}" maxlength="300" ${req}></label>`;
}

function page(d, sub) {
  const all = openForms(d), s = window.Portal && window.Portal.store(d);
  const head = (t, sub2) => `<div class="page-head"><div class="eyebrow">${esc(d.league.name || '')}</div><h1>${t}</h1>${sub2 ? `<p class="lead">${sub2}</p>` : ''}</div>`;
  if (!s) return `<div class="page">${head('Applications')}<div class="card"><p class="muted">Applications aren't set up on this site yet.</p></div></div>`;
  if (!s.ready) return `<div class="page">${head('Applications')}<p class="muted">Loading…</p></div>`;
  const signedIn = !!s.user;
  if (signedIn && P.mine === null && !P.loading) {
    P.loading = true;
    s.myApps().then(x => { P.mine = x.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); P.err = ''; }).catch(e => { P.mine = []; P.err = e.code || e.message; }).finally(() => { P.loading = false; LG.render(false); });
  }
  const mine = P.mine || [];
  const mineFor = id => mine.find(a => a.formId === id);
  const who = signedIn ? `<div class="ap-who">Signed in as <b>${esc(s.user.email)}</b> · <a href="javascript:void 0" data-ap="signout">Sign out</a></div>` : '';

  // ----- a single form -----
  const f = sub && sub !== 'status' ? forms(d).find(x => x.id === sub) : null;
  if (f) {
    const ex = mineFor(f.id);
    const canEdit = !ex || ex.status === 'pending';
    if (!f.open && !ex) return `<div class="page">${head(esc(f.title))}<div class="card"><p class="muted">This application is closed right now.</p><a class="btn" href="#/apply">← All applications</a></div></div>`;
    if (!signedIn) return `<div class="page"><a class="back" href="#/apply">← Applications</a>${head(esc(f.title), f.description ? '' : '')}
      ${f.description ? `<div class="card prose" style="margin-bottom:16px">${LG.md(f.description)}</div>` : ''}
      <div class="card ap-signin"><h3>Sign in to apply</h3><p class="muted">We use your Google account so you can come back and check your application's status. Your email is only visible to league admins.</p><button class="btn primary" data-ap="signin">Sign in with Google</button></div></div>`;
    if (ex && !canEdit) return `<div class="page"><a class="back" href="#/apply">← Applications</a>${head(esc(f.title))}${statusCard(d, ex, f)}</div>`;
    const dr = ex && !Object.keys(getDraft(f.id)).length ? Object.assign({ __applicant: ex.applicant }, ex.answers) : getDraft(f.id);
    return `<div class="page"><a class="back" href="#/apply">← Applications</a>${head(esc(f.title))}${who}
      ${ex ? `<div class="ok-note">You've already applied — ${badge(ex.status)}. You can still update your answers while it's under review.</div>` : ''}
      ${f.description ? `<div class="card prose" style="margin:14px 0 16px">${LG.md(f.description)}</div>` : ''}
      <form class="card ap-form" data-ap-form="${esc(f.id)}" novalidate>
        <div class="fgrid">
          <label class="fld"><span>Your name / nickname <b class="ap-req">*</b></span><small class="ap-help">Shown to the admins and in Discord</small><input name="__applicant" value="${esc(dr.__applicant || '')}" maxlength="80" required></label>
          ${f.questions.map(q => field(d, q, dr[q.id])).join('')}
        </div>
        <div class="toolbar" style="margin-top:16px"><button class="btn primary" ${P.busy ? 'disabled' : ''}>${ex ? 'Update my application' : 'Submit application'}</button><span class="hint" style="margin:0">Your answers are saved on this device as you type.</span></div>
      </form></div>`;
  }

  // ----- list + my applications -----
  const tab = P.tab || (sub === 'status' ? 'mine' : 'open');
  const tabs = signedIn ? `<div class="tabs"><button data-ap-tab="open" class="${tab === 'open' ? 'active' : ''}">Open applications</button><button data-ap-tab="mine" class="${tab === 'mine' ? 'active' : ''}">My applications${mine.length ? ` <span class="muted">${mine.length}</span>` : ''}</button></div>` : '';
  const list = all.length ? `<div class="ap-list">${all.map(x => { const ex = mineFor(x.id); return `<a class="ap-card card" href="#/apply/${esc(x.id)}">
      <div><h3>${esc(x.title)}</h3>${x.description ? `<p class="muted">${esc(LG.plain ? LG.plain(x.description).slice(0, 160) : x.description.slice(0, 160))}</p>` : ''}<span class="muted" style="font-size:12.5px">${x.questions.length} question${x.questions.length === 1 ? '' : 's'}</span></div>
      <div class="ap-card-r">${ex ? badge(ex.status) : '<span class="btn primary sm">Apply →</span>'}</div></a>`; }).join('')}</div>` : `<div class="card"><p class="muted">No applications are open right now — check back soon or keep an eye on Discord.</p></div>`;
  const mineHTML = P.err ? `<div class="warn">${esc(P.err)}</div>` : P.mine === null ? '<p class="muted">Loading your applications…</p>' : mine.length ? mine.map(a => statusCard(d, a, forms(d).find(x => x.id === a.formId))).join('') : '<div class="card"><p class="muted">You haven\'t applied for anything yet.</p></div>';
  return `<div class="page">${head('Applications', 'Apply to race, join a team or help run the league — and track your application here.')}
    ${who}
    ${!signedIn ? `<div class="card ap-signin" style="margin-bottom:18px"><div><b>Already applied?</b><p class="muted" style="margin:4px 0 0">Sign in with the Google account you applied with to see your application status.</p></div><button class="btn" data-ap="signin">Sign in with Google</button></div>` : ''}
    ${tabs}${tab === 'mine' && signedIn ? mineHTML : list}</div>`;
}
function statusCard(d, a, f) {
  const steps = ['Submitted', 'Under review', a.status === 'accepted' ? 'Accepted' : a.status === 'denied' ? 'Not accepted' : a.status === 'waitlist' ? 'Waitlisted' : 'Decision'];
  const at = a.status === 'pending' ? 1 : 2;
  const when = t => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `<div class="card ap-status st-${esc(a.status)}">
    <div class="ap-status-h"><div><div class="eyebrow">${esc(a.formTitle || (f && f.title) || 'Application')}</div><h3>${esc(a.applicant)}</h3></div>${badge(a.status)}</div>
    <ol class="ap-steps">${steps.map((x, k) => `<li class="${k < at ? 'done' : k === at ? 'now' : ''}"><span></span>${esc(x)}</li>`).join('')}</ol>
    <p class="muted" style="font-size:13px;margin:6px 0 0">Sent ${esc(when(a.createdAt))}${a.updatedAt && a.updatedAt - a.createdAt > 60000 ? ` · updated ${esc(when(a.updatedAt))}` : ''}${a.reviewedAt && a.status !== 'pending' ? ` · decided ${esc(when(a.reviewedAt))}` : ''}</p>
    ${a.note && a.status !== 'pending' ? `<div class="ap-note"><b>Message from the league</b><div class="prose">${LG.md(a.note)}</div></div>` : ''}
    <div class="toolbar" style="margin-top:12px">
      ${a.status === 'pending' && f ? `<a class="btn sm" href="#/apply/${esc(f.id)}">Edit answers</a>` : ''}
      ${['pending', 'denied'].includes(a.status) ? `<button class="btn sm ghost" data-ap="withdraw" data-id="${esc(a.id)}">${a.status === 'pending' ? 'Withdraw' : 'Remove so I can reapply'}</button>` : ''}
    </div></div>`;
}

function collect(form, f) {
  const fd = new FormData(form), ans = {};
  f.questions.forEach(q => {
    if (q.type === 'multi') ans[q.id] = fd.getAll('q_' + q.id).map(String);
    else if (q.type === 'number') { const v = String(fd.get('q_' + q.id) || '').trim(); ans[q.id] = v === '' ? '' : Number(v); }
    else ans[q.id] = String(fd.get('q_' + q.id) || '').trim().slice(0, q.type === 'long' ? 4000 : 300);
  });
  return { applicant: String(fd.get('__applicant') || '').trim().slice(0, 80), answers: ans };
}
document.addEventListener('input', e => {
  const form = e.target.closest && e.target.closest('[data-ap-form]'); if (!form) return;
  const f = forms(LG.S.data).find(x => x.id === form.dataset.apForm); if (!f) return;
  const c = collect(form, f); setDraft(f.id, Object.assign({ __applicant: c.applicant }, c.answers));
});
document.addEventListener('change', e => { const form = e.target.closest && e.target.closest('[data-ap-form]'); if (form) form.dispatchEvent(new Event('input', { bubbles: true })); });
document.addEventListener('submit', async e => {
  const form = e.target.closest && e.target.closest('[data-ap-form]'); if (!form) return;
  e.preventDefault();
  const d = LG.S.data, s = window.Portal.store(d), f = forms(d).find(x => x.id === form.dataset.apForm);
  if (!s || !s.user || !f || P.busy) return;
  const c = collect(form, f);
  const missing = [!c.applicant && 'your name', ...f.questions.filter(q => q.required && (c.answers[q.id] === '' || (Array.isArray(c.answers[q.id]) && !c.answers[q.id].length))).map(q => `“${q.label}”`)].filter(Boolean);
  if (missing.length) return toast('Please fill in ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? '…' : ''), 'err');
  const id = f.id + '_' + s.user.uid, ex = (P.mine || []).find(a => a.id === id);
  P.busy = true; LG.render(false);
  try {
    const app = { formId: f.id, formTitle: f.title, applicant: c.applicant, answers: c.answers };
    if (ex) await s.editApp(id, app); else await s.submitApp(id, app);
    clearDraft(f.id);
    notifyNew(s, d, f, app, !!ex);
    toast(ex ? 'Application updated ✓' : 'Application sent! You\'ll see the result under My applications. 🏁');
    P.mine = null; P.tab = 'mine'; location.hash = '#/apply/status';
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

window.Apps = { page, badge, APP_STATUS, Q_TYPES, TEMPLATES, fromTemplate, forms, openForms, answerText, notifyDecision, uidOf };
})();
