/* main.js - drop-in replacement
   - WORKER_URL set to your worker
   - SPA detection + paste fallback
   - extractor + worker integration + renderer
*/

const WORKER_URL = 'https://govscheme-proxy.dhanushsai-work.workers.dev'; // <- YOUR WORKER

/* ----- Keyword lists ----- */
const ELIG_KEYWORDS = ['eligible', 'eligibility', 'who can apply', 'who is eligible', 'applicants', 'beneficiary', 'beneficiaries', 'target group'];
const DOC_KEYWORDS = ['document', 'documents', 'proof', 'id proof', 'identity proof', 'address proof', 'income certificate', 'photo', 'aadhar', 'passport', 'voter id'];

/* ===========================
   extractFromHTML (same as before)
   =========================== */
async function extractFromHTML(htmlString, sourceUrl = null) {
  try {
    htmlString = sanitizeHtmlString(htmlString);
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // Readability
    let article = null;
    if (typeof Readability !== 'undefined') {
      try { article = new Readability(doc.cloneNode(true)).parse(); } catch (e) { article = null; }
    }

    const bodyText = (article && article.textContent) ? article.textContent.trim() : (doc.body ? doc.body.innerText.trim() : '');
    const title = (article && article.title) ? article.title : (doc.title || null);

    const candidates = collectCandidateBlocks(doc, bodyText);
    const scored = candidates.map(c => ({ ...c, score: scoreBlock(c.heading, c.content) }))
      .sort((a, b) => b.score - a.score);
    const top = scored.filter(s => s.score >= 0.35);

    const eligibility = [], documents = [], apply_links = new Set();

    if (top.length) {
      top.forEach(t => {
        const lines = splitToLines(t.content);
        lines.forEach(line => {
          if (isEligibilityLine(line)) eligibility.push(shorten(line));
          if (isDocumentLine(line)) documents.push(shorten(line));
        });
        if (t.node && t.node.querySelectorAll) {
          t.node.querySelectorAll('a[href]').forEach(a => {
            if (looksLikeApplyLink(a)) apply_links.add(makeAbsoluteUrl(a.href, sourceUrl));
          });
        }
      });
    }

    // fallback scanning of whole page
    if (!eligibility.length && bodyText) {
      splitToLines(bodyText).forEach(line => {
        if (isEligibilityLine(line)) eligibility.push(shorten(line));
        if (isDocumentLine(line)) documents.push(shorten(line));
      });
      doc.querySelectorAll('a[href]').forEach(a => {
        if (looksLikeApplyLink(a)) apply_links.add(makeAbsoluteUrl(a.href, sourceUrl));
      });
    }

    const result = {
      title: title || null,
      source_url: sourceUrl || null,
      eligibility: uniqueStrings(eligibility).slice(0, 20),
      documents: uniqueStrings(documents).slice(0, 20),
      apply_links: Array.from(apply_links).slice(0, 10),
      raw_text_snippet: redactPII((bodyText || '').slice(0, 500)),
      method: (article ? 'readability+heuristic' : 'heuristic'),
      confidence: roundTo(computeConfidence(eligibility, documents, top), 2)
    };

    const valid = validateOutputSchema(result);
    if (!valid.valid) {
      return { error: 'invalid_output_schema', details: valid.errors, raw_text: result.raw_text_snippet };
    }
    return result;
  } catch (e) {
    return { error: 'exception', message: String(e) };
  }
}

/* ===========================
   fetchViaWorkerAndExtract (with SPA detection)
   =========================== */
async function fetchViaWorkerAndExtract(targetUrl) {
  try {
    if (!WORKER_URL || WORKER_URL.includes('yourworker')) {
      return { error: 'worker_missing', message: 'Set WORKER_URL to your deployed Cloudflare Worker.' };
    }
    const u = `${WORKER_URL}?url=${encodeURIComponent(targetUrl)}`;
    const r = await fetch(u, { method: 'GET' });
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch (e) { body = { message: 'unknown' }; }
      return { error: 'worker_fetch_failed', details: body };
    }
    const data = await r.json();
    if (data.error) return { error: 'worker_error', details: data };

    // SPA detection heuristic
    if (data.content_type && data.content_type.includes('text/html')) {
      const html = data.html || '';
      const trimmed = html.replace(/\s+/g, ' ').trim();
      const isAppShell = /<app-root[^>]*>(\s*)<\/app-root>/i.test(html)
        || /<div id="root"[^>]*>(\s*)<\/div>/i.test(html)
        || /<router-outlet[^>]*>/i.test(html)
        || (trimmed.length < 900 && /<script|<app-root|<router-outlet|window\.app/i.test(html));
      if (isAppShell) {
        return { error: 'spa_shell', message: 'Dynamic SPA detected — page loads content via JavaScript. Use the paste-HTML fallback or upload PDF.', final_url: data.final_url, html_snippet: html.slice(0, 400) };
      }
    }

    if (data.content_type && data.content_type.includes('application/pdf')) {
      if (typeof window.pdfjsLib === 'undefined') {
        return { error: 'pdf_requires_pdfjs', message: 'PDF returned. Include pdf.js to process or ask user to download and paste text.', final_url: data.final_url };
      }
      // PDF path with pdf.js omitted for zero-budget default
    }

    const htmlString = data.html || '';
    const out = await extractFromHTML(htmlString, data.final_url || targetUrl);
    if (!out.error) {
      out.eligibility = out.eligibility.map(redactPII);
      out.documents = out.documents.map(redactPII);
      out.raw_text_snippet = redactPII(out.raw_text_snippet);
    }
    return out;
  } catch (err) {
    return { error: 'client_exception', message: String(err) };
  }
}

/* ===========================
   UI render + paste fallback
   =========================== */
function renderResult(result, targetUrl) {
  const container = document.querySelector('.output');
  container.innerHTML = '';

  if (!result) {
    container.innerHTML = '<div class="muted">No result</div>';
    return;
  }
  if (result.error) {
    // If SPA, show a short card and caller will show paste fallback
    if (result.error === 'spa_shell') {
      container.innerHTML = `<div class="result-card"><h2>Dynamic site detected</h2><div class="muted" style="margin-top:6px">${escapeHTML(result.message)}</div><div class="muted" style="margin-top:8px">Try: Copy page HTML or article text and paste below.</div></div>`;
      return;
    }
    container.innerHTML = `<div class="result-card"><strong>Error:</strong> ${escapeHTML(result.error)}<div class="muted" style="margin-top:8px;">${escapeHTML(result.message || JSON.stringify(result.details || ''))}</div></div>`;
    return;
  }

  const card = document.createElement('div');
  card.className = 'result-card';

  // Title + badge
  const h = document.createElement('h2');
  h.style.margin = '0 0 6px 0';
  h.textContent = result.title || 'Untitled page';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (result.confidence >= 0.7 ? 'high' : (result.confidence >= 0.4 ? 'med' : 'low'));
  badge.textContent = `Confidence: ${Math.round(result.confidence * 100)}%`;
  h.appendChild(badge);
  card.appendChild(h);

  // Source
  const src = document.createElement('div');
  src.className = 'muted';
  src.style.marginTop = '6px';
  src.innerHTML = `Source: <a href="${escapeHTML(result.source_url || targetUrl || '')}" target="_blank" rel="noopener noreferrer">${escapeHTML(result.source_url || targetUrl || '')}</a> — Method: ${escapeHTML(result.method)}`;
  card.appendChild(src);

  // Eligibility
  const elig = document.createElement('div');
  elig.style.marginTop = '12px';
  elig.innerHTML = `<h3 style="margin:0 0 6px 0">Who can apply?</h3>`;
  if (result.eligibility && result.eligibility.length) {
    const ul = document.createElement('ul'); ul.style.margin = '0 0 8px 18px';
    result.eligibility.forEach(it => { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li); });
    elig.appendChild(ul);
  } else {
    elig.innerHTML += `<p class="muted" style="margin:0">No clear eligibility found. View raw text below.</p>`;
  }
  card.appendChild(elig);

  // Documents
  const docs = document.createElement('div');
  docs.style.marginTop = '8px';
  docs.innerHTML = `<h3 style="margin:0 0 6px 0">Required documents</h3>`;
  if (result.documents && result.documents.length) {
    const ul = document.createElement('ul'); ul.style.margin = '0 0 8px 18px';
    result.documents.forEach(it => { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li); });
    docs.appendChild(ul);
  } else {
    docs.innerHTML += `<p class="muted" style="margin:0">No specific documents detected.</p>`;
  }
  card.appendChild(docs);

  // Apply links
  if (result.apply_links && result.apply_links.length) {
    const links = document.createElement('div');
    links.className = 'links';
    links.style.marginTop = '8px';
    links.innerHTML = `<h3 style="margin:0 0 6px 0">Where to apply</h3>`;
    result.apply_links.forEach(l => {
      const a = document.createElement('a'); a.href = l; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = l.length > 40 ? l.slice(0, 40) + '…' : l;
      links.appendChild(a);
    });
    card.appendChild(links);
  }

  // Raw snippet
  const rawBox = document.createElement('details');
  rawBox.style.marginTop = '10px';
  rawBox.innerHTML = `<summary style="cursor:pointer">View raw text snippet</summary><pre style="white-space:pre-wrap;margin-top:8px;background:#f8fafc;padding:10px;border-radius:6px;">${escapeHTML(result.raw_text_snippet || '')}</pre>`;
  card.appendChild(rawBox);

  document.querySelector('.output').appendChild(card);
}

/* Paste fallback UI (shown when SPA detected) */
function showPasteFallback(originalUrl) {
  const container = document.querySelector('.output');
  container.innerHTML = `
    <div class="result-card">
      <h2>Paste page HTML / text</h2>
      <div class="muted">This site requires JavaScript to render. Copy the page's HTML (View → Save Page As → Webpage, HTML only) or copy the article text and paste here.</div>
      <textarea id="pasteArea" style="width:100%;height:180px;margin-top:12px;padding:10px;border-radius:8px;border:1px solid var(--border)"></textarea>
      <div style="margin-top:10px">
        <button id="pasteRun" class="btn">Run Extractor on pasted text</button>
        <button id="pasteCancel" class="btn" style="background:#eee;color:#111;margin-left:8px">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('pasteRun').addEventListener('click', async () => {
    const html = document.getElementById('pasteArea').value.trim();
    if (!html) return alert('Paste HTML or text first.');
    const res = await extractFromHTML(html, originalUrl || null);
    renderResult(res, originalUrl);
  });
  document.getElementById('pasteCancel').addEventListener('click', () => {
    document.querySelector('.output').innerHTML = '<div class="muted">Summary will appear here…</div>';
  });
}

/* ===========================
   small helpers (same as your code)
   =========================== */
/* Candidate collection, scoring, detection helpers (copied) */
/* ---------- Improved collector + smarter scoring (drop-in replacement) ---------- */

const CLASS_HINTS = [
  'eligib', 'eligibility', 'who-can', 'who_can', 'whois', 'applicants', 'benefit', 'beneficiaries',
  'document', 'documents', 'requirement', 'requirements', 'proof', 'howto', 'how-to', 'apply', 'application',
  'criteria', 'criteria-list', 'steps', 'procedure', 'instructions', 'notice', 'announcement', 'scheme', 'policy'
];

function collectCandidateBlocks(doc, bodyText = '') {
  const blocks = [];
  const seen = new Set();

  // helper to push block if node not seen and content length > 0
  function pushBlock(node, heading = '') {
    if (!node) return;
    if (seen.has(node)) return;
    seen.add(node);
    const text = (node.innerText || '').trim();
    if (!text) return;
    // limit block length to reasonable amount
    const content = text.length > 10000 ? text.slice(0, 10000) : text;
    blocks.push({ heading: (heading || '').trim(), content, node });
  }

  // 1) headings + following siblings (existing logic)
  const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4'));
  headings.forEach(h => {
    const headingText = (h.innerText || '').trim();
    let n = h.nextElementSibling;
    let buf = '';
    let cap = 0;
    while (n && !/^H[1-4]$/i.test(n.tagName) && cap < 30) {
      buf += '\n' + (n.innerText || '');
      n = n.nextElementSibling;
      cap++;
    }
    // use node = h (so link extraction still works)
    if (buf.trim()) pushBlock(h, headingText);
  });

  // 2) lists and tables (existing)
  Array.from(doc.querySelectorAll('ul,ol,table')).forEach(el => {
    if (el && el.innerText && el.innerText.trim()) pushBlock(el, findNearestHeading(el) || '');
  });

  // 3) semantic containers
  Array.from(doc.querySelectorAll('section,article,main,aside,[role="region"],[role="main"]')).forEach(el => {
    if (el && el.innerText && el.innerText.trim()) pushBlock(el, findNearestHeading(el) || '');
  });

  // 4) elements with class/ID/aria hints
  // search for elements whose className or id or aria-label contains hint keywords
  const all = Array.from(doc.querySelectorAll('div,section,article'));
  for (let el of all) {
    if (!el || seen.has(el)) continue;
    const meta = ((el.className || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('role') || '')).toLowerCase();
    if (!meta) continue;
    for (let hint of CLASS_HINTS) {
      if (meta.includes(hint)) {
        // ignore tiny nodes
        if ((el.innerText || '').trim().length < 30) break;
        pushBlock(el, findNearestHeading(el) || '');
        break;
      }
    }
  }

  // 5) text-density fallback for other divs (catch "div soup" content)
  // We'll pick divs with decent text length and relatively few child elements
  for (let el of Array.from(doc.querySelectorAll('div'))) {
    if (!el || seen.has(el)) continue;
    const text = (el.innerText || '').trim();
    if (!text || text.length < 120) continue; // minimum size
    const childCount = (el.querySelectorAll('*') || []).length;
    const density = computeTextDensity(text, childCount); // words per child factor
    // heuristic: if density is high (>= 8) OR text very large (>800) include it
    if (density >= 8 || text.length > 800) {
      pushBlock(el, findNearestHeading(el) || '');
    }
  }

  // 6) fallback: Readability/body paragraphs (only if no blocks found)
  if (!blocks.length && bodyText) {
    const paras = bodyText.split(/\n{1,3}/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(8, paras.length); i++) {
      blocks.push({ heading: '', content: paras[i], node: null });
    }
  }

  return blocks;
}

// compute text density: roughly words per child element (plus smoothing)
function computeTextDensity(text, childCount) {
  const words = (text.split(/\s+/).length) || 1;
  return words / Math.max(1, (childCount || 0) + 1);
}

/* ---------- Smarter scoring: give boosts when classes/roles/hints present ---------- */
function scoreBlock(heading = '', content = '', node = null) {
  let score = 0;
  const h = (heading || '').toLowerCase();
  const c = (content || '').toLowerCase();

  // heading weight (same)
  if (matchKeywords(h, ELIG_KEYWORDS)) score += 0.36;

  // structural weight: lists, bullets, table rows
  if (/^\s*(•|-|\u2022|\d+\.)/.test(content) || content.split('\n').length > 3) score += 0.28;

  // keyword density as before
  const kd = keywordDensity(c, ELIG_KEYWORDS);
  score += Math.min(0.26, kd * 3);

  // class/id/aria hint boost
  try {
    if (node && node.getAttribute) {
      const meta = ((node.className || '') + ' ' + (node.id || '') + ' ' + (node.getAttribute('aria-label') || '')).toLowerCase();
      if (meta) {
        for (let hint of CLASS_HINTS) {
          if (meta.includes(hint)) {
            score += 0.25; // strong boost for explicit class hint
            break;
          }
        }
      }
      // role hint (region/main) small boost
      const role = node.getAttribute('role') || '';
      if (role && /region|main|content|article/.test(role.toLowerCase())) score += 0.12;
    }
  } catch (e) {
    // ignore node access errors
  }

  // text-density boost: denser blocks more likely to be meaningful
  const words = Math.max(1, content.split(/\s+/).length);
  if (words > 200) score += 0.08;
  if (words > 600) score += 0.06;

  return Math.max(0, Math.min(1, score));
}

function findNearestHeading(el) {
  let cur = el;
  for (let i = 0; i < 6 && cur; i++) {
    cur = cur.previousElementSibling;
    if (!cur) break;
    if (/^H[1-4]$/i.test(cur.tagName)) return cur.innerText.trim();
  }
  let parent = el.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const h = parent.querySelector('h1,h2,h3');
    if (h) return h.innerText.trim();
    parent = parent.parentElement;
  }
  return '';
}

function scoreBlock(heading = '', content = '') {
  let score = 0;
  const h = (heading || '').toLowerCase();
  const c = (content || '').toLowerCase();
  if (matchKeywords(h, ELIG_KEYWORDS)) score += 0.40;
  if (/^\s*(•|-|\u2022|\d+\.)/.test(content) || content.split('\n').length > 3) score += 0.30;
  const kd = keywordDensity(c, ELIG_KEYWORDS);
  score += Math.min(0.3, kd * 3);
  return Math.max(0, Math.min(1, score));
}
function matchKeywords(text, keywords) { if (!text) return false; text = text.toLowerCase(); return keywords.some(k => text.includes(k.toLowerCase())); }
function keywordDensity(text, keywords) { if (!text) return 0; const words = Math.max(1, text.split(/\s+/).length); let count = 0; const lc = text.toLowerCase(); keywords.forEach(k => { const patt = new RegExp('\\b' + escapeRegex(k) + '\\b', 'i'); if (patt.test(lc)) count++; }); return count / Math.max(1, words / 50); }
function isEligibilityLine(line) { if (!line) return false; const s = line.toLowerCase(); if (ELIG_KEYWORDS.some(k => s.includes(k))) return true; if (/\b(only|must be|should be|eligible if|applicable to|applicants from)\b/.test(s)) return true; return false; }
function isDocumentLine(line) { if (!line) return false; const s = line.toLowerCase(); return DOC_KEYWORDS.some(k => s.includes(k)); }
function looksLikeApplyLink(aEl) { const txt = (aEl.innerText || aEl.getAttribute('title') || '').toLowerCase(); const href = (aEl.href || '').toLowerCase(); return /apply|registration|register|application/.test(txt) || /apply|registration|register|application/.test(href); }

function splitToLines(text) { return text.split(/\r?\n|[.;]\s+/).map(s => s.trim()).filter(Boolean); }
function shorten(s, len = 200) { s = s.trim(); if (s.length <= len) return s; return s.slice(0, len).trim() + '…'; }
function uniqueStrings(arr) { return Array.from(new Set(arr.map(s => s.trim()))).filter(Boolean); }
function makeAbsoluteUrl(href, base) { try { return new URL(href, base || window.location.href).toString(); } catch (e) { return href; } }
function determineMethod(article, top) { if (!article) return 'heuristic'; if (top && top.length) return 'readability+heuristic'; return 'readability'; }
function roundTo(n, d = 2) { return Math.round(n * Math.pow(10, d)) / Math.pow(10, d); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function computeConfidence(eligList, docList, topBlocks) {
  const base = Math.min(0.6, 0.15 * Math.min(6, eligList.length) + 0.1 * Math.min(4, docList.length));
  const avgTop = topBlocks.length ? (topBlocks.reduce((a, b) => a + (b.score || 0), 0) / topBlocks.length) : 0;
  const conf = Math.min(0.98, base + 0.4 * avgTop);
  if (eligList.length === 0 && docList.length === 0) return 0.12 + avgTop * 0.1;
  return conf;
}

/* Schema validation, redact, sanitize, escape helpers (copied) */
function validateOutputSchema(obj) {
  const errors = [];
  if (!('title' in obj)) errors.push('missing title');
  if (!('source_url' in obj)) errors.push('missing source_url');
  if (!('eligibility' in obj)) errors.push('missing eligibility');
  if (!Array.isArray(obj.eligibility)) errors.push('eligibility must be array');
  if (!('documents' in obj)) errors.push('missing documents');
  if (!Array.isArray(obj.documents)) errors.push('documents must be array');
  if (!('apply_links' in obj)) errors.push('missing apply_links');
  if (!Array.isArray(obj.apply_links)) errors.push('apply_links must be array');
  if (!('raw_text_snippet' in obj)) errors.push('missing raw_text_snippet');
  if (!('method' in obj)) errors.push('missing method');
  if (!('confidence' in obj)) errors.push('missing confidence');
  if (typeof obj.confidence !== 'number') errors.push('confidence must be number');
  return { valid: errors.length === 0, errors };
}

function redactPII(text) {
  if (!text) return text;
  text = text.replace(/\b(\+91[-\s]?)?\d{10}\b/g, '[REDACTED_PHONE]');
  text = text.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig, '[REDACTED_EMAIL]');
  text = text.replace(/\b\d{4}\s*\d{4}\s*\d{4}\b/g, '[REDACTED_ID]');
  return text;
}

function sanitizeHtmlString(html) {
  if (!html) return '';
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/\son\w+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '');
  html = html.replace(/\son\w+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '');
  return html;
}

function escapeHTML(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Wire UI: submit handler shows fallback when SPA */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form');
  const input = document.getElementById('schemeUrl');
  const out = document.querySelector('.output');
  const btn = document.getElementById('simplifyBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return alert('Paste a URL first.');
    out.innerHTML = '<div class="muted">Fetching and extracting…</div>';
    btn.disabled = true;
    try {
      const res = await fetchViaWorkerAndExtract(url);
      // SPA fallback
      if (res && res.error === 'spa_shell') {
        renderResult(res, url);
        showPasteFallback(res.final_url || url);
        btn.disabled = false;
        return;
      }
      renderResult(res, url);
      if (res && res.error === 'pdf_requires_pdfjs') {
        out.insertAdjacentHTML('beforeend', '<div class="muted" style="margin-top:8px;">PDF detected — include pdf.js in the page to extract PDFs, or ask user to upload the PDF file.</div>');
      }
      if (res && res.error && res.details) console.error('Details:', res.details);
    } catch (err) {
      out.innerHTML = '<div class="result-card"><strong>Error:</strong> ' + escapeHTML(String(err)) + '</div>';
    } finally {
      btn.disabled = false;
    }
  });
});
