/* calculator.js — quickjsontools.com
 * Tools (custom render): "jsonFormatter", "diffChecker", "regexTester", "jwtDecoder".
 *
 * PRIVACY IS THE PRODUCT. Everything runs in the visitor's browser: no input is sent to a server, logged or
 * stored. The page states this above each tool, and it must stay true — no analytics event may carry input.
 * The regex tester runs the pattern in a Web Worker with a time limit, so a catastrophic pattern cannot freeze
 * the tab. The JWT decoder decodes only; it never claims a signature is valid.
 */
(function (root, factory) {
  const C = factory();
  if (typeof module === 'object' && module.exports) module.exports = C; else root.CALCS = C;
})(typeof self !== 'undefined' ? self : this, function () {
  // ── pure logic (tested) ──────────────────────────────────────────────────
  function lineCol(text, pos) {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    return { line, col: pos - before.lastIndexOf('\n') };
  }

  function formatJson(text, indent = 2) {
    if (!String(text).trim()) return { ok: false, error: { message: 'Paste some JSON first.' } };
    try {
      const value = JSON.parse(text);
      const pretty = JSON.stringify(value, null, indent === 'tab' ? '\t' : Number(indent));
      return { ok: true, output: pretty, minified: JSON.stringify(value), keys: countKeys(value), bytes: new TextEncoder().encode(JSON.stringify(value)).length };
    } catch (e) {
      // Engines word this differently: V8 "... at position 12 (line 2 column 5)", Firefox "... at line 2 column 5".
      const msg = String(e.message);
      let pos = null, line = null, col = null;
      const lc = msg.match(/line (\d+) column (\d+)/i);
      const p = msg.match(/position (\d+)/i);
      if (lc) { line = Number(lc[1]); col = Number(lc[2]); }
      else if (p) { pos = Number(p[1]); ({ line, col } = lineCol(text, pos)); }
      else {
        // V8's "Unexpected token '}'" carries no position, so locate the error ourselves.
        pos = locateJsonError(text);
        if (pos !== null) ({ line, col } = lineCol(text, pos));
      }
      return { ok: false, error: { message: msg.replace(/^JSON\.parse: /, ''), line, col } };
    }
  }
  /** Minimal JSON scanner: returns the index of the first character that makes the text invalid, or null. */
  function locateJsonError(s) {
    let i = 0;
    const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
    const fail = () => { throw i; };
    const lit = w => { if (s.startsWith(w, i)) i += w.length; else fail(); };
    const str = () => {
      if (s[i] !== '"') fail();
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; else if (s.charCodeAt(i) < 32) fail(); i++; }
      if (i >= s.length) fail();
      i++;
    };
    const num = () => { const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i)); if (!m) fail(); i += m[0].length; };
    const val = () => {
      ws();
      const c = s[i];
      if (c === '{') {
        i++; ws();
        if (s[i] === '}') { i++; return; }
        for (;;) { ws(); str(); ws(); if (s[i] !== ':') fail(); i++; val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return; } fail(); }
      }
      if (c === '[') {
        i++; ws();
        if (s[i] === ']') { i++; return; }
        for (;;) { val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return; } fail(); }
      }
      if (c === '"') return str();
      if (c === 't') return lit('true');
      if (c === 'f') return lit('false');
      if (c === 'n') return lit('null');
      return num();
    };
    try { val(); ws(); return i < s.length ? i : null; } catch (pos) { return typeof pos === 'number' ? Math.min(pos, s.length) : null; }
  }
  function countKeys(v) {
    if (Array.isArray(v)) return v.reduce((a, x) => a + countKeys(x), 0);
    if (v && typeof v === 'object') return Object.keys(v).length + Object.values(v).reduce((a, x) => a + countKeys(x), 0);
    return 0;
  }

  /** Line diff via longest common subsequence. Returns ops in order: same / del (only in A) / add (only in B). */
  function diffLines(a, b) {
    const A = String(a).split('\n'), Bl = String(b).split('\n');
    const n = A.length, m = Bl.length;
    if (n * m > 25e6) return { tooLarge: true, ops: [], added: 0, removed: 0 };
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === Bl[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === Bl[j]) { ops.push({ type: 'same', text: A[i], a: i + 1, b: j + 1 }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ type: 'del', text: A[i], a: i + 1 }); i++; }
      else { ops.push({ type: 'add', text: Bl[j], b: j + 1 }); j++; }
    }
    while (i < n) { ops.push({ type: 'del', text: A[i], a: i + 1 }); i++; }
    while (j < m) { ops.push({ type: 'add', text: Bl[j], b: j + 1 }); j++; }
    return { ops, added: ops.filter(o => o.type === 'add').length, removed: ops.filter(o => o.type === 'del').length };
  }

  function findMatches(pattern, flags, text, limit = 1000) {
    let re;
    try { re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'); }
    catch (e) { return { ok: false, error: String(e.message) }; }
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null && out.length < limit) {
      out.push({ index: m.index, match: m[0], groups: m.slice(1), named: m.groups ? { ...m.groups } : null });
      if (m[0] === '') re.lastIndex++;                         // zero-length match: step forward or loop forever
      if (!flags.includes('g')) break;
    }
    return { ok: true, matches: out, truncated: out.length >= limit };
  }

  const b64urlDecode = s => {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(pad);
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  };
  function decodeJwt(token, nowSec = Math.floor(Date.now() / 1000)) {
    const parts = String(token).trim().split('.');
    if (parts.length !== 3) return { ok: false, error: `A JWT has 3 parts separated by dots; this has ${parts.length}.` };
    try {
      const header = JSON.parse(b64urlDecode(parts[0]));
      const payload = JSON.parse(b64urlDecode(parts[1]));
      const exp = typeof payload.exp === 'number' ? payload.exp : null;
      return { ok: true, header, payload, alg: header.alg, hasSignature: parts[2].length > 0,
        expired: exp === null ? null : exp < nowSec, expiresAt: exp === null ? null : new Date(exp * 1000).toISOString(),
        issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000).toISOString() : null };
    } catch (e) { return { ok: false, error: `Could not decode: ${e.message}` }; }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────
  const h = (tag, attrs = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null && v !== false) n.setAttribute(k, v); } for (const c of [].concat(kids)) if (c != null && c !== '') n.append(c); return n; };
  const area = (id, label, rows = 12, placeholder = '') => [h('label', { for: id, text: label }), h('textarea', { id, rows: String(rows), spellcheck: 'false', placeholder, class: 'mono' })];
  const privacy = () => h('p', { class: 'calc-help', text: 'Runs entirely in your browser. Nothing you paste is uploaded or stored.' });
  const copyBtn = getText => h('button', { type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(getText()) }, 'Copy');

  const jsonFormatter = {
    title: 'JSON formatter',
    render(root) {
      const out = h('pre', { class: 'mono out', 'aria-live': 'polite' });
      const status = h('div', { class: 'calc-result' });
      const indent = h('select', { id: 'j-ind' }, [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tabs']].map(([v, l]) => h('option', { value: v, text: l })));
      const [lab, ta] = area('j-in', 'Paste JSON', 14, '{"example": true}');
      const run = mode => {
        const r = formatJson(ta.value, indent.value);
        status.innerHTML = '';
        if (!r.ok) { out.textContent = ''; status.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: r.error.line ? `Invalid JSON at line ${r.error.line}, column ${r.error.col}: ${r.error.message}` : r.error.message }))); return; }
        out.textContent = mode === 'min' ? r.minified : r.output;
        status.append(h('div', { class: 'calc-summary' }, [['Valid JSON', '✓', true], ['Keys', String(r.keys)], ['Minified size', `${r.bytes.toLocaleString()} bytes`]].map(([k, v, s]) => h('div', { class: `calc-stat${s ? ' strong' : ''}` }, [h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })]))));
      };
      root.append(privacy(), lab, ta, h('div', { class: 'calc-actions' }, [h('label', { for: 'j-ind', text: 'Indent ' }), indent,
        h('button', { type: 'button', onclick: () => run('fmt') }, 'Format'), h('button', { type: 'button', onclick: () => run('min') }, 'Minify'), copyBtn(() => out.textContent)]), status, out);
    },
  };

  const diffChecker = {
    title: 'Diff checker',
    render(root) {
      const [la, ta] = area('d-a', 'Original text', 12);
      const [lb, tb] = area('d-b', 'Changed text', 12);
      const out = h('div', { class: 'diff', 'aria-live': 'polite' });
      const run = () => {
        const r = diffLines(ta.value, tb.value);
        out.innerHTML = '';
        if (r.tooLarge) { out.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: 'These inputs are too large to compare in the browser. Split them into smaller parts.' }))); return; }
        out.append(h('p', { text: `${r.added} line(s) added · ${r.removed} line(s) removed` }));
        for (const o of r.ops) out.append(h('div', { class: `d-${o.type}` }, [h('span', { class: 'd-n', text: o.type === 'add' ? `+${o.b}` : o.type === 'del' ? `-${o.a}` : ` ${o.a}` }), h('code', { text: o.text || ' ' })]));
      };
      root.append(privacy(), h('div', { class: 'two-col' }, [h('div', {}, [la, ta]), h('div', {}, [lb, tb])]), h('div', { class: 'calc-actions' }, h('button', { type: 'button', onclick: run }, 'Compare')), out);
    },
  };

  const regexTester = {
    title: 'Regex tester',
    render(root) {
      const pat = h('input', { id: 'r-p', class: 'mono', placeholder: '\\b\\w+@\\w+\\.com\\b', spellcheck: 'false' });
      const flags = h('input', { id: 'r-f', class: 'mono', value: 'g', size: '6', 'aria-label': 'Flags' });
      const [lt, tt] = area('r-t', 'Test text', 10);
      const out = h('div', { class: 'calc-result', 'aria-live': 'polite' });
      // Run in a Worker so a catastrophic pattern cannot hang the page.
      const src = `onmessage=e=>{const f=${findMatches.toString()};postMessage(f(e.data.p,e.data.f,e.data.t,1000))}`;
      let worker = null, timer = null;
      const run = () => {
        if (worker) worker.terminate();
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        clearTimeout(timer);
        timer = setTimeout(() => { worker.terminate(); worker = null; show({ ok: false, error: 'Stopped after 2 seconds — the pattern is too slow on this text (likely catastrophic backtracking).' }); }, 2000);
        worker.onmessage = e => { clearTimeout(timer); show(e.data); };
        worker.postMessage({ p: pat.value, f: flags.value, t: tt.value });
      };
      const show = r => {
        out.innerHTML = '';
        if (!r.ok) { out.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: r.error }))); return; }
        out.append(h('p', { text: `${r.matches.length}${r.truncated ? '+' : ''} match(es)` }));
        const rows = r.matches.slice(0, 200).map((m, i) => h('tr', {}, [h('td', { text: String(i + 1) }), h('td', { text: String(m.index) }), h('td', {}, h('code', { text: m.match })), h('td', { text: m.groups.length ? m.groups.map(g => g ?? '∅').join(' | ') : '—' })]));
        out.append(h('div', { class: 'calc-table-wrap' }, h('table', { class: 'calc-table' }, [h('thead', {}, h('tr', {}, ['#', 'Index', 'Match', 'Groups'].map(x => h('th', { text: x })))), h('tbody', {}, rows)])));
      };
      root.append(privacy(), h('div', { class: 'calc-form' }, [h('div', { class: 'calc-field' }, [h('label', { for: 'r-p', text: 'Pattern' }), pat]), h('div', { class: 'calc-field' }, [h('label', { for: 'r-f', text: 'Flags (g, i, m, s, u, y)' }), flags])]),
        lt, tt, h('div', { class: 'calc-actions' }, h('button', { type: 'button', onclick: run }, 'Test')), out);
    },
  };

  const jwtDecoder = {
    title: 'JWT decoder',
    render(root) {
      const [lt, tt] = area('w-t', 'Paste a JWT', 6, 'eyJhbGciOi...');
      const out = h('div', { class: 'calc-result', 'aria-live': 'polite' });
      const run = () => {
        const r = decodeJwt(tt.value);
        out.innerHTML = '';
        if (!r.ok) { out.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: r.error }))); return; }
        out.append(h('div', { class: 'calc-summary' }, [['Algorithm', r.alg || '—'], ['Expires', r.expiresAt ? `${r.expiresAt}${r.expired ? ' (expired)' : ''}` : 'no exp claim'], ['Issued', r.issuedAt || 'no iat claim']].map(([k, v]) => h('div', { class: 'calc-stat' }, [h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })]))),
          h('h3', { text: 'Header' }), h('pre', { class: 'mono out', text: JSON.stringify(r.header, null, 2) }),
          h('h3', { text: 'Payload' }), h('pre', { class: 'mono out', text: JSON.stringify(r.payload, null, 2) }),
          h('p', { class: 'calc-help', text: 'Decoded only. The signature is not verified — never trust a token’s claims without verifying it on your server.' }));
      };
      root.append(privacy(), lt, tt, h('div', { class: 'calc-actions' }, h('button', { type: 'button', onclick: run }, 'Decode')), out);
    },
  };

  // ══ more pure logic ══════════════════════════════════════════════════════
  const utf8 = s => new TextEncoder().encode(s);
  const b64encode = s => { let bin = ''; for (const b of utf8(s)) bin += String.fromCharCode(b); return btoa(bin); };
  const b64decode = s => {
    const clean = String(s).trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const padded = clean + '==='.slice((clean.length + 3) % 4);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
  };
  const urlEncode = (s, whole) => whole ? encodeURI(s) : encodeURIComponent(s);
  const urlDecode = (s, plusAsSpace) => decodeURIComponent(plusAsSpace ? s.replace(/\+/g, ' ') : s);

  function fromTimestamp(input) {
    const n = Number(String(input).trim());
    if (!isFinite(n)) return { ok: false, error: 'Enter a number (seconds or milliseconds since 1970).' };
    const unit = Math.abs(n) >= 1e14 ? 'microseconds' : Math.abs(n) >= 1e11 ? 'milliseconds' : 'seconds';
    const ms = unit === 'seconds' ? n * 1000 : unit === 'milliseconds' ? n : n / 1000;
    const d = new Date(ms);
    return { ok: true, unit, iso: d.toISOString(), seconds: Math.floor(ms / 1000), ms: Math.floor(ms) };
  }
  const toTimestamp = iso => { const t = Date.parse(iso); return isNaN(t) ? null : { seconds: Math.floor(t / 1000), ms: t }; };

  const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  function uuidV4(rand = n => crypto.getRandomValues(new Uint8Array(n))) {
    const b = rand(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // RFC 9562 UUIDv7: 48-bit Unix ms timestamp, version 7, variant 10, the rest random
  function uuidV7(ms = Date.now(), rand = n => crypto.getRandomValues(new Uint8Array(n))) {
    const b = rand(16);
    let t = BigInt(ms);
    for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
    b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const uuidInfo = u => { const m = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/i.exec(String(u).trim()); return m ? { valid: true, version: Number.parseInt(m[1], 16), variantOk: /[89ab]/i.test(m[2]) } : { valid: false }; };

  // MD5 (RFC 1321) — Web Crypto has no MD5, so it is implemented here. For checksums only, never for security.
  function md5(str) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
    const msg = utf8(str), len = msg.length, n = ((len + 8) >> 6) + 1;
    const w = new Uint32Array(n * 16);
    for (let i = 0; i < len; i++) w[i >> 2] |= msg[i] << ((i % 4) * 8);
    w[len >> 2] |= 0x80 << ((len % 4) * 8);
    w[n * 16 - 2] = (len * 8) >>> 0; w[n * 16 - 1] = Math.floor(len / 2 ** 29);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let j = 0; j < n * 16; j += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const s = S[(i >> 4) * 4 + (i % 4)];
        F = (F + A + K[i] + w[j + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    return [a0, b0, c0, d0].map(x => hex(new Uint8Array(new Uint32Array([x]).buffer))).join('');
  }
  async function sha(algo, str) { return hex(new Uint8Array(await crypto.subtle.digest(algo, utf8(str)))); }

  const SMALL = new Set('a an and as at but by for in nor of on or per the to up via vs yet'.split(' '));
  function convertCase(text, mode) {
    const words = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-]+/).filter(Boolean);
    const cap = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    switch (mode) {
      case 'upper': return text.toUpperCase();
      case 'lower': return text.toLowerCase();
      case 'title': return text.toLowerCase().split(/(\s+)/).map((w, i, arr) => (/\s/.test(w) || (SMALL.has(w) && i > 0 && i < arr.length - 1)) ? w : cap(w)).join('');
      case 'sentence': { const t = text.toLowerCase(); return t.replace(/(^\s*|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase()); }
      case 'camel': return words.map((w, i) => i ? cap(w) : w.toLowerCase()).join('');
      case 'pascal': return words.map(cap).join('');
      case 'snake': return words.map(w => w.toLowerCase()).join('_');
      case 'kebab': return words.map(w => w.toLowerCase()).join('-');
      case 'constant': return words.map(w => w.toUpperCase()).join('_');
      default: return text;
    }
  }

  // JSON ↔ CSV
  const csvCell = v => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function flatten(obj, prefix = '', out = {}) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out[key] = v;
    }
    return out;
  }
  function jsonToCsv(text) {
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = [data];
    const rows = data.map(r => (r && typeof r === 'object') ? flatten(r) : { value: r });
    const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
    return [cols.map(csvCell).join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
  }
  function parseCsv(text, delim = ',') {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function csvToJson(text, { delim = ',', infer = true } = {}) {
    const [head, ...body] = parseCsv(text, delim);
    const val = s => !infer ? s : s === '' ? '' : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s === 'null' ? null : s;
    return body.filter(r => r.some(c => c !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, val(r[i] ?? '')])));
  }

  // semantic JSON diff
  function jsonDiff(a, b, path = '$', out = []) {
    const t = x => Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x;
    if (t(a) !== t(b)) { out.push({ path, type: 'changed', from: a, to: b }); return out; }
    if (t(a) === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const p = `${path}.${k}`;
        if (!(k in b)) out.push({ path: p, type: 'removed', from: a[k] });
        else if (!(k in a)) out.push({ path: p, type: 'added', to: b[k] });
        else jsonDiff(a[k], b[k], p, out);
      }
    } else if (t(a) === 'array') {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const p = `${path}[${i}]`;
        if (i >= b.length) out.push({ path: p, type: 'removed', from: a[i] });
        else if (i >= a.length) out.push({ path: p, type: 'added', to: b[i] });
        else jsonDiff(a[i], b[i], p, out);
      }
    } else if (a !== b) out.push({ path, type: 'changed', from: a, to: b });
    return out;
  }

  // XML: tokenizer-based pretty printer and a small tree parser (no DOM needed)
  function xmlTokens(xml) {
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^>]+>|[^<]+/g;
    return (String(xml).match(re) || []).map(s => s.trim() ? s : null).filter(Boolean);
  }
  // well-formedness checks the formatter needs: tag syntax, bare & and < in text, a single root element
  const XML_TAG = /^<\/?[A-Za-z_][\w:.-]*(\s[^<>]*)?\/?>$/;
  const XML_SPECIAL = /^(<!--|<!\[CDATA\[|<\?|<!)/;
  function xmlCheck(tokens) {
    let depth = 0, roots = 0;
    for (const t of tokens) {
      if (t.startsWith('<')) {
        if (XML_SPECIAL.test(t)) continue;
        if (!XML_TAG.test(t)) throw new Error(`Invalid markup near "${t.slice(0, 40)}". A "<" inside text must be written as &lt;`);
        if (t.startsWith('</')) depth--;
        else if (!t.endsWith('/>')) { if (depth === 0) roots++; depth++; }
        else if (depth === 0) roots++;
      } else {
        if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t)) throw new Error(`A bare "&" in text near "${t.trim().slice(0, 40)}" must be written as &amp;`);
        if (depth === 0) throw new Error(`Text outside the root element: "${t.trim().slice(0, 40)}"`);
      }
      if (roots > 1) throw new Error('XML allows only one root element; wrap the elements in a single parent');
    }
  }
  function xmlFormat(xml, indent = '  ') {
    const tokens = xmlTokens(xml);
    xmlCheck(tokens);
    const out = []; let depth = 0; const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^<\//.test(t)) {
        const name = t.slice(2, -1).trim();
        if (stack.pop() !== name) throw new Error(`Closing tag </${name}> does not match an open tag`);
        depth--; out.push(indent.repeat(depth) + t);
      } else if (/^<[^!?][^>]*[^/]>$|^<[a-zA-Z_][\w:.-]*>$/.test(t)) {
        const name = t.slice(1).match(/^[^\s>/]+/)[0];
        const text = tokens[i + 1], close = tokens[i + 2];
        if (text && !text.startsWith('<') && close === `</${name}>`) { out.push(indent.repeat(depth) + t + text.trim() + close); i += 2; continue; }
        out.push(indent.repeat(depth) + t); stack.push(name); depth++;
      } else out.push(indent.repeat(depth) + t.trim());
    }
    if (stack.length) throw new Error(`Unclosed tag <${stack.pop()}>`);
    return out.join('\n');
  }
  const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function jsonToXml(value, name = 'root', depth = 0) {
    const pad = '  '.repeat(depth);
    if (Array.isArray(value)) return value.map(v => jsonToXml(v, name, depth)).join('\n');
    if (value && typeof value === 'object') {
      const inner = Object.entries(value).map(([k, v]) => jsonToXml(v, k.replace(/[^\w.-]/g, '_'), depth + 1)).join('\n');
      return `${pad}<${name}>\n${inner}\n${pad}</${name}>`;
    }
    return value === null ? `${pad}<${name}/>` : `${pad}<${name}>${xmlEsc(value)}</${name}>`;
  }
  function jsonToYaml(v, depth = 0) {
    const pad = '  '.repeat(depth);
    const scalar = x => x === null ? 'null' : typeof x === 'string' ? (/^[\w .\/@-]+$/.test(x) && !/^(true|false|null|yes|no|-?\d+(\.\d+)?)$/i.test(x) && x.trim() === x ? x : JSON.stringify(x)) : String(x);
    if (Array.isArray(v)) return v.length ? v.map(x => (x && typeof x === 'object') ? `${pad}-\n${jsonToYaml(x, depth + 1)}` : `${pad}- ${scalar(x)}`).join('\n') : `${pad}[]`;
    if (v && typeof v === 'object') return Object.keys(v).length ? Object.entries(v).map(([k, x]) => (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) ? `${pad}${k}:\n${jsonToYaml(x, depth + 1)}` : `${pad}${k}: ${Array.isArray(x) ? '[]' : x && typeof x === 'object' ? '{}' : scalar(x)}`).join('\n') : `${pad}{}`;
    return pad + scalar(v);
  }

  // JSON Schema (draft 2020-12) inferred from a sample
  function inferSchema(v, root = true) {
    const base = root ? { $schema: 'https://json-schema.org/draft/2020-12/schema' } : {};
    if (v === null) return { ...base, type: 'null' };
    if (Array.isArray(v)) {
      const itemSchemas = v.map(x => inferSchema(x, false));
      const types = [...new Set(itemSchemas.map(s => JSON.stringify(s)))];
      return { ...base, type: 'array', ...(v.length ? { items: types.length === 1 ? itemSchemas[0] : { anyOf: types.map(s => JSON.parse(s)) } } : {}) };
    }
    if (typeof v === 'object') return { ...base, type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inferSchema(x, false)])), required: Object.keys(v) };
    if (typeof v === 'number') return { ...base, type: Number.isInteger(v) ? 'integer' : 'number' };
    return { ...base, type: typeof v };
  }

  // cron (5 fields, Vixie semantics: day-of-month and day-of-week are OR-ed when both are restricted)
  const CRON_NAMES = { month: 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' '), dow: 'sun mon tue wed thu fri sat'.split(' ') };
  function cronField(expr, min, max, names) {
    const set = new Set();
    for (const part of expr.toLowerCase().split(',')) {
      const [range, stepS] = part.split('/');
      const step = stepS ? Number(stepS) : 1;
      if (!(step >= 1)) throw new Error(`Bad step in "${part}"`);
      const val = s => { const i = names ? names.indexOf(s) : -1; const n = i >= 0 ? i + (min === 1 ? 1 : 0) : Number(s); if (!Number.isInteger(n)) throw new Error(`Bad value "${s}"`); return n; };
      let lo, hi;
      if (range === '*') { lo = min; hi = max; }
      else if (range.includes('-')) { [lo, hi] = range.split('-').map(val); }
      else { lo = val(range); hi = stepS ? max : lo; }
      if (lo < min || hi > max + (names === CRON_NAMES.dow ? 1 : 0) || lo > hi) throw new Error(`Value out of range in "${part}"`);
      for (let x = lo; x <= hi; x += step) set.add(names === CRON_NAMES.dow && x === 7 ? 0 : x);
    }
    return set;
  }
  function parseCron(expr) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`A cron expression has 5 fields (minute hour day month weekday); this has ${f.length}.`);
    return { minute: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), month: cronField(f[3], 1, 12, CRON_NAMES.month),
      dow: cronField(f[4], 0, 6, CRON_NAMES.dow), domStar: f[2] === '*', dowStar: f[4] === '*', raw: f };
  }
  function cronNext(expr, fromIso, count = 5) {
    const c = parseCron(expr);
    const d = new Date(fromIso); d.setUTCSeconds(0, 0); d.setUTCMinutes(d.getUTCMinutes() + 1);
    const out = [];
    for (let guard = 0; out.length < count && guard < 600000; guard++) {
      const dayOk = c.domStar && c.dowStar ? true : c.domStar ? c.dow.has(d.getUTCDay()) : c.dowStar ? c.dom.has(d.getUTCDate()) : (c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay()));
      if (!c.month.has(d.getUTCMonth() + 1) || !dayOk) { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); continue; }
      if (!c.hour.has(d.getUTCHours())) { d.setUTCMinutes(0); d.setUTCHours(d.getUTCHours() + 1); continue; }
      if (!c.minute.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1); continue; }
      out.push(d.toISOString()); d.setUTCMinutes(d.getUTCMinutes() + 1);
    }
    return out;
  }
  function describeCron(expr) {
    const c = parseCron(expr), [mi, h, dom, mo, dw] = c.raw;
    const list = (s, f = x => x) => [...s].sort((a, b) => a - b).map(f).join(', ');
    const two = n => String(n).padStart(2, '0');
    const time = mi === '*' && h === '*' ? 'every minute' : /^\*\/\d+$/.test(mi) && h === '*' ? `every ${mi.slice(2)} minutes`
      : /^\*\/\d+$/.test(mi) ? `every ${mi.slice(2)} minutes during hour(s) ${list(c.hour)}`
      : c.minute.size === 1 && c.hour.size === 1 ? `at ${two([...c.hour][0])}:${two([...c.minute][0])}` : `at minute(s) ${list(c.minute)} of hour(s) ${list(c.hour)}`;
    const days = [dom !== '*' ? `on day(s) ${list(c.dom)} of the month` : '', dw !== '*' ? `on ${list(c.dow, d => CRON_NAMES.dow[d].replace(/^./, x => x.toUpperCase()))}` : '']
      .filter(Boolean).join(' or ');
    const months = mo !== '*' ? ` in ${list(c.month, m => CRON_NAMES.month[m - 1].replace(/^./, x => x.toUpperCase()))}` : '';
    return `${time.charAt(0).toUpperCase() + time.slice(1)}${days ? ', ' + days : ''}${months}.`;
  }

  // ══ tool UIs (shared shape: input → action buttons → output) ════════════
  function transformTool({ title, inputLabel, placeholder = '', rows = 12, options = [], actions, note }) {
    return {
      title,
      render(root) {
        const [lab, ta] = area('t-in', inputLabel, rows, placeholder);
        const out = h('pre', { class: 'mono out', 'aria-live': 'polite' });
        const status = h('div', { class: 'calc-result' });
        const opts = options.map(o => {
          if (o.type === 'select') { const s = h('select', { id: `o-${o.id}` }, o.choices.map(([v, l]) => h('option', { value: v, text: l }))); return { o, el: s, node: h('label', {}, [`${o.label} `, s]) }; }
          const c = h('input', { type: 'checkbox', id: `o-${o.id}` }); if (o.checked) c.checked = true; return { o, el: c, node: h('label', {}, [c, ` ${o.label}`]) };
        });
        const val = () => Object.fromEntries(opts.map(x => [x.o.id, x.el.type === 'checkbox' ? x.el.checked : x.el.value]));
        const run = async fn => {
          status.innerHTML = ''; out.textContent = '';
          try { const r = await fn(ta.value, val()); out.textContent = typeof r === 'string' ? r : r.output; if (r.stats) status.append(h('p', { class: 'calc-help', text: r.stats })); }
          catch (e) { status.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: String(e.message || e) }))); }
        };
        root.append(privacy(), lab, ta, opts.length ? h('div', { class: 'calc-actions' }, opts.map(x => x.node)) : '',
          h('div', { class: 'calc-actions' }, [...actions.map(a => h('button', { type: 'button', onclick: () => run(a.fn) }, a.label)), copyBtn(() => out.textContent)]),
          note ? h('p', { class: 'calc-help', text: note }) : '', status, out);
      },
    };
  }
  const needLib = (name, global) => { if (!self[global]) throw new Error(`${name} is not loaded on this page yet (see BUILD-SPEC: vendor /assets/vendor/${name}).`); return self[global]; };

  const jsonValidator = transformTool({ title: 'JSON validator', inputLabel: 'Paste JSON to validate', placeholder: '{"valid": true}',
    actions: [{ label: 'Validate', fn: t => { const r = formatJson(t, 2); if (!r.ok) throw new Error(r.error.line ? `Invalid JSON — line ${r.error.line}, column ${r.error.col}: ${r.error.message}` : r.error.message); return { output: r.output, stats: `Valid JSON · ${r.keys} keys · ${r.bytes.toLocaleString()} bytes minified` }; } }] });

  const jsonViewer = {
    title: 'JSON viewer',
    render(root) {
      const [lab, ta] = area('v-in', 'Paste JSON to explore', 10, '{"users":[{"id":1}]}');
      const out = h('div', { class: 'json-tree mono', 'aria-live': 'polite' });
      const node = (k, v) => {
        if (v && typeof v === 'object') {
          const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
          const d = h('details', { open: '' }, [h('summary', { text: `${k} ${Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`}` })]);
          const ul = h('ul'); entries.forEach(([kk, vv]) => ul.append(h('li', {}, node(kk, vv)))); d.append(ul); return d;
        }
        return h('span', {}, [h('b', { text: `${k}: ` }), h('code', { text: JSON.stringify(v) })]);
      };
      const run = () => { out.innerHTML = ''; const r = formatJson(ta.value, 2); if (!r.ok) { out.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: r.error.message }))); return; } out.append(node('root', JSON.parse(ta.value))); };
      root.append(privacy(), lab, ta, h('div', { class: 'calc-actions' }, [h('button', { type: 'button', onclick: run }, 'View tree'),
        h('button', { type: 'button', onclick: () => out.querySelectorAll('details').forEach(d => { d.open = false; }) }, 'Collapse all')]), out);
    },
  };

  const jsonDiffTool = {
    title: 'JSON diff',
    render(root) {
      const [la, ta] = area('jd-a', 'Original JSON', 10);
      const [lb, tb] = area('jd-b', 'Changed JSON', 10);
      const out = h('div', { class: 'calc-result', 'aria-live': 'polite' });
      const run = () => {
        out.innerHTML = '';
        let a, b;
        try { a = JSON.parse(ta.value); b = JSON.parse(tb.value); } catch (e) { out.append(h('div', { class: 'calc-warn', role: 'alert' }, h('p', { text: `Both sides must be valid JSON: ${e.message}` }))); return; }
        const d = jsonDiff(a, b);
        out.append(h('p', { text: d.length ? `${d.length} difference(s)` : 'The two documents are identical (key order ignored).' }));
        if (d.length) out.append(h('div', { class: 'calc-table-wrap' }, h('table', { class: 'calc-table' }, [h('thead', {}, h('tr', {}, ['Path', 'Change', 'Before', 'After'].map(x => h('th', { text: x })))),
          h('tbody', {}, d.map(x => h('tr', { class: `d-${x.type === 'added' ? 'add' : x.type === 'removed' ? 'del' : 'same'}` }, [h('td', {}, h('code', { text: x.path })), h('td', { text: x.type }), h('td', {}, h('code', { text: x.from === undefined ? '' : JSON.stringify(x.from) })), h('td', {}, h('code', { text: x.to === undefined ? '' : JSON.stringify(x.to) }))])))])));
      };
      root.append(privacy(), h('div', { class: 'two-col' }, [h('div', {}, [la, ta]), h('div', {}, [lb, tb])]), h('div', { class: 'calc-actions' }, h('button', { type: 'button', onclick: run }, 'Compare JSON')), out);
    },
  };

  const jsonCsv = transformTool({ title: 'JSON to CSV converter', inputLabel: 'Paste JSON (an array of objects) or CSV', placeholder: '[{"name":"Ana","age":30}]',
    options: [{ id: 'delim', type: 'select', label: 'CSV delimiter', choices: [[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab']] }, { id: 'infer', label: 'Detect numbers and true/false when reading CSV', checked: true }],
    actions: [
      { label: 'JSON → CSV', fn: (t, o) => { const csv = jsonToCsv(t); return o.delim === ',' ? csv : parseCsv(csv).map(r => r.map(c => (c.includes(o.delim) || /["\n]/.test(c)) ? `"${c.replace(/"/g, '""')}"` : c).join(o.delim)).join('\n'); } },
      { label: 'CSV → JSON', fn: (t, o) => JSON.stringify(csvToJson(t, { delim: o.delim, infer: o.infer }), null, 2) },
    ], note: 'Nested objects become dot-separated columns (address.city). Arrays inside a row are kept as JSON text.' });

  const jsonConvert = transformTool({ title: 'JSON to YAML / XML converter', inputLabel: 'Paste JSON, YAML or XML', placeholder: '{"name":"example"}',
    actions: [
      { label: 'JSON → YAML', fn: t => jsonToYaml(JSON.parse(t)) },
      { label: 'JSON → XML', fn: t => { const v = JSON.parse(t); const keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []; return keys.length === 1 ? jsonToXml(v[keys[0]], keys[0]) : jsonToXml(v, 'root'); } },
      { label: 'YAML → JSON', fn: t => JSON.stringify(needLib('js-yaml.min.js', 'jsyaml').load(t), null, 2) },
    ] });

  const yamlValidator = transformTool({ title: 'YAML validator', inputLabel: 'Paste YAML', placeholder: 'name: example\nitems:\n  - one',
    actions: [{ label: 'Validate', fn: t => { const y = needLib('js-yaml.min.js', 'jsyaml'); try { const v = y.load(t); return { output: JSON.stringify(v, null, 2), stats: 'Valid YAML · shown as JSON below' }; } catch (e) { throw new Error(e.mark ? `Invalid YAML at line ${e.mark.line + 1}, column ${e.mark.column + 1}: ${e.reason}` : e.message); } } }] });

  const xmlFormatter = transformTool({ title: 'XML formatter', inputLabel: 'Paste XML', placeholder: '<root><item id="1">text</item></root>',
    options: [{ id: 'indent', type: 'select', label: 'Indent', choices: [['  ', '2 spaces'], ['    ', '4 spaces'], ['\t', 'Tab']] }],
    actions: [{ label: 'Format', fn: (t, o) => xmlFormat(t, o.indent) }, { label: 'Minify', fn: t => { const k = xmlTokens(t); xmlCheck(k); return k.join(''); } }] });

  const base64Tool = transformTool({ title: 'Base64 encode and decode', inputLabel: 'Text or Base64', placeholder: 'hello',
    actions: [{ label: 'Encode', fn: t => b64encode(t) }, { label: 'Decode', fn: t => { try { return b64decode(t); } catch { throw new Error('This is not valid Base64, or it decodes to bytes that are not UTF-8 text.'); } } }],
    note: 'UTF-8 safe. URL-safe Base64 (- and _) is accepted when decoding.' });

  const urlTool = transformTool({ title: 'URL encode and decode', inputLabel: 'Text or encoded URL', placeholder: 'https://example.com/?q=a b&c=d',
    options: [{ id: 'whole', label: 'Encode as a whole URL (keep : / ? & =)' }, { id: 'plus', label: 'Treat + as a space when decoding' }],
    actions: [{ label: 'Encode', fn: (t, o) => urlEncode(t, o.whole) }, { label: 'Decode', fn: (t, o) => { try { return urlDecode(t, o.plus); } catch { throw new Error('Malformed percent-encoding (a % not followed by two hex digits).'); } } }] });

  const timestampTool = transformTool({ title: 'Unix timestamp converter', inputLabel: 'Unix timestamp, or a date like 2026-09-16T12:00:00Z', rows: 3, placeholder: '1700000000',
    actions: [
      { label: 'Timestamp → date', fn: t => { const r = fromTimestamp(t); if (!r.ok) throw new Error(r.error); const d = new Date(r.ms); return `Read as ${r.unit}\nUTC:        ${r.iso}\nYour time:  ${d.toString()}\nSeconds:    ${r.seconds}\nMillis:     ${r.ms}`; } },
      { label: 'Date → timestamp', fn: t => { const r = toTimestamp(t.trim()); if (!r) throw new Error('Could not read that date. Use ISO format, e.g. 2026-09-16T12:00:00Z.'); return `Seconds: ${r.seconds}\nMillis:  ${r.ms}`; } },
      { label: 'Now', fn: () => { const ms = Date.now(); return `Seconds: ${Math.floor(ms / 1000)}\nMillis:  ${ms}\nUTC:     ${new Date(ms).toISOString()}`; } },
    ] });

  const uuidTool = transformTool({ title: 'UUID generator', inputLabel: 'Paste a UUID to check (optional)', rows: 2,
    options: [{ id: 'version', type: 'select', label: 'Version', choices: [['4', 'v4 (random)'], ['7', 'v7 (time-ordered)']] }, { id: 'count', type: 'select', label: 'How many', choices: [['1', '1'], ['5', '5'], ['10', '10'], ['50', '50']] }, { id: 'upper', label: 'Uppercase' }],
    actions: [
      { label: 'Generate', fn: (t, o) => Array.from({ length: Number(o.count) }, () => o.version === '7' ? uuidV7() : uuidV4()).map(u => o.upper ? u.toUpperCase() : u).join('\n') },
      { label: 'Check UUID', fn: t => { const i = uuidInfo(t); if (!i.valid) throw new Error('Not a valid UUID (8-4-4-4-12 hex digits).'); return `Valid UUID · version ${i.version}${i.variantOk ? ' · RFC 9562 variant' : ' · non-standard variant'}`; } },
    ] });

  const hashTool = transformTool({ title: 'Hash generator', inputLabel: 'Text to hash', rows: 6,
    actions: [{ label: 'Generate hashes', fn: async t => `MD5      ${md5(t)}\nSHA-1    ${await sha('SHA-1', t)}\nSHA-256  ${await sha('SHA-256', t)}\nSHA-384  ${await sha('SHA-384', t)}\nSHA-512  ${await sha('SHA-512', t)}` }],
    note: 'Text is hashed as UTF-8. MD5 and SHA-1 are for checksums only; never use them to store passwords.' });

  const caseTool = transformTool({ title: 'Case converter', inputLabel: 'Text', rows: 6, placeholder: 'the quick brown fox',
    actions: [['UPPER', 'upper'], ['lower', 'lower'], ['Title Case', 'title'], ['Sentence case', 'sentence'], ['camelCase', 'camel'], ['PascalCase', 'pascal'], ['snake_case', 'snake'], ['kebab-case', 'kebab'], ['CONSTANT_CASE', 'constant']]
      .map(([label, mode]) => ({ label, fn: t => convertCase(t, mode) })) });

  const sqlFormatter = transformTool({ title: 'SQL formatter', inputLabel: 'Paste SQL', placeholder: 'select id, name from users where active = 1 order by name',
    options: [{ id: 'dialect', type: 'select', label: 'Dialect', choices: [['sql', 'Standard SQL'], ['postgresql', 'PostgreSQL'], ['mysql', 'MySQL'], ['tsql', 'SQL Server'], ['sqlite', 'SQLite'], ['bigquery', 'BigQuery']] }, { id: 'upper', label: 'Uppercase keywords', checked: true }],
    actions: [{ label: 'Format SQL', fn: (t, o) => needLib('sql-formatter.min.js', 'sqlFormatter').format(t, { language: o.dialect, keywordCase: o.upper ? 'upper' : 'preserve' }) }] });

  const htmlBeautifier = transformTool({ title: 'HTML beautifier', inputLabel: 'Paste HTML', placeholder: '<div><p>Hello</p></div>',
    options: [{ id: 'indent', type: 'select', label: 'Indent', choices: [['2', '2 spaces'], ['4', '4 spaces']] }],
    actions: [{ label: 'Beautify', fn: (t, o) => needLib('beautify-html.min.js', 'html_beautify')(t, { indent_size: Number(o.indent) }) }, { label: 'Minify (whitespace)', fn: t => t.replace(/>\s+</g, '><').trim() }] });

  const cronTool = transformTool({ title: 'Cron expression generator', inputLabel: 'Cron expression (minute hour day month weekday)', rows: 2, placeholder: '*/15 9-17 * * 1-5',
    actions: [{ label: 'Explain and show next runs', fn: t => `${describeCron(t)}\n\nNext 5 runs (UTC):\n${cronNext(t, new Date().toISOString(), 5).join('\n')}` }],
    note: 'Standard 5-field cron. When both day-of-month and weekday are set, a run happens if either matches (Vixie cron behaviour). Times shown in UTC.' });

  const jsonStringify = transformTool({ title: 'JSON stringify and escape', inputLabel: 'JSON or text', placeholder: '{"a": "line one\\nline two"}',
    actions: [
      { label: 'Stringify (escape as a JSON string)', fn: t => JSON.stringify(t) },
      { label: 'Parse a JSON string back', fn: t => { const v = JSON.parse(t); if (typeof v !== 'string') throw new Error('Input is JSON, but not a JSON string (it should start and end with ").'); return v; } },
      { label: 'Minify JSON to one line', fn: t => JSON.stringify(JSON.parse(t)) },
    ] });

  const jsonSchema = transformTool({ title: 'JSON Schema generator', inputLabel: 'Paste a sample JSON document', placeholder: '{"id": 1, "tags": ["a"]}',
    actions: [{ label: 'Generate schema', fn: t => JSON.stringify(inferSchema(JSON.parse(t)), null, 2) }],
    note: 'Draft 2020-12. Every key in the sample is marked required and types come from the sample values; review before using it to validate real data.' });

  // test token: header {"alg":"HS256","typ":"JWT"} payload {"sub":"123","name":"Ana","iat":1700000000,"exp":1800000000}
  const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJuYW1lIjoiQW5hIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.sig';

  return {
    jsonFormatter, diffChecker, regexTester, jwtDecoder,
    jsonValidator, jsonViewer, jsonDiff: jsonDiffTool, jsonCsv, jsonConvert, yamlValidator, xmlFormatter, base64: base64Tool, urlCode: urlTool,
    timestamp: timestampTool, uuid: uuidTool, hash: hashTool, caseConverter: caseTool, sqlFormatter, htmlBeautifier, cron: cronTool, jsonStringify, jsonSchema,
    __pure: { formatJson, diffLines, findMatches, decodeJwt, b64encode, b64decode, urlEncode, urlDecode, fromTimestamp, toTimestamp, uuidV4, uuidV7, uuidInfo,
      md5, sha, convertCase, jsonToCsv, csvToJson, jsonDiff, xmlFormat, jsonToXml, jsonToYaml, inferSchema, parseCron, cronNext, describeCron },
    __tests: [
      { pure: 'formatJson', name: 'formats and counts keys', run: P => { const r = P.formatJson('{"a":1,"b":{"c":[1,2]}}', 2); return { ok: r.ok, keys: r.keys, lines: r.output.split('\n').length, min: r.minified }; },
        expect: { ok: true, keys: 3, lines: 9, min: '{"a":1,"b":{"c":[1,2]}}' } },
      { pure: 'formatJson', name: 'reports the line of an error', run: P => { const r = P.formatJson('{\n  "a": 1,\n  "b": }', 2); return { ok: r.ok, line: r.error.line }; }, expect: { ok: false, line: 3 } },
      { pure: 'formatJson', name: 'error position from the engine message (trailing comma)', run: P => { const r = P.formatJson('{"a":1,}'); return { line: r.error.line, col: r.error.col }; }, expect: { line: 1, col: 8 } },
      { pure: 'formatJson', name: 'empty input asks for JSON', run: P => ({ ok: P.formatJson('  ').ok }), expect: { ok: false } },
      { pure: 'diffLines', name: 'one line changed = 1 added + 1 removed', run: P => { const r = P.diffLines('a\nb\nc', 'a\nB\nc'); return { added: r.added, removed: r.removed, ops: r.ops.map(o => o.type[0]).join('') }; },
        expect: { added: 1, removed: 1, ops: 'sdas' } },
      { pure: 'diffLines', name: 'appended lines', run: P => { const r = P.diffLines('x', 'x\ny\nz'); return { added: r.added, removed: r.removed }; }, expect: { added: 2, removed: 0 } },
      { pure: 'findMatches', name: 'global matches with groups', run: P => { const r = P.findMatches('(\\w+)@(\\w+)\\.com', 'g', 'a@b.com, c@d.com'); return { n: r.matches.length, g: r.matches[1].groups.join(',') }; }, expect: { n: 2, g: 'c,d' } },
      { pure: 'findMatches', name: 'zero-length matches do not loop forever', run: P => ({ n: P.findMatches('\\b', 'g', 'hi there').matches.length }), expect: { n: 4 } },
      { pure: 'findMatches', name: 'invalid pattern returns an error', run: P => ({ ok: P.findMatches('(', 'g', 'x').ok }), expect: { ok: false } },
      { pure: 'decodeJwt', name: 'decodes header, payload and expiry', run: P => { const r = P.decodeJwt(TOKEN, 1750000000); return { alg: r.alg, sub: r.payload.sub, expired: r.expired, exp: r.expiresAt }; },
        expect: { alg: 'HS256', sub: '123', expired: false, exp: '2027-01-15T08:00:00.000Z' } },
      { pure: 'decodeJwt', name: 'expired token is flagged', run: P => ({ expired: P.decodeJwt(TOKEN, 1900000000).expired }), expect: { expired: true } },
      { pure: 'decodeJwt', name: 'two-part string is rejected', run: P => ({ ok: P.decodeJwt('abc.def').ok }), expect: { ok: false } },
      // vectors: Node crypto (MD5/SHA), Buffer (Base64), encodeURIComponent, Date (epoch) — computed outside this file
      { pure: 'b64encode', name: 'Base64 round-trips UTF-8', run: P => ({ enc: P.b64encode('héllo wörld ✓'), dec: P.b64decode('aMOpbGxvIHfDtnJsZCDinJM=') }), expect: { enc: 'aMOpbGxvIHfDtnJsZCDinJM=', dec: 'héllo wörld ✓' } },
      { pure: 'b64decode', name: 'URL-safe Base64 without padding decodes', run: P => ({ v: P.b64decode('aGk_Pz8') }), expect: { v: 'hi???' } },
      { pure: 'urlEncode', name: 'component encoding', run: P => ({ e: P.urlEncode('a b&c=d/é'), d: P.urlDecode('a+b%20c', true) }), expect: { e: 'a%20b%26c%3Dd%2F%C3%A9', d: 'a b c' } },
      { pure: 'fromTimestamp', name: 'seconds and milliseconds are detected', run: P => ({ s: P.fromTimestamp('1700000000').iso, ms: P.fromTimestamp('1700000000000').unit, back: P.toTimestamp('2023-11-14T22:13:20Z').seconds }),
        expect: { s: '2023-11-14T22:13:20.000Z', ms: 'milliseconds', back: 1700000000 } },
      { pure: 'uuidV7', name: 'UUIDv7 encodes the timestamp, version and variant', run: P => ({ u: P.uuidV7(1700000000000, n => new Uint8Array(n)), info: P.uuidInfo(P.uuidV4()).version, ok: P.uuidInfo(P.uuidV7()).variantOk }),
        expect: { u: '018bcfe5-6800-7000-8000-000000000000', info: 4, ok: true } },
      { pure: 'md5', name: 'MD5 test vectors (empty, abc, UTF-8)', run: P => ({ e: P.md5(''), a: P.md5('abc'), u: P.md5('héllo wörld') }),
        expect: { e: 'd41d8cd98f00b204e9800998ecf8427e', a: '900150983cd24fb0d6963f7d28e17f72', u: 'ed0c22cc110ede12327851863c078138' } },
      { pure: 'sha', name: 'SHA-1 and SHA-256 of "abc"', run: async P => ({ s1: await P.sha('SHA-1', 'abc'), s256: await P.sha('SHA-256', 'abc') }),
        expect: { s1: 'a9993e364706816aba3e25717850c26c9cd0d89d', s256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' } },
      { pure: 'convertCase', name: 'case styles', run: P => ({ t: P.convertCase('hello world of code', 'title'), c: P.convertCase('hello world of code', 'camel'), s: P.convertCase('helloWorldOfCode', 'snake'), k: P.convertCase('Hello World', 'constant') }),
        expect: { t: 'Hello World of Code', c: 'helloWorldOfCode', s: 'hello_world_of_code', k: 'HELLO_WORLD' } },
      { pure: 'jsonToCsv', name: 'JSON → CSV flattens and quotes', run: P => ({ v: P.jsonToCsv('[{"a":1,"b":{"c":"x,y"}},{"a":2,"d":true}]') }), expect: { v: 'a,b.c,d\n1,"x,y",\n2,,true' } },
      { pure: 'csvToJson', name: 'CSV → JSON with quoted commas and numbers', run: P => ({ v: JSON.stringify(P.csvToJson('name,age\n"Doe, J",30\nAna,')) }), expect: { v: '[{"name":"Doe, J","age":30},{"name":"Ana","age":""}]' } },
      { pure: 'jsonDiff', name: 'semantic diff finds 1 changed, 2 added, 1 removed', run: P => { const d = P.jsonDiff({ x: 1, y: [1, 2], z: { k: 'v' } }, { x: 2, y: [1, 2, 3], w: true }); return { n: d.length, added: d.filter(x => x.type === 'added').length, removed: d[2].path }; },
        expect: { n: 4, added: 2, removed: '$.z' } },
      { pure: 'xmlFormat', name: 'XML pretty print keeps text inline and self-closing tags', run: P => ({ v: P.xmlFormat('<a><b x="1">t</b><c/></a>') }), expect: { v: '<a>\n  <b x="1">t</b>\n  <c/>\n</a>' } },
      { pure: 'xmlFormat', name: 'a bare < in text gives a clear error, not a crash', run: P => { try { P.xmlFormat('<a>1 < 2</a>'); return { m: 'none' }; } catch (e) { return { m: /Invalid markup/.test(e.message) }; } }, expect: { m: true } },
      { pure: 'xmlFormat', name: 'a bare & in text is an error; &amp; is fine', run: P => { let bare; try { P.xmlFormat('<a>salt & pepper</a>'); bare = false; } catch (e) { bare = /bare "&"/.test(e.message); } return { bare, ok: P.xmlFormat('<a>salt &amp; pepper</a>') === '<a>salt &amp; pepper</a>' }; }, expect: { bare: true, ok: true } },
      { pure: 'xmlFormat', name: 'two root elements are an error', run: P => { try { P.xmlFormat('<a/><b/>'); return { err: false }; } catch (e) { return { err: /one root/.test(e.message) }; } }, expect: { err: true } },
      { pure: 'xmlFormat', name: 'mismatched tag is an error', run: P => { try { P.xmlFormat('<a><b></a>'); return { err: false }; } catch { return { err: true }; } }, expect: { err: true } },
      { pure: 'jsonToXml', name: 'JSON → XML repeats array elements', run: P => ({ v: P.jsonToXml({ item: [1, 2], name: 'x' }, 'root') }), expect: { v: '<root>\n  <item>1</item>\n  <item>2</item>\n  <name>x</name>\n</root>' } },
      { pure: 'jsonToYaml', name: 'JSON → YAML', run: P => ({ v: P.jsonToYaml({ a: 1, b: [1, 'x'], c: { d: null }, e: 'true' }) }), expect: { v: 'a: 1\nb:\n  - 1\n  - x\nc:\n  d: null\ne: "true"' } },
      { pure: 'inferSchema', name: 'schema inference', run: P => { const s = P.inferSchema({ id: 1, name: 'x', tags: ['a'], meta: { ok: true } }); return { id: s.properties.id.type, tags: s.properties.tags.items.type, ok: s.properties.meta.properties.ok.type, req: s.required.join(',') }; },
        expect: { id: 'integer', tags: 'string', ok: 'boolean', req: 'id,name,tags,meta' } },
      { pure: 'cronNext', name: 'weekday business-hours cron rolls to the next morning', run: P => ({ v: P.cronNext('*/15 9-17 * * 1-5', '2026-09-16T17:50:00Z', 3).join(' ') }),
        expect: { v: '2026-09-17T09:00:00.000Z 2026-09-17T09:15:00.000Z 2026-09-17T09:30:00.000Z' } },
      { pure: 'cronNext', name: 'monthly cron, and names (MON) work', run: P => ({ m: P.cronNext('0 0 1 * *', '2026-09-16T00:00:00Z', 1)[0], n: P.cronNext('30 8 * * MON', '2026-09-16T00:00:00Z', 1)[0] }),
        expect: { m: '2026-10-01T00:00:00.000Z', n: '2026-09-21T08:30:00.000Z' } },
      { pure: 'describeCron', name: 'cron description', run: P => ({ v: P.describeCron('0 9 * * 1-5') }), expect: { v: 'At 09:00, on Mon, Tue, Wed, Thu, Fri.' } },
      { pure: 'parseCron', name: 'wrong field count is an error', run: P => { try { P.parseCron('* * *'); return { err: false }; } catch { return { err: true }; } }, expect: { err: true } },
    ],
  };
});
