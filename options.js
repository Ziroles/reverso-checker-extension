const DEFAULTS = RVC.DEFAULTS;
const $ = (id) => document.getElementById(id);
const lines = (s) => [...new Set(s.split('\n').map((x) => x.trim()).filter(Boolean))];
const siteLines = (s) => [...new Set(s.split('\n').map(RVC.normalizeSite).filter(Boolean))];
const mode = () => (document.querySelector('input[name=mode]:checked') || {}).value || 'blacklist';

function showMode() {
  // les deux listes sont gardées ; seule celle du mode choisi est affichée
  $('blWrap').hidden = mode() !== 'blacklist';
  $('wlWrap').hidden = mode() !== 'whitelist';
}
for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', showMode);

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('language').value = s.language;
  $('debounce').value = s.debounce;
  $('dictionary').value = s.dictionary.join('\n');
  $('sites').value = s.disabledSites.join('\n');
  $('wsites').value = s.enabledSites.join('\n');
  document.querySelector('input[name=mode][value=' + s.siteMode + ']').checked = true;
  showMode();
});

$('save').addEventListener('click', () => {
  const debounce = Math.min(5000, Math.max(300, parseInt($('debounce').value, 10) || 900));
  chrome.storage.sync.set(
    {
      enabled: $('enabled').checked,
      language: $('language').value,
      debounce,
      dictionary: lines($('dictionary').value),
      siteMode: mode(),
      disabledSites: siteLines($('sites').value),
      enabledSites: siteLines($('wsites').value)
    },
    () => {
      $('debounce').value = debounce;
      chrome.storage.sync.get(DEFAULTS, (s) => {
        $('sites').value = s.disabledSites.join('\n');
        $('wsites').value = s.enabledSites.join('\n');
      });
      $('saved').classList.add('on');
      setTimeout(() => $('saved').classList.remove('on'), 1500);
    }
  );
});

function showDebug() {
  chrome.storage.local.get('lastDebug', ({ lastDebug }) => {
    $('debug').value = lastDebug
      ? `${lastDebug.at}\nlangue: ${lastDebug.language}\nenvoyé: ${lastDebug.sent}\nbrutes: ${lastDebug.rawCount} / gardées: ${lastDebug.keptCount}\nphrases: ${lastDebug.stats ? lastDebug.stats.chunks : '?'} (en cache: ${lastDebug.stats ? lastDebug.stats.cached : '?'}, requêtes: ${lastDebug.stats ? lastDebug.stats.requests : '?'})\n\n${lastDebug.response}`
      : 'Aucune vérification effectuée pour le moment.';
  });
}
showDebug();
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.lastDebug) showDebug(); });
