// Isolated-world content script for YouTube watch pages. Uses overlay.js.
(() => {
  let nativeLang = 'en';
  let target = [];
  let native = [];
  let targetLang = '';
  let loadToken = 0;
  let video = null;
  let lastKey = '';

  // Asks the main-world script for the current video's caption tracks.
  // Retries until the player has switched to the video in the URL.
  async function fetchTracks() {
    const want = new URL(location.href).searchParams.get('v');
    for (let i = 0; i < 20; i++) {
      const payload = await new Promise((resolve) => {
        const onTracks = (e) => {
          window.removeEventListener('lr-tracks', onTracks);
          resolve(JSON.parse(e.detail));
        };
        window.addEventListener('lr-tracks', onTracks);
        window.dispatchEvent(new CustomEvent('lr-request-tracks'));
        setTimeout(() => {
          window.removeEventListener('lr-tracks', onTracks);
          resolve({ videoId: '', tracks: [] });
        }, 500);
      });
      if (payload.videoId === want && payload.tracks.length) return payload.tracks;
      await new Promise((r) => setTimeout(r, 300));
    }
    return [];
  }

  // Prefer a human-made track in another language, then any track.
  function pickTrack(tracks) {
    const sorted = [...tracks].sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr'));
    return sorted.find((t) => t.languageCode !== nativeLang) || sorted[0];
  }

  async function fetchCues(url) {
    const res = await fetch(url + '&fmt=json3');
    return LRCaptions.parseJson3(await res.json());
  }

  async function load() {
    const token = ++loadToken;
    target = [];
    native = [];
    render();
    if (location.pathname !== '/watch') return;

    const tracks = await fetchTracks();
    const pick = pickTrack(tracks);
    if (!pick || token !== loadToken) return;

    const nextTarget = await fetchCues(pick.baseUrl);
    // YouTube translates a track into any language via tlang.
    const nextNative = pick.languageCode === nativeLang
      ? []
      : await fetchCues(pick.baseUrl + '&tlang=' + nativeLang);
    if (token !== loadToken) return;

    target = nextTarget;
    native = nextNative;
    targetLang = pick.languageCode.split('-')[0];
    lastKey = '';
    update();
  }

  function render(tCue, nCue) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    player.classList.toggle('lr-active', target.length > 0);
    LROverlay.show(player, {
      primary: tCue?.text,
      secondary: nCue?.text,
      lang: targetLang,
    });
  }

  function update() {
    if (!video) return;
    const t = video.currentTime;
    const tCue = LRCaptions.findCue(target, t);
    const nCue = LRCaptions.findCue(native, t);
    const key = `${tCue?.start}|${nCue?.start}`;
    if (key === lastKey) return;
    lastKey = key;
    render(tCue, nCue);
  }

  function bindVideo() {
    const current = document.querySelector('video');
    if (!current || current === video) return;
    video = current;
    video.addEventListener('timeupdate', update);
    video.addEventListener('seeked', update);
  }

  async function init() {
    const stored = await chrome.storage.sync.get({ nativeLang: 'en' });
    nativeLang = stored.nativeLang;
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.nativeLang) {
        nativeLang = changes.nativeLang.newValue;
        load();
      }
    });
    document.addEventListener('yt-navigate-finish', () => {
      bindVideo();
      load();
    });
    bindVideo();
    load();
  }

  init();
})();
