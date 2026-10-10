// Isolated-world content script for Netflix. Translates the whole subtitle track in batches,
// then shows each translated cue just above Netflix's own subtitle, which stays visible.
(() => {
  const BATCH_SIZE = 40;
  const CONCURRENCY = 8;
  const GAP_PX = 8;
  const FALLBACK_FONT_PX = 22;
  const FALLBACK_BOTTOM_PX = 110;

  let source = [];
  let translated = [];
  let lastVtt = '';
  let loadToken = 0;
  let video = null;
  let lastKey = '';
  let line = null;
  let lineText = '';
  let lineVisible = true; // toggled by the eye button, remembered in storage

  // Registered at load time, not after the storage read, so an early subtitle download is not lost.
  window.addEventListener('lr-subtitle-file', (e) => onSubtitleFile(e.detail));

  function onSubtitleFile(vtt) {
    if (vtt === lastVtt) return;
    lastVtt = vtt;
    loadTrack();
  }

  // The single translation line. It lives inside the player, so fullscreen shows it, and Netflix's
  // own subtitle is left alone.
  function getLine() {
    const player = document.querySelector('.watch-video') || document.body;
    if (!line) {
      line = document.createElement('div');
      line.className = 'lr-netflix-line';
    }
    if (line.parentNode !== player) player.appendChild(line);
    return line;
  }

  // The subtitle to sit above: Language Reactor's line when it is on screen, otherwise Netflix's own.
  function anchorEl() {
    const lln = document.querySelector('.lln-subs.lln-sentence-wrap');
    if (lln && lln.getBoundingClientRect().height > 0) return lln;
    const sub = document.querySelector('.player-timedtext-text-container') || document.querySelector('.player-timedtext');
    return sub && sub.getBoundingClientRect().height > 0 ? sub : null;
  }

  // Puts the line just above the anchor subtitle, at its font size.
  // With no subtitle on screen, it sits near the bottom of the player.
  function place() {
    if (!line || !lineText || !line.offsetParent) return;
    // Positions are measured against the line's containing block, so they are correct in any layout.
    const base = line.offsetParent.getBoundingClientRect();
    const sub = anchorEl();
    if (sub) {
      const subRect = sub.getBoundingClientRect();
      // The text's own font size is on the innermost span, not the outer wrappers.
      const spans = sub.querySelectorAll('span');
      const sample = spans.length ? spans[spans.length - 1] : sub;
      line.style.fontSize = getComputedStyle(sample).fontSize;
      line.style.left = `${subRect.left - base.left + subRect.width / 2}px`;
      line.style.bottom = `${base.bottom - subRect.top + GAP_PX}px`;
    } else {
      line.style.fontSize = `${FALLBACK_FONT_PX}px`;
      line.style.left = `${base.width / 2}px`;
      line.style.bottom = `${FALLBACK_BOTTOM_PX}px`;
    }
  }

  // Eye toggle that shows or hides the translated line. Shown only while Netflix's controls are
  // visible, and removed when they hide.
  let panel = null;
  let eyeButton = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EYE_PATH = 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z';

  // Draws the eye icon. A slash through it marks the hidden state.
  function eyeIcon(visible) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const eye = document.createElementNS(SVG_NS, 'path');
    eye.setAttribute('d', EYE_PATH);
    svg.appendChild(eye);
    const pupil = document.createElementNS(SVG_NS, 'circle');
    pupil.setAttribute('cx', '12');
    pupil.setAttribute('cy', '12');
    pupil.setAttribute('r', '3');
    svg.appendChild(pupil);
    if (!visible) {
      const slash = document.createElementNS(SVG_NS, 'line');
      slash.setAttribute('x1', '3');
      slash.setAttribute('y1', '3');
      slash.setAttribute('x2', '21');
      slash.setAttribute('y2', '21');
      svg.appendChild(slash);
    }
    return svg;
  }

  function paintEye() {
    if (!eyeButton) return;
    eyeButton.replaceChildren(eyeIcon(lineVisible));
    const label = lineVisible ? 'Hide translation' : 'Show translation';
    eyeButton.title = label;
    eyeButton.setAttribute('aria-label', label);
    eyeButton.setAttribute('aria-pressed', String(lineVisible));
  }

  function toggleLine() {
    lineVisible = !lineVisible;
    chrome.storage.sync.set({ lineVisible });
    paintEye();
    showLine();
  }

  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'lr-eye';
    // Keep clicks on the panel from reaching Netflix, which would toggle play.
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    eyeButton = document.createElement('button');
    eyeButton.type = 'button';
    eyeButton.addEventListener('click', toggleLine);
    el.appendChild(eyeButton);
    paintEye();
    return el;
  }

  // Netflix's control bar carries this class; it is `inactive` while the bar is hidden.
  function syncPanel() {
    const bar = document.querySelector('[class*="default-ltr-iqcdef-cache-fntwn3"]');
    const visible = bar && !bar.classList.contains('inactive');
    if (!visible) {
      if (panel) panel.remove();
      return;
    }
    // Sit beside Language Reactor's controls when present, otherwise in the bottom control bar.
    const lln = document.querySelector('#lln-extension-controls');
    const host = lln ? lln.parentElement : document.querySelector('.watch-video--bottom-controls-container');
    if (!host) return;
    if (!panel) panel = buildPanel();
    if (panel.parentNode !== host) host.insertBefore(panel, host.firstChild);
  }

  function setLine(text) {
    lineText = text || '';
    getLine().textContent = lineText;
    showLine();
  }

  // Shows the line only when there is text and the eye toggle is on.
  function showLine() {
    if (!line) return;
    line.style.display = lineText && lineVisible ? 'block' : 'none';
    place();
  }

  // Shows progress in the same line, near the bottom of the player.
  function showProgress(done, total) {
    setLine(`Translating subtitles… ${done}/${total}`);
  }

  // Sends one short message per batch, a few at a time. Keeps order and logs progress.
  // A batch that fails keeps its source text, and the rest still translate.
  async function translateAll(texts, lang, token) {
    const starts = [];
    for (let s = 0; s < texts.length; s += BATCH_SIZE) starts.push(s);
    const out = new Array(texts.length);
    let next = 0;
    let done = 0;
    let failed = 0;
    let firstError = null;

    async function worker() {
      while (next < starts.length && token === loadToken) {
        const start = starts[next++];
        const slice = texts.slice(start, start + BATCH_SIZE);
        let reply;
        try {
          reply = await chrome.runtime.sendMessage({ type: 'translateBatch', texts: slice, lang, offset: start });
        } catch (err) {
          reply = { error: err.message };
        }
        // A reply can hold partial results with an error. Keep the translated parts.
        const got = reply.texts || slice;
        got.forEach((t, i) => { out[start + i] = t; });
        if (reply.error) {
          failed++;
          firstError = firstError || reply.error;
        }
        done++;
        console.info(`[dual-subs] batch ${done}/${starts.length} done${reply.error ? ' (failed)' : ''}`);
        if (token === loadToken) showProgress(done, starts.length);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker));
    return { texts: out, failed, batches: starts.length, firstError };
  }

  async function loadTrack() {
    const token = ++loadToken;
    source = LRCaptions.parseSubtitle(lastVtt);
    translated = [];
    lastKey = '';
    setLine('');
    if (!source.length) {
      console.warn('[dual-subs] subtitle file had no cues');
      return;
    }

    const { nativeLang } = await chrome.storage.sync.get({ nativeLang: 'en' });
    console.info(`[dual-subs] translating ${source.length} cues to ${nativeLang} in batches of ${BATCH_SIZE}`);
    const startedAt = Date.now();
    showProgress(0, Math.ceil(source.length / BATCH_SIZE));
    const result = await translateAll(source.map((c) => c.text), nativeLang, token);
    if (token !== loadToken) return;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (result.failed === result.batches) {
      console.warn(`[dual-subs] translation failed (${elapsed}s): ${result.firstError}`);
      setLine('');
      return;
    }
    if (result.failed) {
      console.warn(`[dual-subs] ${result.failed}/${result.batches} batches failed and show source text: ${result.firstError}`);
    }
    console.info(`[dual-subs] translation ready in ${elapsed}s`);
    translated = source.map((c, i) => ({ start: c.start, end: c.end, text: result.texts[i] }));
    refresh();
  }

  // Redraws the line for the current time now. Used after translation, when a paused video
  // sends no timeupdate events and the cue key may not have changed.
  function refresh() {
    const t = video ? video.currentTime : 0;
    const tCue = LRCaptions.findCue(translated, t);
    lastKey = `${tCue?.start}`;
    console.info(
      `[dual-subs] refresh: video ${video ? 'bound' : 'NOT bound'}, time ${t.toFixed(1)}s, ` +
      `cues ${translated.length} from ${translated[0]?.start?.toFixed(1)}s to ${translated.at(-1)?.end?.toFixed(1)}s, ` +
      `shown: ${tCue ? 'translated' : 'none'}`,
    );
    setLine(tCue?.text);
  }

  function update() {
    if (!video) return;
    const tCue = LRCaptions.findCue(translated, video.currentTime);
    const key = `${tCue?.start}`;
    if (key === lastKey) return;
    lastKey = key;
    setLine(tCue?.text);
  }

  function bindVideo() {
    const current = document.querySelector('video');
    if (!current || current === video) return;
    video = current;
    console.info('[dual-subs] video element bound');
    video.addEventListener('timeupdate', update);
    video.addEventListener('seeked', update);
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.nativeLang) loadTrack();
  });
  chrome.storage.sync.get({ lineVisible: true }).then((s) => {
    lineVisible = s.lineVisible;
    showLine();
  });
  // Netflix moves its own subtitle as the layout changes, so keep the line tracking it.
  setInterval(place, 200);
  setInterval(syncPanel, 300);
  setInterval(bindVideo, 1000);
  bindVideo();
  console.info('[dual-subs] Netflix script running');
})();
