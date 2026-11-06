// Google Docs, côté page : déclenche les vérifications et souligne les fautes par-dessus le canvas.
//
// Les fautes viennent de chrome.storage.session (écrites par gdocs-bg.js). Pour les placer,
// on cherche chaque faute, avec son contexte, dans les <rect aria-label> du canvas annoté,
// puis on mesure le texte avec la police donnée par data-font-css.
(() => {
  'use strict';
  if (window.top !== window || window.__rvcGdocs) return;
  window.__rvcGdocs = true;

  const POLL_MS = 5000;
  const COLORS = { spell: '#e5484d', gram: '#2f6feb', punct: '#d99a00' };
  const LABELS = { spell: 'Orthographe', gram: 'Grammaire', punct: 'Ponctuation' };

  let ids = RVC.gdocIds(location.href);
  if (!ids) return;
  let key = RVC.gdocKey(ids);
  let settings = { ...RVC.DEFAULTS };
  let result = null;
  let ignored = [];
  let ui = null;

  const active = () => settings.enabled && RVC.siteActive(settings, location.hostname);

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ ...msg, docId: ids.docId, docTab: ids.docTab }, (r) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r || {});
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension rechargée : rechargez la page.' });
      }
    });
  }

  async function loadSession() {
    try {
      const got = await chrome.storage.session.get([key, 'gdocIgnore']);
      result = got[key] || null;
      ignored = got.gdocIgnore || [];
    } catch (e) {} // accès pas encore ouvert par le service worker : réessai au prochain tour
    drawSoon();
  }

  chrome.storage.sync.get(RVC.DEFAULTS, (s) => {
    settings = { ...RVC.DEFAULTS, ...s };
    if (active()) send({ type: 'gdoc-check', interactive: false }).then(loadSession);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
      drawSoon();
    } else if (area === 'session') {
      if (changes[key]) result = changes[key].newValue || null;
      if (changes.gdocIgnore) ignored = changes.gdocIgnore.newValue || [];
      drawSoon();
    }
  });

  // Docs change d'URL sans recharger (onglets ?tab=) : on suit.
  setInterval(() => {
    const next = RVC.gdocIds(location.href);
    if (next && RVC.gdocKey(next) !== key) {
      ids = next;
      key = RVC.gdocKey(ids);
      result = null;
      hideCard();
      if (active()) send({ type: 'gdoc-check', interactive: false }).then(loadSession);
      return;
    }
    if (!document.hidden && active()) send({ type: 'gdoc-poll' }).then(() => !result && loadSession());
  }, POLL_MS);

  /* ---------------------------------------------------------------- interface */

  const CSS = `
    :host { all: initial; }
    .mark { position: fixed; height: 5px; border-radius: 2px; pointer-events: auto; cursor: pointer;
      background: linear-gradient(var(--c), var(--c)) bottom / 100% 2px no-repeat; }
    .mark:hover { background: color-mix(in srgb, var(--c) 25%, transparent); }
    .card { position: fixed; width: 300px; font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #fff; color: #1f2328; border: 1px solid #e6e8eb; border-radius: 12px; overflow: hidden;
      box-shadow: 0 12px 32px rgba(15,23,42,.18); pointer-events: auto; }
    .card[hidden] { display: none; }
    .accent { height: 3px; background: var(--c); }
    .in { padding: 10px 12px; }
    .chip { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--c); }
    .title { font-weight: 600; margin: 4px 0 8px; }
    s { color: #cf222e; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    button { font: inherit; cursor: pointer; }
    .sug { padding: 4px 10px; border-radius: 8px; border: 1px solid #e6e8eb; background: #f3f4f6; color: inherit; }
    .sug.main { background: var(--c); border-color: var(--c); color: #fff; font-weight: 600; }
    .foot { display: flex; gap: 12px; padding: 7px 12px; border-top: 1px solid #e6e8eb; background: #f6f8fa; }
    .link { background: none; border: 0; padding: 0; color: #656d76; font-size: 12px; }
    .link:hover { color: #0969da; text-decoration: underline; }
    .note { color: #656d76; font-size: 12px; margin-top: 6px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #22272e; color: #cdd9e5; border-color: #3b434d; }
      .sug { background: #2d333b; border-color: #3b434d; } .foot { background: #2a3038; border-color: #3b434d; }
      s { color: #ff7b72; } .link, .note { color: #8b98a5; }
    }`;

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    const style = mk('style');
    style.textContent = CSS;
    const marks = mk('div');
    const card = mk('div', 'card');
    card.hidden = true;
    card.addEventListener('mousedown', (e) => e.preventDefault());
    root.append(style, marks, card);
    document.documentElement.appendChild(host);
    ui = { host, marks, card };
    return ui;
  }

  function hideCard() {
    if (ui) ui.card.hidden = true;
  }

  function openCard(c, box) {
    const { card } = ensureUI();
    card.textContent = '';
    card.style.setProperty('--c', COLORS[c.cat]);
    card.append(mk('div', 'accent'));
    const inner = mk('div', 'in');
    inner.append(mk('div', 'chip', LABELS[c.cat]), mk('div', 'title', c.title || 'Faute détectée'));
    inner.append(mk('s', null, c.mistake));
    if (c.suggestions.length && c.fixable) {
      const btns = mk('div', 'btns');
      c.suggestions.slice(0, 6).forEach((sug, i) => {
        const b = mk('button', 'sug' + (i ? '' : ' main'), sug);
        b.addEventListener('click', () => {
          hideCard();
          send({ type: 'gdoc-fix', fixes: [{ id: c.id, rep: sug }] });
        });
        btns.append(b);
      });
      inner.append(btns);
    } else if (!c.fixable) {
      inner.append(mk('div', 'note', 'Correction automatique impossible ici (image ou saut dans la faute).'));
    } else {
      inner.append(mk('div', 'note', 'Aucune suggestion.'));
    }
    if (c.desc) inner.append(mk('div', 'note', c.desc));
    card.append(inner);
    const foot = mk('div', 'foot');
    const ign = mk('button', 'link', 'Ignorer');
    ign.addEventListener('click', () => {
      hideCard();
      chrome.storage.session.set({ gdocIgnore: [...new Set([...ignored, c.mistake.toLowerCase()])] });
    });
    const close = mk('button', 'link', 'Fermer');
    close.addEventListener('click', hideCard);
    foot.append(ign, close);
    card.append(foot);

    card.hidden = false;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.max(8, Math.min(box.left, innerWidth - w - 8));
    let top = box.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, box.top - h - 6);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  /* ---------------------------------------------------------------- placement des soulignements */

  const ctx = document.createElement('canvas').getContext('2d');
  function measure(font, s) {
    ctx.font = font;
    return ctx.measureText(s).width;
  }

  function lines() {
    const editor = document.querySelector('.kix-appview-editor') || document.body;
    const view = editor.getBoundingClientRect();
    const out = [];
    for (const r of editor.querySelectorAll('rect[aria-label]')) {
      const label = r.getAttribute('aria-label');
      if (!label) continue;
      const box = r.getBoundingClientRect();
      if (box.bottom < view.top || box.top > view.bottom || box.width === 0) continue;
      out.push({ label, box, font: r.getAttribute('data-font-css') || getComputedStyle(r).font || '14.6667px Arial' });
    }
    return { out, view };
  }

  // Meilleure occurrence de la faute parmi les lignes visibles, d'après le contexte avant/après.
  function place(c, ls, used) {
    let best = null;
    let bestScore = -1;
    ls.forEach((l, li) => {
      for (let i = l.label.indexOf(c.mistake); i !== -1; i = l.label.indexOf(c.mistake, i + 1)) {
        if (used.has(li + ':' + i)) continue;
        let score = 0;
        while (score < c.before.length && l.label[i - 1 - score] === c.before[c.before.length - 1 - score]) score++;
        const beforeAvail = Math.min(c.before.length, i);
        let a = 0;
        const j = i + c.mistake.length;
        while (a < c.after.length && l.label[j + a] === c.after[a]) a++;
        const afterAvail = Math.min(c.after.length, l.label.length - j);
        // la ligne peut couper le contexte : on ne demande que ce qu'elle contient
        if (score < beforeAvail && score < 4) continue;
        if (a < afterAvail && a < 4) continue;
        if (score + a > bestScore) {
          bestScore = score + a;
          best = { li, i };
        }
      }
    });
    return best;
  }

  let raf = 0;
  let lastDraw = 0;
  function drawSoon() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const wait = 120 - (performance.now() - lastDraw);
      if (wait > 0) return setTimeout(drawSoon, wait);
      lastDraw = performance.now();
      draw();
    });
  }

  function draw() {
    const list = active() && result ? RVC.visible(result.corrections, settings.dictionary, ignored) : [];
    if (!list.length) {
      if (ui) ui.marks.textContent = '';
      return;
    }
    const { marks } = ensureUI();
    marks.textContent = '';
    const { out: ls, view } = lines();
    if (!ls.length) return; // canvas annoté indisponible : le panneau reste utilisable
    const joined = ls.map((l) => l.label).join('\n');
    const used = new Set();
    for (const c of list) {
      if (!c.mistake || !joined.includes(c.mistake)) continue;
      const p = place(c, ls, used);
      if (!p) continue;
      used.add(p.li + ':' + p.i);
      const l = ls[p.li];
      const full = measure(l.font, l.label);
      const k = full > 0 ? l.box.width / full : 1;
      const x = l.box.left + measure(l.font, l.label.slice(0, p.i)) * k;
      const w = Math.max(4, measure(l.font, c.mistake) * k);
      if (x + w < view.left || x > view.right) continue;
      const m = mk('div', 'mark');
      m.style.setProperty('--c', COLORS[c.cat] || COLORS.gram);
      m.style.left = x + 'px';
      m.style.top = l.box.bottom - 3 + 'px';
      m.style.width = w + 'px';
      m.title = c.mistake + (c.suggestions[0] ? ' → ' + c.suggestions[0] : '');
      m.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCard(c, m.getBoundingClientRect());
      });
      marks.append(m);
    }
  }

  // Docs re-rend les tuiles du canvas au défilement et à la frappe
  new MutationObserver(drawSoon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
  addEventListener('scroll', () => { hideCard(); drawSoon(); }, true);
  addEventListener('resize', drawSoon);
  document.addEventListener('mousedown', (e) => {
    if (ui && !ui.card.hidden && !e.composedPath().includes(ui.host)) hideCard();
  }, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hideCard(), true);
})();
