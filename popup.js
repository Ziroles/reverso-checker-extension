const $ = (id) => document.getElementById(id);

function markSeg(id, attr, value) {
  for (const b of document.querySelectorAll('#' + id + ' button')) b.classList.toggle('on', b.dataset[attr] === value);
}

let hostname = '';

// Met à jour l'interrupteur « Sur ce site » selon le mode et la liste en vigueur.
function showSite(s) {
  const wl = s.siteMode === 'whitelist';
  $('modeHint').textContent = wl ? 'Sites autorisés uniquement' : 'Sauf sites exclus';
  if (!hostname) {
    $('site').disabled = true;
    $('host').textContent = 'Page non gérée';
    return;
  }
  const rule = RVC.siteRule(RVC.listFor(s), hostname);
  $('site').checked = RVC.siteActive(s, hostname);
  // une règle « *.domaine » ne se retire que depuis les options
  const wildcard = rule && rule !== hostname;
  $('site').disabled = !!wildcard;
  $('host').textContent = wildcard ? hostname + ' (règle ' + rule + ')' : hostname;
  $('host').title = $('host').textContent;
}

chrome.storage.sync.get(RVC.DEFAULTS, async (s) => {
  $('enabled').checked = s.enabled;
  markSeg('language', 'lang', s.language);
  markSeg('mode', 'mode', s.siteMode);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) hostname = u.hostname.toLowerCase();
    if (RVC.gdocIds(tab.url)) {
      $('gdRow').hidden = false;
      $('gdOpen').addEventListener('click', () => {
        chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close(), () => {});
      });
    }
  } catch (e) {}
  showSite(s);

  $('enabled').addEventListener('change', () => chrome.storage.sync.set({ enabled: $('enabled').checked }));

  $('site').addEventListener('change', () => {
    chrome.storage.sync.get(RVC.DEFAULTS, (cur) => {
      const key = cur.siteMode === 'whitelist' ? 'enabledSites' : 'disabledSites';
      const set = new Set(cur[key]);
      // whitelist : coché = dans la liste ; blacklist : coché = hors de la liste
      const inList = cur.siteMode === 'whitelist' ? $('site').checked : !$('site').checked;
      if (inList) set.add(hostname);
      else set.delete(hostname);
      chrome.storage.sync.set({ [key]: [...set] });
    });
  });

  for (const b of document.querySelectorAll('#mode button')) {
    b.addEventListener('click', () => {
      markSeg('mode', 'mode', b.dataset.mode);
      chrome.storage.sync.set({ siteMode: b.dataset.mode }, () => chrome.storage.sync.get(RVC.DEFAULTS, showSite));
    });
  }

  for (const b of document.querySelectorAll('#language button')) {
    b.addEventListener('click', () => {
      markSeg('language', 'lang', b.dataset.lang);
      chrome.storage.sync.set({ language: b.dataset.lang });
    });
  }
});

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
