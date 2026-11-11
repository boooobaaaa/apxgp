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
