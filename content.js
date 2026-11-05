(() => {
  'use strict';
  if (window.__rvcLoaded) return;
  window.__rvcLoaded = true;

  const MAX_CHARS = 10000;
  const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  const DEFAULTS = { enabled: true, language: 'auto', debounce: 900, disabledSites: [], dictionary: [] };
  const CATS = {
    spell: { label: 'Orthographe', color: '#e5484d' },
    gram: { label: 'Grammaire', color: '#2f6feb' },
    punct: { label: 'Ponctuation', color: '#d99a00' }
  };
  // Alt+Maj+<touche> : corrige une catégorie (KeyboardEvent.code, indépendant du clavier)
  const CAT_KEYS = { spell: 'KeyO', gram: 'KeyG', punct: 'KeyP' };

  let settings = { ...DEFAULTS };
  let dict = new Set();
  const sessionIgnore = new Set();
  let state = null; // champ actuellement surveillé
  let ui = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ réglages */

  function applySettings(s) {
    settings = { ...DEFAULTS, ...s };
    dict = new Set((settings.dictionary || []).map((w) => String(w).toLowerCase()));
  }

  function active() {
    return settings.enabled && !(settings.disabledSites || []).includes(location.hostname);
  }

  chrome.storage.sync.get(DEFAULTS, (s) => applySettings(s));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
    applySettings(next);
    if (!active()) detach();
    else if (state) {
      state.lastChecked = null;
      schedule(state, 100);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state && state.status !== 'ok') schedule(state, 200);
  });

  /* ------------------------------------------------------------------ détection du champ */

  function resolveEditable(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.spellcheck === false) return null;
    if (t.tagName === 'TEXTAREA') return t.readOnly || t.disabled ? null : t;
    if (t.tagName === 'INPUT') {
      const type = (t.type || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') return null;
      const ac = (t.autocomplete || '').toLowerCase();
      if (/password|cc-|one-time|username|email|tel|address|postal|name/.test(ac)) return null;
      return t.readOnly || t.disabled ? null : t;
    }
    if (t.isContentEditable) {
      let h = t;
      while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
      return h;
    }
    return null;
  }

  /* ------------------------------------------------------------------ texte (champs et contenteditable) */

  function blockOf(n, root) {
    let e = n.parentElement;
    while (e && e !== root) {
      if (/^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|TD|TH)$/.test(e.tagName)) return e;
      e = e.parentElement;
    }
    return root;
  }

  // Aplatit un contenteditable en texte + table texte -> noeuds.
  function ceExtract(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let text = '';
    const segs = [];
    let prevBlock = null;
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) {
        if (n.tagName === 'BR') {
          text += '\n';
          prevBlock = null;
        }
        continue;
      }
      if (!n.nodeValue) continue;
      const block = blockOf(n, root);
      if (prevBlock && block !== prevBlock) text += '\n';
      segs.push({ node: n, start: text.length, end: text.length + n.nodeValue.length });
      text += n.nodeValue;
      prevBlock = block;
    }
    return { text, segs };
  }

  function getText(st) {
    return st.kind === 'text' ? st.el.value : ceExtract(st.el).text;
  }

  function rangeFor(segs, start, end) {
    let a = null;
    let b = null;
    for (const s of segs) {
      if (!a && start >= s.start && start < s.end) a = { n: s.node, o: start - s.start };
      if (end > s.start && end <= s.end) b = { n: s.node, o: end - s.start };
    }
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.n, a.o);
      r.setEnd(b.n, b.o);
      return r;
    } catch (e) {
      return null;
    }
  }

  function pickLanguage(text) {
    if (settings.language !== 'auto') return settings.language;
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
  }

  function catOf(c) {
    const s = (c.group + ' ' + c.type).toLowerCase();
    if (/ortho|spell|mot inconnu|accent/.test(s)) return 'spell';
    if (/ponct|punct|typo|espace/.test(s)) return 'punct';
    return 'gram';
  }

  /* ------------------------------------------------------------------ cycle de vie */

  function attach(el) {
    detach();
    const kind = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? 'text' : 'ce';
    const st = {
      el,
      kind,
      text: '',
      lastChecked: null,
      corrections: [],
      seq: 0,
      timer: 0,
      mirror: null,
      spans: new Map(),
      handlers: [],
      observer: null,
      focused: true,
      status: 'idle',
      error: ''
    };
    state = st;
    const on = (type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      st.handlers.push([type, fn, opts]);
    };
    on('input', () => onInput(st));
    on('scroll', () => layoutSoon(), { passive: true });
    on('click', () => onCaret(st));
    on('keyup', (e) => {
      if (NAV_KEYS.has(e.key)) onCaret(st);
    });
    on('focus', () => {
      st.focused = true;
      layoutSoon();
    });
    on('blur', () => {
      st.focused = false;
      setTimeout(() => {
        hideCard();
        layoutSoon();
      }, 0);
    });
    if (kind === 'ce') {
      // Slate, Lexical, React... re-rendent le DOM, parfois sans événement input, et les Range
      // des soulignements pointent sur des noeuds détachés. On les reconstruit à chaque mutation.
      let pending = 0;
      st.observer = new MutationObserver(() => {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = 0;
          if (state !== st) return;
          if (sync(st)) hideCard();
          renderHighlights(st);
          layoutSoon();
        });
      });
      st.observer.observe(el, { childList: true, characterData: true, subtree: true });
    }
    st.text = getText(st);
    if (st.text.trim()) schedule(st, 200);
    layoutSoon();
  }

  function detach() {
    const st = state;
    if (!st) return;
    clearTimeout(st.timer);
    for (const [t, fn, o] of st.handlers) st.el.removeEventListener(t, fn, o);
    if (st.observer) st.observer.disconnect();
    if (st.mirror) st.mirror.remove();
    clearHighlights();
    state = null;
    hideCard();
    if (ui) ui.badge.hidden = true;
  }

  function onInput(st) {
    hideCard();
    rebase(st, getText(st));
    render(st);
    schedule(st, settings.debounce);
  }

  // Après une frappe, décale les corrections pour garder l'alignement.
  function rebase(st, nt) {
    const ot = st.text;
    if (ot === nt) return;
    let p = 0;
    const m = Math.min(ot.length, nt.length);
    while (p < m && ot.charCodeAt(p) === nt.charCodeAt(p)) p++;
    let s = 0;
    while (s < m - p && ot.charCodeAt(ot.length - 1 - s) === nt.charCodeAt(nt.length - 1 - s)) s++;
    const delta = nt.length - ot.length;
    const oldTail = ot.length - s;
    st.corrections = st.corrections.flatMap((c) => {
      if (c.end <= p) return [c];
      if (c.start >= oldTail) return [{ ...c, start: c.start + delta, end: c.end + delta }];
      return [];
    });
    st.text = nt;
  }

  // Recale st.text et les corrections sur le champ ; true si le texte a changé.
  function sync(st) {
    const nt = getText(st);
    if (nt === st.text) return false;
    rebase(st, nt);
    schedule(st, settings.debounce);
    return true;
  }

  function schedule(st, delay) {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => runCheck(st), delay);
  }

  function ask(text, language) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'check', text, language }, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: 'Pas de réponse' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension rechargée : rechargez la page.' });
      }
    });
  }

  async function runCheck(st) {
    if (state !== st || !active()) return;
    if (document.hidden) return; // reprendra au retour sur l'onglet
    const text = getText(st);
    st.text = text;
    if (text.trim().length < 2) {
      st.corrections = [];
      st.status = 'idle';
      st.lastChecked = null;
      render(st);
      return;
    }
    if (text === st.lastChecked && st.status === 'ok') return; // rien de neuf
    const seq = ++st.seq;
    st.status = 'checking';
    layoutSoon();
    const resp = await ask(text.slice(0, MAX_CHARS), pickLanguage(text));
    if (state !== st || seq !== st.seq) return;
    if (getText(st) !== text) return; // texte changé : nouveau contrôle déjà planifié
    if (!resp.ok) {
      st.status = 'error';
      st.error = resp.error || 'Erreur inconnue';
      layoutSoon();
      if (resp.retryAfter) schedule(st, resp.retryAfter + 300); // limite de débit : réessai automatique
      return;
    }
    st.status = 'ok';
    st.error = '';
    st.lastChecked = text;
    st.corrections = resp.corrections
      .filter((c) => {
        const k = c.mistake.toLowerCase();
        return !dict.has(k) && !sessionIgnore.has(k);
      })
      .map((c) => ({ ...c, cat: catOf(c) }));
    render(st);
  }

  /* ------------------------------------------------------------------ soulignement */

  const COPY_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'lineHeight',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'direction', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'textRendering', 'fontKerning'
  ];

  function render(st) {
    if (st.kind === 'text') renderMirror(st);
    else renderHighlights(st);
    layoutSoon();
  }

  // <textarea>/<input> : calque transparent qui reproduit le texte et souligne les fautes.
  function renderMirror(st) {
    if (!st.mirror) {
      st.mirror = document.createElement('div');
      st.mirror.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(st.mirror);
    }
    const m = st.mirror;
    m.textContent = '';
    st.spans.clear();
    const text = st.text;
    let pos = 0;
    for (const c of st.corrections) {
      if (c.start < pos) continue;
      if (c.start > pos) m.append(text.slice(pos, c.start));
      const sp = document.createElement('span');
      sp.textContent = text.slice(c.start, c.end);
      sp.style.cssText =
        'text-decoration:underline wavy ' + CATS[c.cat].color +
        ';text-decoration-thickness:1.5px;text-underline-offset:2px;text-decoration-skip-ink:none;';
      m.append(sp);
      st.spans.set(c, sp);
      pos = c.end;
    }
    m.append(text.slice(pos) + '​');
    syncMirrorStyle(st);
  }

  function syncMirrorStyle(st) {
    const el = st.el;
    const m = st.mirror;
    if (!m) return;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    for (const k of COPY_STYLES) m.style[k] = cs[k];
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - bl - br);
    Object.assign(m.style, {
      position: 'fixed',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width - scrollbar + 'px',
      height: r.height + 'px',
      boxSizing: 'border-box',
      borderStyle: 'solid',
      borderColor: 'transparent',
      margin: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      color: 'transparent',
      background: 'transparent',
      whiteSpace: el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre',
      overflowWrap: 'break-word',
      wordBreak: cs.wordBreak,
      zIndex: '2147483646',
      display: r.width === 0 || r.height === 0 ? 'none' : 'block'
    });
    if (el.tagName === 'INPUT') {
      const inner = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      m.style.lineHeight = inner + 'px';
    }
    m.scrollTop = el.scrollTop;
    m.scrollLeft = el.scrollLeft;
  }

  // contenteditable : API CSS Custom Highlight (DOM de la page intact).
  function clearHighlights() {
    if (!('highlights' in CSS)) return;
    for (const k of Object.keys(CATS)) CSS.highlights.delete('rvc-' + k);
  }

  function renderHighlights(st) {
    if (!('highlights' in CSS)) return;
    sync(st);
    const cur = ceExtract(st.el);
    const by = { spell: [], gram: [], punct: [] };
    for (const c of st.corrections) {
      const r = rangeFor(cur.segs, c.start, c.end);
      if (r) by[c.cat].push(r);
    }
    clearHighlights();
    for (const k of Object.keys(by)) if (by[k].length) CSS.highlights.set('rvc-' + k, new Highlight(...by[k]));
  }

  function rectFor(st, c) {
    if (st.kind === 'text') {
      const sp = st.spans.get(c);
      return sp ? sp.getBoundingClientRect() : null;
    }
    const cur = ceExtract(st.el);
    if (cur.text !== st.text) return null; // texte modifié : correction périmée
    const r = rangeFor(cur.segs, c.start, c.end);
    return r ? r.getBoundingClientRect() : null;
  }

  /* ------------------------------------------------------------------ clic sur une faute */

  function caretOffset(st) {
    if (st.kind === 'text') {
      const el = st.el;
      return el.selectionStart === el.selectionEnd ? el.selectionStart : -1;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return -1;
    const n = sel.anchorNode;
    if (!n || n.nodeType !== 3 || !st.el.contains(n)) return -1;
    if (sync(st)) render(st);
    const cur = ceExtract(st.el);
    const seg = cur.segs.find((s) => s.node === n);
    return seg ? seg.start + sel.anchorOffset : -1;
  }

  function onCaret(st) {
    const pos = caretOffset(st);
    if (pos < 0) return hideCard();
    const c = st.corrections.find((x) => pos >= x.start && pos <= x.end);
    if (c) openCard(st, c);
    else hideCard();
  }

  /* ------------------------------------------------------------------ appliquer une correction */

  // Remplace start..end par rep. Draft, Lexical, Slate, React contrôlé... défont à la frappe suivante
  // une modification qu'ils n'ont pas initiée : on essaie chaque méthode jusqu'à ce que le texte change.
  async function replaceRange(st, start, end, rep, mistake) {
    const el = st.el;
    sync(st);
    const before = st.text;
    if (before.slice(start, end) !== mistake) return false;
    const expected = before.slice(0, start) + rep + before.slice(end);
    const applied = () => getText(st) !== before;
    el.focus();

    if (st.kind === 'text') {
      el.setSelectionRange(start, end);
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, rep);
      } catch (e) {
        ok = false;
      }
      await sleep(80);
      if (!ok || el.value !== expected) {
        if (el.value === before || el.value !== expected) setNativeValue(el, expected, start + rep.length);
      }
    } else {
      const select = () => {
        const cur = ceExtract(el);
        const r = rangeFor(cur.segs, start, end);
        if (!r) return null;
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return r;
      };
      const r0 = select();
      if (!r0) return false;
      // laisse l'éditeur traiter selectionchange (asynchrone chez Slate)
      await sleep(30);
      // 1) beforeinput, géré par les éditeurs modernes. Sans targetRanges, Slate (Discord)
      // insère au point du clic au lieu de remplacer la faute.
      const init = { inputType: 'insertText', data: rep, bubbles: true, cancelable: true, composed: true };
      try {
        init.targetRanges = [new StaticRange(r0)];
      } catch (e) {}
      el.dispatchEvent(new InputEvent('beforeinput', init));
      await sleep(60);
      // 2) sinon, insertion native
      if (!applied()) {
        if (select()) {
          try {
            document.execCommand('insertText', false, rep);
          } catch (e) {}
        }
        await sleep(100);
      }
      // 3) collage simulé
      if (!applied() && select()) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', rep);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch (e) {}
        await sleep(120);
      }
      // 4) dernier recours : sélectionne la faute, copie la correction
      if (!applied()) {
        select();
        try {
          await navigator.clipboard.writeText(rep);
          toast('Le site refuse la modification. « ' + rep + ' » est copié : faites Ctrl+V.');
        } catch (e) {
          toast('Le site refuse la modification automatique.');
        }
        return false;
      }
    }

    if (state === st && st.text !== getText(st)) onInput(st); // l'éditeur n'a pas émis d'input
    return true;
  }

  function setNativeValue(el, value, caret) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    try {
      el.setSelectionRange(caret, caret);
    } catch (e) {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
  }

  async function applyFix(st, c, replacement) {
    hideCard();
    st.seq++; // invalide toute réponse encore en vol
    // le texte a pu bouger depuis l'ouverture de la carte : prend la correction recalée la plus proche
    sync(st);
    const cur = st.corrections.includes(c)
      ? c
      : st.corrections
          .filter((x) => x.mistake === c.mistake)
          .sort((a, b) => Math.abs(a.start - c.start) - Math.abs(b.start - c.start))[0];
    if (!cur) return;
    await replaceRange(st, cur.start, cur.end, replacement, cur.mistake);
  }

  // cat : 'spell' | 'gram' | 'punct' ; absent = tout corriger.
  async function fixAll(st, cat) {
    hideCard();
    st.seq++;
    sync(st);
    const pick = st.corrections.filter((c) => c.suggestions.length && (!cat || c.cat === cat));
    if (!pick.length) {
      toast(cat ? 'Aucune faute de type « ' + CATS[cat].label.toLowerCase() + ' » à corriger.' : 'Aucune faute à corriger.');
      return;
    }
    // de la fin vers le début pour garder les positions valides
    const todo = pick
      .map((c) => ({ start: c.start, end: c.end, mistake: c.mistake, rep: c.suggestions[0] }))
      .sort((a, b) => b.start - a.start);
    for (const t of todo) {
      if (state !== st) return;
      await replaceRange(st, t.start, t.end, t.rep, t.mistake);
    }
  }

  /* ------------------------------------------------------------------ interface (carte, liste, pastille) */

  const CSS_UI = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card, .badge, .toast { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .card { --bg: #fff; --fg: #1f2328; --mut: #656d76; --line: #e6e8eb; --chip: #f3f4f6; --hover: #f6f8fa;
      position: fixed; width: 330px; max-width: calc(100vw - 16px); background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
      box-shadow: 0 12px 32px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.08); animation: pop .12s ease-out; }
    @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
    .card[hidden], .badge[hidden], .toast[hidden] { display: none; }
    .accent { height: 3px; background: var(--c, #2f6feb); }
    .in { padding: 12px 14px 10px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .chip { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 2px 8px;
      border-radius: 999px; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
    .x { margin-left: auto; width: 22px; height: 22px; border: 0; border-radius: 6px; background: none; color: var(--mut);
      font-size: 16px; line-height: 1; cursor: pointer; }
    .x:hover { background: var(--hover); color: var(--fg); }
    .title { font-weight: 600; margin: 8px 0 8px; }
    .diff { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; font-size: 14px; }
    .diff s { color: #cf222e; text-decoration-thickness: 1.5px; word-break: break-word; }
    .diff .arrow { color: var(--mut); }
    .diff b { color: #1a7f37; word-break: break-word; }
    .primary { width: 100%; padding: 8px 12px; border: 0; border-radius: 8px; background: var(--c); color: #fff;
      font: inherit; font-weight: 600; cursor: pointer; text-align: center; }
    .primary:hover { filter: brightness(1.08); }
    .alts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .alt { font: inherit; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--chip);
      color: var(--fg); cursor: pointer; }
    .alt:hover { border-color: var(--c); }
    .none { color: var(--mut); }
    .why { margin-top: 10px; color: var(--mut); font-size: 12px; }
    .why summary { cursor: pointer; user-select: none; }
    .why p { margin: 6px 0 0; max-height: 120px; overflow: auto; }
    .foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--line); background: var(--hover); }
    .link { font: inherit; font-size: 12px; background: none; border: 0; padding: 0; color: var(--mut); cursor: pointer; }
    .link:hover { color: #0969da; text-decoration: underline; }
    .hint { margin-left: auto; font-size: 11px; color: var(--mut); }
    .head2 { display: flex; align-items: center; gap: 8px; padding: 12px 14px 6px; }
    .head2 strong { font-size: 14px; }
    .all { margin-left: auto; padding: 5px 10px; border: 0; border-radius: 8px; background: #1a7f37; color: #fff;
      font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .all:hover { filter: brightness(1.1); }
    .cats { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; }
    .catbtn { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid color-mix(in srgb, var(--c) 40%, transparent); color: var(--c);
      background: color-mix(in srgb, var(--c) 10%, transparent); }
    .catbtn:hover { background: color-mix(in srgb, var(--c) 20%, transparent); }
    .list { max-height: 260px; overflow: auto; padding: 0 6px 8px; }
    .item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px;
      background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .item:hover { background: var(--hover); }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
    .item s { color: #cf222e; }
    .item b { color: #1a7f37; }
    .item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { position: fixed; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; cursor: pointer; padding: 0;
      font-size: 11px; font-weight: 700; line-height: 20px; color: #fff; text-align: center;
      box-shadow: 0 1px 5px rgba(0,0,0,.28); transition: transform .12s; }
    .badge:hover { transform: scale(1.12); }
    .badge.ok { background: #1a7f37; } .badge.bad { background: #cf222e; } .badge.err { background: #bf8700; }
    .badge.busy { background: #6e7781; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .55; } }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: min(420px, calc(100vw - 32px));
      padding: 9px 14px; border-radius: 10px; background: #1f2328; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    @media (prefers-color-scheme: dark) {
      .card { --bg: #22272e; --fg: #cdd9e5; --mut: #8b98a5; --line: #3b434d; --chip: #2d333b; --hover: #2a3038; }
      .diff s, .item s { color: #ff7b72; } .diff b, .item b { color: #57d36d; }
      .link:hover { color: #6cb6ff; } .badge { border-color: #22272e; }
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
    host.id = 'rvc-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS_UI;
    const card = mk('div', 'card');
    card.hidden = true;
    const badge = mk('button', 'badge');
    badge.hidden = true;
    const toastEl = mk('div', 'toast');
    toastEl.hidden = true;
    root.append(style, card, badge, toastEl);
    document.documentElement.appendChild(host);
    // garde le focus dans le champ pendant qu'on clique sur la carte
    card.addEventListener('mousedown', (e) => e.preventDefault());
    badge.addEventListener('mousedown', (e) => e.preventDefault());
    badge.addEventListener('click', () => {
      const st = state;
      if (!st) return;
      if (!ui.card.hidden && ui.mode === 'list') return hideCard();
      if (st.corrections.length) openList(st);
      else toast(st.status === 'error' ? 'Reverso : ' + st.error : 'Aucune faute détectée.');
    });
    ui = { host, card, badge, toast: toastEl, mode: null, current: null, toastTimer: 0 };
    return ui;
  }

  function toast(msg) {
    const u = ensureUI();
    u.toast.textContent = msg;
    u.toast.hidden = false;
    clearTimeout(u.toastTimer);
    u.toastTimer = setTimeout(() => (u.toast.hidden = true), 4500);
  }

  function placeCard(rect, preferAbove) {
    const card = ui.card;
    card.hidden = false;
    card.style.left = '0px';
    card.style.top = '0px';
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.max(8, Math.min(preferAbove ? rect.right - w : rect.left, window.innerWidth - w - 8));
    let top = preferAbove ? rect.top - h - 8 : rect.bottom + 6;
    if (preferAbove && top < 8) top = rect.bottom + 8;
    if (!preferAbove && top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function openCard(st, c) {
    const u = ensureUI();
    const card = u.card;
    const cat = CATS[c.cat];
    card.textContent = '';
    card.style.setProperty('--c', cat.color);
    u.mode = 'card';
    u.current = { st, c };

    card.append(mk('div', 'accent'));
    const inner = mk('div', 'in');
    const top = mk('div', 'row');
    top.append(mk('span', 'chip', cat.label));
    const close = mk('button', 'x', '×');
    close.title = 'Fermer (Échap)';
    close.addEventListener('click', hideCard);
    top.append(close);
    inner.append(top);
    if (c.title) inner.append(mk('div', 'title', c.title));
    else inner.append(mk('div', 'title', 'Faute détectée'));

    const best = c.suggestions[0];
    const diff = mk('div', 'diff');
    diff.append(mk('s', null, c.mistake));
    if (best) {
      diff.append(mk('span', 'arrow', '→'), mk('b', null, best));
    }
    inner.append(diff);

    if (best) {
      const prim = mk('button', 'primary', 'Corriger');
      prim.addEventListener('click', () => applyFix(st, c, best));
      inner.append(prim);
      if (c.suggestions.length > 1) {
        const alts = mk('div', 'alts');
        for (const s of c.suggestions.slice(1, 6)) {
          const b = mk('button', 'alt', s);
          b.addEventListener('click', () => applyFix(st, c, s));
          alts.append(b);
        }
        inner.append(alts);
      }
    } else {
      inner.append(mk('div', 'none', 'Aucune suggestion disponible.'));
    }

    if (c.desc) {
      const why = mk('details', 'why');
      why.append(mk('summary', null, 'Pourquoi ?'), mk('p', null, c.desc));
      inner.append(why);
    }
    card.append(inner);

    const foot = mk('div', 'foot');
    const ign = mk('button', 'link', 'Ignorer');
    ign.addEventListener('click', () => {
      const k = c.mistake.toLowerCase();
      sessionIgnore.add(k);
      st.corrections = st.corrections.filter((x) => x.mistake.toLowerCase() !== k);
      hideCard();
      render(st);
    });
    foot.append(ign);
    if (/^\S+$/.test(c.mistake)) {
      const add = mk('button', 'link', 'Ajouter au dictionnaire');
      add.addEventListener('click', () => {
        chrome.storage.sync.get({ dictionary: [] }, (s) => {
          const list = s.dictionary || [];
          if (!list.map((w) => w.toLowerCase()).includes(c.mistake.toLowerCase())) list.push(c.mistake);
          chrome.storage.sync.set({ dictionary: list });
        });
        hideCard();
      });
      foot.append(add);
    }
    if (best) foot.append(mk('span', 'hint', 'Alt+Entrée'));
    card.append(foot);

    const rect = rectFor(st, c);
    if (!rect) return hideCard();
    placeCard(rect, false);
  }

  // Panneau de la pastille : fautes du champ + « Tout corriger ».
  function openList(st) {
    const u = ensureUI();
    const card = u.card;
    card.textContent = '';
    card.style.setProperty('--c', '#2f6feb');
    u.mode = 'list';
    u.current = null;

    const n = st.corrections.length;
    const head = mk('div', 'head2');
    head.append(mk('strong', null, n + (n > 1 ? ' fautes' : ' faute')));
    if (st.corrections.some((c) => c.suggestions.length)) {
      const all = mk('button', 'all', 'Tout corriger');
      all.title = 'Alt+Maj+Entrée';
      all.addEventListener('click', () => fixAll(st));
      head.append(all);
    }
    card.append(head);

    // filtre par catégorie (si plusieurs)
    const present = Object.keys(CATS).filter((k) => st.corrections.some((c) => c.cat === k && c.suggestions.length));
    if (present.length > 1) {
      const cats = mk('div', 'cats');
      for (const k of present) {
        const b = mk('button', 'catbtn', CATS[k].label + ' (' + st.corrections.filter((c) => c.cat === k && c.suggestions.length).length + ')');
        b.style.setProperty('--c', CATS[k].color);
        b.title = 'Corriger seulement : ' + CATS[k].label.toLowerCase() + ' (Alt+Maj+' + CAT_KEYS[k].slice(3) + ')';
        b.addEventListener('click', () => fixAll(st, k));
        cats.append(b);
      }
      card.append(cats);
    }

    const list = mk('div', 'list');
    for (const c of st.corrections) {
      const item = mk('button', 'item');
      item.style.setProperty('--c', CATS[c.cat].color);
      item.append(mk('span', 'dot'));
      const label = mk('span');
      label.append(mk('s', null, c.mistake));
      if (c.suggestions[0]) {
        label.append(document.createTextNode(' → '), mk('b', null, c.suggestions[0]));
      }
      item.append(label);
      item.addEventListener('click', () => {
        if (c.suggestions[0]) applyFix(st, c, c.suggestions[0]);
        else openCard(st, c);
      });
      list.append(item);
    }
    card.append(list);

    placeCard(u.badge.getBoundingClientRect(), true);
  }

  function hideCard() {
    if (ui) {
      ui.card.hidden = true;
      ui.mode = null;
      ui.current = null;
    }
  }

  function placeBadge(st) {
    const u = ensureUI();
    const b = u.badge;
    const r = st.el.getBoundingClientRect();
    if (!st.focused || r.width < 80 || r.height < 24 || !st.text.trim()) {
      b.hidden = true;
      return;
    }
    const n = st.corrections.length;
    b.hidden = false;
    b.style.left = r.right - 32 + 'px';
    b.style.top = r.bottom - 32 + 'px';
    if (st.status === 'error') {
      b.className = 'badge err';
      b.textContent = '!';
      b.title = 'Reverso : ' + st.error;
    } else if (st.status === 'checking' && !n) {
      b.className = 'badge busy';
      b.textContent = '…';
      b.title = 'Vérification en cours';
    } else {
      b.className = 'badge ' + (n ? 'bad' : 'ok');
      b.textContent = n ? String(n) : '✓';
      b.title = n ? n + ' faute(s) : cliquer pour la liste' : 'Aucune faute détectée';
    }
  }

  /* ------------------------------------------------------------------ positionnement */

  let raf = 0;
  function layoutSoon() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      layout();
    });
  }

  function layout() {
    const st = state;
    if (!st) return;
    if (!st.el.isConnected) return detach();
    if (st.kind === 'text') syncMirrorStyle(st);
    placeBadge(st);
  }

  window.addEventListener(
    'scroll',
    (e) => {
      if (state && e.target === state.mirror) return;
      if (ui && e.composedPath().includes(ui.host)) return;
      layoutSoon();
      if (ui && !ui.card.hidden) hideCard();
    },
    true
  );
  window.addEventListener('resize', () => {
    layoutSoon();
    hideCard();
  });
  setInterval(() => {
    if (state) layoutSoon();
  }, 600);

  /* ------------------------------------------------------------------ entrées globales */

  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.composedPath ? e.composedPath()[0] : e.target;
      const el = resolveEditable(t);
      if (!el || !active()) return;
      if (state && state.el === el) {
        state.focused = true;
        layoutSoon();
        return;
      }
      attach(el);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      if (ui && !ui.card.hidden && !e.composedPath().includes(ui.host)) hideCard();
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') hideCard();
      else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && state && state.focused) {
        const cat = Object.keys(CAT_KEYS).find((k) => CAT_KEYS[k] === e.code);
        if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && !cat) return;
        e.preventDefault();
        e.stopPropagation();
        fixAll(state, cat);
      } else if (e.altKey && e.key === 'Enter' && ui && ui.current) {
        const { st, c } = ui.current;
        if (c.suggestions[0]) {
          e.preventDefault();
          applyFix(st, c, c.suggestions[0]);
        }
      }
    },
    true
  );
})();
