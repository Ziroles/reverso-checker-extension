// Google Docs, côté service worker (chargé par background.js via importScripts).
//
// - lecture du document par l'API Docs (OAuth via chrome.identity) ;
// - texte « à plat » dont chaque position = index de l'API Docs, vérifié par check() de background.js ;
// - résultats dans chrome.storage.session (clé RVC.gdocKey), lus par le panneau et par gdocs.js ;
// - corrections écrites par documents.batchUpdate, après relecture du document.

const DOCS_API = 'https://docs.googleapis.com/v1/documents/';
const GD_BATCH = 6000; // caractères par lot envoyé à check()
const gdState = new Map(); // clé -> { running, again, lastRev, seenRev, result }
const gdSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// le content script gdocs.js lit les résultats et la liste « ignorés » dans storage.session
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) {}

/* ---------------------------------------------------------------- OAuth et API */

function authError(msg) {
  const e = new Error(msg || 'Connexion Google requise');
  e.auth = true;
  return e;
}

function getToken(interactive) {
  const clientId = (chrome.runtime.getManifest().oauth2 || {}).client_id || '';
  if (!clientId || /REMPLACER/.test(clientId)) {
    return Promise.reject(authError('Client OAuth non configuré : voir README, section Google Docs.'));
  }
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, (t) => {
      const token = typeof t === 'string' ? t : t && t.token;
      if (chrome.runtime.lastError || !token) reject(authError(chrome.runtime.lastError && chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function gapi(url, opts = {}, interactive = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(interactive);
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body
        ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
        : { Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401 && attempt === 0) {
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error('Google Docs : HTTP ' + res.status + ' ' + ((data.error && data.error.message) || ''));
      e.status = res.status;
      if (res.status === 401 || res.status === 403) e.auth = true;
      throw e;
    }
    return data;
  }
  throw authError();
}

const docUrl = (docId, extra) => DOCS_API + encodeURIComponent(docId) + '?includeTabsContent=true' + (extra || '');

/* ---------------------------------------------------------------- document à plat */

function findTab(tabs, id) {
  for (const t of tabs || []) {
    if (!id || (t.tabProperties && t.tabProperties.tabId === id)) return t;
    const c = findTab(t.childTabs, id);
    if (c) return c;
  }
  return null;
}

// Renvoie { body, tabId } pour l'onglet demandé (premier onglet si absent ou introuvable).
function pickTab(doc, docTab) {
  const t = findTab(doc.tabs, docTab) || findTab(doc.tabs, '');
  if (t && t.documentTab) return { body: t.documentTab.body || {}, tabId: t.tabProperties && t.tabProperties.tabId };
  return { body: doc.body || {}, tabId: undefined };
}

// Texte dont l'indice i correspond à l'index i de l'API. Hors texte (tableaux, sauts...) : '\n'.
// Éléments non textuels dans un paragraphe (image, puce de personne...) : ' ', marqués non modifiables.
function flatten(body) {
  const content = body.content || [];
  const end = content.length ? content[content.length - 1].endIndex || 0 : 0;
  const chars = new Array(end).fill('\n');
  const isText = new Uint8Array(end);
  const walk = (list) => {
    for (const el of list || []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements || []) {
          const s = pe.startIndex || 0;
          if (pe.textRun && typeof pe.textRun.content === 'string') {
            const t = pe.textRun.content;
            for (let i = 0; i < t.length && s + i < end; i++) {
              chars[s + i] = t[i] === '\u000b' ? '\n' : t[i]; // saut de ligne manuel
              isText[s + i] = 1;
            }
          } else {
            for (let i = s; i < (pe.endIndex || s) && i < end; i++) chars[i] = ' ';
          }
        }
      } else if (el.table) {
        for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content);
      }
      // tableOfContents : texte généré, non vérifié
    }
  };
  walk(content);
  return { text: chars.join(''), isText };
}

// Lots de lignes entières, GD_BATCH caractères max (une ligne plus longue forme son propre lot).
function batchesOf(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + GD_BATCH);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      end = nl > start ? nl + 1 : Math.max(end, text.indexOf('\n', end) + 1 || text.length);
    }
    const slice = text.slice(start, end);
    if (/\p{L}/u.test(slice)) out.push({ start, text: slice });
    start = end;
  }
  return out;
}

function contextOf(text, start, end) {
  const p0 = text.lastIndexOf('\n', start - 1) + 1;
  let p1 = text.indexOf('\n', end);
  if (p1 < 0) p1 = text.length;
  return { before: text.slice(Math.max(p0, start - 30), start), after: text.slice(end, Math.min(p1, end + 30)) };
}

function fixableRange(text, isText, start, end) {
  if (end <= start) return false;
  for (let i = start; i < end; i++) if (!isText[i] || text[i] === '\n') return false;
  return true;
}

/* ---------------------------------------------------------------- état partagé */

function gdEntry(key) {
  let st = gdState.get(key);
  if (!st) gdState.set(key, (st = { running: false, again: false, lastRev: null, seenRev: null, result: null }));
  return st;
}

async function setResult(key, patch) {
  const st = gdEntry(key);
  if (!st.result) {
    const got = await chrome.storage.session.get(key);
    st.result = got[key] || { status: 'idle', corrections: [] };
  }
  st.result = { ...st.result, ...patch };
  await chrome.storage.session.set({ [key]: st.result });
  return st.result;
}

async function checkWithRetry(text, language) {
  for (let i = 0; ; i++) {
    try {
      return (await check(text, language)).corrections;
    } catch (e) {
      if (!e.retryAfter || i >= 5) throw e;
      await gdSleep(e.retryAfter + 300);
    }
  }
}

/* ---------------------------------------------------------------- vérification */

async function gdocCheck({ docId, docTab, interactive }) {
  const key = RVC.gdocKey({ docId, docTab });
  const st = gdEntry(key);
  if (st.running) {
    st.again = true;
    return;
  }
  st.running = true;
  try {
    const settings = await chrome.storage.sync.get(RVC.DEFAULTS);
    if (!settings.enabled || !RVC.siteActive(settings, 'docs.google.com')) {
      await setResult(key, { status: 'off', error: '', corrections: [] });
      return;
    }
    await setResult(key, { status: 'checking', error: '', progress: { done: 0, total: 0 } });
    const doc = await gapi(docUrl(docId), {}, interactive);
    const { body, tabId } = pickTab(doc, docTab);
    const { text, isText } = flatten(body);
    const batches = batchesOf(text);
    const corrections = [];
    await setResult(key, { title: doc.title || '', progress: { done: 0, total: batches.length } });

    for (let b = 0; b < batches.length; b++) {
      const { start, text: part } = batches[b];
      const found = await checkWithRetry(part, RVC.pickLanguage(part, settings.language));
      for (const c of found) {
        const s = start + c.start;
        const e = start + c.end;
        corrections.push({
          start: s,
          end: e,
          mistake: c.mistake,
          suggestions: c.suggestions,
          title: c.title,
          desc: c.desc,
          cat: RVC.catOf(c),
          fixable: fixableRange(text, isText, s, e),
          ...contextOf(text, s, e)
        });
      }
      await setResult(key, { progress: { done: b + 1, total: batches.length } });
    }
    corrections.forEach((c, i) => (c.id = doc.revisionId + ':' + i));
    st.lastRev = st.seenRev = doc.revisionId;
    await setResult(key, { status: 'ok', revisionId: doc.revisionId, tabId, corrections, at: Date.now() });
  } catch (e) {
    await setResult(key, { status: e.auth ? 'auth' : 'error', error: String((e && e.message) || e) });
  } finally {
    st.running = false;
    if (st.again) {
      st.again = false;
      gdocCheck({ docId, docTab, interactive: false });
    }
  }
}

// Appelé toutes les quelques secondes par gdocs.js : revérifie quand la révision a changé
// puis n'a plus bougé pendant un tour (frappe terminée).
async function gdocPoll({ docId, docTab }) {
  const key = RVC.gdocKey({ docId, docTab });
  const st = gdEntry(key);
  if (st.running) return;
  if (!st.result) await setResult(key, {});
  if (st.result.status === 'auth' || st.result.status === 'off') return;
  const r = await gapi(docUrl(docId, '&fields=revisionId'), {}, false);
  if (r.revisionId === st.lastRev) return;
  if (st.lastRev && r.revisionId !== st.seenRev) {
    st.seenRev = r.revisionId;
    return;
  }
  await gdocCheck({ docId, docTab, interactive: false });
}

/* ---------------------------------------------------------------- correction */

// Retrouve la faute dans le document relu : position d'origine, sinon occurrence voisine au meilleur contexte.
function locate(text, isText, c) {
  const len = c.mistake.length;
  if (text.slice(c.start, c.end) === c.mistake && fixableRange(text, isText, c.start, c.end)) return c.start;
  let best = -1;
  let bestScore = -1;
  let bestDist = Infinity;
  const from = Math.max(0, c.start - 5000);
  const to = Math.min(text.length, c.end + 5000);
  for (let i = text.indexOf(c.mistake, from); i !== -1 && i < to; i = text.indexOf(c.mistake, i + 1)) {
    if (!fixableRange(text, isText, i, i + len)) continue;
    let score = 0;
    while (score < c.before.length && text[i - 1 - score] === c.before[c.before.length - 1 - score]) score++;
    let a = 0;
    while (a < c.after.length && text[i + len + a] === c.after[a]) a++;
    score += a;
    const dist = Math.abs(i - c.start);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      best = i;
      bestScore = score;
      bestDist = dist;
    }
  }
  const need = Math.min(4, c.before.length + c.after.length);
  return bestScore >= need ? best : -1;
}

async function gdocFix({ docId, docTab, fixes }) {
  const key = RVC.gdocKey({ docId, docTab });
  const st = gdEntry(key);
  if (!st.result) await setResult(key, {});
  const byId = new Map((st.result.corrections || []).map((c) => [c.id, c]));
  const wanted = (fixes || []).map((f) => ({ c: byId.get(f.id), rep: String(f.rep) })).filter((f) => f.c);
  if (!wanted.length) return { applied: 0, skipped: (fixes || []).length };

  for (let attempt = 0; attempt < 2; attempt++) {
    const doc = await gapi(docUrl(docId), {}, false);
    const { body, tabId } = pickTab(doc, docTab);
    const { text, isText } = flatten(body);
    const todo = [];
    for (const f of wanted) {
      const at = locate(text, isText, f.c);
      if (at >= 0) todo.push({ start: at, end: at + f.c.mistake.length, rep: f.rep, id: f.c.id });
    }
    // de la fin vers le début, sans chevauchement, pour garder les index valides
    todo.sort((a, b) => b.start - a.start);
    const requests = [];
    const done = [];
    let floor = Infinity;
    for (const t of todo) {
      if (t.end > floor) continue;
      floor = t.start;
      requests.push({ deleteContentRange: { range: { startIndex: t.start, endIndex: t.end, tabId } } });
      if (t.rep) requests.push({ insertText: { location: { index: t.start, tabId }, text: t.rep } });
      done.push(t.id);
    }
    if (!requests.length) return { applied: 0, skipped: wanted.length };
    try {
      await gapi(DOCS_API + encodeURIComponent(docId) + ':batchUpdate', {
        method: 'POST',
        body: { requests, writeControl: { requiredRevisionId: doc.revisionId } }
      });
    } catch (e) {
      if (e.status === 400 && attempt === 0) continue; // document modifié entre-temps : on relit
      throw e;
    }
    // retire tout de suite les fautes corrigées (soulignements et panneau)
    const gone = new Set(done);
    await setResult(key, { corrections: (st.result.corrections || []).filter((c) => !gone.has(c.id)) });
    gdocCheck({ docId, docTab, interactive: false });
    return { applied: done.length, skipped: wanted.length - done.length };
  }
  return { applied: 0, skipped: wanted.length };
}

/* ---------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('gdoc-')) return;
  if (typeof msg.docId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(msg.docId)) {
    sendResponse({ ok: false, error: 'Document invalide' });
    return;
  }
  const args = { docId: msg.docId, docTab: typeof msg.docTab === 'string' ? msg.docTab : '' };
  let p;
  if (msg.type === 'gdoc-check') p = gdocCheck({ ...args, interactive: !!msg.interactive });
  else if (msg.type === 'gdoc-poll') p = gdocPoll(args);
  else if (msg.type === 'gdoc-fix') p = gdocFix({ ...args, fixes: msg.fixes });
  else return;
  p.then(
    (r) => sendResponse({ ok: true, ...(r || {}) }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});
