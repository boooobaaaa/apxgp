/* =========================================================
   League site — public pages, data loading, standings engine
   All league data lives in data/league.json.
   ========================================================= */
(() => {
'use strict';

const DATA_URL = 'data/league.json';
const DRAFT_KEY = 'league.draft.v1';
const S = { published: null, data: null, isDraft: false, draftStale: false };

/* ---------------- utilities ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const uid = (p = 'x') => p + '-' + Math.random().toString(36).slice(2, 8);
const fmtPts = n => { const v = Math.round((Number(n) || 0) * 10) / 10; return String(v); };
const fmtDate = (iso, o = { day: 'numeric', month: 'short', year: 'numeric' }) => iso ? new Date(iso).toLocaleDateString(undefined, o) : 'TBA';
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
const byId = (arr, id) => (arr || []).find(x => x.id === id);

const DEFAULT_SCORING = {
  race: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  sprint: [8, 7, 6, 5, 4, 3, 2, 1],
  fastestLap: 1, fastestLapTopN: 10, sprintFastestLap: 0, pole: 0
};

const DEFAULT_THEME = { accent: '#39c5bb', accentSoft: '#86cecb', accentDeep: '#137a7f', highlight: '#e12885', bgDark: '#07090c', bgLight: '#f2f8f7', defaultMode: 'dark', allowToggle: true, effects: true };
const DEFAULT_SIGNUPS = { open: false, title: 'Join the grid', intro: '', requirements: '', formUrl: '', seatsPerTeam: 2, showBuilder: true };
const MODE_KEY = 'league.mode';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { } };
const isHex = v => /^#[0-9a-f]{6}$/i.test(v || '');
const rcName = d => String((d.league && d.league.raceControl) || 'KIRA').trim() || 'KIRA';
const HIST_ROLES = ['Race Driver', 'Reserve Driver', 'Academy Driver', 'Race Engineer', 'Team Principal'];
const hasVal = x => x !== '' && x !== null && x !== undefined;
const TZ_BY_CC = { BH: 'Asia/Bahrain', SA: 'Asia/Riyadh', AU: 'Australia/Melbourne', JP: 'Asia/Tokyo', CN: 'Asia/Shanghai', US: 'America/New_York', IT: 'Europe/Rome', MC: 'Europe/Monaco',
  ES: 'Europe/Madrid', CA: 'America/Toronto', AT: 'Europe/Vienna', GB: 'Europe/London', HU: 'Europe/Budapest', BE: 'Europe/Brussels', NL: 'Europe/Amsterdam', AZ: 'Asia/Baku',
  SG: 'Asia/Singapore', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo', QA: 'Asia/Qatar', AE: 'Asia/Dubai', FR: 'Europe/Paris', DE: 'Europe/Berlin', PT: 'Europe/Lisbon',
  TR: 'Europe/Istanbul', RU: 'Europe/Moscow', VN: 'Asia/Ho_Chi_Minh', KR: 'Asia/Seoul', IN: 'Asia/Kolkata', MY: 'Asia/Kuala_Lumpur', AR: 'America/Argentina/Buenos_Aires', ZA: 'Africa/Johannesburg' };
const trackTz = r => r.tz || TZ_BY_CC[String(r.country || '').toUpperCase()] || '';
function fmtIn(iso, tz, opts) { try { return new Date(iso).toLocaleString(undefined, Object.assign({}, opts, tz ? { timeZone: tz } : {})); } catch (e) { return ''; } }

function emptyLeague() {
  return {
    league: { name: 'My F1 League', season: String(new Date().getFullYear()), tagline: '', logo: '', rules: '', links: {} },
    settings: { adminHash: '' },
    scoring: clone(DEFAULT_SCORING),
    teams: [], drivers: [], calendar: [], results: {}, adjustments: [], news: [], stewards: [], history: [],
    theme: clone(DEFAULT_THEME), signups: clone(DEFAULT_SIGNUPS),
    meta: { updated: null }
  };
}

function normalize(x) {
  const base = emptyLeague();
  const d = Object.assign(base, x || {});
  d.league = Object.assign(emptyLeague().league, d.league || {});
  d.league.links = d.league.links || {};
  d.applications = Object.assign({ forms: [] }, d.applications || {}); if (!Array.isArray(d.applications.forms)) d.applications.forms = [];
  d.settings = Object.assign({ adminHash: '' }, d.settings || {});
  if (!d.league.rcKira) { if (!d.league.raceControl || /^\s*fia\s*$/i.test(d.league.raceControl)) d.league.raceControl = 'KIRA'; d.league.rcKira = true; }
  (d.drivers || []).forEach(x => (x.history || []).forEach(h => { const m = h && HIST_ROLES.find(r => r.toLowerCase() === String(h.role || '').trim().toLowerCase().replace('principle', 'principal')); if (m) h.role = m; }));
  d.scoring = Object.assign(clone(DEFAULT_SCORING), d.scoring || {});
  d.theme = Object.assign(clone(DEFAULT_THEME), d.theme || {});
  d.signups = Object.assign(clone(DEFAULT_SIGNUPS), d.signups || {});
  ['teams', 'drivers', 'calendar', 'adjustments', 'news', 'stewards', 'history'].forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
  if (!d.results || typeof d.results !== 'object' || Array.isArray(d.results)) d.results = {};
  d.meta = d.meta || { updated: null };
  return d;
}

function themeMode(d) {
  const t = d.theme;
  let m = t.defaultMode || 'dark';
  if (t.allowToggle !== false) {
    const saved = lsGet(MODE_KEY), v = lsGet(MODE_KEY + '.v');
    // a visitor's own choice only counts while the site's default is the one they chose against
    if ((saved === 'light' || saved === 'dark') && v === String(t.defaultMode || 'dark')) m = saved;
  }
  if (m === 'system') m = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return m === 'light' ? 'light' : 'dark';
}
function applyTheme(d) {
  const t = d.theme, r = document.documentElement;
  const set = (k, v, f) => r.style.setProperty(k, isHex(v) ? v : f);
  set('--miku', t.accent, DEFAULT_THEME.accent);
  set('--miku-soft', t.accentSoft, DEFAULT_THEME.accentSoft);
  set('--miku-deep', t.accentDeep, DEFAULT_THEME.accentDeep);
  set('--pink', t.highlight, DEFAULT_THEME.highlight);
  set('--bg-dark', t.bgDark, DEFAULT_THEME.bgDark);
  set('--bg-light', t.bgLight, DEFAULT_THEME.bgLight);
  const mode = themeMode(d);
  r.dataset.theme = mode;
  r.dataset.effects = t.effects === false ? 'off' : 'on';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = mode === 'light' ? (isHex(t.bgLight) ? t.bgLight : DEFAULT_THEME.bgLight) : (isHex(t.bgDark) ? t.bgDark : DEFAULT_THEME.bgDark);
  const mt = document.getElementById('mode-toggle');
  if (mt) { mt.hidden = t.allowToggle === false; mt.textContent = mode === 'light' ? '☾' : '☀'; mt.title = mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'; }
}

function flag(cc, cls = '') {
  if (!cc || !/^[a-z]{2}$/i.test(cc)) return '';
  return `<img class="flag ${cls}" src="https://flagcdn.com/w80/${cc.toLowerCase()}.png" alt="${esc(cc.toUpperCase())}" loading="lazy" onerror="this.remove()">`;
}

function nameHTML(n) {
  const parts = String(n || 'Unknown').trim().split(/\s+/);
  const last = parts.pop();
  return `<span class="dname">${parts.length ? `<span class="fn">${esc(parts.join(' '))}</span> ` : ''}<span class="ln">${esc(last)}</span></span>`;
}

const teamColor = t => (t && t.color) || '#39c5bb';
/* freshly uploaded files show from memory until GitHub Pages has rebuilt */
const ASSET_CACHE = {};
const asset = u => ASSET_CACHE[u] || u;
const isImg = u => /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(String(u || '')) || /^data:image\//.test(String(u || ''));
function avatar(drv, t, size = '') {
  const src = drv && (drv.headshot || drv.photo);
  return `<span class="avatar ${size}" style="--tc:${esc(teamColor(t))}">${src ? `<img src="${esc(asset(src))}" alt="" loading="lazy" onerror="this.remove()">` : esc(drv && drv.number !== undefined ? drv.number : '')}</span>`;
}

/* tiny markdown: # headings, **bold**, *italic*, [links](https://…), - lists, paragraphs */
function md(src) {
  const inline = s => s
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, (m, c) => `&#${c.charCodeAt(0)};`)
    .replace(/!\[([^\]]*)\]\(((?:https?:\/\/|uploads\/|images\/)[^\s)]+)\)/g, (m, alt, u) => `<img class="md-img zoomable" src="${asset(u)}" alt="${alt}" loading="lazy">`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\((#\/[^\s)]*)\)/g, '<a href="$2">$1</a>');
  let html = '', para = [], list = null, table = null, quote = null;
  const flushP = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const flushL = () => {
    if (!list) return;
    let i = 0;
    const out = lvl => {
      const ord = list[i].ord, tag = ord ? 'ol' : 'ul';
      let h = `<${tag}${ord && list[i].n > 1 ? ` start="${list[i].n}"` : ''}>`;
      while (i < list.length && list[i].lvl >= lvl) {
        if (list[i].lvl > lvl) { h = h.replace(/<\/li>$/, '') + out(list[i].lvl) + '</li>'; continue; }
        h += `<li>${inline(list[i].text)}</li>`; i++;
      }
      return h + `</${tag}>`;
    };
    while (i < list.length) html += out(list[i].lvl);
    list = null;
  };
  const flushT = () => {
    if (!table) return;
    const rows = table.filter(r => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(r));
    const hasHead = table.length > 1 && /^\|?\s*:?-{2,}/.test(table[1]);
    const cells = r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));
    html += `<div class="md-table"><table>${rows.map((r, k) => `<tr>${cells(r).map(c => k === 0 && hasHead ? `<th>${c}</th>` : `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
    table = null;
  };
  const flushQ = () => { if (quote) { html += `<blockquote>${quote.map(inline).join('<br>')}</blockquote>`; quote = null; } };
  const flush = () => { flushP(); flushL(); flushT(); flushQ(); };
  for (const raw of esc(src || '').split(/\r?\n/)) {
    const t = raw.trim(); let m;
    if (!t) { flush(); continue; }
    if (t.startsWith('|')) { flushP(); flushL(); flushQ(); (table = table || []).push(t); continue; }
    if ((m = t.match(/^&gt;\s?(.*)/))) { flushP(); flushL(); flushT(); (quote = quote || []).push(m[1]); continue; }
    if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) { flush(); html += `<figure>${inline(t)}${m[1] ? `<figcaption>${m[1]}</figcaption>` : ''}</figure>`; continue; }
    if ((m = t.match(/^(#{1,6})\s+(.*)/))) { flush(); const lv = Math.min(6, m[1].length + 1); html += `<h${lv}>${inline(m[2])}</h${lv}>`; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); html += '<hr>'; continue; }
    if ((m = raw.match(/^(\s*)([-*+]|(\d+)[.)])\s+(.*)/))) {
      flushP(); flushT(); flushQ();
      (list = list || []).push({ lvl: Math.min(4, Math.floor(m[1].replace(/\t/g, '    ').length / 2)), ord: !!m[3], n: Number(m[3]) || 1, text: m[4] });
      continue;
    }
    if (list && /^\s{2,}/.test(raw)) { list[list.length - 1].text += ' ' + t; continue; }
    flushL(); flushT(); flushQ(); para.push(t);
  }
  flush();
  return html;
}

/* ---------------- rulebook: parse markdown into chapters & points ---------------- */
const NUM_RE = /^(?:(chapter|part|section|article|art\.?|rule|appendix)\s+)?((?:[A-Z]{0,2}\d+|[IVXLC]+)(?:\.\d+)*)[.)]?(?:\s*[-–—:.]\s*|\s+|$)(.*)$/i;
function splitNum(title) {
  const m = String(title || '').match(NUM_RE);
  return m && (m[3] || m[1]) ? { num: (/^appendix$/i.test(m[1] || '') ? 'App. ' : '') + m[2], title: m[3].trim() } : { num: '', title: String(title || '').trim() };
}
/* Google Docs "Download → Markdown" clean-up: heading anchors {#…}, the linked contents list,
   backslash escapes, and regulation tables (| **A1.1.1** | text |) turned into numbered points. */
const RULE_NO = /^[A-Z]{0,2}\d+(?:\.\d+)+\.?$/;
function cleanDocsMd(src) {
  const cells = row => { const t = row.trim().replace(/^\|/, '').replace(/\|$/, ''); return t.split(/(?<!\\)\|/).map(c => c.trim()); };
  const strip = c => c.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  const lines = String(src || '').replace(/ /g, ' ').split(/\r?\n/)
    .map(l => l.replace(/\s*\{#[^}\n]*\}\s*$/, '').replace(/\t+/g, '  ').replace(/\\([-.()[\]#*_+!=~>])/g, '$1'))
    .filter(l => !/^\s*\[[^\]]*\]\(#[^)]*\)\s*$/.test(l) && !/^\s*\**contents:?\**\s*$/i.test(l));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) { out.push(lines[i]); continue; }
    let j = i; const block = [];
    while (j < lines.length && /^\s*\|/.test(lines[j])) block.push(lines[j++]);
    const rows = block.filter(r => !/^:?-{2,}/.test(r.trim().replace(/^\|\s*/, ''))).map(cells);
    const isReg = rows.some(r => RULE_NO.test(strip(r[0] || '')) || /^[A-Z]{0,2}\d+(\.\d+)+\s+\S/.test(strip(r[0] || '')));
    const oneCol = rows.every(r => r.filter(Boolean).length <= 1);
    if (!isReg && !oneCol) { out.push(...block); i = j - 1; continue; }
    rows.forEach(r => {
      const a = strip(r[0] || ''), rest = r.slice(1).filter(Boolean).join(' ').trim();
      if (!a && !rest) return;
      const sm = a.match(/^([A-Z]{0,2}\d+(?:\.\d+)+)\.?\s+(\S.*)$/);
      if (sm && !rest) out.push('', `## ${sm[1]} ${sm[2]}`, '');
      else if (RULE_NO.test(a)) out.push('', `**${a.replace(/\.$/, '')}** ${rest}`.trim(), '');
      else if (oneCol) out.push('', (r.find(Boolean) || '').trim(), '');
      else out.push('', [r[0], rest].filter(Boolean).join(' — '), '');
    });
    i = j - 1;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
function parseRulebook(src, opts = {}) {
  if (/\{#[^}]+\}|^\s*\|\s*\**[A-Z]{0,2}\d+(\.\d+)+/m.test(src || '')) src = cleanDocsMd(src);
  let lines = String(src || '').replace(/ /g, ' ').split(/\r?\n/);
  let heads = lines.map((l, i) => { const m = l.match(/^(#{1,6})\s+(.*)/); return m ? { i, lv: m[1].length, text: m[2].replace(/\*\*|__/g, '').trim() } : null; }).filter(Boolean);
  if (!heads.length) {
    // no heading styles — fall back to "Chapter 1 …" lines and "1.1 …" points
    lines = lines.map(l => {
      const t = l.trim();
      if (/^(chapter|part)\s+(\d+|[ivxlc]+)\b/i.test(t) && t.length < 120) return '# ' + t;
      if (/^\d+\.\d+(\.\d+)*\.?\s+\S/.test(t)) return '## ' + t;
      return l;
    });
    heads = lines.map((l, i) => { const m = l.match(/^(#{1,6})\s+(.*)/); return m ? { i, lv: m[1].length, text: m[2].trim() } : null; }).filter(Boolean);
  }
  const res = { title: '', intro: '', chapters: [] };
  if (!heads.length) { res.intro = lines.join('\n'); return res; }
  const minLv = Math.min(...heads.map(h => h.lv));
  let chLv = minLv, titleLine = -1;
  const top = heads.filter(h => h.lv === minLv);
  if (top.length === 1 && heads[0].lv === minLv && heads.some(h => h.lv > minLv)) {
    titleLine = heads[0].i; res.title = heads[0].text;
    chLv = Math.min(...heads.filter(h => h.lv > minLv).map(h => h.lv));
  }
  const deeper = heads.filter(h => h.lv > chLv).map(h => h.lv);
  const secLv = deeper.length ? Math.min(...deeper) : 0;
  let ch = null, sec = null;
  const intro = [];
  lines.forEach((l, i) => {
    if (i === titleLine) return;
    const m = l.match(/^(#{1,6})\s+(.*)/);
    const lv = m ? m[1].length : 0, text = m ? m[2].replace(/\*\*|__/g, '').trim() : '';
    if (m && lv === chLv) { ch = { ...splitNum(text), raw: text, intro: [], sections: [] }; sec = null; res.chapters.push(ch); return; }
    if (m && secLv && lv === secLv && ch) { sec = { ...splitNum(text), raw: text, body: [] }; ch.sections.push(sec); return; }
    if (m && lv < chLv) return;
    const line = m && lv > secLv ? '#'.repeat(Math.min(6, lv - secLv + 2)) + ' ' + text : l;
    if (sec) sec.body.push(line); else if (ch) ch.intro.push(line); else intro.push(line);
  });
  while (intro.length && !intro[0].trim()) intro.shift();
  if (!res.title && intro.length) { const f = intro[0].trim().replace(/^\*\*(.*)\*\*$/, '$1'); if (f.length < 90 && !/[.:]$/.test(f) && !/^[-*|>!]/.test(f)) { res.title = f; intro.shift(); } }
  res.intro = intro.join('\n').trim();
  const auto = opts.autoNumber !== false && !res.chapters.some(c => c.num);
  res.chapters.forEach((c, ci) => {
    c.id = 'c' + (ci + 1);
    if (!c.num && auto) c.num = String(ci + 1);
    c.intro = c.intro.join('\n').trim();
    c.sections.forEach((x, si) => {
      x.id = 's' + (si + 1);
      if (!x.num && auto) x.num = (c.num && /^\d+$/.test(c.num) ? c.num : ci + 1) + '.' + (si + 1);
      x.body = x.body.join('\n').trim();
      if (!x.title) { const w = plain(x.body).split(' '); x.label = w.slice(0, 7).join(' ') + (w.length > 7 ? '…' : ''); }
    });
  });
  return res;
}

/* ---------------- Google Docs (clipboard or exported .html) → markdown ---------------- */
function htmlToMd(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const boldC = new Set(), italC = new Set();
  doc.querySelectorAll('style').forEach(st => {
    for (const m of st.textContent.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      if (/font-weight:\s*(700|bold)/.test(m[2])) boldC.add(m[1]);
      if (/font-style:\s*italic/.test(m[2])) italC.add(m[1]);
    }
  });
  doc.querySelectorAll('style,script,meta,title,head').forEach(e => e.remove());
  const isBold = el => /^(B|STRONG)$/.test(el.tagName) && !/font-weight:\s*(normal|[1-5]00)/.test(el.getAttribute('style') || '') || /font-weight:\s*(bold|[6-9]00)/.test(el.getAttribute('style') || '') || [...el.classList].some(c => boldC.has(c));
  const isItal = el => /^(I|EM)$/.test(el.tagName) || /font-style:\s*italic/.test(el.getAttribute('style') || '') || [...el.classList].some(c => italC.has(c));
  const href = a => { let h = a.getAttribute('href') || ''; try { const u = new URL(h); if (/google\.com$/.test(u.hostname) && u.pathname === '/url') h = u.searchParams.get('q') || h; } catch (e) { } return h; };
  const escMd = t => t.replace(/([\\*_`\[\]|])/g, '\\$1');
  const runs = (node, fmt = {}, out = []) => {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { out.push({ t: n.textContent.replace(/[\s ]+/g, ' '), ...fmt }); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'BR') { out.push({ t: '\n', br: 1 }); return; }
      if (n.tagName === 'IMG') return;
      const f = { ...fmt };
      if (isBold(n)) f.b = 1;
      if (isItal(n)) f.i = 1;
      if (n.tagName === 'A' && n.getAttribute('href')) f.a = href(n);
      runs(n, f, out);
    });
    return out;
  };
  const inl = node => {
    const rs = runs(node);
    const merged = [];
    rs.forEach(r => { const l = merged[merged.length - 1]; if (l && !r.br && !l.br && l.b === r.b && l.i === r.i && l.a === r.a) l.t += r.t; else merged.push({ ...r }); });
    return merged.map(r => {
      if (r.br) return '\n';
      const m = r.t.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m[2]) return r.t;
      let x = escMd(m[2]);
      if (r.i) x = `*${x}*`;
      if (r.b) x = `**${x}**`;
      if (r.a && /^(https?:|mailto:)/.test(r.a)) x = `[${x}](${r.a})`;
      return m[1] + x + m[3];
    }).join('').replace(/[ \t]+\n/g, '\n').trim();
  };
  const lines = [];
  const para = t => { if (t) lines.push(t.replace(/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/, m => '\\' + m), ''); };
  const walk = (node, depth = 0) => {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { para(n.textContent.trim()); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (/^H[1-6]$/.test(tag)) { const t = inl(n).replace(/\n/g, ' '); if (t) lines.push('#'.repeat(+tag[1]) + ' ' + t.replace(/^\*\*(.*)\*\*$/, '$1'), ''); return; }
      if (tag === 'P') { para(inl(n)); return; }
      if (tag === 'UL' || tag === 'OL') {
        n.querySelectorAll(':scope > li').forEach(li => {
          const lvl = Math.max(0, (Number(li.getAttribute('aria-level')) || 1) - 1) + depth;
          const clone = li.cloneNode(true); clone.querySelectorAll('ul,ol').forEach(x => x.remove());
          lines.push('  '.repeat(lvl) + (tag === 'OL' ? '1. ' : '- ') + inl(clone).replace(/\n/g, ' '));
          li.querySelectorAll(':scope > ul, :scope > ol').forEach(sub => walk({ childNodes: [sub] }, lvl + 1));
        });
        lines.push(''); return;
      }
      if (tag === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inl(td).replace(/\n/g, ' ').replace(/\|/g, '\\|')));
        if (rows.length) {
          const w = Math.max(...rows.map(r => r.length));
          rows.forEach((r, k) => { while (r.length < w) r.push(''); lines.push('| ' + r.join(' | ') + ' |'); if (k === 0) lines.push('|' + ' --- |'.repeat(w)); });
          lines.push('');
        }
        return;
      }
      if (tag === 'HR') { lines.push('---', ''); return; }
      walk(n, depth);
    });
  };
  walk(doc.body);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const plain = src => String(src || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_\[\]()>|]/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

function toast(msg, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

/* ---------------- data loading & drafts ---------------- */
async function load() {
  let pub = null;
  try {
    const r = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) pub = await r.json();
  } catch (e) { /* offline or file:// */ }
  if (!pub && window.EMBEDDED_LEAGUE) pub = window.EMBEDDED_LEAGUE;
  if (!pub) pub = emptyLeague();
  S.published = normalize(pub);

  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { }
  if (draft && draft.data) {
    S.data = normalize(draft.data);
    S.isDraft = true;
    S.draftStale = (draft.base || null) !== (S.published.meta.updated || null);
  } else {
    S.data = clone(S.published);
  }
}

function saveDraft() {
  S.isDraft = true;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ base: S.published.meta.updated || null, saved: new Date().toISOString(), data: S.data })); }
  catch (e) { toast('Could not save draft in this browser (storage full?). Download a backup!', 'err'); }
  updateDraftBanner();
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { }
  S.isDraft = false; S.draftStale = false;
  updateDraftBanner();
}
function discardDraft() {
  S.data = clone(S.published);
  clearDraft(); render(); toast('Draft discarded — showing the published site.');
}
function updateDraftBanner() {
  const b = document.getElementById('draft-banner');
  if (!b) return;
  const inAdmin = location.hash.startsWith('#/admin');
  if (!S.isDraft || inAdmin) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<span>👀 You're previewing <b>unpublished changes</b> (only visible in this browser).${S.draftStale ? ' ⚠️ The live site changed since this draft was started.' : ''}</span>
    <a class="btn xs primary" href="#/admin/publish">Publish</a>
    <button class="btn xs ghost" data-act="discard-draft">Discard</button>`;
}

/* ---------------- league maths ---------------- */
const rounds = d => [...d.calendar].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0));
const session = (d, rid, s) => (d.results[rid] && Array.isArray(d.results[rid][s])) ? d.results[rid][s] : [];
const isDone = (d, r) => session(d, r.id, 'race').length > 0;
const nextRound = d => rounds(d).find(r => !isDone(d, r) && !r.cancelled);
const lastRound = d => rounds(d).filter(r => isDone(d, r)).pop();

function poleDriver(d, rid) {
  const flagged = session(d, rid, 'race').find(e => e.pole);
  if (flagged) return flagged.driverId;
  const q = classify(session(d, rid, 'quali'), 'quali', d.scoring);
  return q.length && q[0].pos === 1 ? q[0].driverId : null;
}

/* Turns an ordered list of entries into classified rows with positions & points.
   Order in the array = finishing order. Non-finishers (DNF/DSQ/DNS) get no position. */
function classify(entries, type, sc, pole) {
  const fin = [], other = [];
  (entries || []).forEach(e => ((e.status || 'FIN') === 'FIN' ? fin : other).push(e));
  const table = type === 'race' ? (sc.race || []) : type === 'sprint' ? (sc.sprint || []) : [];
  const hasOverride = e => e.pointsOverride !== undefined && e.pointsOverride !== null && e.pointsOverride !== '';
  const out = fin.map((e, i) => {
    const pos = i + 1;
    let pts = Number(table[i]) || 0;
    if (type !== 'quali' && e.fastestLap) {
      const fl = Number(type === 'race' ? sc.fastestLap : sc.sprintFastestLap) || 0;
      const topN = Number(sc.fastestLapTopN) || 0;
      if (fl && (!topN || pos <= topN)) pts += fl;
    }
    if (type === 'race' && pole && e.driverId === pole) pts += Number(sc.pole) || 0;
    if (hasOverride(e)) pts = Number(e.pointsOverride) || 0;
    return { ...e, status: 'FIN', pos, label: String(pos), pts };
  });
  const order = { DNF: 0, DSQ: 1, DNS: 2 };
  other.map((e, i) => ({ e, i })).sort((a, b) => (order[a.e.status] ?? 9) - (order[b.e.status] ?? 9) || a.i - b.i)
    .forEach(({ e }) => {
      let pts = 0;
      if (type === 'race' && pole && e.driverId === pole && e.status !== 'DSQ') pts += Number(sc.pole) || 0;
      if (hasOverride(e)) pts = Number(e.pointsOverride) || 0;
      out.push({ ...e, pos: null, label: e.status, pts });
    });
  if (type === 'quali') out.forEach(o => { o.pts = 0; });
  return out;
}

function countback(a, b) {
  const n = Math.max(a.counts.length, b.counts.length);
  for (let i = 0; i < n; i++) { const diff = (b.counts[i] || 0) - (a.counts[i] || 0); if (diff) return diff; }
  return 0;
}

function computeStandings(d) {
  const sc = d.scoring, D = {}, T = {};
  const dRow = id => D[id] || (D[id] = { id, points: 0, wins: 0, podiums: 0, poles: 0, fls: 0, dnfs: 0, starts: 0, best: null, adj: 0, counts: [], rounds: {}, lastTeam: null });
  const tRow = id => T[id] || (T[id] = { id, points: 0, wins: 0, podiums: 0, poles: 0, adj: 0, counts: [], rounds: {} });
  d.drivers.forEach(x => dRow(x.id));
  d.teams.forEach(x => tRow(x.id));

  for (const r of rounds(d)) {
    if (!d.results[r.id]) continue;
    const pole = poleDriver(d, r.id);
    for (const type of ['sprint', 'race']) {
      for (const e of classify(session(d, r.id, type), type, sc, pole)) {
        if (!e.driverId) continue;
        const dr = dRow(e.driverId), tr = e.teamId ? tRow(e.teamId) : null;
        dr.points += e.pts; if (tr) tr.points += e.pts;
        const rr = dr.rounds[r.id] || (dr.rounds[r.id] = { pts: 0 });
        rr.pts += e.pts; rr[type] = { pos: e.pos, label: e.label, pts: e.pts, teamId: e.teamId, fl: !!e.fastestLap };
        if (tr) { const tt = tr.rounds[r.id] || (tr.rounds[r.id] = { pts: 0 }); tt.pts += e.pts; }
        if (type === 'race') {
          if (e.teamId) dr.lastTeam = e.teamId;
          if (e.status !== 'DNS') dr.starts++;
          if (e.status === 'DNF') dr.dnfs++;
          if (e.fastestLap) dr.fls++;
          if (e.pos) {
            dr.counts[e.pos - 1] = (dr.counts[e.pos - 1] || 0) + 1;
            if (tr) tr.counts[e.pos - 1] = (tr.counts[e.pos - 1] || 0) + 1;
            if (e.pos === 1) { dr.wins++; if (tr) tr.wins++; }
            if (e.pos <= 3) { dr.podiums++; if (tr) tr.podiums++; }
            if (!dr.best || e.pos < dr.best) dr.best = e.pos;
          }
        }
      }
    }
    if (pole) {
      dRow(pole).poles++;
      const pe = session(d, r.id, 'race').find(e => e.driverId === pole) || session(d, r.id, 'quali').find(e => e.driverId === pole);
      if (pe && pe.teamId) tRow(pe.teamId).poles++;
    }
  }
  for (const a of d.adjustments) {
    if (!a.targetId) continue;
    const row = a.type === 'team' ? tRow(a.targetId) : dRow(a.targetId);
    const p = Number(a.points) || 0;
    row.points += p; row.adj += p;
    if (a.roundId) { const rr = row.rounds[a.roundId] || (row.rounds[a.roundId] = { pts: 0 }); rr.pts += p; rr.adj = (rr.adj || 0) + p; }
  }
  for (const s of d.stewards) {
    const p = Number(s.points) || 0;
    if (!s.driverId || !p) continue;
    const bump = row => { row.points += p; row.adj += p; if (s.roundId) { const rr = row.rounds[s.roundId] || (row.rounds[s.roundId] = { pts: 0 }); rr.pts += p; rr.adj = (rr.adj || 0) + p; } };
    bump(dRow(s.driverId));
    if (s.teamToo) {
      const ent = s.roundId ? [...session(d, s.roundId, 'race'), ...session(d, s.roundId, 'sprint')].find(e => e.driverId === s.driverId) : null;
      const tid = (ent && ent.teamId) || (byId(d.drivers, s.driverId) || {}).teamId;
      if (tid) bump(tRow(tid));
    }
  }
  const cmp = (a, b) => b.points - a.points || countback(a, b);
  const drivers = Object.values(D).filter(x => {
    const drv = byId(d.drivers, x.id);
    return (drv && drv.active !== false) || x.starts > 0 || x.points !== 0;
  }).sort(cmp);
  drivers.forEach((x, i) => { x.position = i + 1; });
  const teams = Object.values(T).filter(x => byId(d.teams, x.id) || x.points !== 0).sort(cmp);
  teams.forEach((x, i) => { x.position = i + 1; });
  return { drivers, teams, D, T };
}

const driverTeam = (d, drv, st) => byId(d.teams, (drv && drv.teamId) || (st && st.lastTeam));
const driverLabel = (d, id) => byId(d.drivers, id) || { id, name: 'Unknown driver', number: '' };
const teamLabel = (d, id) => byId(d.teams, id) || { id, name: id ? 'Unknown team' : '—', color: '#555' };

/* ---------------- shared snippets ---------------- */
const head = (eyebrow, title, sub) => `<div class="page-head"><div class="eyebrow">${esc(eyebrow)}</div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>`;
const empty = (t, s) => `<div class="empty"><b>${esc(t)}</b>${s || ''}</div>`;
const teamCell = t => `<span class="swatch" style="--tc:${esc(teamColor(t))}"></span><span class="team-name">${esc(t ? t.name : '—')}</span>`;
const sessionName = s => ({ race: 'Race', sprint: 'Sprint', quali: 'Qualifying' }[s] || s);

function roundStatus(d, r) {
  if (r.cancelled) return ['cancelled', 'Cancelled'];
  if (isDone(d, r)) return ['done', 'Completed'];
  const n = nextRound(d);
  if (n && n.id === r.id) {
    if (r.start && new Date(r.start) < Date.now()) return ['live', 'Results pending'];
    return ['next', 'Next race'];
  }
  return ['upcoming', 'Upcoming'];
}

function countdownHTML(iso) {
  if (!iso) return `<div class="countdown over">Date to be announced</div>`;
  return `<div class="countdown" data-countdown="${esc(iso)}">
    <div><b data-u="d">00</b><span>Days</span></div><div><b data-u="h">00</b><span>Hrs</span></div>
    <div><b data-u="m">00</b><span>Min</span></div><div><b data-u="s">00</b><span>Sec</span></div></div>`;
}
function tick() {
  document.querySelectorAll('[data-cd-short]').forEach(el => {
    const ms = new Date(el.dataset.cdShort) - Date.now();
    if (ms <= 0) { const rb = document.getElementById('race-bar'); if (rb) rb.dataset.key = ''; raceBar(); return; }
    const dd = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1e3) % 60;
    el.textContent = 'in ' + (dd ? `${dd}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec}s`);
  });
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const ms = new Date(el.dataset.countdown) - Date.now();
    if (ms <= 0) { el.className = 'countdown over'; el.removeAttribute('data-countdown'); el.textContent = '🏁 Lights out! Results coming soon.'; return; }
    const v = { d: Math.floor(ms / 864e5), h: Math.floor(ms / 36e5) % 24, m: Math.floor(ms / 6e4) % 60, s: Math.floor(ms / 1e3) % 60 };
    for (const k in v) { const b = el.querySelector(`[data-u="${k}"]`); if (b) b.textContent = String(v[k]).padStart(2, '0'); }
  });
}
setInterval(tick, 1000);

/* ---------------- pages ---------------- */
function pageHome(d) {
  const st = computeStandings(d);
  const nx = nextRound(d), last = lastRound(d);
  const words = esc(d.league.name).split(' ');
  const title = words.length > 1 ? `${words.slice(0, -1).join(' ')} <span class="accent">${words.slice(-1)}</span>` : `<span class="accent">${words[0]}</span>`;
  const done = rounds(d).filter(r => isDone(d, r)).length, total = rounds(d).filter(r => !r.cancelled).length;

  const nextCard = nx ? `<div class="next-card">
      <div class="nc-top"><span class="eyebrow" style="margin:0">Round ${esc(nx.round)} · Up next</span>${nx.sprint ? '<span class="badge sprint">Sprint weekend</span>' : ''}</div>
      <div style="display:flex;gap:12px;align-items:center">${flag(nx.country, 'lg')}<h2>${esc(nx.name)}</h2></div>
      <div class="nc-meta"><span>${esc(nx.track || '')}</span>${nx.start ? `<span>·</span><span class="mono">${fmtDate(nx.start, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(nx.start)}</span>` : ''}</div>
      ${countdownHTML(nx.start)}
      <div class="hero-cta"><a class="btn sm" href="#/schedule">Full calendar →</a></div>
    </div>`
    : `<div class="next-card"><span class="eyebrow">Season status</span><h2>${total && done >= total ? 'Season complete 🏆' : 'Calendar coming soon'}</h2>
       ${st.drivers[0] && done ? `<p class="nc-meta">Champion: ${nameHTML(driverLabel(d, st.drivers[0].id).name)}</p>` : ''}</div>`;

  let podium = empty('No races yet', '<p>The first podium will appear here.</p>');
  if (last) {
    const cl = classify(session(d, last.id, 'race'), 'race', d.scoring, poleDriver(d, last.id)).filter(e => e.pos && e.pos <= 3);
    const step = p => {
      const e = cl.find(x => x.pos === p); if (!e) return '<div class="step"></div>';
      const drv = driverLabel(d, e.driverId), t = teamLabel(d, e.teamId);
      return `<div class="step p${p}" style="--tc:${esc(teamColor(t))}"><div class="who"><a href="#/driver/${esc(drv.id)}">${nameHTML(drv.name)}</a><small>${esc(t.name)}</small></div><div class="block">${p}</div></div>`;
    };
    podium = `<div class="podium">${step(2)}${step(1)}${step(3)}</div>`;
  }

  const miniD = st.drivers.slice(0, 6).map(x => { const drv = driverLabel(d, x.id), t = driverTeam(d, drv, x); return `<li><span class="p">${x.position}</span><span class="swatch" style="--tc:${esc(teamColor(t))}"></span><a class="grow" href="#/driver/${esc(x.id)}">${nameHTML(drv.name)}</a><span class="v">${fmtPts(x.points)}</span></li>`; }).join('');
  const miniT = st.teams.slice(0, 6).map(x => { const t = teamLabel(d, x.id); return `<li><span class="p">${x.position}</span><span class="swatch" style="--tc:${esc(teamColor(t))}"></span><a class="grow" href="#/team/${esc(x.id)}">${esc(t.name)}</a><span class="v">${fmtPts(x.points)}</span></li>`; }).join('');

  const news = sortedNews(d).slice(0, 3);

  return `<div class="page">
    <section class="hero">
      <div class="hero-text">
        <div class="eyebrow">Season ${esc(d.league.season)}${total ? ` · Round ${Math.min(done + (nx ? 1 : 0), total)} of ${total}` : ''}</div>
        <h1>${title}</h1>
        ${d.league.tagline ? `<p>${esc(d.league.tagline)}</p>` : ''}
        <div class="hero-cta"><a class="btn primary" href="#/standings">Championship standings</a><a class="btn ghost" href="#/results">Latest results</a>${d.signups.open ? '<a class="btn ghost" href="#/join">✦ Join the league</a>' : ''}</div>
      </div>
      ${nextCard}
    </section>
    ${(() => { const g = [d.fantasy && d.fantasy.enabled ? ['#/fantasy', 'Fantasy', `Build a ${d.fantasy.budget || 100}M team and climb the global leaderboard.`, '★', 'ft'] : null, d.gridDraft && d.gridDraft.enabled ? ['#/griddraft', 'Grid Draft', 'Two cards, one choice, three times. Draft the highest-scoring team.', '⇄', 'gd'] : null].filter(Boolean);
      return g.length ? `<section class="games">${g.map(([h, t, sub, ic, k]) => `<a class="game-btn ${k}" href="${h}"><span class="game-ic">${ic}</span><span><b>${t.toUpperCase()}</b><small>${sub}</small></span><span class="game-go">PLAY →</span></a>`).join('')}</section>` : ''; })()}

    <section class="grid grid-3">
      <div class="card">
        <div class="card-title"><h3>${last ? `${esc(last.name)} podium` : 'Latest podium'}</h3>${last ? `<a href="#/results/${esc(last.id)}">Full result →</a>` : ''}</div>
        ${podium}
      </div>
      <div class="card"><div class="card-title"><h3>Drivers</h3><a href="#/standings">All →</a></div>${miniD ? `<ul class="mini">${miniD}</ul>` : empty('No drivers yet')}</div>
      <div class="card"><div class="card-title"><h3>Constructors</h3><a href="#/standings/teams">All →</a></div>${miniT ? `<ul class="mini">${miniT}</ul>` : empty('No teams yet')}</div>
    </section>

    ${(() => { const r = rounds(d).filter(x => dotdOf(d, x.id)).pop(); return r ? `<section>${dotdCard(d, r.id, true)}</section>` : ''; })()}
    ${fiaHomeSection(d)}
    ${ytSection(d)}
    <section>
      <div class="section-title"><h2>Latest news</h2><a href="#/news">All news →</a></div>
      ${news.length ? `<div class="news-grid">${news.map(n => newsCard(n)).join('')}</div>` : empty('No news yet', '<p>Posts written in the admin console show up here.</p>')}
    </section>
  </div>`;
}

function pageSchedule(d) {
  const rs = rounds(d);
  const cards = rs.map(r => {
    const [cls, label] = roundStatus(d, r);
    let winner = '';
    if (isDone(d, r)) {
      const w = classify(session(d, r.id, 'race'), 'race', d.scoring).find(e => e.pos === 1);
      if (w) { const drv = driverLabel(d, w.driverId), t = teamLabel(d, w.teamId); winner = `<div class="rc-winner"><span class="swatch" style="--tc:${esc(teamColor(t))}"></span>🏆 ${nameHTML(drv.name)}</div>`; }
    }
    return `<a class="round-card ${cls}" href="#/results/${esc(r.id)}">
      <span class="big-n">${esc(r.round)}</span>
      <div class="rc-top"><span class="rc-round">Round ${esc(r.round)}</span><span style="display:flex;gap:6px">${r.sprint ? '<span class="badge sprint">Sprint</span>' : ''}<span class="badge ${cls}">${label}</span></span></div>
      <div>${flag(r.country, 'lg')}</div>
      <h3>${esc(r.name)}</h3>
      <div class="rc-track">${esc(r.track || '')}</div>
      <div class="rc-date">${r.start ? `${fmtDate(r.start, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(r.start)}` : 'Date TBA'}</div>
      ${winner}
    </a>`;
  }).join('');
  return `<div class="page">${head('Season ' + d.league.season, 'Calendar', 'Every round of the season. Times are shown in your local time zone.')}
    ${rs.length ? `<div class="round-grid">${cards}</div>` : empty('No rounds scheduled yet')}</div>`;
}

function pageResultsIndex(d) {
  const rs = rounds(d).filter(r => !r.cancelled);
  const rows = rs.map(r => {
    const done = isDone(d, r);
    let w = null, fl = null;
    if (done) {
      const cl = classify(session(d, r.id, 'race'), 'race', d.scoring);
      w = cl.find(e => e.pos === 1); fl = cl.find(e => e.fastestLap);
    }
    const pole = done ? poleDriver(d, r.id) : null;
    const wd = w && driverLabel(d, w.driverId), wt = w && teamLabel(d, w.teamId);
    return `<tr>
      <td class="pos">${esc(r.round)}</td>
      <td><a href="#/results/${esc(r.id)}">${flag(r.country)}&nbsp; ${esc(r.name)}</a>${r.sprint ? ' <span class="badge sprint">Sprint</span>' : ''}</td>
      <td class="mono hide-sm">${r.start ? fmtDate(r.start, { day: 'numeric', month: 'short' }) : 'TBA'}</td>
      <td>${wd ? `<a href="#/driver/${esc(wd.id)}">${nameHTML(wd.name)}</a>` : '<span class="muted">—</span>'}</td>
      <td class="hide-sm">${wt ? teamCell(wt) : ''}</td>
      <td class="hide-sm">${pole ? nameHTML(driverLabel(d, pole).name) : '<span class="muted">—</span>'}</td>
      <td class="hide-sm">${fl ? nameHTML(driverLabel(d, fl.driverId).name) : '<span class="muted">—</span>'}</td>
      <td class="hide-sm">${dotdOf(d, r.id) ? nameHTML(driverLabel(d, dotdOf(d, r.id).driverId).name) : '<span class="muted">—</span>'}</td>
      <td class="mono hide-sm">${esc((w && w.laps) || r.laps || '')}</td>
    </tr>`;
  }).join('');
  return `<div class="page">${head('Season ' + d.league.season, 'Race results', 'Pick a round for the full classification, sprint and qualifying.')}
    ${roundPicker(d, null)}
    ${rs.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Rd</th><th>Grand Prix</th><th class="hide-sm">Date</th><th>Winner</th><th class="hide-sm">Team</th><th class="hide-sm">Pole</th><th class="hide-sm">Fastest lap</th><th class="hide-sm">DOTD</th><th class="hide-sm">Laps</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('No rounds yet')}
  </div>`;
}

function roundPicker(d, activeId) {
  const rs = rounds(d).filter(r => !r.cancelled);
  if (!rs.length) return '';
  return `<div class="round-picker"><a href="#/results" class="${!activeId ? 'active' : ''}">All rounds</a>${rs.map(r => `<a href="#/results/${esc(r.id)}" class="${r.id === activeId ? 'active' : ''} ${isDone(d, r) ? '' : 'pending'}">${flag(r.country)} R${esc(r.round)}</a>`).join('')}</div>`;
}

/* ---------------- tyres ---------------- */
const TYRES = { S: ['Soft', '#e8002d'], M: ['Medium', '#ffd12e'], H: ['Hard', '#f2f2f2'], I: ['Intermediate', '#43b02a'], W: ['Wet', '#0d74d4'] };
function parseTyres(v) {
  if (Array.isArray(v)) return v.filter(x => x && TYRES[x.c]);
  return String(v || '').toUpperCase().split(/[\s,>\-–/]+/).map(t => t.match(/^([SMHIW])(?:\D*)(\d+)?$/)).filter(Boolean).map(m => ({ c: m[1], laps: m[2] ? Number(m[2]) : null }));
}
const tyreChip = (c, sm) => `<span class="tyre ${sm ? 'sm' : ''}" style="--ty:${TYRES[c][1]}" title="${TYRES[c][0]}">${c}</span>`;
function stintBar(st, total) {
  if (!st.length) return '<span class="muted">—</span>';
  const known = st.reduce((a, x) => a + (x.laps || 0), 0), unknown = st.filter(x => !x.laps).length;
  const fill = unknown ? Math.max(1, ((total || known || st.length * 10) - known) / unknown) : 0;
  const lens = st.map(x => x.laps || fill), sum = lens.reduce((a, b) => a + b, 0) || 1;
  return `<div class="stints">${st.map((x, k) => `<span class="stint" style="flex:${lens[k] / sum};--ty:${TYRES[x.c][1]}" title="${TYRES[x.c][0]}${x.laps ? ' · ' + x.laps + ' laps' : ''}">${tyreChip(x.c, 1)}${x.laps ? `<em>${x.laps}</em>` : ''}</span>`).join('')}</div>`;
}
const RV_KEY = 'league.resultsView';
function detailedTable(d, r, sess, cl, isQ) {
  const quali = classify(session(d, r.id, sess === 'sprint' ? 'sprintQuali' : 'quali'), 'quali', d.scoring);
  const gridOf = id => { const i = quali.findIndex(q => q.driverId === id); return i >= 0 ? i + 1 : null; };
  const total = Number(r.laps) || Math.max(0, ...cl.map(e => Number(e.laps) || 0));
  const usage = {}; let anyTyre = false;
  const rows = cl.map(e => {
    const drv = driverLabel(d, e.driverId), t = teamLabel(d, e.teamId), st = parseTyres(e.tyres);
    if (st.length) anyTyre = true;
    st.forEach(x => { usage[x.c] = (usage[x.c] || 0) + 1; });
    const g = gridOf(e.driverId), gained = g && e.pos ? g - e.pos : null;
    const oneCompound = e.pos && st.length && new Set(st.map(x => x.c)).size < 2 && !st.some(x => x.c === 'I' || x.c === 'W');
    return `<tr class="${e.pos && e.pos <= 3 ? 'top' + e.pos : ''}">
      <td class="pos">${e.pos ? e.pos : `<span class="status">${esc(e.label)}</span>`}</td>
      <td>${avatar(drv, t, 'sm')}<a href="#/driver/${esc(drv.id)}">${nameHTML(drv.name)}</a>${e.fastestLap ? '<span class="tag-fl">FL</span>' : ''}</td>
      <td class="hide-sm">${teamCell(t)}</td>
      <td class="mono c">${g || '—'}</td>
      <td class="mono c">${gained === null ? '' : gained > 0 ? `<span class="gain up">▲${gained}</span>` : gained < 0 ? `<span class="gain dn">▼${-gained}</span>` : '<span class="gain">–</span>'}</td>
      <td class="mono c">${st.length ? st.length - 1 : '—'}</td>
      <td class="strat">${stintBar(st, Number(e.laps) || total)}${oneCompound ? '<span class="one-c" title="Only one dry compound used">!</span>' : ''}</td>
      <td class="mono hide-sm">${esc(e.time || (e.pos ? '' : e.status))}</td>
      <td class="pts">${fmtPts(e.pts)}</td>
    </tr>`;
  }).join('');
  const usedTotal = Object.values(usage).reduce((a, b) => a + b, 0);
  const strategies = {};
  cl.forEach(e => { const k = parseTyres(e.tyres).map(x => x.c).join('-'); if (k) strategies[k] = (strategies[k] || 0) + 1; });
  const topStrat = Object.entries(strategies).sort((a, b) => b[1] - a[1])[0];
  const summary = anyTyre ? `<div class="ty-summary">
      <div class="ty-usage"><span class="ty-lbl">Compound usage</span><div class="ty-bar">${Object.keys(TYRES).filter(c => usage[c]).map(c => `<span style="flex:${usage[c]};--ty:${TYRES[c][1]}" title="${TYRES[c][0]}: ${usage[c]} stints"></span>`).join('')}</div>
        <div class="ty-legend">${Object.keys(TYRES).filter(c => usage[c]).map(c => `<span>${tyreChip(c, 1)} ${TYRES[c][0]} <b>${Math.round(usage[c] / usedTotal * 100)}%</b></span>`).join('')}</div></div>
      ${topStrat ? `<div class="ty-stat"><span class="ty-lbl">Most common strategy</span><b>${topStrat[0].split('-').map(c => tyreChip(c)).join('<i>›</i>')}</b><small class="muted">${topStrat[1]} driver${topStrat[1] > 1 ? 's' : ''}</small></div>` : ''}
    </div>` : `<p class="muted ty-none">Tyre data hasn't been added for this ${sessionName(sess).toLowerCase()} yet.</p>`;
  return `${summary}<div class="table-wrap"><table class="tbl detail"><thead><tr><th>Pos</th><th>Driver</th><th class="hide-sm">Team</th><th class="c">Grid</th><th class="c">+/-</th><th class="c">Stops</th><th>Tyre strategy</th><th class="hide-sm">Time</th><th class="r">Pts</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="legend">${Object.keys(TYRES).map(c => `<span>${tyreChip(c, 1)} ${TYRES[c][0]}</span>`).join('')}<span><span class="one-c">!</span> only one dry compound</span></div>`;
}

function pageRound(d, rid, sess) {
  const r = byId(d.calendar, rid);
  if (!r) return notFound();
  const avail = ['race', 'sprint', 'quali'].filter(s => s === 'race' || session(d, rid, s).length || (s === 'sprint' && r.sprint));
  sess = avail.includes(sess) ? sess : 'race';
  const pole = poleDriver(d, rid);
  const cl = classify(session(d, rid, sess), sess, d.scoring, pole);
  const rs = rounds(d).filter(x => !x.cancelled);
  const idx = rs.findIndex(x => x.id === rid);
  const prev = rs[idx - 1], next = rs[idx + 1];
  const isQ = sess === 'quali';

  const rows = cl.map(e => {
    const drv = driverLabel(d, e.driverId), t = teamLabel(d, e.teamId);
    return `<tr class="${e.pos && e.pos <= 3 ? 'top' + e.pos : ''}">
      <td class="pos">${e.pos ? e.pos : `<span class="status">${esc(e.label)}</span>`}</td>
      <td class="num muted hide-sm">${esc(drv.number ?? '')}</td>
      <td>${avatar(drv, t, 'sm')}<a href="#/driver/${esc(drv.id)}">${nameHTML(drv.name)}</a>${e.fastestLap && !isQ ? '<span class="tag-fl">FL</span>' : ''}${!isQ && sess === 'race' && pole === e.driverId ? '<span class="tag-pole">POLE</span>' : ''}</td>
      <td>${teamCell(t)}</td>
      ${isQ ? '' : `<td class="mono hide-sm">${esc(e.laps ?? '')}</td>`}
      <td class="mono">${esc(e.time || (e.pos ? '' : e.status))}</td>
      ${isQ ? '' : `<td class="pts">${fmtPts(e.pts)}</td>`}
    </tr>`;
  }).join('');

  const view = !isQ && cl.length && lsGet(RV_KEY) === 'detail' ? 'detail' : 'classic';
  const tabs = `<div class="res-bar">${avail.length > 1 ? `<div class="tabs" style="margin:0">${avail.map(s => `<a href="#/results/${esc(rid)}/${s}" class="${s === sess ? 'active' : ''}">${sessionName(s)}</a>`).join('')}</div>` : '<span></span>'}
    ${!isQ && cl.length ? `<div class="tabs seg" style="margin:0"><button data-rv="classic" class="${view === 'classic' ? 'active' : ''}">Classic</button><button data-rv="detail" class="${view === 'detail' ? 'active' : ''}">Detailed · tyres</button></div>` : ''}</div>`;
  const dotdHTML = dotdOf(d, rid) ? `<section>${dotdCard(d, rid)}</section>` : '';
  const sds = d.stewards.filter(x => x.roundId === rid);
  const sdHTML = sds.length ? `<section><div class="section-title"><h2>${esc(rcName(d))}</h2><a href="#/stewards/${esc(rid)}">All for this round →</a></div><div class="sd-list">${sds.map(x => stewardCard(d, x, true)).join('')}</div></section>` : '';
  const notes = r.notes ? `<div class="card" style="margin-top:20px"><div class="prose">${md(r.notes)}</div></div>` : '';

  return `<div class="page">
    ${roundPicker(d, rid)}
    <div class="page-head"><div class="eyebrow">Round ${esc(r.round)} · ${esc(sessionName(sess))}</div>
      <div class="round-head">${flag(r.country, 'lg')}<h1 style="margin:0">${esc(r.name)}</h1>
        <div class="round-nav">${prev ? `<a class="btn sm" href="#/results/${esc(prev.id)}">← R${esc(prev.round)}</a>` : ''}${next ? `<a class="btn sm" href="#/results/${esc(next.id)}">R${esc(next.round)} →</a>` : ''}</div>
      </div>
      <div class="rh-meta"><span>${esc(r.track || '')}</span>${r.start ? `<span class="mono">${fmtDate(r.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><span class="mono">${fmtTime(r.start)} your time${trackTz(r) ? ' · ' + esc(fmtIn(r.start, trackTz(r), { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })) + ' track time' : ''}</span>` : ''}${r.laps ? `<span>${esc(r.laps)} laps</span>` : ''}</div>
    </div>
    ${!isDone(d, r) && !r.cancelled ? weekendSchedule(d, r) : ''}
    ${tabs}
    ${cl.length && view === 'detail' ? detailedTable(d, r, sess, cl, isQ) : cl.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Pos</th><th class="hide-sm">No</th><th>Driver</th><th>Team</th>${isQ ? '' : '<th class="hide-sm">Laps</th>'}<th>${isQ ? 'Lap time' : 'Time / Retired'}</th>${isQ ? '' : '<th class="r">Pts</th>'}</tr></thead><tbody>${rows}</tbody></table></div>`
      : empty(r.cancelled ? 'This round was cancelled' : 'No results yet', r.start ? `<p>${esc(sessionName(sess))} scheduled for ${fmtDate(r.start)} · ${fmtTime(r.start)}</p>` : '')}
    ${dotdHTML}
    ${(d.gallery || []).some(x => x.roundId === rid) ? `<section><div class="section-title"><h2>Photos</h2><a href="#/gallery">Gallery →</a></div>${galleryGrid(d, d.gallery.filter(x => x.roundId === rid))}</section>` : ''}
    ${notes}
    ${sdHTML}
    ${isDone(d, r) && (r.sessions || []).some(x => x && x.start) ? weekendSchedule(d, r) : ''}
    ${relatedArticles(d, 'rounds', rid)}
  </div>`;
}

function pageStandings(d, view) {
  view = ['drivers', 'teams', 'grid', 'progress'].includes(view) ? view : 'drivers';
  const st = computeStandings(d);
  const tabs = `<div class="tabs">${[['drivers', 'Drivers'], ['teams', 'Constructors'], ['grid', 'Season grid'], ['progress', 'Progression']].map(([k, l]) => `<a href="#/standings/${k}" class="${k === view ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  let body = '';
  if (view === 'drivers') {
    body = st.drivers.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Pos</th><th>Driver</th><th class="hide-sm">Nat</th><th>Team</th><th class="r hide-sm">Wins</th><th class="r hide-sm">Podiums</th><th class="r">Pts</th></tr></thead><tbody>
      ${st.drivers.map(x => { const drv = driverLabel(d, x.id), t = driverTeam(d, drv, x); return `<tr class="${x.position <= 3 ? 'top' + x.position : ''}"><td class="pos">${x.position}</td><td>${avatar(drv, t, 'sm')}<a href="#/driver/${esc(x.id)}">${nameHTML(drv.name)}</a>${x.adj ? `<span class="adj-note" title="Includes penalties/adjustments">(${x.adj > 0 ? '+' : ''}${fmtPts(x.adj)})</span>` : ''}</td><td class="hide-sm">${flag(drv.country)}</td><td>${teamCell(t)}</td><td class="r mono hide-sm">${x.wins}</td><td class="r mono hide-sm">${x.podiums}</td><td class="pts">${fmtPts(x.points)}</td></tr>`; }).join('')}
      </tbody></table></div>` : empty('No drivers yet');
  } else if (view === 'teams') {
    body = st.teams.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Pos</th><th>Team</th><th class="hide-sm">Drivers</th><th class="r hide-sm">Wins</th><th class="r hide-sm">Podiums</th><th class="r">Pts</th></tr></thead><tbody>
      ${st.teams.map(x => { const t = teamLabel(d, x.id); const drs = d.drivers.filter(p => p.teamId === x.id && p.active !== false).map(p => esc(p.name.split(' ').pop())).join(' / '); return `<tr class="${x.position <= 3 ? 'top' + x.position : ''}"><td class="pos">${x.position}</td><td><a href="#/team/${esc(x.id)}">${teamCell(t)}</a>${x.adj ? `<span class="adj-note">(${x.adj > 0 ? '+' : ''}${fmtPts(x.adj)})</span>` : ''}</td><td class="muted hide-sm">${drs}</td><td class="r mono hide-sm">${x.wins}</td><td class="r mono hide-sm">${x.podiums}</td><td class="pts">${fmtPts(x.points)}</td></tr>`; }).join('')}
      </tbody></table></div>` : empty('No teams yet');
  } else if (view === 'progress') {
    body = progressChart(d, st);
  } else {
    const rs = rounds(d).filter(r => !r.cancelled);
    const cellFor = (x, r) => {
      const rr = x.rounds[r.id];
      if (!rr || !rr.race) return isDone(d, r) ? '<span class="cell blank">–</span>' : '<span class="cell blank">·</span>';
      const race = rr.race;
      const sp = rr.sprint && rr.sprint.pos ? `<span class="s">S${rr.sprint.pos}</span>` : '';
      if (!race.pos) return `<span class="cell dnf">${esc(race.label)}${sp}</span>`;
      const cls = race.pos <= 3 ? 'p' + race.pos : (race.pts > 0 ? 'pts' : 'nopts');
      return `<span class="cell ${cls}" title="${fmtPts(rr.pts)} pts">${race.pos}${race.fl ? '•' : ''}${sp}</span>`;
    };
    body = st.drivers.length ? `<div class="table-wrap"><table class="tbl matrix"><thead><tr><th>Pos</th><th>Driver</th>${rs.map(r => `<th title="${esc(r.name)}">${flag(r.country)}<small>R${esc(r.round)}</small></th>`).join('')}<th class="r">Pts</th></tr></thead><tbody>
      ${st.drivers.map(x => { const drv = driverLabel(d, x.id), t = driverTeam(d, drv, x); return `<tr><td class="pos">${x.position}</td><td><span class="swatch" style="--tc:${esc(teamColor(t))}"></span><a href="#/driver/${esc(x.id)}">${nameHTML(drv.name)}</a></td>${rs.map(r => `<td>${cellFor(x, r)}</td>`).join('')}<td class="pts">${fmtPts(x.points)}</td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="legend"><span><span class="cell p1">1</span>Win</span><span><span class="cell p2">2</span><span class="cell p3">3</span>Podium</span><span><span class="cell pts">7</span>Points</span><span><span class="cell nopts">14</span>No points</span><span><span class="cell dnf">DNF</span>Retired</span><span>• fastest lap</span><span>S = sprint finish</span></div>` : empty('No drivers yet');
  }
  return `<div class="page">${head('Season ' + d.league.season, 'Championship standings', '')}${tabs}${body}</div>`;
}

function pageDrivers(d) {
  const st = computeStandings(d);
  const custom = (d.theme || {}).listOrder === 'custom';
  const active = d.drivers.filter(x => x.active !== false); if (!custom) active.sort((a, b) => ((st.D[a.id] || {}).position || 999) - ((st.D[b.id] || {}).position || 999));
  const former = d.drivers.filter(x => x.active === false);
  const card = drv => {
    const s = st.D[drv.id] || { points: 0 }, t = driverTeam(d, drv, s);
    return `<a class="driver-card${drv.photo ? ' has-photo' : ''}" href="#/driver/${esc(drv.id)}" style="--tc:${esc(teamColor(t))}">
      <div class="dc-pos">${s.position ? 'P' + s.position + ' in championship' : 'Driver'}</div>
      <div class="dc-pts"><b>${fmtPts(s.points)}</b><span>PTS</span></div>
      ${drv.photo ? `<img class="dc-photo" src="${esc(asset(drv.photo))}" alt="" loading="lazy" onerror="this.remove()">` : `<div class="dc-num">${esc(drv.number ?? '')}</div>`}
      <div class="dc-name">${nameHTML(drv.name)}</div>
      <div class="dc-team">${flag(drv.country)} <span>${esc(t ? t.name : 'Free agent')}</span></div>
    </a>`;
  };
  return `<div class="page">${head('Season ' + d.league.season, 'Drivers', `${active.length} drivers on the grid.`)}
    ${active.length ? `<div class="driver-grid">${active.map(card).join('')}</div>` : empty('No drivers yet', '<p>Add drivers from the admin console.</p>')}
    ${former.length ? `<section><div class="section-title"><h2>Former / reserve drivers</h2></div><div class="driver-grid">${former.map(card).join('')}</div></section>` : ''}
  </div>`;
}

const isNowWord = v => /^\s*(now|present|current|today|-|—)\s*$/i.test(String(v ?? ''));
const seasonNum = v => { const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };
function careerStints(d, D) {
  const curSeason = d.league.season, cal = d.calendar.filter(r => !r.cancelled).length || 1, last = lastRound(d);
  const lastNo = last ? Number(last.round) || 0 : 0;
  return (D.history || []).filter(h => h && (h.teamId || h.team)).map((h, k) => {
    const t = byId(d.teams, h.teamId);
    const cur = (!h.toSeason && !h.toRound) || isNowWord(h.toSeason) || isNowWord(h.toRound);
    const fs = h.fromSeason || '', fr = Number(h.fromRound) || 1;
    const ts = cur ? curSeason : (h.toSeason || fs), tr = cur ? Math.max(lastNo, fr) : (Number(h.toRound) || fr);
    const a = seasonNum(fs); let b = seasonNum(ts);
    // "now" = this season: count from the round they joined to the latest round raced. Only add whole seasons when the
    // start season is clearly an earlier season of the same numbering (e.g. Season 1 → league season 2).
    if (cur && (b === null || a === null || b < a || b - a > 10 || String(fs).trim() === String(curSeason).trim())) b = a;
    let len = 1;
    if (a !== null && b !== null) len = b === a ? Math.max(1, tr - fr + 1) : Math.max(1, (cal - fr + 1) + (b - a - 1) * cal + tr);
    const startKey = (a ?? 0) * 1000 + fr, endKey = cur ? Infinity : (b ?? a ?? 0) * 1000 + tr;
    return { h, k, t, cur, fs, fr, ts, tr, len, startKey, endKey, name: t ? t.name : h.team, color: t ? teamColor(t) : (h.color || '#8a9aa0'), logo: t && t.logo, role: h.role || '' };
  }).sort((x, y) => (y.endKey - x.endKey) || (y.startKey - x.startKey) || (y.k - x.k)); // current first, then most recent finish
}
const stintPt = (s, r) => `${s ? 'Season ' + esc(s) : ''}${r ? `${s ? ' · ' : ''}R${esc(r)}` : ''}`;
const stintWhen = x => `<span class="nw">${stintPt(x.fs, x.h.fromRound) || 'Start'}</span> <span class="nw">→ ${x.cur ? '<b class="th-now">Present</b>' : stintPt(x.h.toSeason || x.fs, x.h.toRound)}</span>`;
const stintLen = x => `${x.len} round${x.len === 1 ? '' : 's'}${x.cur ? ' so far' : ''}`;
const teamLink = x => x.t ? `<a href="#/team/${esc(x.t.id)}">${esc(x.name)}</a>` : esc(x.name);
const stintLogo = x => x.logo ? `<img src="${esc(asset(x.logo))}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('i'),{textContent:'${esc(String(x.name || '?')[0])}'}))">` : `<i>${esc(String(x.name || '?')[0])}</i>`;
function teamHistory(d, D) {
  const xs = careerStints(d, D), style = (d.theme && d.theme.historyStyle) || 'timeline';
  if (style === 'cards') return `<div class="th-cards">${xs.map(x => `<div class="th-card ${x.cur ? 'cur' : ''}" style="--tc:${esc(x.color)}">
      <div class="th-logo">${stintLogo(x)}</div>
      <div class="th-body"><div class="th-top">${x.cur ? '<span class="th-badge">Current</span>' : ''}${x.role ? `<span class="th-role">${esc(x.role)}</span>` : ''}</div>
        <b>${teamLink(x)}</b><div class="th-when mono">${stintWhen(x)}</div></div>
      <div class="th-len"><b>${x.len}</b><span>${x.len === 1 ? 'round' : 'rounds'}</span></div></div>`).join('')}</div>`;
  if (style === 'strip') {
    const chrono = xs.slice().reverse(), total = chrono.reduce((a, x) => a + x.len, 0);
    return `<div class="th-strip" role="img" aria-label="Career timeline">${chrono.map(x => `<span class="${x.cur ? 'cur' : ''}" style="--tc:${esc(x.color)};flex:${x.len}" title="${esc(x.name)} · ${esc(stintLen(x))}">${x.len / total > .14 ? `<em>${esc(String(x.name).split(' ').slice(0, 2).join(' '))}</em>` : ''}</span>`).join('')}</div>
      <div class="th-strip-ends mono"><span>${chrono[0] ? stintPt(chrono[0].fs, chrono[0].h.fromRound) : ''}</span><span>${xs[0] && xs[0].cur ? 'Today' : xs[0] ? stintPt(xs[0].ts, xs[0].tr) : ''}</span></div>
      <ul class="th-rows">${xs.map(x => `<li class="${x.cur ? 'cur' : ''}" style="--tc:${esc(x.color)}"><div class="th-logo sm">${stintLogo(x)}</div><div><b>${teamLink(x)}</b>${x.role ? ` <span class="chip">${esc(x.role)}</span>` : ''}<div class="th-when mono">${stintWhen(x)}</div></div><span class="th-pill mono">${esc(stintLen(x))}</span></li>`).join('')}</ul>`;
  }
  return `<ol class="th-list">${xs.map(x => `<li class="${x.cur ? 'cur' : ''}" style="--tc:${esc(x.color)}"><span class="th-dot"></span>
      <div><b>${teamLink(x)}</b>${x.role ? ` <span class="chip">${esc(x.role)}</span>` : ''}
      <div class="th-when mono">${stintWhen(x)}</div></div></li>`).join('')}</ol>`;
}
function pageDriver(d, id) {
  const drv = byId(d.drivers, id);
  const st = computeStandings(d);
  const s = st.D[id];
  if (!drv && !s) return notFound();
  const D = drv || driverLabel(d, id), x = s || { points: 0, wins: 0, podiums: 0, poles: 0, fls: 0, dnfs: 0, starts: 0, rounds: {} };
  const t = driverTeam(d, D, x);
  const rows = rounds(d).filter(r => x.rounds[r.id]).map(r => {
    const rr = x.rounds[r.id], race = rr.race, sp = rr.sprint;
    const rt = race ? teamLabel(d, race.teamId) : null;
    return `<tr><td class="pos">${esc(r.round)}</td><td><a href="#/results/${esc(r.id)}">${flag(r.country)}&nbsp; ${esc(r.name)}</a></td><td class="hide-sm">${rt ? teamCell(rt) : ''}</td>
      <td class="mono">${sp ? esc(sp.label) : '<span class="muted">—</span>'}</td>
      <td class="mono">${race ? (race.pos ? race.pos : `<span class="status">${esc(race.label)}</span>`) + (race.fl ? '<span class="tag-fl">FL</span>' : '') : '<span class="muted">—</span>'}</td>
      <td class="pts">${fmtPts(rr.pts)}${rr.adj ? `<span class="adj-note">(${rr.adj > 0 ? '+' : ''}${fmtPts(rr.adj)})</span>` : ''}</td></tr>`;
  }).join('');
  const adjs = d.adjustments.filter(a => a.type !== 'team' && a.targetId === id)
    .concat(d.stewards.filter(x => x.driverId === id && Number(x.points)).map(x => ({ points: Number(x.points), reason: (x.title || rcName(d) + ' decision') + (x.penalty ? ' — ' + x.penalty : ''), roundId: x.roundId })));
  return `<div class="page">
    <div class="back-row"><a class="back" href="#/drivers">← All drivers</a><a class="btn sm" href="#/h2h/drivers/${esc(id)}">⚔ Head to head</a></div>
    <div class="profile-hero" style="--tc:${esc(teamColor(t))}">
      ${D.photo ? `<img class="ph-photo" src="${esc(asset(D.photo))}" alt="" onerror="this.remove()">` : `<div class="ph-num">${esc(D.number ?? '')}</div>`}
      <div class="eyebrow">${x.position ? `P${x.position} · ` : ''}${esc(t ? t.name : 'Free agent')}</div>
      <h1>${nameHTML(D.name).replace('class="dname"', 'class="dname"')}</h1>
      <div class="ph-meta">${flag(D.country, 'lg')}${D.number !== undefined && D.number !== '' ? `<span class="mono">#${esc(D.number)}</span>` : ''}${D.active === false ? '<span class="pill-inactive">Inactive</span>' : ''}</div>
    </div>
    <div class="stats stats-drv">
      <div class="stat"><b>${x.position || '—'}</b><span>Position</span></div>
      <div class="stat"><b>${fmtPts(x.points)}</b><span>Points</span></div>
      <div class="stat"><b>${x.wins}</b><span>Wins</span></div>
      <div class="stat"><b>${x.podiums}</b><span>Podiums</span></div>
      <div class="stat"><b>${x.poles}</b><span>Poles</span></div>
      <div class="stat"><b>${x.fls}</b><span>Fastest laps</span></div>
      <div class="stat"><b>${x.best ? 'P' + x.best : '—'}</b><span>Best finish</span></div>
      <div class="stat"><b>${x.dnfs}</b><span>DNFs</span></div>
      <div class="stat"><b>${rounds(d).filter(r => (dotdOf(d, r.id) || {}).driverId === id).length}</b><span>Driver of the Day</span></div>
    </div>
    ${D.bio || (D.history || []).length ? `<div class="grid grid-2 drv-about">
      ${D.bio ? `<section class="card drv-bio"><div class="card-title"><h3>Biography</h3></div><div class="prose">${md(D.bio)}</div></section>` : ''}
      ${(D.history || []).filter(h => h && (h.teamId || h.team)).length ? `<section class="card drv-hist" ${D.bio ? '' : 'style="grid-column:1/-1"'}><div class="card-title"><h3>Team history</h3></div>${teamHistory(d, D)}</section>` : ''}
    </div>` : ''}
    <div class="section-title"><h2>Season results</h2></div>
    ${rows ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Rd</th><th>Grand Prix</th><th class="hide-sm">Team</th><th>Sprint</th><th>Race</th><th class="r">Pts</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('No results yet')}
    ${adjs.length ? `<section><div class="section-title"><h2>Penalties & adjustments</h2></div><div class="table-wrap"><table class="tbl"><tbody>${adjs.map(a => `<tr><td class="pts" style="text-align:left;width:80px">${a.points > 0 ? '+' : ''}${fmtPts(a.points)}</td><td>${esc(a.reason || '')}</td><td class="muted">${a.roundId && byId(d.calendar, a.roundId) ? 'R' + esc(byId(d.calendar, a.roundId).round) : ''}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    ${relatedArticles(d, 'drivers', id)}
  </div>`;
}

function pageTeams(d) {
  const st = computeStandings(d);
  const list = [...d.teams]; if ((d.theme || {}).listOrder !== 'custom') list.sort((a, b) => ((st.T[a.id] || {}).position || 999) - ((st.T[b.id] || {}).position || 999));
  const cards = list.map(t => {
    const s = st.T[t.id] || { points: 0 };
    const drs = d.drivers.filter(x => x.teamId === t.id && x.active !== false);
    return `<a class="team-card" href="#/team/${esc(t.id)}" style="--tc:${esc(teamColor(t))}">
      <div class="tc-head"><div><div class="tc-pos">${s.position ? 'P' + s.position : 'Team'}</div><h3>${esc(t.name)}</h3><div class="muted" style="font-size:14px">${esc(t.car || t.base || '')}</div></div>
      <div style="display:flex;gap:12px;align-items:center">${t.logo ? `<img class="tc-logo" src="${esc(asset(t.logo))}" alt="" onerror="this.remove()">` : ''}<div class="tc-pts"><b>${fmtPts(s.points)}</b><span>PTS</span></div></div></div>
      <div class="tc-drivers ${t.carImage ? 'has-car' : ''}">${drs.length ? drs.map(x => `<div class="tc-driver">${avatar(x, t)}<div><small>#${esc(x.number ?? '')}</small>${nameHTML(x.name)}</div></div>`).join('') : '<div class="tc-driver muted">No drivers yet</div>'}</div>
      <div class="tc-car-slot">${t.carImage ? `<img class="tc-car" src="${esc(asset(t.carImage))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    </a>`;
  }).join('');
  return `<div class="page">${head('Season ' + d.league.season, 'Teams', `${d.teams.length} constructors fighting for the title.`)}
    ${list.length ? `<div class="team-grid">${cards}</div>` : empty('No teams yet', '<p>Add constructors from the admin console.</p>')}</div>`;
}

function pageTeam(d, id) {
  const t = byId(d.teams, id);
  const st = computeStandings(d);
  const s = st.T[id];
  if (!t && !s) return notFound();
  const T = t || teamLabel(d, id), x = s || { points: 0, wins: 0, podiums: 0, poles: 0, rounds: {} };
  const drs = d.drivers.filter(p => p.teamId === id);
  const raced = new Set();
  rounds(d).forEach(r => ['race', 'sprint'].forEach(ss => session(d, r.id, ss).forEach(e => { if (e.teamId === id) raced.add(e.driverId); })));
  const drIds = [...new Set([...drs.filter(p => p.active !== false).map(p => p.id), ...raced])];
  const rows = rounds(d).filter(r => isDone(d, r)).map(r => {
    const cl = classify(session(d, r.id, 'race'), 'race', d.scoring, poleDriver(d, r.id));
    const cells = drIds.map(did => { const e = cl.find(z => z.driverId === did && z.teamId === id); return `<td class="mono">${e ? (e.pos || `<span class="status">${esc(e.label)}</span>`) : '<span class="muted">—</span>'}</td>`; }).join('');
    const rr = x.rounds[r.id];
    return `<tr><td class="pos">${esc(r.round)}</td><td><a href="#/results/${esc(r.id)}">${flag(r.country)}&nbsp; ${esc(r.name)}</a></td>${cells}<td class="pts">${fmtPts(rr ? rr.pts : 0)}</td></tr>`;
  }).join('');
  return `<div class="page">
    <div class="back-row"><a class="back" href="#/teams">← All teams</a><a class="btn sm" href="#/h2h/teams/${esc(id)}">⚔ Head to head</a></div>
    <div class="profile-hero" style="--tc:${esc(teamColor(T))}">
      ${T.logo ? `<img class="ph-photo" src="${esc(asset(T.logo))}" alt="" style="height:70%;bottom:15%" onerror="this.remove()">` : ''}
      <div class="eyebrow">${x.position ? `P${x.position} in constructors'` : 'Constructor'}</div>
      <h1>${esc(T.name)}</h1>
      <dl class="kv" style="position:relative;margin-top:14px">
        ${T.base ? `<dt>Base</dt><dd>${esc(T.base)}</dd>` : ''}${(((T.staff || {}).principal || {}).name || T.principal) ? `<dt>Team principal</dt><dd>${esc(((T.staff || {}).principal || {}).name || T.principal)}</dd>` : ''}${T.car ? `<dt>Chassis</dt><dd>${esc(T.car)}</dd>` : ''}${T.engine ? `<dt>Power unit</dt><dd>${esc(T.engine)}</dd>` : ''}
      </dl>
      ${T.bio ? `<div class="bio prose">${md(T.bio)}</div>` : ''}
      ${T.carImage ? `<img class="ph-car zoomable" src="${esc(asset(T.carImage))}" alt="" onerror="this.remove()">` : ''}
    </div>
    <div class="stats">
      <div class="stat"><b>${x.position || '—'}</b><span>Position</span></div>
      <div class="stat"><b>${fmtPts(x.points)}</b><span>Points</span></div>
      <div class="stat"><b>${x.wins}</b><span>Wins</span></div>
      <div class="stat"><b>${x.podiums}</b><span>Podiums</span></div>
      <div class="stat"><b>${x.poles}</b><span>Poles</span></div>
    </div>
    <div class="section-title"><h2>Drivers</h2></div>
    ${teamLineup(d, T, st)}
    <div class="section-title"><h2>Race by race</h2></div>
    ${rows ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Rd</th><th>Grand Prix</th>${drIds.map(did => `<th>${esc(driverLabel(d, did).name.split(' ').pop())}</th>`).join('')}<th class="r">Pts</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('No results yet')}
    ${relatedArticles(d, 'teams', id)}
  </div>`;
}

const sortedNews = d => [...d.news].filter(n => !n.hidden).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.date || '').localeCompare(String(a.date || '')));
function newsCard(n, feature = false) {
  const initials = esc((n.tag || 'NEWS').slice(0, 4).toUpperCase());
  return `<a class="news-card ${feature ? 'feature' : ''}" href="#/news/${esc(n.id)}">
    <div class="nc-img">${n.image ? `<img src="${esc(asset(n.image))}" alt="" loading="lazy" onerror="this.remove()">` : ''}<div class="ph" ${n.image ? 'style="display:none"' : ''}>${initials}</div></div>
    <div class="nc-body">${n.tag ? `<span class="chip" style="width:fit-content">${esc(n.tag)}</span>` : ''}<h3>${esc(n.title)}</h3><p>${esc(plain(n.body).slice(0, feature ? 220 : 130))}${plain(n.body).length > (feature ? 220 : 130) ? '…' : ''}</p>
    <div class="nc-meta">${n.pinned ? '<span>📌</span>' : ''}<span>${n.date ? fmtDate(n.date + 'T12:00:00') : ''}</span>${n.author ? `<span>· ${esc(n.author)}</span>` : ''}</div></div>
  </a>`;
}
function pageNews(d) {
  const list = sortedNews(d);
  return `<div class="page">${head('Paddock', 'News', 'Announcements, race reports and everything in between.')}
    ${list.length ? `<div class="news-grid">${list.map((n, i) => newsCard(n, i === 0)).join('')}</div>` : empty('No news yet')}</div>`;
}
function pageArticle(d, id) {
  const n = byId(d.news, id);
  if (!n) return notFound();
  return `<div class="page"><article class="article">
    <a class="back" href="#/news">← All news</a>
    ${n.tag ? `<div class="eyebrow">${esc(n.tag)}</div>` : ''}
    <h1>${esc(n.title)}</h1>
    <div class="a-meta"><span>${n.date ? fmtDate(n.date + 'T12:00:00', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''}</span>${n.author ? `<span>· by ${esc(n.author)}</span>` : ''}</div>
    ${n.image ? `<div class="a-cover"><img src="${esc(asset(n.image))}" alt="" onerror="this.parentNode.remove()"></div>` : ''}
    <div class="prose">${md(n.body)}</div>
    ${(() => { const tags = [...(n.teams || []).map(x => byId(d.teams, x)).filter(Boolean).map(t => `<a class="a-tag" href="#/team/${esc(t.id)}" style="--tc:${esc(teamColor(t))}"><span class="swatch"></span>${esc(t.name)}</a>`),
      ...(n.drivers || []).map(x => byId(d.drivers, x)).filter(Boolean).map(p => `<a class="a-tag" href="#/driver/${esc(p.id)}">${avatar(p, byId(d.teams, p.teamId), 'sm')}${esc(p.name)}</a>`),
      ...(n.rounds || []).map(x => byId(d.calendar, x)).filter(Boolean).map(r => `<a class="a-tag" href="#/results/${esc(r.id)}">${flag(r.country)} ${esc(r.name)}</a>`)];
      return tags.length ? `<div class="a-tags">${tags.join('')}</div>` : ''; })()}
  </article>
  ${(() => { const k = (n.teams || [])[0] ? ['teams', n.teams[0]] : (n.drivers || [])[0] ? ['drivers', n.drivers[0]] : null; return k ? `<div style="max-width:1100px;margin:40px auto 0">${relatedArticles(d, k[0], k[1], n.id)}</div>` : ''; })()}
  </div>`;
}

function scoringHTML(d) {
  const sc = d.scoring;
  const ptsTable = (label, arr) => arr && arr.length ? `<div class="card"><h3>${label}</h3><div class="table-wrap" style="box-shadow:none"><table class="tbl"><thead><tr><th>Position</th><th class="r">Points</th></tr></thead><tbody>${arr.map((p, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}"><td class="pos">P${i + 1}</td><td class="pts">${fmtPts(p)}</td></tr>`).join('')}</tbody></table></div></div>` : '';
  const bonuses = [];
  if (Number(sc.fastestLap)) bonuses.push(`<li><b>+${fmtPts(sc.fastestLap)}</b> for the fastest lap in the race${Number(sc.fastestLapTopN) ? ` (only if finishing in the top ${esc(sc.fastestLapTopN)})` : ''}</li>`);
  if (Number(sc.sprintFastestLap)) bonuses.push(`<li><b>+${fmtPts(sc.sprintFastestLap)}</b> for the fastest lap in the sprint</li>`);
  if (Number(sc.pole)) bonuses.push(`<li><b>+${fmtPts(sc.pole)}</b> for pole position</li>`);
  bonuses.push('<li>DNF, DSQ and DNS score no points.</li><li>Ties are broken by most wins, then most 2nd places, and so on.</li>');
  return `<div class="grid grid-3">${ptsTable('Race points', sc.race)}${ptsTable('Sprint points', sc.sprint)}<div class="card"><h3>Bonuses & tie-breaks</h3><ul class="prose" style="font-size:15px;padding-left:1.1em">${bonuses.join('')}</ul></div></div>`;
}
let RULE_TARGET = null;
function rulebookData(d) {
  const rb = d.rulebook || {};
  if (!rb.md || !String(rb.md).trim()) return null;
  const parsed = parseRulebook(rb.md, rb);
  if (!parsed.chapters.length) return null;
  if (rb.showScoring !== false) parsed.chapters.unshift({ id: 'points', num: '★', title: 'Points & scoring', intro: '', sections: [], scoring: true });
  return { rb, ...parsed };
}
function pageRules(d, chId, secId) {
  const R = rulebookData(d);
  if (!R) return `<div class="page">${head('Season ' + d.league.season, 'Rules & scoring', '')}${scoringHTML(d)}
    ${d.league.rules ? `<section class="card" style="margin-top:24px"><div class="prose">${md(d.league.rules)}</div></section>` : ''}</div>`;
  const chs = R.chapters;
  const ci = Math.max(0, chs.findIndex(c => c.id === chId));
  const c = chs[ci];
  RULE_TARGET = secId || null;
  const lbl = c2 => `${c2.num ? `<span class="rb-n">${esc(c2.num)}</span>` : ''}<span class="rbk-t">${esc(c2.title || c2.raw || 'Chapter')}</span>`;
  const side = `<aside class="rb-side">
    <div class="rb-search"><input type="search" id="rb-q" placeholder="Search the rules…" autocomplete="off"></div>
    <nav class="rb-chapters">${chs.map(x => `<a href="#/rules/${x.id}" class="rb-ch ${x.id === c.id ? 'active' : ''}">${lbl(x)}</a>
      ${x.id === c.id && x.sections.length ? `<div class="rb-points">${x.sections.map(sx => `<button data-rule-jump="${sx.id}"><b>${esc(sx.num)}</b> ${esc(sx.title || sx.label || '')}</button>`).join('')}</div>` : ''}`).join('')}</nav>
  </aside>`;
  const mobileNav = `<div class="rb-mnav"><select id="rb-msel">${chs.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc((x.num ? x.num + ' · ' : '') + (x.title || ''))}</option>`).join('')}</select>
    ${c.sections.length ? `<div class="rb-mpoints">${c.sections.map(sx => `<button data-rule-jump="${sx.id}">${esc(sx.num || sx.title)}</button>`).join('')}</div>` : ''}</div>`;
  const body = c.scoring ? `<div class="rb-intro prose"><p>How championship points are awarded this season.</p></div>${scoringHTML(d)}` : `
    ${c.intro ? `<div class="rb-intro prose">${md(c.intro)}</div>` : ''}
    ${c.sections.map(sx => `<article class="rb-sec" id="rule-${sx.id}">
      <header>${sx.num ? `<span class="rb-badge mono">${esc(sx.num)}</span>` : ''}<h3>${esc(sx.title || '')}</h3><button class="rb-link" data-rule-copy="${c.id}/${sx.id}" title="Copy link to this rule">🔗</button></header>
      ${sx.body ? `<div class="prose">${md(sx.body)}</div>` : ''}
    </article>`).join('')}`;
  const prev = chs[ci - 1], next = chs[ci + 1];
  return `<div class="page rb">
    <div class="page-head"><div class="eyebrow">${esc(R.rb.version ? 'Version ' + R.rb.version : 'Season ' + d.league.season)}${R.rb.updated ? ' · Updated ' + esc(fmtDate(R.rb.updated + 'T12:00:00')) : ''}</div>
      <h1>${esc(R.rb.title || R.title || 'Rulebook')}</h1></div>
    ${ci === 0 && R.intro ? `<div class="prose rb-docintro">${md(R.intro)}</div>` : ''}
    ${mobileNav}
    <div class="rb-layout">${side}
      <section class="rb-main" id="rb-main">
        <div class="rb-chead"><span class="rb-chnum">${c.scoring ? 'Points' : 'Chapter ' + esc(c.num || ci + 1)}</span><h2>${esc(c.title || '')}</h2>${c.sections.length ? `<span class="muted">${c.sections.length} point${c.sections.length === 1 ? '' : 's'}</span>` : ''}</div>
        ${body}
        <div class="rb-pager">${prev ? `<a class="rb-pg" href="#/rules/${prev.id}"><small>← Previous</small>${esc((prev.num ? prev.num + ' · ' : '') + prev.title)}</a>` : '<span></span>'}${next ? `<a class="rb-pg next" href="#/rules/${next.id}"><small>Next →</small>${esc((next.num ? next.num + ' · ' : '') + next.title)}</a>` : ''}</div>
      </section>
    </div>
  </div>`;
}
function ruleSearch(q) {
  const main = document.getElementById('rb-main'); if (!main) return;
  if (!main.dataset.orig) main.dataset.orig = '1', main._orig = main.innerHTML;
  q = q.trim().toLowerCase();
  if (q.length < 2) { main.innerHTML = main._orig; return; }
  const R = rulebookData(S.data), hits = [];
  R.chapters.forEach(c => c.sections.forEach(sx => {
    const hay = `${sx.num} ${sx.title} ${plain(sx.body)}`.toLowerCase();
    const k = hay.indexOf(q);
    if (k >= 0) { const txt = plain(sx.body); const j = Math.max(0, txt.toLowerCase().indexOf(q) - 60); hits.push({ c, sx, snip: (j ? '…' : '') + txt.slice(j, j + 180) + (txt.length > j + 180 ? '…' : '') }); }
  }));
  const hl = t => esc(t).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  main.innerHTML = `<div class="rb-chead"><span class="rb-chnum">Search</span><h2>${hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(q)}”</h2></div>
    ${hits.map(h => `<a class="rb-hit" href="#/rules/${h.c.id}/${h.sx.id}"><span class="rb-badge mono">${esc(h.sx.num)}</span><div><b>${hl(h.sx.title || h.sx.label || '')}</b><small class="muted">${esc(h.c.title)}</small><p>${hl(h.snip)}</p></div></a>`).join('') || '<p class="muted">Nothing matches — try another word.</p>'}`;
}
function ruleJump(id, flash = true) {
  const el = document.getElementById('rule-' + id); if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 140;
  window.scrollTo({ top: y, behavior: 'smooth' });
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

/* ---------------- team lineup ---------------- */
function wideDriverCard(d, p, T, st, role) {
  const ps = st.D[p.id] || { points: 0 };
  const tag = p.id && byId(d.drivers, p.id) ? 'a' : 'div';
  const num = hasVal(p.number) ? p.number : '';
  return `<${tag} class="dw-card ${role ? 'compact' : ''}" ${tag === 'a' ? `href="#/driver/${esc(p.id)}"` : ''} style="--tc:${esc(teamColor(T))}">
    <div class="dw-bg"></div>
    ${p.photo ? `<img class="dw-photo" src="${esc(asset(p.photo))}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="dw-ghost">${esc(num)}</span>`}
    <div class="dw-text">
      <div class="dc-pos">${role ? `<span class="dw-role">${esc(role)}</span>` : (ps.position ? 'P' + ps.position + ' in championship' : 'Driver')}${p.active === false && !role ? ' · inactive' : ''}</div>
      <div class="dw-name">${nameHTML(p.name || 'TBA')}</div>
      ${num !== '' ? `<div class="dw-num">${esc(num)}</div>` : ''}
      <div class="dw-flag">${flag(p.country, 'lg')}</div>
    </div>
    ${!role ? `<div class="dc-pts"><b>${fmtPts(ps.points)}</b><span>PTS</span></div>` : ''}
  </${tag}>`;
}
function staffCard(d, x, role, T) {
  const w = x.driverId ? byId(d.drivers, x.driverId) : null;
  const ini = String(x.name || '').split(/\s+/).map(z => z[0] || '').join('').slice(0, 2).toUpperCase();
  return `<div class="st-card" style="--tc:${esc(teamColor(T))}">
    <span class="avatar st-av">${x.photo ? `<img src="${esc(asset(x.photo))}" alt="" loading="lazy" onerror="this.remove()">` : esc(ini)}</span>
    <div class="st-txt"><div class="st-role">${esc(role)}</div><div class="st-name">${nameHTML(x.name)}</div>
      ${w || x.country ? `<div class="st-sub">${flag(x.country)}${w ? `<span>with <a href="#/driver/${esc(w.id)}">#${esc(w.number ?? '')} ${esc(w.name.split(' ').pop())}</a></span>` : ''}</div>` : ''}</div>
  </div>`;
}
function teamLineup(d, T, st) {
  const S2 = T.staff || {};
  const drs = d.drivers.filter(p => p.teamId === T.id && p.active !== false);
  const named = x => x && (x.name || x.driverId);
  const people = [];
  if (named(S2.exec)) people.push([S2.exec, (S2.exec.title || 'Executive officer')]);
  const tp = S2.principal && S2.principal.name ? S2.principal : (T.principal ? { name: T.principal } : null);
  if (tp) people.push([tp, 'Team principal']);
  (S2.race || []).filter(named).forEach(x => people.push([x, 'Race engineer']));
  (S2.perf || []).filter(named).forEach(x => people.push([x, 'Performance engineer']));
  const resolve = x => { const r = x.driverId ? byId(d.drivers, x.driverId) : null; return r ? { ...r } : { id: '', name: x.name, number: x.number, country: x.country, photo: x.photo }; };
  const bench = [...(S2.reserves || []).filter(named).map(x => [resolve(x), 'Reserve driver']), ...(S2.academy || []).filter(named).slice(0, 1).map(x => [resolve(x), 'Academy driver'])];
  return `<div class="dw-grid">${drs.length ? drs.map(p => wideDriverCard(d, p, T, st)).join('') : empty('No drivers signed')}</div>
    ${people.length ? `<div class="section-title" style="margin-top:34px"><h2>Team personnel</h2></div><div class="st-grid">${people.map(([x, r]) => staffCard(d, x, r, T)).join('')}</div>` : ''}
    ${bench.length ? `<div class="section-title" style="margin-top:34px"><h2>Reserve & academy</h2></div><div class="dw-grid three">${bench.map(([p, r]) => wideDriverCard(d, p, T, st, r)).join('')}</div>` : ''}
    <div style="height:34px"></div>`;
}

/* ---------------- head to head ---------------- */
function h2hDriverStats(d, id, st) {
  const x = st.D[id] || { points: 0, wins: 0, podiums: 0, poles: 0, fls: 0, dnfs: 0, starts: 0, rounds: {} };
  const fins = rounds(d).map(r => x.rounds[r.id] && x.rounds[r.id].race).filter(rr => rr && rr.pos).map(rr => rr.pos);
  const qs = rounds(d).map(r => { const q = classify(session(d, r.id, 'quali'), 'quali', d.scoring); const i = q.findIndex(e => e.driverId === id); return i >= 0 ? i + 1 : null; }).filter(Boolean);
  const dotd = rounds(d).filter(r => ((d.results[r.id] || {}).dotd || {}).driverId === id).length;
  return { pos: x.position || null, points: x.points, wins: x.wins, podiums: x.podiums, poles: x.poles, fls: x.fls, dnfs: x.dnfs, starts: x.starts, dotd,
    best: fins.length ? Math.min(...fins) : null, avg: fins.length ? fins.reduce((a, b) => a + b, 0) / fins.length : null,
    avgQ: qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : null, ppr: x.starts ? x.points / x.starts : 0, rounds: x.rounds };
}
function h2hTeamStats(d, id, st) {
  const x = st.T[id] || { points: 0, wins: 0, podiums: 0, poles: 0, rounds: {} };
  let best = null, dnfs = 0, onetwo = 0, finSum = 0, finN = 0, races = 0;
  rounds(d).filter(r => isDone(d, r)).forEach(r => {
    const cl = classify(session(d, r.id, 'race'), 'race', d.scoring).filter(e => e.teamId === id);
    if (cl.length) races++;
    cl.forEach(e => { if (e.pos) { best = best ? Math.min(best, e.pos) : e.pos; finSum += e.pos; finN++; } if (e.status === 'DNF') dnfs++; });
    const ps = cl.map(e => e.pos).filter(Boolean).sort((a, b) => a - b);
    if (ps[0] === 1 && ps[1] === 2) onetwo++;
  });
  return { pos: x.position || null, points: x.points, wins: x.wins, podiums: x.podiums, poles: x.poles, best, dnfs, onetwo, races, avg: finN ? finSum / finN : null, ppr: races ? x.points / races : 0, rounds: x.rounds };
}
function pageH2H(d, kind, a, b) {
  kind = kind === 'teams' ? 'teams' : 'drivers';
  const isD = kind === 'drivers';
  const st = computeStandings(d);
  const pool = isD ? st.drivers.map(x => driverLabel(d, x.id)).filter(x => x && x.name) : st.teams.map(x => teamLabel(d, x.id)).filter(x => byId(d.teams, x.id));
  if (pool.length < 2) return `<div class="page">${head('Compare', 'Head to head', '')}${empty('Not enough ' + kind + ' to compare yet')}</div>`;
  const A = pool.find(x => x.id === a) || pool[0];
  const B = pool.find(x => x.id === b && x.id !== A.id) || pool.find(x => x.id !== A.id);
  const tA = isD ? driverTeam(d, A, st.D[A.id]) : A, tB = isD ? driverTeam(d, B, st.D[B.id]) : B;
  let cA = teamColor(tA), cB = teamColor(tB);
  if (cA.toLowerCase() === cB.toLowerCase()) cB = 'var(--pink)';
  const sA = isD ? h2hDriverStats(d, A.id, st) : h2hTeamStats(d, A.id, st), sB = isD ? h2hDriverStats(d, B.id, st) : h2hTeamStats(d, B.id, st);
  // race-by-race head to head
  let aheadA = 0, aheadB = 0, qA = 0, qB = 0;
  const rr = rounds(d).filter(r => isDone(d, r)).map(r => {
    const cl = classify(session(d, r.id, 'race'), 'race', d.scoring, poleDriver(d, r.id));
    const bestOf = id => { const es = cl.filter(e => isD ? e.driverId === id : e.teamId === id); const f = es.filter(e => e.pos).sort((x, y) => x.pos - y.pos)[0]; return f || es[0] || null; };
    const ea = bestOf(A.id), eb = bestOf(B.id);
    if (ea && eb) { const pa = ea.pos || 99, pb = eb.pos || 99; if (pa < pb) aheadA++; else if (pb < pa) aheadB++; }
    if (isD) { const q = classify(session(d, r.id, 'quali'), 'quali', d.scoring); const ia = q.findIndex(e => e.driverId === A.id), ib = q.findIndex(e => e.driverId === B.id); if (ia >= 0 && ib >= 0) { if (ia < ib) qA++; else qB++; } }
    const pA = (sA.rounds[r.id] || {}).pts || 0, pB = (sB.rounds[r.id] || {}).pts || 0;
    const cell = e => e ? (e.pos ? `P${e.pos}` : `<span class="status">${esc(e.label)}</span>`) : '<span class="muted">—</span>';
    const win = ea && eb ? ((ea.pos || 99) < (eb.pos || 99) ? 'a' : (eb.pos || 99) < (ea.pos || 99) ? 'b' : '') : '';
    return `<tr><td class="pos">${esc(r.round)}</td><td><a href="#/results/${esc(r.id)}">${flag(r.country)}&nbsp; ${esc(r.name)}</a></td>
      <td class="mono c ${win === 'a' ? 'h2h-win' : ''}" style="--hc:${cA}">${cell(ea)}</td><td class="mono c">${fmtPts(pA)}</td>
      <td class="mono c ${win === 'b' ? 'h2h-win' : ''}" style="--hc:${cB}">${cell(eb)}</td><td class="mono c">${fmtPts(pB)}</td></tr>`;
  }).join('');
  const f1 = v => v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toString();
  const rows = (isD ? [
    ['Championship position', sA.pos, sB.pos, 'low', v => v ? 'P' + v : '—'], ['Points', sA.points, sB.points, 'high', fmtPts], ['Race head to head', aheadA, aheadB, 'high'],
    ['Qualifying head to head', qA, qB, 'high'], ['Wins', sA.wins, sB.wins, 'high'], ['Podiums', sA.podiums, sB.podiums, 'high'], ['Poles', sA.poles, sB.poles, 'high'],
    ['Fastest laps', sA.fls, sB.fls, 'high'], ['Best finish', sA.best, sB.best, 'low', v => v ? 'P' + v : '—'], ['Average finish', sA.avg, sB.avg, 'low', f1],
    ['Average qualifying', sA.avgQ, sB.avgQ, 'low', f1], ['Points per race', sA.ppr, sB.ppr, 'high', f1], ['Driver of the Day', sA.dotd, sB.dotd, 'high'], ['DNFs', sA.dnfs, sB.dnfs, 'low'], ['Races', sA.starts, sB.starts, 'none']
  ] : [
    ['Championship position', sA.pos, sB.pos, 'low', v => v ? 'P' + v : '—'], ['Points', sA.points, sB.points, 'high', fmtPts], ['Race head to head (best car)', aheadA, aheadB, 'high'],
    ['Wins', sA.wins, sB.wins, 'high'], ['Podiums', sA.podiums, sB.podiums, 'high'], ['Poles', sA.poles, sB.poles, 'high'], ['1-2 finishes', sA.onetwo, sB.onetwo, 'high'],
    ['Best finish', sA.best, sB.best, 'low', v => v ? 'P' + v : '—'], ['Average finish', sA.avg, sB.avg, 'low', f1], ['Points per race', sA.ppr, sB.ppr, 'high', f1], ['DNFs', sA.dnfs, sB.dnfs, 'low']
  ]).map(([label, va, vb, better, fmt]) => {
    fmt = fmt || (v => v === null || v === undefined ? '—' : String(v));
    const na = Number(va), nb = Number(vb), has = va !== null && vb !== null && va !== undefined && vb !== undefined;
    let wa = 50, win = '';
    if (has && better !== 'none') {
      if (better === 'high') { wa = na + nb > 0 ? na / (na + nb) * 100 : 50; win = na > nb ? 'a' : nb > na ? 'b' : ''; }
      else { const ia = 1 / Math.max(na, .5), ib = 1 / Math.max(nb, .5); wa = ia / (ia + ib) * 100; win = na < nb ? 'a' : nb < na ? 'b' : ''; }
    }
    return `<div class="h2h-row"><b class="${win === 'a' ? 'win' : ''}">${fmt(va)}</b><div class="h2h-mid"><span>${esc(label)}</span><div class="h2h-bar"><i style="width:${wa}%;background:${cA}"></i><i style="width:${100 - wa}%;background:${cB}"></i></div></div><b class="${win === 'b' ? 'win' : ''}">${fmt(vb)}</b></div>`;
  }).join('');
  const sel = (side, cur, other) => `<select class="h2h-sel" data-h2h="${side}">${pool.map(x => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''} ${x.id === other ? 'disabled' : ''}>${esc(isD ? (hasVal(x.number) ? '#' + x.number + ' ' : '') + x.name : x.name)}</option>`).join('')}</select>`;
  const side = (X, t, c, s2, cls) => `<div class="h2h-side ${cls}" style="--tc:${c}">
      ${isD ? (X.photo ? `<img class="h2h-photo" src="${esc(asset(X.photo))}" alt="" onerror="this.remove()">` : `<span class="h2h-ghost">${esc(X.number ?? '')}</span>`) : (X.logo ? `<img class="h2h-logo" src="${esc(asset(X.logo))}" alt="" onerror="this.remove()">` : '')}
      <div class="h2h-id"><a href="#/${isD ? 'driver' : 'team'}/${esc(X.id)}" class="h2h-name">${isD ? nameHTML(X.name) : esc(X.name)}</a>
        <div class="muted">${isD ? `${flag(X.country)} ${esc(t ? t.name : '')}` : esc(X.car || X.base || '')}</div>
        <div class="h2h-big"><b>${fmtPts(s2.points)}</b><span>PTS</span></div></div>
    </div>`;
  return `<div class="page h2h">
    <div class="page-head"><div class="eyebrow">Compare</div><h1>Head to head</h1>
      <div class="tabs" style="margin-top:14px"><a href="#/h2h/drivers" class="${isD ? 'active' : ''}">Drivers</a><a href="#/h2h/teams" class="${!isD ? 'active' : ''}">Constructors</a></div></div>
    <div class="h2h-pick">${sel('a', A.id, B.id)}<button class="btn sm" data-h2h-swap>⇄ Swap</button>${sel('b', B.id, A.id)}</div>
    <div class="h2h-hero">${side(A, tA, cA, sA, 'left')}<div class="h2h-vs">VS</div>${side(B, tB, cB, sB, 'right')}</div>
    <div class="card h2h-stats">${rows}</div>
    ${rr ? `<section><div class="section-title"><h2>Race by race</h2></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Rd</th><th>Grand Prix</th><th class="c">${esc(isD ? A.name.split(' ').pop() : A.name)}</th><th class="c">Pts</th><th class="c">${esc(isD ? B.name.split(' ').pop() : B.name)}</th><th class="c">Pts</th></tr></thead><tbody>${rr}</tbody></table></div></section>` : ''}
  </div>`;
}

/* ---------------- gallery ---------------- */
function galleryGrid(d, list) {
  return `<div class="gal-grid">${list.map(x => `<figure class="gal-fig"><img class="zoomable" src="${esc(asset(x.src))}" alt="${esc(x.caption || '')}" loading="lazy"><figcaption>${x.caption ? `<b>${esc(x.caption)}</b>` : ''}${x.credit ? `<span>📷 ${esc(x.credit)}</span>` : ''}</figcaption></figure>`).join('')}</div>`;
}
function pageGallery(d) {
  const g = (d.gallery || []).slice();
  const groups = [];
  g.forEach(x => { const k = x.roundId || ''; const gr = groups.find(y => y.k === k); if (gr) gr.items.push(x); else groups.push({ k, items: [x] }); });
  groups.sort((a, b) => { const ra = byId(d.calendar, a.k), rb = byId(d.calendar, b.k); return (rb ? Number(rb.round) : -1) - (ra ? Number(ra.round) : -1); });
  return `<div class="page">${head('Paddock', 'Gallery', 'Photos from around the league — from our press & media team and the paddock.')}
    ${g.length ? groups.map(gr => { const r = byId(d.calendar, gr.k); return `<section><div class="section-title"><h2>${r ? `${flag(r.country)} R${esc(r.round)} · ${esc(r.name)}` : 'Around the paddock'}</h2><span class="muted">${gr.items.length} photo${gr.items.length === 1 ? '' : 's'}</span></div>${galleryGrid(d, gr.items)}</section>`; }).join('') : empty('No photos yet')}
  </div>`;
}

/* ---------------- about ---------------- */
/* ---------- league staff: big profile slides ---------- */
const SS = { i: 0 };
function staffShow(d, people, title) {
  const n = people.length; if (SS.i >= n) SS.i = 0;
  const slide = (x, k) => {
    const ini = String(x.name || '').split(/\s+/).map(z => z[0] || '').join('').slice(0, 2).toUpperCase();
    return `<article class="ss-slide" data-ss-i="${k}" aria-roledescription="slide" aria-label="${k + 1} of ${n}">
      <div class="ss-photo">${x.photo ? `<img src="${esc(asset(x.photo))}" alt="${esc(x.name)}" loading="lazy" onerror="this.remove()">` : ''}<span class="ss-ini">${esc(ini)}</span></div>
      <div class="ss-info"><div class="ss-no mono">${String(k + 1).padStart(2, '0')}</div>
        <div class="ss-role">${esc(x.role || 'Staff')}</div>
        <h3 class="ss-name">${nameHTML(x.name)}</h3>
        <div class="ss-meta">${flag(x.country)}${x.handle ? `<span class="mono">${esc(x.handle)}</span>` : ''}</div>
        ${x.bio ? `<div class="ss-bio prose">${md(x.bio)}</div>` : ''}</div></article>`;
  };
  return `<section class="staff-show-wrap"><div class="section-title"><h2>${esc(title)}</h2>${n > 1 ? `<span class="ss-count mono"><b>${String(SS.i + 1).padStart(2, '0')}</b> / ${String(n).padStart(2, '0')}</span>` : ''}</div>
    <div class="staff-show ${n === 1 ? 'single' : ''}" data-ss tabindex="0" aria-roledescription="carousel">
      <div class="ss-track">${people.map(slide).join('')}</div>
      ${n > 1 ? `<button class="ss-nav prev" data-ss-go="-1" aria-label="Previous">‹</button><button class="ss-nav next" data-ss-go="1" aria-label="Next">›</button>` : ''}
    </div>
    ${n > 1 ? `<div class="ss-dots">${people.map((x, k) => `<button data-ss-to="${k}" aria-label="${esc(x.name)}" title="${esc(x.name)}"></button>`).join('')}</div>` : ''}</section>`;
}
function ssApply(root) {
  const box = root || document.querySelector('[data-ss]'); if (!box) return;
  const slides = [...box.querySelectorAll('.ss-slide')], n = slides.length; if (!n) return;
  SS.i = ((SS.i % n) + n) % n;
  slides.forEach((el, k) => {
    let off = k - SS.i;
    if (n > 2) { if (off > n / 2) off -= n; if (off < -n / 2) off += n; }
    el.className = 'ss-slide ' + (off === 0 ? 'is-cur' : off === -1 ? 'is-prev' : off === 1 ? 'is-next' : off < 0 ? 'is-far-l' : 'is-far-r');
    el.setAttribute('aria-hidden', off === 0 ? 'false' : 'true');
  });
  const wrap = box.closest('.staff-show-wrap');
  if (wrap) {
    const c = wrap.querySelector('.ss-count b'); if (c) c.textContent = String(SS.i + 1).padStart(2, '0');
    wrap.querySelectorAll('.ss-dots button').forEach((b, k) => b.classList.toggle('on', k === SS.i));
  }
}
const ssGo = dir => { SS.i += dir; ssApply(); };
document.addEventListener('click', e => {
  if (!e.target.closest) return;
  const g = e.target.closest('[data-ss-go]'); if (g) { ssGo(Number(g.dataset.ssGo)); return; }
  const t = e.target.closest('[data-ss-to]'); if (t) { SS.i = Number(t.dataset.ssTo); ssApply(); return; }
  const s = e.target.closest('.ss-slide.is-prev, .ss-slide.is-next'); if (s) { ssGo(s.classList.contains('is-prev') ? -1 : 1); }
});
document.addEventListener('keydown', e => {
  if (!document.querySelector('[data-ss]') || /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) return;
  if (e.key === 'ArrowLeft') ssGo(-1); else if (e.key === 'ArrowRight') ssGo(1);
});
let ssTouch = null;
document.addEventListener('touchstart', e => { if (e.target.closest && e.target.closest('[data-ss]')) ssTouch = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
document.addEventListener('touchend', e => {
  if (!ssTouch) return; const dx = e.changedTouches[0].clientX - ssTouch[0], dy = e.changedTouches[0].clientY - ssTouch[1]; ssTouch = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) ssGo(dx < 0 ? 1 : -1);
}, { passive: true });

function pageAbout(d) {
  const a = d.about || {};
  const people = (a.team || []).filter(x => x && x.name);
  return `<div class="page about">
    ${a.image ? `<div class="about-cover"><img src="${esc(asset(a.image))}" alt="" onerror="this.parentNode.remove()"></div>` : ''}
    ${head('About', esc(a.title || 'About ' + (d.league.name || 'the league')), a.tagline ? esc(a.tagline) : '')}
    <div class="about-grid">
      <div class="card prose about-body">${a.body ? md(a.body) : `<p class="muted">The league hasn't written its story yet.</p>`}</div>
      <aside class="about-side">
        <div class="card"><h3>At a glance</h3><dl class="kv">
          <dt>Season</dt><dd>${esc(d.league.season)}</dd><dt>Drivers</dt><dd>${d.drivers.filter(x => x.active !== false).length}</dd><dt>Teams</dt><dd>${d.teams.length}</dd>
          <dt>Rounds</dt><dd>${d.calendar.filter(r => !r.cancelled).length}</dd>${d.history.length ? `<dt>Seasons</dt><dd>${d.history.length + 1}</dd>` : ''}${a.founded ? `<dt>Founded</dt><dd>${esc(a.founded)}</dd>` : ''}${a.platform ? `<dt>Platform</dt><dd>${esc(a.platform)}</dd>` : ''}</dl></div>
        ${d.league.links && Object.values(d.league.links).some(Boolean) ? `<div class="card"><h3>Find us</h3><div class="toolbar" style="display:flex;gap:8px;flex-wrap:wrap">${[['discord', 'Discord'], ['youtube', 'YouTube'], ['twitch', 'Twitch'], ['website', 'Website']].filter(([k]) => d.league.links[k]).map(([k, l]) => `<a class="btn sm" href="${esc(d.league.links[k])}" target="_blank" rel="noopener">${l}</a>`).join('')}</div></div>` : ''}
      </aside>
    </div>
    ${people.length ? ((a.staffStyle || 'carousel') === 'carousel' ? staffShow(d, people, a.teamTitle || 'League staff') : `<section><div class="section-title"><h2>${esc(a.teamTitle || 'League staff')}</h2></div><div class="st-grid">${people.map(x => staffCard(d, x, x.role || 'Staff', { color: x.color || 'var(--miku)' })).join('')}</div></section>`) : ''}
  </div>`;
}

/* ---------------- search ---------------- */
function searchIndex(d) {
  const items = [];
  const add = (type, title, sub, href, hay, img) => items.push({ type, title, sub, href, hay: (title + ' ' + (hay || '') + ' ' + (sub || '')).toLowerCase(), img });
  [['Home', '#/'], ['Calendar', '#/schedule'], ['Results', '#/results'], ['Standings', '#/standings'], ['Constructors standings', '#/standings/teams'], ['Points progression', '#/standings/progress'], ['Drivers', '#/drivers'], ['Teams', '#/teams'], ['News', '#/news'], ['Rules', '#/rules'], [rcName(d), '#/fia'], ['Fantasy league', '#/fantasy'], ['Grid Draft', '#/griddraft'], ['Hall of fame', '#/history'], ['Seasons archive', '#/seasons'], ['Head to head', '#/h2h'], ['About', '#/about'], ['Join the league', '#/join']]
    .forEach(([t, h]) => add('Pages', t, '', h, ''));
  d.drivers.forEach(x => { const t = byId(d.teams, x.teamId); add('Drivers', x.name, `${hasVal(x.number) ? '#' + x.number + ' · ' : ''}${t ? t.name : 'Free agent'}`, '#/driver/' + x.id, `${x.number} ${x.gamertag || ''} ${x.country || ''}`, { drv: x, t }); });
  d.teams.forEach(t => {
    add('Teams', t.name, [t.base, t.car].filter(Boolean).join(' · '), '#/team/' + t.id, `${t.engine || ''} ${t.principal || ''}`, { team: t });
    const S2 = t.staff || {};
    [[S2.exec, (S2.exec || {}).title || 'Executive'], [S2.principal, 'Team principal'], ...(S2.race || []).map(x => [x, 'Race engineer']), ...(S2.perf || []).map(x => [x, 'Performance engineer']), ...(S2.reserves || []).map(x => [x, 'Reserve driver']), ...(S2.academy || []).map(x => [x, 'Academy driver'])]
      .filter(([x]) => x && x.name).forEach(([x, role]) => add('People', x.name, `${role} · ${t.name}`, '#/team/' + t.id, ''));
  });
  rounds(d).forEach(r => add('Races', r.name, `Round ${r.round}${r.track ? ' · ' + r.track : ''}${r.start ? ' · ' + fmtDate(r.start) : ''}`, '#/results/' + r.id, `${r.track || ''} ${r.country || ''} r${r.round} round ${r.round}`, { flag: r.country }));
  sortedNews(d).forEach(n => add('News', n.title, n.date ? fmtDate(n.date + 'T12:00:00') : '', '#/news/' + n.id, `${n.tag || ''} ${plain(n.body).slice(0, 600)}`));
  const R = rulebookData(d);
  if (R) R.chapters.forEach(c => c.sections.forEach(x => add('Rules', `${x.num} ${x.title || x.label || ''}`.trim(), c.title, `#/rules/${c.id}/${x.id}`, plain(x.body).slice(0, 400))));
  d.stewards.forEach(x => { const r = byId(d.calendar, x.roundId); add(rcName(d), x.title || 'Decision', `${r ? 'R' + r.round + ' · ' : ''}${x.status || ''}`, '#/stewards' + (r ? '/' + r.id : ''), `${x.penalty || ''} ${plain(x.decision)} ${(byId(d.drivers, x.driverId) || {}).name || ''}`); });
  fiaNewsList(d).forEach(x => add(rcName(d), x.title, `Announcement${x.date ? ' · ' + fmtDate(x.date) : ''}`, '#/fia/announcements', plain(x.body).slice(0, 400)));
  d.history.forEach(h => add('Hall of fame', `Season ${h.season}`, `${h.driverChampion || ''}${h.teamChampion ? ' · ' + h.teamChampion : ''}`, h.standings ? '#/history/' + h.id : '#/history', ''));
  return items;
}
function runSearch(d, q) {
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return searchIndex(d).map(it => {
    if (!words.every(w => it.hay.includes(w))) return null;
    const tl = it.title.toLowerCase(); let sc = 0;
    words.forEach(w => { if (tl.startsWith(w)) sc += 6; else if (tl.split(/\s+/).some(x => x.startsWith(w))) sc += 4; else if (tl.includes(w)) sc += 2; else sc += 1; });
    sc += { Drivers: 2, Teams: 2, Races: 1.5, Pages: 1 }[it.type] || 0;
    return { ...it, sc };
  }).filter(Boolean).sort((a, b) => b.sc - a.sc);
}
const SEARCH_ORDER = ['Drivers', 'Teams', 'Races', 'People', 'News', 'Rules', 'KIRA', 'FIA', 'Hall of fame', 'Pages'];
function searchResultHTML(it, q) {
  const hl = t => { let h = esc(t); q.toLowerCase().split(/\s+/).filter(w => w.length > 1).forEach(w => { h = h.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); }); return h; };
  const ic = it.img && it.img.drv ? avatar(it.img.drv, it.img.t, 'sm') : it.img && it.img.team ? `<span class="swatch" style="--tc:${esc(teamColor(it.img.team))};height:26px;margin:0 8px 0 4px"></span>` : it.img && it.img.flag ? `<span class="sr-flag">${flag(it.img.flag)}</span>` : `<span class="sr-ic">${{ News: '✎', Rules: '§', Pages: '↗', People: '◉', 'Hall of fame': '♛' }[it.type] || '⚑'}</span>`;
  return `<a class="sr-item" href="${esc(it.href)}">${ic}<span class="sr-txt"><b>${hl(it.title)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span class="sr-type">${esc(it.type)}</span></a>`;
}
function groupedResults(res, q, limit) {
  const groups = {};
  res.forEach(r => { (groups[r.type] = groups[r.type] || []).push(r); });
  const keys = Object.keys(groups).sort((a, b) => (SEARCH_ORDER.indexOf(a) + 99) % 99 - (SEARCH_ORDER.indexOf(b) + 99) % 99 || 0);
  return keys.map(k => `<div class="sr-group"><div class="sr-gh">${esc(k)} <span>${groups[k].length}</span></div>${groups[k].slice(0, limit || 99).map(it => searchResultHTML(it, q)).join('')}</div>`).join('');
}
function pageSearch(d, q) {
  q = q || '';
  const res = runSearch(d, q);
  return `<div class="page search-page">
    <div class="page-head"><div class="eyebrow">Search</div><h1>${q ? `Results for “${esc(q)}”` : 'Search the league'}</h1></div>
    <form class="sp-form" data-form="search"><input type="search" name="q" value="${esc(q)}" placeholder="Drivers, teams, races, rules, news…" autocomplete="off"><button class="btn primary">Search</button></form>
    ${q ? (res.length ? `<p class="muted">${res.length} result${res.length === 1 ? '' : 's'}</p><div class="sr-page">${groupedResults(res, q)}</div>` : empty('Nothing found', '<p>Try a driver surname, a team, a track or a rule number.</p>')) : ''}
  </div>`;
}
function openSearch() {
  let o = document.getElementById('search-ov');
  if (!o) {
    o = document.createElement('div'); o.id = 'search-ov'; o.className = 'search-ov';
    o.innerHTML = `<div class="so-box" role="dialog" aria-label="Search"><form class="so-form" data-form="search"><span class="so-ic">⌕</span><input name="q" type="search" placeholder="Search drivers, teams, races, rules…" autocomplete="off"><kbd>Esc</kbd></form><div class="so-res"></div><div class="so-foot muted">Enter to see all results</div></div>`;
    document.body.appendChild(o);
    o.addEventListener('click', e => { if (e.target === o) closeSearch(); });
    o.querySelector('input').addEventListener('input', e => {
      const q = e.target.value, res = runSearch(S.data, q);
      o.querySelector('.so-res').innerHTML = q.trim() ? (res.length ? groupedResults(res, q, 4) : '<p class="muted" style="padding:14px">No matches.</p>') : '<p class="muted" style="padding:14px">Start typing — try a driver, team, track or rule number.</p>';
    });
  }
  o.classList.add('open'); document.body.classList.add('so-lock');
  const i = o.querySelector('input'); i.value = ''; i.dispatchEvent(new Event('input')); setTimeout(() => i.focus(), 30);
}
function closeSearch() { const o = document.getElementById('search-ov'); if (o) { if (o.contains(document.activeElement)) document.activeElement.blur(); o.classList.remove('open'); } document.body.classList.remove('so-lock'); }

/* ---------------- driver of the day ---------------- */
const dotdOf = (d, rid) => { const v = d.results[rid] && d.results[rid].dotd; return v && v.driverId ? v : null; };
const teamAt = (d, rid, did) => { const e = [...session(d, rid, 'race'), ...session(d, rid, 'sprint')].find(x => x.driverId === did); return teamLabel(d, (e && e.teamId) || (byId(d.drivers, did) || {}).teamId); };
function dotdCard(d, rid, withRound) {
  const v = dotdOf(d, rid); if (!v) return '';
  const r = byId(d.calendar, rid), drv = driverLabel(d, v.driverId), t = teamAt(d, rid, v.driverId);
  const has = x => x !== '' && x !== null && x !== undefined;
  const rows = [{ driverId: v.driverId, pct: v.pct }, ...(v.runners || []).filter(x => x && x.driverId)];
  const bars = rows.length > 1 && rows.some(x => has(x.pct)) ? `<div class="dotd-bars">${rows.map(x => {
    const p = driverLabel(d, x.driverId), pt = teamAt(d, rid, x.driverId), w = Math.max(0, Math.min(100, Number(x.pct) || 0));
    return `<div class="bar"><span class="bl">${esc(p.name.split(' ').pop())}</span><span class="track"><i style="width:${w}%;background:${esc(teamColor(pt))}"></i></span><span class="bp">${has(x.pct) ? fmtPts(x.pct) + '%' : ''}</span></div>`;
  }).join('')}</div>` : '';
  return `<div class="dotd" style="--tc:${esc(teamColor(t))}">
    <div class="dotd-main">${avatar(drv, t, 'lg')}<div style="min-width:0"><div class="eyebrow" style="margin-bottom:4px">Driver of the Day${withRound && r ? ` · R${esc(r.round)} ${esc(r.name)}` : ''}</div>
      <div class="dotd-name"><a href="#/driver/${esc(drv.id)}">${nameHTML(drv.name)}</a></div>
      <div class="muted" style="font-size:14px">${esc(t.name)}${has(v.pct) ? ` · ${fmtPts(v.pct)}% of the vote` : ''}</div>
      ${v.link ? `<a class="btn xs ghost" style="margin-top:10px" href="${esc(v.link)}" target="_blank" rel="noopener">See the poll →</a>` : ''}</div></div>
    ${bars}
  </div>`;
}

/* ---------------- progression: animated graph + bar race ---------------- */
const PG = { kind: 'drv', mode: 'graph', t: null, n: 0, playing: false, hidden: {}, raf: 0, data: null };
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function progressChart(d, st) {
  const rs = rounds(d).filter(r => !r.cancelled && isDone(d, r));
  if (!rs.length) return empty('No races completed yet', '<p>The progression fills in after the first round.</p>');
  const mk = (rows, isTeam) => rows.map(x => {
    const ent = isTeam ? teamLabel(d, x.id) : driverLabel(d, x.id);
    const t = isTeam ? ent : driverTeam(d, ent, x);
    let c = 0; const pts = [0];
    rs.forEach(r => { c += x.rounds[r.id] ? x.rounds[r.id].pts : 0; pts.push(c); });
    pts[pts.length - 1] += x.points - c;
    const short = isTeam ? (ent.name.length > 18 ? ent.name.slice(0, 17) + '…' : ent.name) : ent.name.split(' ').pop();
    return { name: ent.name, short, color: teamColor(t), pts, drv: isTeam ? null : ent, team: t };
  });
  const n = rs.length;
  if (PG.n !== n || PG.t === null) { PG.t = n; PG.hidden = {}; }
  PG.n = n; PG.data = { rs, drv: mk(st.drivers, false), team: mk(st.teams, true) };
  const seg = (attr, cur, opts) => `<div class="tabs seg">${opts.map(([k, l]) => `<button data-${attr}="${k}" class="${cur === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="card prog" id="prog">
    <div class="prog-bar">
      ${seg('pg-kind', PG.kind, [['drv', 'Drivers'], ['team', 'Constructors']])}
      ${seg('pg-mode', PG.mode, [['graph', 'Graph'], ['race', 'Bar race']])}
      <div class="prog-play"><button class="btn sm primary" data-pg="play" id="pg-play">▶ Play</button><input type="range" id="pg-slider" min="0" max="${n}" step="0.01" value="${PG.t}" aria-label="Round"><span class="mono" id="pg-label"></span></div>
    </div>
    <div id="pg-stage" class="pg-stage"></div>
    <div class="chips" id="pg-chips"></div>
  </div>`;
}
const pgSeries = () => PG.kind === 'team' ? PG.data.team : PG.data.drv;
const pgVal = (s, t) => { const j = Math.floor(t), f = t - j, a = s.pts[Math.min(j, s.pts.length - 1)], b = s.pts[Math.min(j + 1, s.pts.length - 1)]; return a + (b - a) * f; };
function pgHidden() { const ser = pgSeries(); return PG.hidden[PG.kind] || (PG.hidden[PG.kind] = new Set(ser.map((x, i) => i).filter(i => i >= 10))); }
function mountProgress() { pgBuild(); pgDraw(); pgButton(); }
function pgBuild() {
  const stage = document.getElementById('pg-stage'); if (!stage) return;
  const ser = pgSeries(), hid = pgHidden();
  document.querySelectorAll('[data-pg-kind]').forEach(b => b.classList.toggle('active', b.dataset.pgKind === PG.kind));
  document.querySelectorAll('[data-pg-mode]').forEach(b => b.classList.toggle('active', b.dataset.pgMode === PG.mode));
  document.getElementById('pg-chips').innerHTML = PG.mode === 'graph'
    ? ser.map((x, i) => `<button data-pg-chip="${i}" class="${hid.has(i) ? 'off' : ''}" style="--c:${esc(x.color)}"><i></i>${esc(x.short)}</button>`).join('') + '<button data-pg="all" class="chip-act">Show all</button><button data-pg="none" class="chip-act">Hide all</button>'
    : '';
  stage.innerHTML = PG.mode === 'race'
    ? `<div class="race-head"><div class="race-round" id="pg-round"></div><div class="muted" id="pg-lead"></div></div>
       <div class="race" style="height:${ser.length * 44}px">${ser.map((x, i) => `<div class="race-row" data-i="${i}" style="--c:${esc(x.color)}"><span class="rr-pos"></span>${x.drv ? avatar(x.drv, x.team, 'sm') : `<span class="swatch" style="--tc:${esc(x.color)}"></span>`}<span class="rr-name">${esc(x.short)}</span><span class="rr-track"><i></i></span><span class="rr-val"></span></div>`).join('')}</div>`
    : '';
}
function pgDraw() {
  const stage = document.getElementById('pg-stage');
  if (!stage || !PG.data) { PG.playing = false; cancelAnimationFrame(PG.raf); return; }
  const ser = pgSeries(), rs = PG.data.rs, t = PG.t, ri = Math.round(t);
  const fmtV = v => PG.playing ? String(Math.round(v)) : fmtPts(v);
  const lbl = document.getElementById('pg-label'); if (lbl) lbl.textContent = ri ? `After R${rs[ri - 1].round}` : 'Season start';
  const sl = document.getElementById('pg-slider'); if (sl && document.activeElement !== sl) sl.value = t;
  if (PG.mode === 'race') {
    const order = ser.map((x, i) => ({ i, v: pgVal(x, t) })).sort((a, b) => b.v - a.v || a.i - b.i);
    const max = Math.max(1, order[0].v);
    order.forEach((o, rank) => {
      const row = stage.querySelector(`.race-row[data-i="${o.i}"]`); if (!row) return;
      row.style.transform = `translateY(${rank * 44}px)`;
      row.querySelector('.rr-pos').textContent = rank + 1;
      row.querySelector('.rr-track i').style.width = (Math.max(0, o.v) / max * 100).toFixed(2) + '%';
      row.querySelector('.rr-val').textContent = fmtV(o.v);
    });
    const r = ri ? rs[ri - 1] : null;
    document.getElementById('pg-round').innerHTML = r ? `${flag(r.country)} R${esc(r.round)} · ${esc(r.name)}` : 'Season start';
    document.getElementById('pg-lead').textContent = ri ? `Leader: ${ser[order[0].i].name} · ${fmtV(order[0].v)} pts` : '';
  } else stage.innerHTML = graphSVG(ser, rs, t, pgHidden(), fmtV);
}
function graphSVG(ser, rs, t, hid, fmtV) {
  const W = 960, H = 420, L = 46, R = 170, T = 18, B = 40, n = rs.length;
  const vis = ser.map((x, i) => ({ x, i })).filter(o => !hid.has(o.i));
  const all = (vis.length ? vis : ser.map((x, i) => ({ x, i }))).flatMap(o => o.x.pts);
  const hi = Math.max(...all, 1), lo = Math.min(0, ...all);
  const step = niceStep(Math.max(10, hi - lo) / 5);
  const top = Math.ceil(hi / step) * step, bot = Math.floor(lo / step) * step;
  const X = i => L + (W - L - R) * (n ? i / n : 0);
  const Y = v => T + (H - T - B) * (1 - (v - bot) / ((top - bot) || 1));
  let g = '';
  for (let v = bot; v <= top + 1e-9; v += step) g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${fmtPts(v)}</text>`;
  for (let i = 0; i <= n; i++) g += `<text class="ax" x="${X(i).toFixed(1)}" y="${H - B + 24}" text-anchor="middle">${i ? 'R' + esc(rs[i - 1].round) : 'Start'}</text>`;
  if (t < n) g += `<line class="now" x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
  const ends = vis.map(o => ({ i: o.i, y: Y(pgVal(o.x, t)) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
  const ly = {}; ends.forEach(e => { ly[e.i] = e.y; });
  const seen = {}, dash = {};
  ser.forEach((x, i) => { dash[i] = !!seen[x.color]; seen[x.color] = 1; });
  const fl = Math.floor(t);
  const lines = vis.map(({ x, i }) => {
    const pts = []; for (let j = 0; j <= fl && j <= n; j++) pts.push([X(j), Y(x.pts[j])]);
    if (t > fl) pts.push([X(t), Y(pgVal(x, t))]);
    const path = pts.map((p, j) => `${j ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const dots = x.pts.slice(1, fl + 1).map((v, j) => `<circle cx="${X(j + 1).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.2" fill="${esc(x.color)}"><title>${esc(x.name)} · R${esc(rs[j].round)}: ${fmtPts(v)} pts</title></circle>`).join('');
    const hx = X(t), hy = Y(pgVal(x, t));
    return `<g><path class="ln" d="${path}" stroke="${esc(x.color)}"${dash[i] ? ' stroke-dasharray="7 5"' : ''}/>${dots}<circle class="head" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="5" fill="${esc(x.color)}"/><text class="lbl" x="${W - R + 10}" y="${(ly[i] + 4).toFixed(1)}" fill="${esc(x.color)}">${esc(x.short)} · ${fmtV(pgVal(x, t))}</text></g>`;
  }).join('');
  return `<div style="overflow-x:auto"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Points progression" style="min-width:640px">${g}${lines}</svg></div>`;
}
function pgButton() { const b = document.getElementById('pg-play'); if (b) b.textContent = PG.playing ? '❚❚ Pause' : PG.t >= PG.n - 0.001 ? '↺ Replay' : '▶ Play'; }
function pgStop() { PG.playing = false; cancelAnimationFrame(PG.raf); pgButton(); pgDraw(); }
function pgPlay() {
  if (PG.playing) return pgStop();
  if (PG.t >= PG.n - 0.001) PG.t = 0;
  PG.playing = true; pgButton();
  let last = performance.now();
  const step = now => {
    if (!PG.playing) return;
    PG.t = Math.min(PG.n, PG.t + (now - last) / 1100); last = now;
    pgDraw();
    if (!document.getElementById('pg-stage')) return;
    if (PG.t >= PG.n) return pgStop();
    PG.raf = requestAnimationFrame(step);
  };
  PG.raf = requestAnimationFrame(step);
}
document.addEventListener('click', e => {
  const k = e.target.closest('[data-pg-kind]'), m = e.target.closest('[data-pg-mode]'), c = e.target.closest('[data-pg-chip]'), a = e.target.closest('[data-pg]');
  if (k) { PG.kind = k.dataset.pgKind; pgBuild(); pgDraw(); }
  else if (m) { PG.mode = m.dataset.pgMode; pgBuild(); pgDraw(); }
  else if (c) { const h = pgHidden(), i = Number(c.dataset.pgChip); h.has(i) ? h.delete(i) : h.add(i); c.classList.toggle('off'); pgDraw(); }
  else if (a) { const act = a.dataset.pg; if (act === 'play') pgPlay(); else { const h = pgHidden(); h.clear(); if (act === 'none') pgSeries().forEach((x, i) => h.add(i)); pgBuild(); pgDraw(); } }
});
document.addEventListener('input', e => { if (e.target.id === 'pg-slider') { PG.playing = false; cancelAnimationFrame(PG.raf); PG.t = Number(e.target.value); pgDraw(); pgButton(); } });

/* ---------------- hall of fame ---------------- */
function snapshotSeason(d) {
  const st = computeStandings(d);
  const dr = st.drivers.map(x => { const p = driverLabel(d, x.id), t = driverTeam(d, p, x); return { name: p.name, team: t ? t.name : '', color: teamColor(t), country: p.country || '', points: x.points, wins: x.wins, podiums: x.podiums }; });
  const tm = st.teams.map(x => { const t = teamLabel(d, x.id); return { name: t.name, color: teamColor(t), points: x.points, wins: x.wins }; });
  const winners = rounds(d).filter(r => isDone(d, r)).map(r => {
    const w = classify(session(d, r.id, 'race'), 'race', d.scoring).find(e => e.pos === 1);
    const p = w ? driverLabel(d, w.driverId) : null, t = w ? teamLabel(d, w.teamId) : null;
    return { round: r.round, name: r.name, country: r.country || '', winner: p ? p.name : '', team: t ? t.name : '', color: teamColor(t) };
  });
  const c = dr[0], ct = tm[0];
  return { id: uid('season'), season: d.league.season, driverChampion: c ? c.name : '', driverTeam: c ? c.team : '', driverColor: c ? c.color : '#39c5bb', driverPoints: c ? c.points : '',
    teamChampion: ct ? ct.name : '', teamColor: ct ? ct.color : '#39c5bb', teamPoints: ct ? ct.points : '', notes: '', standings: { drivers: dr, teams: tm }, winners };
}
const seasonSort = (a, b) => String(b.season).localeCompare(String(a.season), undefined, { numeric: true });
const TROPHY = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hofg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset=".5" stop-color="#e6b84f"/><stop offset="1" stop-color="#9c6a14"/></linearGradient></defs><path fill="url(#hofg)" d="M18 6h28v14c0 9-6 16-14 16S18 29 18 20zM16 10H6c0 10 5 15 13 16l-1-5c-4-1-6-4-7-7h5zM48 10h10c0 10-5 15-13 16l1-5c4-1 6-4 7-7h-5zM28 35h8v9h-8zM19 44h26l3 12H16z"/></svg>`;
function champPhoto(d, name) {
  const p = d.drivers.find(x => x.name && name && x.name.trim().toLowerCase() === String(name).trim().toLowerCase());
  return p && (p.headshot || p.photo) ? asset(p.headshot || p.photo) : '';
}
/* ---------- sakura (cherry blossom) hall of fame ---------- */
const isSakura = d => ((d.theme || {}).hofStyle || 'sakura') === 'sakura';
const SK_PETAL = 'M0 0C-7.5-5-9-14.5-4.2-20.5L0-17.2L4.2-20.5C9-14.5 7.5-5 0 0Z';
function skFlower(x, y, s, rot, op = 1, open = true) {
  const petals = [0, 72, 144, 216, 288].map(a => `<path d="${SK_PETAL}" transform="rotate(${a})"/>`).join('');
  const stamens = open ? [15, 87, 159, 231, 303].map(a => `<line x1="0" y1="0" x2="0" y2="-7.5" transform="rotate(${a})"/><circle cx="0" cy="-8" r="1.1" transform="rotate(${a})"/>`).join('') : '';
  return `<g class="skf" transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" opacity="${op}"><g class="skp">${petals}</g><circle class="skc" r="3.2"/><g class="sks">${stamens}</g></g>`;
}
function skBranch() {
  return `<svg viewBox="0 0 440 230" aria-hidden="true"><g class="skb" fill="none" stroke-linecap="round">
      <path d="M-10 26C70 34 120 58 176 92S290 150 360 152" stroke-width="9"/><path d="M118 60C140 30 168 18 204 14" stroke-width="5"/><path d="M228 118C246 150 252 176 250 206" stroke-width="5"/>
      <path d="M300 146C326 126 352 118 386 120" stroke-width="3.5"/><path d="M60 36C66 60 64 84 54 104" stroke-width="3.5"/></g>
    ${skFlower(206, 14, 1.25, 10)}${skFlower(176, 30, 1, 40, .95)}${skFlower(142, 64, 1.35, -12)}${skFlower(98, 52, 1.05, 30, .9)}${skFlower(54, 104, 1.15, 5)}${skFlower(30, 30, .9, -25, .85)}
    ${skFlower(250, 206, 1.15, 22)}${skFlower(240, 162, .95, -8, .9)}${skFlower(206, 112, 1.2, 16)}${skFlower(300, 148, 1.3, -30)}${skFlower(346, 126, 1, 12, .9)}${skFlower(388, 120, 1.15, 48)}${skFlower(364, 156, .85, 0, .8)}
    <g class="skbud"><ellipse cx="232" cy="8" rx="4" ry="6" transform="rotate(40 232 8)"/><ellipse cx="80" cy="118" rx="3.5" ry="5.5"/><ellipse cx="408" cy="134" rx="3.5" ry="5.5" transform="rotate(60 408 134)"/><ellipse cx="270" cy="182" rx="3" ry="5" transform="rotate(-30 270 182)"/></g></svg>`;
}
const skIcon = (cls = '') => `<svg class="sk-icon ${cls}" viewBox="-24 -24 48 48" aria-hidden="true">${skFlower(0, 0, 1, 0)}</svg>`;
function skFall(n = 22) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = (i * 37 + 11) % 100, dur = 9 + (i * 7) % 9, del = -((i * 13) % 17), sz = 9 + (i * 5) % 9, sw = 30 + (i * 11) % 60, rot = (i * 47) % 360;
    out += `<i style="--x:${x}%;--d:${dur}s;--dl:${del}s;--s:${sz}px;--sw:${sw}px;--r:${rot}deg"></i>`;
  }
  return `<div class="sk-fall" aria-hidden="true">${out}</div>`;
}
const skHeroDeco = () => `<div class="sk-branch l">${skBranch()}</div><div class="sk-branch r">${skBranch()}</div><div class="sk-kanji" aria-hidden="true">殿堂</div><div class="sk-moon" aria-hidden="true"></div>`;

function champCard(d, h, current) {
  const photo = champPhoto(d, h.driverChampion);
  const sk = isSakura(d);
  return `<article class="hof-card ${current ? 'current' : ''}">
    <div class="hof-sheen"></div>${sk ? `<div class="sk-corner" aria-hidden="true">${skIcon()}${skIcon('b')}</div>` : ''}
    <div class="hof-top"><span class="hof-season">${esc(h.season)}</span><span class="hof-tag">${current ? 'In progress' : 'Champions'}</span></div>
    <div class="hof-driver">
      <div class="hof-medal"><span class="hof-trophy">${sk ? skIcon() : current ? '◆' : TROPHY}</span>${photo ? `<img src="${esc(photo)}" alt="" onerror="this.remove()">` : ''}</div>
      <div style="min-width:0"><div class="hof-label">${current ? 'Championship leader' : "Drivers' Champion"}</div>
        <div class="hof-name">${h.driverChampion ? nameHTML(h.driverChampion) : '—'}</div>
        <div class="hof-sub"><span class="swatch" style="--tc:${esc(h.driverColor || '#e6b84f')}"></span>${esc(h.driverTeam || '')}${hasVal(h.driverPoints) ? ` · <b>${fmtPts(h.driverPoints)}</b> pts` : ''}</div></div>
    </div>
    <div class="hof-divider"><span>${sk ? skIcon() : '✦'}</span></div>
    <div class="hof-label">${current ? 'Leading constructor' : "Constructors' Champion"}</div>
    <div class="hof-tname"><span class="swatch" style="--tc:${esc(h.teamColor || '#e6b84f')}"></span>${esc(h.teamChampion || '—')}${hasVal(h.teamPoints) ? `<span class="hof-pts">${fmtPts(h.teamPoints)} pts</span>` : ''}</div>
    ${h.notes ? `<div class="hof-notes prose">${md(h.notes)}</div>` : ''}
    ${current ? '<a class="hof-link" href="#/standings">Live standings →</a>' : (() => { const full = (S.data.seasons || []).find(x => x && x.file && String(x.label) === String(h.season)); return full ? `<a class="hof-link" href="#/seasons/view/${esc(full.id)}">Explore the full season →</a>` : h.standings ? `<a class="hof-link" href="#/history/${esc(h.id)}">Final standings →</a>` : ''; })()}
  </article>`;
}
function pageHistory(d) {
  const list = [...d.history].sort(seasonSort);
  const st = computeStandings(d);
  const started = rounds(d).some(r => isDone(d, r));
  const cur = started && !d.history.some(h => String(h.season) === String(d.league.season)) && st.drivers[0] ? (() => {
    const p = driverLabel(d, st.drivers[0].id), t = driverTeam(d, p, st.drivers[0]), ct = st.teams[0] && teamLabel(d, st.teams[0].id);
    return champCard(d, { season: d.league.season, driverChampion: p.name, driverTeam: t ? t.name : '', driverColor: teamColor(t), driverPoints: st.drivers[0].points, teamChampion: ct ? ct.name : '', teamColor: teamColor(ct), teamPoints: st.teams[0] ? st.teams[0].points : '' }, true);
  })() : '';
  const tally = {};
  list.forEach(h => { if (h.driverChampion) tally[h.driverChampion] = (tally[h.driverChampion] || 0) + 1; });
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const multi = ranked.filter(([, n]) => n > 1);
  const sk = isSakura(d);
  return `<div class="page hof ${sk ? 'hof-sakura' : ''}">${sk ? skFall() : ''}
    <header class="hof-hero">${sk ? skHeroDeco() : ''}
      <div class="hof-crest">${sk ? skIcon() : TROPHY}</div>
      <div class="hof-eyebrow">${esc(d.league.name)}</div>
      <h1 class="hof-title">Hall of Fame${sk ? '<span class="sk-seal" aria-hidden="true">桜</span>' : ''}</h1>
      <p class="hof-subtitle">The drivers and teams who conquered the grid.</p>
      <div class="hof-stats">
        <div><b>${list.length}</b><span>Seasons</span></div>
        <div><b>${ranked.length}</b><span>Champions</span></div>
        <div><b>${ranked[0] ? esc(ranked[0][0].split(' ').pop()) : '—'}</b><span>Most titles${ranked[0] ? ' · ' + ranked[0][1] : ''}</span></div>
      </div>
    </header>
    ${multi.length ? `<div class="hof-multi">${multi.map(([nm, n]) => `<span class="hof-chip">${sk ? skIcon().repeat(Math.min(n, 7)) : '★'.repeat(Math.min(n, 7))} ${esc(nm)} <b>×${n}</b></span>`).join('')}</div>` : ''}
    ${cur || list.length ? `<div class="hof-grid">${cur}${list.map(h => champCard(d, h)).join('')}</div>` : empty('No champions crowned yet', '<p>When a season ends, the admin archives it here.</p>')}
  </div>`;
}
function pageHistorySeason(d, id) {
  const h = byId(d.history, id);
  if (!h) return notFound();
  const sd = (h.standings && h.standings.drivers) || [], tm = (h.standings && h.standings.teams) || [], w = h.winners || [];
  const sk = isSakura(d);
  return `<div class="page hof ${sk ? 'hof-sakura' : ''}">${sk ? skFall(14) : ''}<a class="back" href="#/history">← Hall of fame</a>
    <header class="hof-hero sm">${sk ? skHeroDeco() : ''}
      <div class="hof-crest">${sk ? skIcon() : TROPHY}</div>
      <div class="hof-eyebrow">Season ${esc(h.season)} · Final standings</div>
      <h1 class="hof-title">${h.driverChampion ? esc(h.driverChampion) : 'Season ' + esc(h.season)}</h1>
      <p class="hof-subtitle">${h.driverChampion ? "Drivers' Champion" : ''}${h.teamChampion ? ` · ${esc(h.teamChampion)}, Constructors' Champion` : ''}</p>
    </header>
    <div class="grid grid-2">
      <div><div class="section-title"><h2>Drivers</h2></div>${sd.length ? `<div class="table-wrap hof-table"><table class="tbl"><thead><tr><th>Pos</th><th>Driver</th><th class="hide-sm">Team</th><th class="r">Wins</th><th class="r">Pts</th></tr></thead><tbody>${sd.map((x, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}"><td class="pos">${i + 1}</td><td><span class="swatch" style="--tc:${esc(x.color)}"></span>${nameHTML(x.name)} ${flag(x.country)}</td><td class="hide-sm team-name">${esc(x.team)}</td><td class="r mono">${x.wins ?? ''}</td><td class="pts">${fmtPts(x.points)}</td></tr>`).join('')}</tbody></table></div>` : empty('No data')}</div>
      <div><div class="section-title"><h2>Constructors</h2></div>${tm.length ? `<div class="table-wrap hof-table"><table class="tbl"><thead><tr><th>Pos</th><th>Team</th><th class="r">Wins</th><th class="r">Pts</th></tr></thead><tbody>${tm.map((x, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}"><td class="pos">${i + 1}</td><td><span class="swatch" style="--tc:${esc(x.color)}"></span>${esc(x.name)}</td><td class="r mono">${x.wins ?? ''}</td><td class="pts">${fmtPts(x.points)}</td></tr>`).join('')}</tbody></table></div>` : empty('No data')}</div>
    </div>
    ${w.length ? `<section><div class="section-title"><h2>Race winners</h2></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Rd</th><th>Grand Prix</th><th>Winner</th><th class="hide-sm">Team</th></tr></thead><tbody>${w.map(x => `<tr><td class="pos">${esc(x.round)}</td><td>${flag(x.country)}&nbsp; ${esc(x.name)}</td><td>${x.winner ? nameHTML(x.winner) : '—'}</td><td class="hide-sm"><span class="swatch" style="--tc:${esc(x.color)}"></span><span class="team-name">${esc(x.team)}</span></td></tr>`).join('')}</tbody></table></div></section>` : ''}
  </div>`;
}

/* ---------------- stewards ---------------- */
const STATUS_CLS = { 'Penalty': 'st-pen', 'Warning': 'st-warn', 'Reprimand': 'st-warn', 'No further action': 'st-nfa', 'Under investigation': 'st-inv' };
function stewardCard(d, s, hideRound) {
  const r = byId(d.calendar, s.roundId);
  const drv = s.driverId ? driverLabel(d, s.driverId) : null;
  const ent = r && drv ? [...session(d, r.id, 'race'), ...session(d, r.id, 'sprint')].find(e => e.driverId === drv.id) : null;
  const t = byId(d.teams, (ent && ent.teamId) || (drv && drv.teamId));
  const pts = Number(s.points) || 0;
  return `<div class="sd-card" style="--tc:${esc(teamColor(t))}">
    <div class="sd-top"><span class="sd-org">${esc(rcName(d))}</span>${r && !hideRound ? `<a class="chip" href="#/results/${esc(r.id)}">R${esc(r.round)} · ${esc(r.name)}</a>` : ''}<span class="muted">${esc(sessionName(s.session || 'race'))}${s.lap ? ` · ${esc(s.lap)}` : ''}</span><span class="badge ${STATUS_CLS[s.status] || 'st-inv'}">${esc(s.status || 'Under investigation')}</span></div>
    <h3>${esc(s.title || 'Incident')}</h3>
    ${drv ? `<div class="sd-who"><span class="swatch" style="--tc:${esc(teamColor(t))}"></span><a href="#/driver/${esc(drv.id)}">${nameHTML(drv.name)}</a>${s.involved ? `<span class="muted"> · involving ${esc(s.involved)}</span>` : ''}</div>` : (s.involved ? `<div class="sd-who muted">Involving ${esc(s.involved)}</div>` : '')}
    ${s.decision ? `<div class="prose sd-body">${md(s.decision)}</div>` : ''}
    ${docsHTML(s.docs)}
    ${s.penalty || pts ? `<div class="sd-pen">${s.penalty ? `<span class="tag-fl">${esc(s.penalty)}</span>` : ''}${pts ? `<span class="tag-pole">${pts > 0 ? '+' : ''}${fmtPts(pts)} championship pts${s.teamToo ? ' · driver & team' : ''}</span>` : ''}</div>` : ''}
  </div>`;
}
function docsHTML(docs) {
  const list = (docs || []).filter(Boolean);
  if (!list.length) return '';
  return `<div class="sd-docs">${list.map(u => isImg(u)
    ? `<img class="sd-doc zoomable" src="${esc(asset(u))}" alt="Official document" loading="lazy">`
    : `<a class="btn sm" href="${esc(asset(u))}" target="_blank" rel="noopener">📄 ${/\.pdf$/i.test(u) ? 'Open full report (PDF)' : 'Open document'}</a>`).join('')}</div>`;
}
const FIA_CATS = { notice: ['Notice', 'var(--miku)'], document: ['Document', '#9aa5ff'], penalty: ['Penalty', 'var(--pink)'], schedule: ['Schedule', '#f3d27a'], regulation: ['Regulation', '#86cecb'] };
const fiaNewsList = d => [...(d.fiaNews || [])].filter(x => x && x.title && !x.hidden).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.date || '').localeCompare(String(a.date || '')));
function fiaCard(d, x, short) {
  const c = FIA_CATS[x.category] || FIA_CATS.notice, r = byId(d.calendar, x.roundId);
  const body = short ? `<p>${esc(plain(x.body).slice(0, 170))}${plain(x.body).length > 170 ? '…' : ''}</p>` : `<div class="prose">${md(x.body || '')}</div>${docsHTML(x.docs)}`;
  return `<article class="fia-card" style="--fc:${c[1]}">
    <div class="fia-top"><span class="sd-org">${esc(rcName(d))}</span><span class="fia-cat">${esc(c[0])}</span>${x.pinned ? '<span title="Pinned">📌</span>' : ''}<span class="muted fia-date">${x.date ? esc(fmtDate(x.date, { day: 'numeric', month: 'short', year: 'numeric' })) + (String(x.date).length > 10 ? ' · ' + esc(fmtTime(x.date)) : '') : ''}</span></div>
    <h3>${short ? `<a href="#/fia/announcements">${esc(x.title)}</a>` : esc(x.title)}</h3>
    ${r ? `<a class="chip" href="#/results/${esc(r.id)}" style="margin-bottom:8px;display:inline-block">${flag(r.country)} R${esc(r.round)} · ${esc(r.name)}</a>` : ''}
    ${body}
  </article>`;
}
function fiaHomeSection(d) {
  const list = fiaNewsList(d).slice(0, 3);
  if (!list.length) return '';
  return `<section><div class="section-title"><h2>Latest from the ${esc(rcName(d))}</h2><a href="#/fia/announcements">All ${esc(rcName(d))} announcements →</a></div><div class="fia-grid">${list.map(x => fiaCard(d, x, true)).join('')}</div></section>`;
}
function pageStewards(d, rid) {
  const feed = d.fiaFeed || {};
  const hasLive = /^\d{5,}$/.test(String(feed.server || '').trim()) && /^\d{5,}$/.test(String(feed.channel || '').trim());
  const news = fiaNewsList(d);
  let tab = rid === 'announcements' || rid === 'decisions' || rid === 'live' ? rid : rid ? 'decisions' : (news.length ? 'announcements' : 'decisions');
  if (rid === 'decisions' || rid === 'announcements' || rid === 'live') rid = null;
  const tabs = `<div class="tabs"><a href="#/fia/announcements" class="${tab === 'announcements' ? 'active' : ''}">Announcements${news.length ? ` <span class="muted">${news.length}</span>` : ''}</a><a href="#/fia/decisions" class="${tab === 'decisions' ? 'active' : ''}">Decisions${d.stewards.length ? ` <span class="muted">${d.stewards.length}</span>` : ''}</a>${hasLive ? `<a href="#/fia/live" class="${tab === 'live' ? 'active' : ''}">● Live from Discord</a>` : ''}</div>`;
  const top = head('Race control', esc(rcName(d)), 'Official announcements, documents, incident reviews and penalties.');
  if (tab === 'announcements') return `<div class="page">${top}${tabs}${news.length ? `<div class="fia-list">${news.map(x => fiaCard(d, x)).join('')}</div>` : empty('No announcements yet')}</div>`;
  if (tab === 'live') return `<div class="page">${top}${tabs}<div class="fia-live"><iframe src="https://e.widgetbot.io/channels/${esc(String(feed.server).trim())}/${esc(String(feed.channel).trim())}" title="${esc(rcName(d))} Discord channel" loading="lazy" allow="clipboard-write; fullscreen"></iframe></div><p class="hint">Live view of the league's Discord channel.</p></div>`;
  return `<div class="page">${top}${tabs}${pageStewardsBody(d, rid)}</div>`;
}
function pageStewardsBody(d, rid) {
  const rorder = x => { const r = byId(d.calendar, x.roundId); return r ? Number(r.round) || 0 : -1; };
  const all = [...d.stewards].sort((a, b) => rorder(b) - rorder(a));
  const withDec = rounds(d).filter(r => all.some(x => x.roundId === r.id));
  const list = rid ? all.filter(x => x.roundId === rid) : all;
  const picker = withDec.length > 1 ? `<div class="round-picker"><a href="#/fia/decisions" class="${!rid ? 'active' : ''}">All rounds</a>${withDec.map(r => `<a href="#/stewards/${esc(r.id)}" class="${r.id === rid ? 'active' : ''}">${flag(r.country)} R${esc(r.round)}</a>`).join('')}</div>` : '';
  const groups = [];
  list.forEach(x => { const g = groups.find(y => y.id === (x.roundId || '')); if (g) g.items.push(x); else groups.push({ id: x.roundId || '', items: [x] }); });
  const body = groups.map(g => { const r = byId(d.calendar, g.id); return `<section><div class="section-title"><h2>${r ? `${flag(r.country)} R${esc(r.round)} · ${esc(r.name)}` : 'General'}</h2><span class="muted">${g.items.length} decision${g.items.length > 1 ? 's' : ''}</span></div><div class="sd-list">${g.items.map(x => stewardCard(d, x, true)).join('')}</div></section>`; }).join('');
  return `${picker}${list.length ? body : empty('No decisions published', '<p>Clean racing so far. 🩵</p>')}`;
}

/* ---------------- sign-ups ---------------- */
function pageJoin(d) {
  const s = d.signups, per = Number(s.seatsPerTeam) || 2;
  const seats = d.teams.map(t => ({ t, n: per - d.drivers.filter(x => x.teamId === t.id && x.active !== false).length })).filter(x => x.n > 0);
  const total = seats.reduce((a, b) => a + b.n, 0);
  const taken = d.drivers.filter(x => x.active !== false && x.number !== '' && x.number != null).map(x => Number(x.number)).sort((a, b) => a - b);
  const discord = d.league.links && d.league.links.discord;
  const appForm = ((d.applications || {}).forms || []).find(f => f.open);
  const applyBtn = appForm ? `<a class="btn primary" href="#/apply/${esc(appForm.id)}">Apply now →</a>` : s.formUrl ? `<a class="btn primary" href="${esc(s.formUrl)}" target="_blank" rel="noopener">Apply now →</a>` : discord ? `<a class="btn primary" href="${esc(discord)}" target="_blank" rel="noopener">Apply on Discord →</a>` : '';
  return `<div class="page">${head('Season ' + d.league.season, esc(s.title || 'Join the grid'), '')}
    <div class="card" style="margin-bottom:20px"><div class="join-status"><span class="badge ${s.open ? 'next' : 'cancel'}" style="${s.open ? '' : 'text-decoration:none'}">${s.open ? 'Sign-ups open' : 'Sign-ups closed'}</span>${s.open && total ? `<span class="muted">${total} seat${total > 1 ? 's' : ''} available</span>` : ''}<span style="margin-left:auto">${s.open ? applyBtn : ''}</span></div>
      ${s.intro ? `<div class="prose" style="margin-top:16px">${md(s.intro)}</div>` : `<p class="muted" style="margin:14px 0 0">${s.open ? 'We\'re looking for drivers! Read the requirements and send in an application.' : 'Sign-ups are closed right now — keep an eye on the news page or Discord for the next window.'}</p>`}
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-title"><h3>Open seats</h3></div>${seats.length ? `<ul class="mini">${seats.map(x => `<li><span class="swatch" style="--tc:${esc(teamColor(x.t))}"></span><span class="grow">${esc(x.t.name)}</span><span class="v">${x.n} seat${x.n > 1 ? 's' : ''}</span></li>`).join('')}</ul>` : '<p class="muted">Every race seat is filled — you can still apply as a reserve driver.</p>'}</div>
      <div class="card"><div class="card-title"><h3>Requirements</h3></div>${s.requirements ? `<div class="prose" style="font-size:15px">${md(s.requirements)}</div>` : `<p class="muted">Check the <a href="#/rules">rules</a> before applying.</p>`}</div>
    </div>
    ${s.open && s.showBuilder !== false ? `<section class="card" style="margin-top:20px"><div class="card-title"><h3>Build your application</h3><span class="muted" style="font-size:13px">Fill it in, copy, and paste it ${s.formUrl ? 'into the form' : 'in Discord'}</span></div>
      <div class="pform">
        <label class="fld"><span>Name</span><input id="ap-name" type="text"></label>
        <label class="fld"><span>Gamertag / PSN / Steam</span><input id="ap-tag" type="text"></label>
        <label class="fld"><span>Platform</span><select id="ap-platform"><option>PC</option><option>PlayStation</option><option>Xbox</option></select></label>
        <label class="fld"><span>Country</span><input id="ap-country" type="text"></label>
        <label class="fld"><span>Preferred number</span><input id="ap-number" type="number" min="1" max="99"></label>
        <label class="fld"><span>Availability</span><input id="ap-avail" type="text" placeholder="e.g. every Wednesday 8pm CT"></label>
        <label class="fld wide"><span>Racing experience</span><textarea id="ap-exp" placeholder="Leagues, lap times, favourite tracks…"></textarea></label>
        ${taken.length ? `<div class="wide"><span class="muted" style="font-size:13px">Numbers already taken:</span><div class="taken">${taken.map(n => `<span>#${n}</span>`).join('')}</div></div>` : ''}
        <div class="wide" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn primary" data-act="copy-app">Copy application</button>${applyBtn.replace('btn primary', 'btn')}</div>
        <label class="fld wide" hidden><span>Your application</span><textarea id="ap-out" readonly rows="8"></textarea></label>
      </div></section>` : ''}
  </div>`;
}
function copyApplication() {
  const v = id => ((document.getElementById('ap-' + id) || {}).value || '').trim();
  if (!v('name')) return toast('Add your name first', 'err');
  const num = v('number');
  if (num && S.data.drivers.some(x => x.active !== false && String(x.number) === num)) return toast(`#${num} is already taken — pick another`, 'err');
  const txt = [`**Driver application · ${S.data.league.name}**`, `Name: ${v('name')}`, `Gamertag: ${v('tag') || '—'}`, `Platform: ${v('platform')}`, `Country: ${v('country') || '—'}`, `Preferred number: ${num || 'Any'}`, `Availability: ${v('avail') || '—'}`, `Experience: ${v('exp') || '—'}`].join('\n');
  const out = document.getElementById('ap-out');
  if (out) { out.value = txt; out.closest('label').hidden = false; }
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
    .then(() => toast('Application copied! Paste it ' + (S.data.signups.formUrl ? 'into the form.' : 'in Discord.')))
    .catch(() => { if (out) out.select(); toast('Copy the text below and paste it in Discord.'); });
}

/* ---------------- timing widget (my time / track time + watch) ---------------- */
const TP_KEY = 'league.timepref';
let TIMEPREF = lsGet(TP_KEY) === 'track' ? 'track' : 'mine';
const clockStr = tz => fmtIn(Date.now(), tz || undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function zoneParts(tz) {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', timeZone: tz || undefined });
    const o = {}; f.formatToParts(new Date()).forEach(x => { o[x.type] = Number(x.value); }); return o;
  } catch (e) { const n = new Date(); return { hour: n.getHours(), minute: n.getMinutes(), second: n.getSeconds() }; }
}
function watchSVG() {
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = i * 6, big = i % 5 === 0;
    ticks += `<line x1="50" y1="${big ? 13 : 14.5}" x2="50" y2="${big ? 19 : 16.5}" transform="rotate(${a} 50 50)" class="${big ? 'tk-b' : 'tk'}"/>`;
  }
  return `<svg class="watch" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="48" class="w-bezel"/><circle cx="50" cy="50" r="44" class="w-ring"/><circle cx="50" cy="50" r="37" class="w-face"/>
    ${ticks}
    <g class="w-h"><line x1="50" y1="53" x2="50" y2="32"/></g>
    <g class="w-m"><line x1="50" y1="55" x2="50" y2="22"/></g>
    <g class="w-s"><line x1="50" y1="58" x2="50" y2="18"/><circle cx="50" cy="50" r="2.4"/></g>
    <circle cx="50" cy="50" r="1" class="w-pin"/></svg>`;
}
function timingWidget(d, tz, cls = '') {
  const logo = (d.theme && d.theme.timingLogo) || d.league.logo;
  return `<div class="tw ${cls}" data-tz="${esc(tz || '')}">
    ${d.theme.timingLogo !== 'none' ? `<span class="tw-logo">${logo && logo !== 'none' ? `<img src="${esc(asset(logo))}" alt="" onerror="this.remove()">` : esc((d.league.name || 'F1').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>` : ''}
    <div class="tw-rows">
      <button class="tw-row ${TIMEPREF === 'mine' ? 'on' : ''}" data-tp="mine"><i></i><span>My time</span><b class="mono" data-clock="">--:--</b></button>
      ${tz ? `<button class="tw-row ${TIMEPREF === 'track' ? 'on' : ''}" data-tp="track"><i></i><span>Track time</span><b class="mono" data-clock="${esc(tz)}">--:--</b></button>` : ''}
    </div>
    ${watchSVG()}
  </div>`;
}
function tickClocks() {
  document.querySelectorAll('.tw').forEach(w => {
    const tz = w.dataset.tz;
    w.querySelectorAll('[data-clock]').forEach(b => { b.textContent = clockStr(b.dataset.clock); });
    const p = zoneParts(TIMEPREF === 'track' && tz ? tz : null);
    const set = (sel, deg) => { const g = w.querySelector(sel); if (g) g.setAttribute('transform', `rotate(${deg} 50 50)`); };
    set('.w-h', (p.hour % 12) * 30 + p.minute * 0.5);
    set('.w-m', p.minute * 6 + p.second * 0.1);
    set('.w-s', p.second * 6);
  });
}
setInterval(tickClocks, 1000);
function setTimePref(v) {
  TIMEPREF = v; lsSet(TP_KEY, v);
  document.querySelectorAll('[data-tp]').forEach(b => b.classList.toggle('on', b.dataset.tp === v));
  document.querySelectorAll('.wk').forEach(w => { const r = byId(S.data.calendar, w.dataset.round); if (r) w.outerHTML = weekendSchedule(S.data, r); });
  tickClocks();
}

/* ---------------- weekend schedule ---------------- */
const SESSION_PRESETS = ['Practice 1', 'Practice 2', 'Practice 3', 'Sprint Qualifying', 'Sprint', 'Qualifying', 'Race'];
function weekendSessions(r) {
  const list = (r.sessions || []).filter(x => x && x.start).map(x => ({ name: x.name || 'Session', start: x.start, end: x.end || '' }));
  if (!list.length && r.start) list.push({ name: 'Race', start: r.start, end: '' });
  return list.sort((a, b) => new Date(a.start) - new Date(b.start));
}
function weekendSchedule(d, r) {
  const ss = weekendSessions(r);
  if (!ss.length) return '';
  const tz = trackTz(r), useTrack = TIMEPREF === 'track' && tz;
  const zone = useTrack ? tz : null;
  const hm = iso => fmtIn(iso, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const now = Date.now();
  const rows = ss.map(x => {
    const st = new Date(x.start).getTime(), en = x.end ? new Date(x.end).getTime() : st + 2 * 36e5;
    const state = now >= en ? 'past' : now >= st ? 'live' : '';
    return `<div class="wk-row ${state}">
      <div class="wk-date"><b class="mono">${esc(fmtIn(x.start, zone, { day: '2-digit' }))}</b><span>${esc(fmtIn(x.start, zone, { month: 'short' }).toUpperCase())}</span></div>
      <div class="wk-name">${esc(x.name)}${state === 'live' ? '<span class="rb-pill live">● Live</span>' : ''}</div>
      <div class="wk-time mono">${esc(hm(x.start))}${x.end ? ' – ' + esc(hm(x.end)) : ''}</div>
    </div>`;
  }).join('');
  return `<section class="wk" data-round="${esc(r.id)}">
    <div class="wk-head"><h2>Schedule</h2>${timingWidget(d, tz)}</div>
    <div class="wk-card">
      <div class="wk-bar"><button class="btn sm primary" data-act="ics" data-round="${esc(r.id)}">📅 Add to calendar</button>
        ${tz ? `<div class="tabs seg wk-toggle"><button data-tp="mine" class="${!useTrack ? 'active' : ''}">My time</button><button data-tp="track" class="${useTrack ? 'active' : ''}">Track time</button></div>` : ''}</div>
      ${rows}
      <p class="wk-note muted">${useTrack ? `Times shown in track time (${esc(fmtIn(ss[0].start, tz, { timeZoneName: 'short' }).split(' ').pop())}).` : `Times shown in your time zone (${esc(fmtIn(ss[0].start, null, { timeZoneName: 'short' }).split(' ').pop())}).`}</p>
    </div>
  </section>`;
}
function downloadICS(d, r) {
  const ss = weekendSessions(r);
  const z = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escI = t => String(t).replace(/[,;\\]/g, m => '\\' + m);
  const ev = ss.map((x, i) => ['BEGIN:VEVENT', `UID:${r.id}-${i}-${z(x.start)}@league`, `DTSTAMP:${z(new Date().toISOString())}`, `DTSTART:${z(x.start)}`,
    `DTEND:${z(x.end || new Date(new Date(x.start).getTime() + 2 * 36e5).toISOString())}`, `SUMMARY:${escI(`${d.league.name} · R${r.round} ${r.name} · ${x.name}`)}`,
    `LOCATION:${escI(r.track || r.name)}`, `URL:${location.href.split('#')[0]}#/results/${r.id}`, 'END:VEVENT'].join('\r\n'));
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//League Site//EN', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${(r.name || 'round').replace(/[^\w]+/g, '-')}.ics`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------------- youtube ---------------- */
function ytVideoId(u) {
  const m = String(u || '').match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(String(u || '').trim()) ? String(u).trim() : '');
}
function ytSection(d) {
  const y = d.youtube || {};
  if (y.show === false) return '';
  const vid = ytVideoId(y.pinned);
  const ch = String(y.channelId || '').trim();
  let src = '';
  if (vid) src = `https://www.youtube-nocookie.com/embed/${vid}?rel=0`;
  else if (/^UC[\w-]{22}$/.test(ch)) src = `https://www.youtube-nocookie.com/embed/videoseries?list=UU${ch.slice(2)}&rel=0`;
  if (!src) return '';
  const chUrl = y.channelUrl || (ch ? `https://www.youtube.com/channel/${ch}` : '');
  return `<section class="yt">
    <div class="section-title"><h2>${esc(y.title || 'Latest video')}</h2>${chUrl ? `<a href="${esc(chUrl)}" target="_blank" rel="noopener">${y.subscribe === false ? 'Channel' : 'Subscribe'} →</a>` : ''}</div>
    <div class="yt-frame"><iframe src="${esc(src)}" title="${esc(y.title || 'Latest video')}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>
  </section>`;
}

/* ---------------- related articles ---------------- */
function relTime(dateStr) {
  if (!dateStr) return '';
  const t = new Date(dateStr.length <= 10 ? dateStr + 'T12:00:00' : dateStr), diff = Date.now() - t;
  if (diff >= 0 && diff < 864e5) { const h = Math.max(1, Math.round(diff / 36e5)); return `${h} hour${h > 1 ? 's' : ''} ago`; }
  if (diff >= 864e5 && diff < 2 * 864e5) return 'Yesterday';
  return t.toLocaleDateString(undefined, { month: 'long', day: '2-digit', year: 'numeric' });
}
function relatedArticles(d, key, id, excludeId) {
  const list = sortedNews(d).filter(n => n.id !== excludeId && (n[key] || []).includes(id)).slice(0, 6);
  if (!list.length) return '';
  return `<section class="rel"><div class="section-title"><h2 class="rel-title">Related articles</h2><a href="#/news">View all</a></div>
    <div class="rel-grid">${list.map(n => `<a class="rel-card" href="#/news/${esc(n.id)}">
      <div class="rel-img">${n.image ? `<img src="${esc(asset(n.image))}" alt="" loading="lazy" onerror="this.remove()">` : `<span>${esc((n.tag || 'NEWS').slice(0, 4).toUpperCase())}</span>`}</div>
      <div class="rel-body"><h3>${esc(n.title)}</h3><span class="rel-date">${esc(relTime(n.date))}</span></div></a>`).join('')}</div></section>`;
}

const notFound = () => `<div class="page">${empty('Page not found', '<p><a href="#/">Back to home</a></p>')}</div>`;

/* ---------------- router & chrome ---------------- */
const NAV = [['', 'Home'], ['schedule', 'Calendar'], ['results', 'Results'], ['standings', 'Standings'], ['drivers', 'Drivers'], ['teams', 'Teams'], ['news', 'News']];
const MORE = [['about', 'About'], ['rules', 'Rules'], ['stewards', 'Stewards'], ['h2h', 'Head to head'], ['history', 'Hall of fame'], ['seasons', 'Seasons'], ['gallery', 'Gallery'], ['griddraft', 'Grid Draft'], ['apply', 'Applications'], ['join', 'Join the league']];
const ROUTES = [
  [/^$/, d => pageHome(d)],
  [/^schedule$/, d => pageSchedule(d)],
  [/^results$/, d => pageResultsIndex(d)],
  [/^results\/([^/]+)(?:\/(\w+))?$/, (d, m) => pageRound(d, m[1], m[2])],
  [/^standings(?:\/(\w+))?$/, (d, m) => pageStandings(d, m[1])],
  [/^drivers$/, d => pageDrivers(d)],
  [/^driver\/([^/]+)$/, (d, m) => pageDriver(d, m[1])],
  [/^teams$/, d => pageTeams(d)],
  [/^team\/([^/]+)$/, (d, m) => pageTeam(d, m[1])],
  [/^news$/, d => pageNews(d)],
  [/^news\/([^/]+)$/, (d, m) => pageArticle(d, m[1])],
  [/^rules(?:\/([^/]+))?(?:\/([^/]+))?$/, (d, m) => pageRules(d, m[1], m[2])],
  [/^(?:stewards|fia)(?:\/([^/]+))?$/, (d, m) => pageStewards(d, m[1])],
  [/^history$/, d => pageHistory(d)],
  [/^history\/([^/]+)$/, (d, m) => pageHistorySeason(d, m[1])],
  [/^join$/, d => pageJoin(d)],
  [/^h2h(?:\/(drivers|teams))?(?:\/([^/]+))?(?:\/([^/]+))?$/, (d, m) => pageH2H(d, m[1], m[2], m[3])],
  [/^about$/, d => pageAbout(d)],
  [/^gallery$/, d => pageGallery(d)],
  [/^seasons(?:\/(view)\/([^/]+))?$/, (d, m) => window.Extras ? window.Extras.pageSeasons(d, m[1], m[2]) : notFound()],
  [/^portal$/, d => window.Portal ? window.Portal.page(d) : notFound()],
  [/^apply(?:\/([^/]+))?$/, (d, m) => window.Apps ? window.Apps.page(d, m[1]) : notFound()],
  [/^griddraft(?:\/(\w+))?$/, (d, m) => window.GridDraft ? window.GridDraft.page(d, m[1]) : notFound()],
  [/^fantasy(?:\/(\w+))?$/, (d, m) => window.Fantasy ? window.Fantasy.page(d, m[1]) : notFound()],
  [/^search(?:\/(.*))?$/, (d, m) => pageSearch(d, m[1] || '')],
  [/^admin(?:\/(\w+))?$/, (d, m) => window.Admin ? window.Admin.render(m[1]) : notFound()]
];

function barRound(d) {
  const now = Date.now();
  return rounds(d).find(r => { if (r.cancelled) return false; const ss = weekendSessions(r); if (!ss.length) return false; const last = ss[ss.length - 1]; return new Date(last.end || last.start).getTime() + (last.end ? 0 : 3 * 36e5) > now; });
}
function raceBar() {
  const el = document.getElementById('race-bar'); if (!el || !S.data) return;
  const d = S.data, r = d.theme.topBanner === false ? null : barRound(d);
  if (!r) { el.hidden = true; el.innerHTML = ''; return; }
  const ss = weekendSessions(r), first = ss[0], tz = trackTz(r), now = Date.now();
  const live = new Date(first.start) <= now;
  const nextS = ss.find(x => new Date(x.start) > now);
  const key = `${r.id}|${live}|${nextS ? nextS.start : ''}|${TIMEPREF}`;
  if (el.dataset.key === key && !el.hidden) return;
  el.dataset.key = key;
  const d1 = fmtDate(first.start, { day: '2-digit' }), d2 = fmtDate(ss[ss.length - 1].start, { day: '2-digit', month: 'short' }).toUpperCase();
  el.hidden = false;
  el.innerHTML = `<div class="rb-inner">
    <a class="rb-round" href="#/results/${esc(r.id)}">
      <span class="rb-top mono">R${esc(r.round)}<span class="rb-sep">|</span>${d1 === fmtDate(ss[ss.length - 1].start, { day: '2-digit' }) ? '' : esc(d1) + ' – '}${esc(d2)}${live ? '<span class="rb-pill live">● Live</span>' : ''}</span>
      <b>${flag(r.country)} ${esc(r.name)} <span class="rb-chev">›</span></b>
    </a>
    <div class="rb-right">${nextS ? `<span class="rb-cd"><span class="muted">${esc(nextS.name)}</span> <span data-cd-short="${esc(nextS.start)}"></span></span>` : ''}${timingWidget(d, tz, 'dark')}</div>
  </div>`;
  tickClocks();
}
setInterval(() => { if (S.data) raceBar(); }, 60000);

function ensureSearchFab() {
  if (document.getElementById('search-fab')) return;
  const b = document.createElement('button');
  b.id = 'search-fab'; b.className = 'search-fab'; b.setAttribute('aria-label', 'Search the site'); b.title = 'Search (press /)';
  b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.6-4.6"/></svg>';
  document.body.appendChild(b);
}
function chrome() {
  ensureSearchFab();
  const d = S.data, L = d.league;
  applyTheme(d);
  document.title = (L.name || 'F1 League') + (L.season ? ` · ${L.season}` : '');
  document.getElementById('brand-name').textContent = L.name || 'F1 League';
  document.getElementById('brand-season').textContent = L.season ? 'Season ' + L.season : '';
  const mark = document.getElementById('brand-mark');
  mark.innerHTML = L.logo ? `<img src="${esc(asset(L.logo))}" alt="" onerror="this.remove()">` : esc((L.name || 'F1').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
  const top = location.hash.replace(/^#\/?/, '').split('/')[0];
  const cur = ({ driver: 'drivers', team: 'teams', fia: 'stewards' })[top] || top;
  raceBar();
  const link = ([k, l]) => `<a href="#/${k}" class="${cur === k ? 'active' : ''}">${l}${k === 'join' && d.signups.open ? '<span class="dot" title="Sign-ups open"></span>' : ''}</a>`;
  const moreOn = MORE.some(([k]) => k === cur);
  const navItems = d.fantasy && d.fantasy.enabled ? [...NAV, ['fantasy', 'Fantasy']] : NAV;
  document.getElementById('nav').innerHTML = navItems.map(link).join('') +
    `<div class="more"><button class="more-btn ${moreOn ? 'active' : ''}" data-act="more" aria-haspopup="true">More<span class="caret">▾</span>${d.signups.open ? '<span class="dot"></span>' : ''}</button><div class="more-menu">${MORE.filter(([k]) => (k !== 'griddraft' || (d.gridDraft && d.gridDraft.enabled)) && (k !== 'gallery' || (d.gallery || []).length) && (k !== 'apply' || ((d.applications || {}).forms || []).length)).map(([k, l]) => [k, k === 'stewards' ? esc(rcName(d)) : l]).map(link).join('')}</div></div>`;
  const links = L.links || {};
  const ext = [['discord', 'Discord'], ['youtube', 'YouTube'], ['twitch', 'Twitch'], ['website', 'Website']].filter(([k]) => links[k]).map(([k, l]) => `<a href="${esc(links[k])}" target="_blank" rel="noopener">${l}</a>`).join('');
  document.getElementById('foot').innerHTML = `<div class="inner"><div><b style="color:var(--text)">${esc(L.name)}</b> · Season ${esc(L.season)}<br><span style="font-size:12px">${esc(L.footer ?? 'Fan-run sim racing league. Not affiliated with Formula 1.')}</span></div>
    <div class="links">${ext}<a href="#/stewards">${esc(rcName(d))}</a><a href="#/history">Hall of fame</a><a href="#/about">About</a><a href="#/join">Join</a>${((d.applications || {}).forms || []).length ? '<a href="#/apply">Applications</a>' : ''}<a href="#/rules">Rules</a>${d.portalOn ? '<a href="#/portal">Team portal</a>' : ''}<a href="#/admin">Admin</a></div></div>`;
}

/* Title Case for UI labels (menus, tabs, buttons, headings). Only capitalises — never lowercases names like FIA or R5. */
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with', 'from', 'into', 'than', 'is']);
function titleCaseText(t, first) {
  return t.replace(/[A-Za-z][A-Za-z'’]*/g, (w, i) => {
    const before = t.slice(0, i);
    const isFirst = first && !/[A-Za-z0-9]/.test(before);
    const afterColon = /[:—–·]\s*$/.test(before);
    if (/[A-Z]/.test(w.slice(1)) || /^(e|i)\.?$/.test(w) && t[i + w.length] === '.') return w;
    if (t[i - 1] === '.' || (t[i + w.length] === '.' && /[A-Za-z]/.test(t[i + w.length + 1] || ''))) return w; // file names like league.json
    if (!isFirst && !afterColon && SMALL.has(w.toLowerCase()) && !/-$/.test(before)) return w;
    return w[0].toUpperCase() + w.slice(1);
  });
}
const TC_SEL = ['#nav > a', '.more-menu a', '.site-foot .links a', '.side-link', '.tabs > a', '.tabs > button', '.section-title > h2', '.card-title > h3', '.card-title > h2',
  '.page-head h1', '.a-head h1', '.a-card > h3', '.a-card > h4', '.card > h3', '.btn:not(.gd-play)', '.quick a', '.ft-group > h4', '.staff-h > b', '.dw-role', '.gd-slot-l', '.game-btn b', '.sea-info b'].join(',');
function setFavicon(d) {
  const src = d && d.league && (d.league.favicon || d.league.logo); if (!src) return;
  const href = asset(src), link = document.querySelector('link[rel="icon"]');
  if (link && link.dataset.src !== src) { link.href = href; link.dataset.src = src; }
}
function applyTitleCase(root) {
  root.querySelectorAll(TC_SEL).forEach(el => {
    if (el.closest('[data-no-tc], .article, .prose, .news-card, .rel-card')) return;
    let first = true;
    const walk = n => n.childNodes.forEach(c => {
      if (c.nodeType === 3) { if (c.textContent.trim()) { c.textContent = titleCaseText(c.textContent, first); first = false; } }
      else if (c.nodeType === 1 && !/^(INPUT|SELECT|TEXTAREA|SVG|svg|SMALL|KBD|CODE)$/.test(c.tagName) && !c.classList.contains('dname') && !c.classList.contains('muted')) walk(c);
      else if (c.nodeType === 1) first = false;
    });
    walk(el);
  });
}

function render(resetScroll) {
  if (!S.data) return;
  const path = decodeURIComponent(location.hash.replace(/^#\/?/, '')).replace(/\/$/, '');
  let html = null;
  const X = window.Extras;
  const data = S.archive && X && !X.LIVE_ROUTES.test(path) ? S.archive.data : S.data;
  for (const [re, fn] of ROUTES) { const m = path.match(re); if (m) { html = fn(data, m); break; } }
  chrome();
  document.getElementById('app').innerHTML = html ?? notFound();
  document.getElementById('nav').classList.remove('open');
  updateDraftBanner();
  tick();
  if (document.getElementById('prog')) mountProgress();
  if (RULE_TARGET && document.getElementById('rule-' + RULE_TARGET)) { const id = RULE_TARGET; RULE_TARGET = null; setTimeout(() => ruleJump(id), 60); }
  tickClocks();
  if (window.Extras) window.Extras.afterRender(path);
  ssApply();
  setFavicon(S.data);
  applyTitleCase(document.getElementById('app')); applyTitleCase(document.querySelector('.topbar')); applyTitleCase(document.getElementById('foot'));
  if (resetScroll) window.scrollTo({ top: 0, behavior: 'instant' });
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act="discard-draft"]');
  if (b && confirm('Throw away all unpublished changes in this browser?')) discardDraft();
});
document.addEventListener('click', e => {
  const more = e.target.closest('[data-act="more"]');
  document.querySelectorAll('.more.open').forEach(m => { if (!more || !m.contains(more)) m.classList.remove('open'); });
  if (more) { more.parentNode.classList.toggle('open'); return; }
  const ser = e.target.closest('[data-series]');
  if (ser) { const off = ser.classList.toggle('off'); const g = document.querySelector(`[data-line="${ser.dataset.series}"]`); if (g) g.style.display = off ? 'none' : ''; return; }
  const z = e.target.closest('img.zoomable');
  if (z && !z.closest('.admin')) { const o = document.createElement('div'); o.className = 'lightbox'; o.innerHTML = `<img src="${esc(z.currentSrc || z.src)}" alt="">`; o.addEventListener('click', () => o.remove()); document.body.appendChild(o); return; }
  const rj = e.target.closest('[data-rule-jump]');
  if (rj) { ruleJump(rj.dataset.ruleJump); return; }
  const rc = e.target.closest('[data-rule-copy]');
  if (rc) { const url = location.href.split('#')[0] + '#/rules/' + rc.dataset.ruleCopy; (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Link to this rule copied')).catch(() => prompt('Copy this link:', url)); return; }
  const rv = e.target.closest('[data-rv]');
  if (rv) { lsSet(RV_KEY, rv.dataset.rv); render(false); return; }
  const sw = e.target.closest('[data-h2h-swap]');
  if (sw) { const m = location.hash.match(/^#\/h2h\/(drivers|teams)/); const a = document.querySelector('[data-h2h="a"]').value, b = document.querySelector('[data-h2h="b"]').value; location.hash = `#/h2h/${m ? m[1] : 'drivers'}/${b}/${a}`; return; }
  if (e.target.closest('#search-fab')) { openSearch(); return; }
  if (e.target.closest('.search-ov .sr-item')) { closeSearch(); return; }
  const tp = e.target.closest('[data-tp]');
  if (tp && !tp.closest('.admin')) { setTimePref(tp.dataset.tp); const rb = document.getElementById('race-bar'); if (rb) rb.dataset.key = ''; raceBar(); return; }
  const ic = e.target.closest('[data-act="ics"]');
  if (ic) { const r = byId(S.data.calendar, ic.dataset.round); if (r) downloadICS(S.data, r); return; }
  if (e.target.closest('[data-act="copy-app"]')) copyApplication();
});
document.addEventListener('input', e => { if (e.target.id === 'rb-q') ruleSearch(e.target.value); });
document.addEventListener('change', e => {
  if (e.target.id === 'rb-msel') location.hash = '#/rules/' + e.target.value;
  if (e.target.dataset && e.target.dataset.h2h) { const m = location.hash.match(/^#\/h2h\/(drivers|teams)/); const a = document.querySelector('[data-h2h="a"]').value, b = document.querySelector('[data-h2h="b"]').value; location.hash = `#/h2h/${m ? m[1] : 'drivers'}/${a}/${b}`; }
});
document.addEventListener('submit', e => { if (e.target.dataset.form !== 'search') return; e.preventDefault(); const q = e.target.q.value.trim(); closeSearch(); if (q) location.hash = '#/search/' + encodeURIComponent(q); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSearch();
  if ((e.key === '/' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { e.preventDefault(); openSearch(); } if (e.key === 'Escape') document.querySelectorAll('.lightbox').forEach(o => o.remove()); });
document.getElementById('mode-toggle').addEventListener('click', () => {
  lsSet(MODE_KEY, themeMode(S.data) === 'light' ? 'dark' : 'light');
  lsSet(MODE_KEY + '.v', String(S.data.theme.defaultMode || 'dark'));
  applyTheme(S.data);
});
if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S.data) applyTheme(S.data); });
document.getElementById('nav-toggle').addEventListener('click', () => document.getElementById('nav').classList.toggle('open'));
window.addEventListener('hashchange', () => render(true));

/* expose helpers for the admin console */
window.LG = { S, esc, clone, uid, md, fmtPts, fmtDate, fmtTime, byId, flag, nameHTML, teamColor, toast, normalize, emptyLeague,
  rcName, HIST_ROLES, rounds, session, isDone, nextRound, classify, poleDriver, computeStandings, saveDraft, clearDraft, discardDraft, render, DEFAULT_SCORING,
  DEFAULT_THEME, MODE_KEY, applyTheme, snapshotSeason, lastRound, ASSET_CACHE, asset, isImg, avatar, plain, titleCaseText, applyTitleCase, SESSION_PRESETS, ytVideoId, parseRulebook, htmlToMd, parseTyres, tyreChip, TYRES };

load().then(() => render(false));
})();
