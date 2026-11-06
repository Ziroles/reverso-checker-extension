const $ = (id) => document.getElementById(id);
const COLORS = { spell: '#e5484d', gram: '#2f6feb', punct: '#d99a00' };
const LABELS = { spell: 'Orthographe', gram: 'Grammaire', punct: 'Ponctuation' };

let ids = null;
let key = null;
let result = null;
let settings = { ...RVC.DEFAULTS };
let ignored = [];
let note = ''; // message après une correction, gardé jusqu'à la prochaine action

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function send(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ ...msg, docId: ids.docId, docTab: ids.docTab }, (r) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r || {})
    )
  );
}

async function refreshTab() {
  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = (tab && tab.url) || '';
  } catch (e) {}
  note = '';
  ids = RVC.gdocIds(url);
  key = ids ? RVC.gdocKey(ids) : null;
  const got = await chrome.storage.session.get(key ? [key, 'gdocIgnore'] : ['gdocIgnore']);
  result = key ? got[key] || null : null;
  ignored = got.gdocIgnore || [];
  render();
}

const check = (interactive) => send({ type: 'gdoc-check', interactive });

async function fix(list) {
  note = '';
  const r = await send({ type: 'gdoc-fix', fixes: list.map((c) => ({ id: c.id, rep: c.rep || c.suggestions[0] })) });
  if (!r.ok) note = r.error || 'Erreur inconnue';
  else if (r.skipped) note = r.skipped + ' correction(s) non appliquée(s) : le texte a changé. Nouvelle vérification en cours.';
  render();
}

function showError(text) {
  $('msg').textContent = '';
  if (text) $('msg').append(mk('div', 'err', text));
}

function statusText() {
  if (!result) return 'Pas encore vérifié';
  switch (result.status) {
    case 'checking': {
      const p = result.progress || {};
      return p.total ? 'Vérification… ' + p.done + ' / ' + p.total : 'Lecture du document…';
    }
    case 'auth': return 'Connexion Google requise';
    case 'off': return 'Désactivé sur docs.google.com (popup)';
    case 'error': return 'Erreur';
    case 'ok': return 'Vérifié à ' + new Date(result.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    default: return '';
  }
}

function render() {
  const bar = $('bar');
  const list = $('list');
  bar.textContent = '';
  list.textContent = '';
  if (!ids) {
    $('title').textContent = 'Google Docs';
    $('status').textContent = '';
    showError('');
    list.append(mk('div', 'empty', 'Ouvrez un document Google Docs dans cet onglet.'));
    return;
  }
  $('title').textContent = (result && result.title) || 'Document Google Docs';
  $('status').textContent = statusText();
  showError(result && (result.status === 'error' || result.status === 'auth') ? result.error : note);

  const busy = result && result.status === 'checking';
  const auth = !result || result.status === 'auth';
  const go = mk('button', 'btn', auth ? 'Se connecter et vérifier' : 'Vérifier');
  go.disabled = !!busy;
  go.addEventListener('click', () => {
    note = '';
    check(true);
  });
  bar.append(go);

  const items = result ? RVC.visible(result.corrections, settings.dictionary, ignored) : [];
  const fixable = items.filter((c) => c.fixable && c.suggestions.length);
  if (fixable.length) {
    const all = mk('button', 'btn green', 'Tout corriger (' + fixable.length + ')');
    all.disabled = !!busy;
    all.addEventListener('click', () => fix(fixable));
    bar.append(all);
    for (const cat of Object.keys(LABELS)) {
      const some = fixable.filter((c) => c.cat === cat);
      if (!some.length || some.length === fixable.length) continue;
      const b = mk('button', 'cat', LABELS[cat] + ' (' + some.length + ')');
      b.title = 'Corriger seulement : ' + LABELS[cat].toLowerCase();
      b.style.setProperty('--c', COLORS[cat]);
      b.disabled = !!busy;
      b.addEventListener('click', () => fix(some));
      bar.append(b);
    }
  }

  if (result && result.status === 'ok' && !items.length) {
    list.append(mk('div', 'empty', 'Aucune faute détectée.'));
    return;
  }
  for (const c of items) list.append(renderItem(c, busy));
}

function renderItem(c, busy) {
  const item = mk('div', 'item');
  item.style.setProperty('--c', COLORS[c.cat] || COLORS.gram);
  const head = mk('div', 'head');
  head.append(mk('span', 'dot'));
  const label = mk('span');
  label.append(mk('s', null, c.mistake));
  if (c.suggestions[0]) label.append(document.createTextNode(' → '), mk('b', null, c.suggestions[0]));
  head.append(label);
  item.append(head);

  // contexte : aide à retrouver la faute dans le document
  const ctx = mk('div', 'ctx');
  ctx.append('…' + c.before, mk('mark', null, c.mistake), c.after + '…');
  item.append(ctx);

  const acts = mk('div', 'acts');
  if (c.fixable) {
    c.suggestions.slice(0, 5).forEach((s, i) => {
      const b = mk('button', 'sug' + (i ? '' : ' main'), s);
      b.disabled = busy;
      b.addEventListener('click', () => fix([{ ...c, rep: s }]));
      acts.append(b);
    });
  }
  const ign = mk('button', 'link', 'Ignorer');
  ign.addEventListener('click', () =>
    chrome.storage.session.set({ gdocIgnore: [...new Set([...ignored, c.mistake.toLowerCase()])] })
  );
  acts.append(ign);
  if (/^\S+$/.test(c.mistake)) {
    const add = mk('button', 'link', 'Ajouter au dictionnaire');
    add.addEventListener('click', () =>
      chrome.storage.sync.get({ dictionary: [] }, (s) => {
        const d = s.dictionary || [];
        if (!d.map((w) => w.toLowerCase()).includes(c.mistake.toLowerCase())) d.push(c.mistake);
        chrome.storage.sync.set({ dictionary: d });
      })
    );
    acts.append(add);
  }
  item.append(acts);
  if (!c.fixable) item.append(mk('div', 'ctx', 'Correction automatique impossible ici (image ou saut dans la faute).'));
  if (c.desc) {
    const why = mk('details');
    why.append(mk('summary', null, c.title || 'Pourquoi ?'), mk('p', null, c.desc));
    item.append(why);
  }
  return item;
}

chrome.storage.sync.get(RVC.DEFAULTS, (s) => {
  settings = { ...RVC.DEFAULTS, ...s };
  refreshTab();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
    render();
  } else if (area === 'session') {
    if (key && changes[key]) result = changes[key].newValue || null;
    if (changes.gdocIgnore) ignored = changes.gdocIgnore.newValue || [];
    render();
  }
});
chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url && tab.active) refreshTab();
});
