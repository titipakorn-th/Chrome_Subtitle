// Shared subtitle overlay. Loaded before each site script.
const LROverlay = (() => {
  let el = null;

  // Each word links to Wiktionary in the given language. Without a language, text is plain.
  // ponytail: whitespace tokens, so unspaced languages like Japanese get one long link.
  function appendWords(text, lang, parent) {
    for (const word of text.split(' ')) {
      const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const node = document.createElement(lang && clean ? 'a' : 'span');
      node.textContent = word + ' ';
      if (lang && clean) {
        node.href = `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(clean)}`;
        node.target = '_blank';
        node.rel = 'noopener';
      }
      parent.appendChild(node);
    }
  }

  // Replaces the overlay contents. Empty primary and secondary clears it.
  function show(container, { primary, secondary, lang }) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'lr-overlay';
    }
    if (el.parentNode !== container) container.appendChild(el);
    el.replaceChildren();
    if (primary) {
      const line = document.createElement('div');
      line.className = 'lr-primary';
      appendWords(primary, lang, line);
      el.appendChild(line);
    }
    if (secondary) {
      const line = document.createElement('div');
      line.className = 'lr-secondary';
      line.textContent = secondary;
      el.appendChild(line);
    }
  }

  function clear() {
    if (el) el.replaceChildren();
  }

  return { show, clear };
})();
