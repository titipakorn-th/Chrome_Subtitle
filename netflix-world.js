// Main-world script. Watches the page's fetch and XHR responses for subtitle files, matching on
// content rather than URL because Netflix's CDN URLs are opaque IDs.
(() => {
  // Subtitle files are small. Media segments are large, so skip them without reading.
  const MAX_BYTES = 2 * 1024 * 1024;
  const MEDIA_TYPE = /video|audio|image/;

  function emit(text) {
    if (!text || !isSubtitleText(text)) return;
    console.info(`[dual-subs] subtitle file captured (${text.length} chars)`);
    window.dispatchEvent(new CustomEvent('lr-subtitle-file', { detail: text }));
  }

  // The main world has no captions.js, so the detection is repeated here on purpose.
  function isSubtitleText(text) {
    const head = text.trimStart().slice(0, 200);
    return head.startsWith('WEBVTT') || (/<tt[\s>]/.test(text) && /<p[\s>]/.test(text));
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    const type = res.headers.get('content-type') || '';
    const length = Number(res.headers.get('content-length') || 0);
    if (!MEDIA_TYPE.test(type) && !(length > MAX_BYTES)) {
      res.clone().text().then(emit, () => {});
    }
    return res;
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      const type = this.getResponseHeader('content-type') || '';
      const length = Number(this.getResponseHeader('content-length') || 0);
      if (MEDIA_TYPE.test(type) || length > MAX_BYTES) return;
      // responseText throws for binary response types, so only read it for text responses.
      if (this.responseType !== '' && this.responseType !== 'text') return;
      emit(this.responseText);
    });
    return origSend.apply(this, arguments);
  };
})();
