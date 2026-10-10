const select = document.getElementById('nativeLang');
const apiKey = document.getElementById('apiKey');

chrome.storage.sync.get({ nativeLang: 'en' }).then((s) => {
  // A language saved before the list shrank falls back to English.
  const supported = [...select.options].map((o) => o.value);
  select.value = supported.includes(s.nativeLang) ? s.nativeLang : 'en';
});
chrome.storage.local.get({ apiKey: '' }).then((s) => {
  apiKey.value = s.apiKey;
});

select.addEventListener('change', () => {
  chrome.storage.sync.set({ nativeLang: select.value });
});
apiKey.addEventListener('change', () => {
  chrome.storage.local.set({ apiKey: apiKey.value.trim() });
});

const clearBtn = document.getElementById('clearCache');
const cacheStatus = document.getElementById('cacheStatus');
clearBtn.addEventListener('click', async () => {
  if (!confirm('Delete all saved translations? Lines will be requested from MiniMax again.')) return;
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  cacheStatus.textContent = 'Translation cache cleared.';
});
