// Service worker : appelle l'API Reverso à la place des content scripts (bloqués par CORS).
//
// - texte découpé en phrases, cache par langue + phrase ;
// - seules les phrases modifiées partent à l'API, groupées par séries contiguës ;
// - requêtes identiques en vol dédupliquées, 2 appels parallèles max ;
// - 429 / 5xx : pause exponentielle, le content script réessaie.

const API_URL = 'https://orthographe.reverso.net/api/v1/Spelling';
const MAX_CACHE = 800; // phrases
const MAX_RUN = 3000; // caractères par requête
const MAX_PARALLEL = 2;

const chunkCache = new Map(); // "lang\0phrase" -> corrections relatives à la phrase
const inflight = new Map(); // "lang\0texte" -> Promise<réponse brute>
let active = 0;
const waiters = [];
let blockedUntil = 0;
let failures = 0;

/* ---------------------------------------------------------------- utilitaires */

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// endIndex inclusif ou exclusif : inconnu. On cale la plage sur mistakeText.
function normalizeRange(text, c) {
  const s = c.startIndex;
  const e = c.endIndex;
  if (typeof s !== 'number' || typeof e !== 'number') return null;
  const mistake = c.mistakeText;
  if (mistake) {
    if (text.slice(s, e) === mistake) return { start: s, end: e };
    if (text.slice(s, e + 1) === mistake) return { start: s, end: e + 1 };
    const i = text.indexOf(mistake, Math.max(0, s - 20));
    if (i !== -1) return { start: i, end: i + mistake.length };
    return null;
  }
  if (e > s && e <= text.length) return { start: s, end: e };
  return null;
}

function dedupeOverlaps(list) {
  list.sort((a, b) => a.start - b.start);
  const clean = [];
  let last = -1;
  for (const c of list) {
    if (c.start >= last) {
      clean.push(c);
      last = c.end;
    }
  }
  return clean;
}

function mapCorrections(text, raw) {
  const out = [];
  for (const c of raw || []) {
    const range = normalizeRange(text, c);
    if (!range) continue;
    const mistake = text.slice(range.start, range.end);
    const suggestions = [];
    if (c.correctionText && c.correctionText !== mistake) suggestions.push(c.correctionText);
    for (const x of c.suggestions || []) {
      const t = typeof x === 'string' ? x : x && x.text;
      if (t && t !== mistake && !suggestions.includes(t)) suggestions.push(t);
    }
    out.push({
      start: range.start,
      end: range.end,
      mistake,
      suggestions,
      title: stripTags(c.shortDescription),
      desc: stripTags(c.longDescription),
      type: c.type || '',
      group: c.group || ''
    });
  }
  return dedupeOverlaps(out);
}

/* ---------------------------------------------------------------- découpage en phrases */

// Renvoie [{ start, text }] : phrases sans espaces autour, avec leur position.
function splitChunks(text) {
  const chunks = [];
  const re = /[.!?…]+["'»”’)\]]*\s+|\n+/g;
  let start = 0;
  const push = (a, b) => {
    let s = a;
    let e = b;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e - s >= 2 && /\p{L}/u.test(text.slice(s, e))) chunks.push({ start: s, text: text.slice(s, e) });
  };
  let m;
  while ((m = re.exec(text))) {
    push(start, m.index + m[0].length);
    start = m.index + m[0].length;
  }
  push(start, text.length);
  return chunks;
}

/* ---------------------------------------------------------------- cache et file d'attente */

function remember(key, value) {
  chunkCache.delete(key);
  chunkCache.set(key, value);
  if (chunkCache.size > MAX_CACHE) chunkCache.delete(chunkCache.keys().next().value);
}

async function acquire() {
  if (active < MAX_PARALLEL) {
    active++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve)); // le créneau nous est transmis
}

function release() {
  const w = waiters.shift();
  if (w) w();
  else active--;
}

function rateError(ms, status) {
  const e = new Error(
    status ? 'Reverso a répondu HTTP ' + status + ' (pause ' + Math.ceil(ms / 1000) + ' s)' : 'Trop de requêtes, pause ' + Math.ceil(ms / 1000) + ' s'
  );
  e.retryAfter = ms;
  return e;
}

function callApi(text, language) {
  const key = language + '\u0000' + text;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const wait = blockedUntil - Date.now();
    if (wait > 0) throw rateError(wait);
    await acquire();
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoReplace: false,
          generateSynonyms: false,
          getCorrectionDetails: true,
          interfaceLanguage: 'fr',
          language, // 'fra' | 'eng'
          locale: 'Indifferent',
          origin: 'interactive',
          text
        })
      });
      if (res.status === 429 || res.status >= 500) {
        failures++;
        const delay = Math.min(60000, 1000 * 2 ** failures);
        blockedUntil = Date.now() + delay;
        throw rateError(delay, res.status);
      }
      if (!res.ok) throw new Error('Reverso a répondu HTTP ' + res.status);
      failures = 0;
      return await res.json();
    } finally {
      release();
    }
  })();
  inflight.set(key, p);
  const done = () => inflight.delete(key);
  p.then(done, done);
  return p;
}

function saveDebug(sent, language, data, rawCount, keptCount, stats) {
  try {
    chrome.storage.local.set({
      lastDebug: {
        at: new Date().toISOString(),
        language,
        sent: sent.slice(0, 500),
        rawCount,
        keptCount,
        stats,
        response: JSON.stringify(data).slice(0, 6000)
      }
    });
  } catch (e) {}
}

/* ---------------------------------------------------------------- vérification */

async function check(text, language) {
  const chunks = splitChunks(text);
  const per = new Array(chunks.length);
  const dirty = [];
  chunks.forEach((c, i) => {
    const key = language + '\u0000' + c.text;
    const hit = chunkCache.get(key);
    if (hit) {
      remember(key, hit); // rafraîchit l'ordre LRU
      per[i] = hit;
    } else dirty.push(i);
  });

  // une requête par série de phrases modifiées contiguës
  const runs = [];
  for (const i of dirty) {
    const last = runs[runs.length - 1];
    const tail = last && last[last.length - 1];
    if (last && tail === i - 1 && chunks[i].start + chunks[i].text.length - chunks[last[0]].start <= MAX_RUN) last.push(i);
    else runs.push([i]);
  }

  const extra = []; // corrections à cheval sur deux phrases (hors cache)
  const stats = { chunks: chunks.length, cached: chunks.length - dirty.length, requests: runs.length };

  await Promise.all(
    runs.map(async (run) => {
      const first = chunks[run[0]];
      const lastC = chunks[run[run.length - 1]];
      const runStart = first.start;
      const runText = text.slice(runStart, lastC.start + lastC.text.length);
      const data = await callApi(runText, language);
      const raw = [...(data.corrections || []), ...(data.autoReplacements || [])];
      const mapped = mapCorrections(runText, raw);
      saveDebug(runText, language, data, raw.length, mapped.length, stats);

      const taken = new Set();
      for (const i of run) {
        const c = chunks[i];
        const a = c.start - runStart;
        const b = a + c.text.length;
        const mine = [];
        mapped.forEach((m, j) => {
          if (m.start >= a && m.end <= b) {
            taken.add(j);
            mine.push({ ...m, start: m.start - a, end: m.end - a });
          }
        });
        per[i] = mine;
        remember(language + '\u0000' + c.text, mine);
      }
      mapped.forEach((m, j) => {
        if (!taken.has(j)) extra.push({ ...m, start: m.start + runStart, end: m.end + runStart });
      });
    })
  );

  const out = [...extra];
  chunks.forEach((c, i) => {
    for (const m of per[i] || []) out.push({ ...m, start: m.start + c.start, end: m.end + c.start });
  });
  return { corrections: dedupeOverlaps(out), stats };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'check') return;
    if (typeof msg.text !== 'string' || !['fra', 'eng'].includes(msg.language)) {
      sendResponse({ ok: false, error: 'Requête invalide' });
      return;
    }
    check(msg.text, msg.language).then(
      (r) => sendResponse({ ok: true, corrections: r.corrections, stats: r.stats }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e), retryAfter: (e && e.retryAfter) || 0 })
    );
    return true; // réponse asynchrone
  });
}

if (typeof module !== 'undefined') {
  module.exports = { check, splitChunks, normalizeRange, mapCorrections };
}
