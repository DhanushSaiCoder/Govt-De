/* =========================
   Minimal integrated client code
   - extractFromHTML (heuristics + Readability)
   - fetchViaWorkerAndExtract (calls worker)
   - renderResult (UI)
   Adjust WORKER_URL below.
   ========================= */

const WORKER_URL = 'https://yourworker.workers.dev'; // <-- CHANGE THIS to your worker

/* ----- Utility lists ----- */
const ELIG_KEYWORDS = ['eligible', 'eligibility', 'who can apply', 'who is eligible', 'applicants', 'beneficiary', 'beneficiaries', 'target group'];
const DOC_KEYWORDS = ['document', 'documents', 'proof', 'id proof', 'identity proof', 'address proof', 'income certificate', 'photo', 'aadhar', 'passport', 'voter id'];

/* ---------- Main extractor (simplified but fully usable) ---------- */
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

/* ---------- Worker fetch + driver ---------- */
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

    if (data.content_type && data.content_type.includes('application/pdf')) {
      // Worker returned base64 PDF. We don't handle PDF extraction here unless pdf.js is loaded.
      if (typeof window.pdfjsLib === 'undefined') {
        return { error: 'pdf_requires_pdfjs', message: 'PDF returned. Include pdf.js to process or ask user to download and paste text.', final_url: data.final_url };
      }
      // If pdf.js exists, convert and extract text (not implemented here by default).
    }

    const htmlString = data.html || '';
    const out = await extractFromHTML(htmlString, data.final_url || targetUrl);
    // redact PII again for safety
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

/* ---------- Render result to UI ---------- */
function renderResult(result, targetUrl) {
  const container = document.querySelector('.output');
  container.innerHTML = '';

  if (!result) {
    container.innerHTML = '<div class="muted">No result</div>';
    return;
  }
  if (result.error) {
    container.innerHTML = `<div class="result-card"><strong>Error:</strong> ${escapeHTML(result.error)}<div class="muted" style="margin-top:8px;">${escapeHTML(result.message || JSON.stringify(result.details || ''))}</div></div>`;
    return;
  }

  const card = document.createElement('div');
  card.className = 'result-card';

  // Title + confidence badge
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
      const a = document.createElement('a');
      a.href = l; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = l.length > 40 ? l.slice(0, 40) + '…' : l;
      links.appendChild(a);
    });
    card.appendChild(links);
  }

  // Raw snippet toggle
  const rawBox = document.createElement('details');
  rawBox.style.marginTop = '10px';
  rawBox.innerHTML = `<summary style="cursor:pointer">View raw text snippet</summary><pre style="white-space:pre-wrap;margin-top:8px;background:#f8fafc;padding:10px;border-radius:6px;">${escapeHTML(result.raw_text_snippet || '')}</pre>`;
  card.appendChild(rawBox);

  container.appendChild(card);
}

/* ---------- Helpers (smaller versions of the full ones) ---------- */
function collectCandidateBlocks(doc, bodyText = '') {
  const blocks = [];
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
    blocks.push({ heading: headingText, content: buf.trim(), node: h });
  });
  Array.from(doc.querySelectorAll('ul,ol,table')).forEach(el => {
    const text = el.innerText || '';
    blocks.push({ heading: findNearestHeading(el) || '', content: text.trim(), node: el });
  });
  if (!blocks.length && bodyText) {
    const paras = bodyText.split(/\n{1,3}/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(8, paras.length); i++) blocks.push({ heading: '', content: paras[i], node: null });
  }
  return blocks;
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

/* ---------- Wire UI actions ---------- */
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
      renderResult(res, url);
      // If returned invalid schema or pdf warning, show guidance
      if (res && res.error === 'pdf_requires_pdfjs') {
        out.insertAdjacentHTML('beforeend', '<div class="muted" style="margin-top:8px;">PDF detected — include pdf.js in the page to extract PDFs, or ask user to upload the PDF file.</div>');
      }
      if (res && res.error && res.details) {
        console.error('Details:', res.details);
      }
    } catch (err) {
      out.innerHTML = '<div class="result-card"><strong>Error:</strong> ' + escapeHTML(String(err)) + '</div>';
    } finally {
      btn.disabled = false;
    }
  });
});
