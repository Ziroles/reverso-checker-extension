const DEFAULTS = { enabled: true, language: 'auto', disabledSites: [] };
const $ = (id) => document.getElementById(id);

function markLang(lang) {
  for (const b of document.querySelectorAll('#language button')) b.classList.toggle('on', b.dataset.lang === lang);
}

chrome.storage.sync.get(DEFAULTS, async (s) => {
  $('enabled').checked = s.enabled;
  markLang(s.language);

  let hostname = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    hostname = new URL(tab.url).hostname;
  } catch (e) {}

  if (hostname) {
    $('host').textContent = hostname;
    $('site').checked = !s.disabledSites.includes(hostname);
  } else {
    $('site').disabled = true;
    $('host').textContent = 'Page non gérée';
  }

  $('enabled').addEventListener('change', () => chrome.storage.sync.set({ enabled: $('enabled').checked }));
  $('site').addEventListener('change', () => {
    chrome.storage.sync.get({ disabledSites: [] }, (cur) => {
      const set = new Set(cur.disabledSites);
      if ($('site').checked) set.delete(hostname);
      else set.add(hostname);
      chrome.storage.sync.set({ disabledSites: [...set] });
    });
  });
  for (const b of document.querySelectorAll('#language button')) {
    b.addEventListener('click', () => {
      markLang(b.dataset.lang);
      chrome.storage.sync.set({ language: b.dataset.lang });
    });
  }
});

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
