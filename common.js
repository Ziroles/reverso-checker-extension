// Partagé par content.js, popup.js et options.js : réglages par défaut et règles de sites.
//
// siteMode :
//   'blacklist' : actif partout, sauf sur les sites de disabledSites ;
//   'whitelist' : inactif partout, sauf sur les sites de enabledSites.
// Une entrée « example.com » vise ce domaine exact ; « *.example.com » vise aussi ses sous-domaines.

globalThis.RVC = globalThis.RVC || {
  DEFAULTS: {
    enabled: true,
    language: 'auto',
    debounce: 900,
    siteMode: 'blacklist',
    disabledSites: [],
    enabledSites: [],
    dictionary: []
  },

  // Nettoie une saisie : « https://Docs.Example.com/x » -> « docs.example.com ».
  normalizeSite(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, '');
  },

  // Renvoie l'entrée de la liste qui vise host, ou null.
  siteRule(list, host) {
    host = String(host || '').toLowerCase();
    for (const raw of list || []) {
      const e = String(raw).toLowerCase();
      if (e === host) return e;
      if (e.startsWith('*.')) {
        const base = e.slice(2);
        if (host === base || host.endsWith('.' + base)) return e;
      }
    }
    return null;
  },

  listFor(s) {
    return s.siteMode === 'whitelist' ? s.enabledSites || [] : s.disabledSites || [];
  },

  siteActive(s, host) {
    const hit = RVC.siteRule(RVC.listFor(s), host);
    return s.siteMode === 'whitelist' ? !!hit : !hit;
  },

  // 'auto' : comptage de mots-outils et d'accents ; français en cas de doute.
  pickLanguage(text, setting) {
    if (setting && setting !== 'auto') return setting;
    const words = text.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ']+/g) || [];
    const FR = new Set('le la les un une des et est que qui dans pour pas je tu il elle nous vous ils sur avec ce cette de du au aux mais ou où ne se sont suis ai a en'.split(' '));
    const EN = new Set('the and is are to of in that it for with as on was be this have not you i but they at by from'.split(' '));
    let fr = (text.match(/[àâçéèêëîïôûùüÿœ]/gi) || []).length;
    let en = 0;
    for (const w of words) {
      if (FR.has(w)) fr++;
      if (EN.has(w)) en++;
    }
    return en > fr ? 'eng' : 'fra';
  },

  catOf(c) {
    const s = (c.group + ' ' + c.type).toLowerCase();
    if (/ortho|spell|mot inconnu|accent/.test(s)) return 'spell';
    if (/ponct|punct|typo|espace/.test(s)) return 'punct';
    return 'gram';
  },

  // Google Docs : identifiant du document et onglet (?tab=t.xxx) d'après l'URL.
  gdocIds(url) {
    const m = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/.exec(url || '');
    if (!m) return null;
    let docTab = '';
    try {
      docTab = new URL(url).searchParams.get('tab') || '';
    } catch (e) {}
    return { docId: m[1], docTab };
  },

  gdocKey(ids) {
    return 'gdoc:' + ids.docId + '#' + (ids.docTab || '');
  },

  // Corrections à afficher : hors dictionnaire et hors fautes ignorées.
  visible(corrections, dictionary, ignored) {
    const skip = new Set([...(dictionary || []), ...(ignored || [])].map((w) => String(w).toLowerCase()));
    return (corrections || []).filter((c) => !skip.has(c.mistake.toLowerCase()));
  }
};
