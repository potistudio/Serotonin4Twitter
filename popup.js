const DEFAULTS = { enabled: true, animation: 'slide-x', focus: false };

const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = !!s.enabled;
  $('animation').value = s.animation;
  $('focus').checked = !!s.focus;
});

$('enabled').addEventListener('change', (e) => chrome.storage.sync.set({ enabled: e.target.checked }));
$('animation').addEventListener('change', (e) => chrome.storage.sync.set({ animation: e.target.value }));
$('focus').addEventListener('change', (e) => chrome.storage.sync.set({ focus: e.target.checked }));

// ページ側（Alt+S とか）で切り替えられたときも追従する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if ('enabled' in changes) $('enabled').checked = !!changes.enabled.newValue;
  if ('animation' in changes) $('animation').value = changes.animation.newValue;
  if ('focus' in changes) $('focus').checked = !!changes.focus.newValue;
});
