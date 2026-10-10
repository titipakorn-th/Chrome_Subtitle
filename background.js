// Service worker. The only place that talks to MiniMax, so the API key never reaches page scripts.
// Translates one batch per message, so each request stays short enough for the worker to live.
const ENDPOINT = 'https://api.minimax.cn/anthropic/v1/messages';
const MODEL = 'MiniMax-M3.1-Flash-Preview';
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
// The languages the popup offers. Anything else falls back to English.
const LANG_NAMES = {
  en: 'English', ja: 'Japanese', th: 'Thai', 'zh-Hans': 'Simplified Chinese',
};

function systemPrompt(lang) {
  const name = LANG_NAMES[lang] || LANG_NAMES.en;
  return `You translate movie subtitles into ${name}.
The input is a JSON array of objects {"i": number, "text": string}. Each object is one subtitle cue, in order.
Translate every cue. Return only a JSON array of {"i": number, "text": string} with the same ids, one output per input cue.
Never merge, split, skip, or reorder cues. Keep proper names. Keep the speaker's tone. Write natural spoken ${name} that fits on screen. Replace line breaks with spaces.
Output only the JSON array. No code fences and no commentary.`;
}

// Errors where splitting the batch can help: the reply was empty or not parseable.
// Auth and HTTP errors are not splittable, so they fail fast.
function splittable(message) {
  const err = new Error(message);
  err.splittable = true;
  return err;
}

// MiniMax's content filter flagged a cue. Splitting isolates that cue. Retrying the same text
// cannot help, so the retry is skipped.
function flagged(message) {
  const err = splittable(message);
  err.noRetry = true;
  return err;
}

async function callMiniMax(system, user) {
  // The key comes only from the popup field, entered by the user.
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('No MiniMax API key set. Open the extension popup.');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      // The endpoint reads X-Api-Key. Bearer is sent too, matching the documented curl.
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      // Thinking cannot be disabled on this model and shares this budget with the reply.
      // Low effort keeps thinking short. Batches that still run out are split by translateBatch.
      max_tokens: 8192,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (body.includes('new_sensitive')) throw flagged(`MiniMax flagged content: ${body}`);
    throw new Error(`MiniMax HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  const blocks = data.content || [];
  // Keep text blocks only. Some MiniMax models also inline a <think> block into the text.
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  if (!text) {
    const types = blocks.map((b) => b.type).join(',') || 'none';
    throw splittable(`empty reply (stop_reason=${data.stop_reason}, blocks=${types})`);
  }
  return text;
}

// Parses the model's JSON array. Tolerates prose or code fences around it.
// Returns a map from cue index to translated text.
function parseBatch(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) throw splittable(`no JSON array in reply: ${raw.slice(0, 120)}`);
  let items;
  try {
    items = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw splittable(`bad JSON in reply: ${err.message}`);
  }
  const out = new Map();
  for (const item of items) out.set(Number(item.i), String(item.text));
  return out;
}

// Translates a batch. Retries once. If the reply is still empty or unparseable, splits the batch
// in half and translates each half. Cues that still fail keep their source text, and the
// result marks which cues were really translated (ok) and carries the first error.
async function translateBatch(texts, lang, offset) {
  const payload = texts.map((text, i) => ({ i: offset + i, text }));
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const raw = await callMiniMax(systemPrompt(lang), JSON.stringify(payload));
      const map = parseBatch(raw);
      const ok = texts.map((_, i) => map.has(offset + i));
      return { texts: texts.map((text, i) => map.get(offset + i) ?? text), ok, error: null };
    } catch (err) {
      lastErr = err;
      if (!err.splittable || err.noRetry) break;
      if (attempt + 1 < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  if (lastErr.splittable && texts.length > 1) {
    const half = Math.ceil(texts.length / 2);
    const left = await translateBatch(texts.slice(0, half), lang, offset);
    const right = await translateBatch(texts.slice(half), lang, offset + half);
    return { texts: [...left.texts, ...right.texts], ok: [...left.ok, ...right.ok], error: left.error || right.error };
  }
  return { texts, ok: texts.map(() => false), error: lastErr.message };
}

// Translations kept across sessions, so replays and repeated lines cost no API calls.
// Keys include the model, so switching models does not reuse old translations.
const CACHE_KEY = 'translationCache';
const CACHE_MAX = 20000;
let cachePromise = null;
let cacheGen = 0; // bumped on clear, so a batch in flight does not write its old copy back

async function clearCache() {
  cacheGen++;
  cachePromise = null;
  await chrome.storage.local.remove(CACHE_KEY);
}

function loadCache() {
  if (!cachePromise) {
    cachePromise = chrome.storage.local.get(CACHE_KEY).then((saved) => saved[CACHE_KEY] || {});
  }
  return cachePromise;
}

async function saveCache(store) {
  const keys = Object.keys(store); // insertion order, so the oldest come first
  for (const key of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete store[key];
  await chrome.storage.local.set({ [CACHE_KEY]: store });
}

const cacheKey = (lang, text) => `${MODEL}|${lang}|${text}`;

// Translates a batch, sending to MiniMax only the cues the cache does not have.
// Only real translations are stored. Cues that failed keep their source text uncached.
async function translateCached(texts, lang, offset) {
  const gen = cacheGen;
  const store = await loadCache();
  const out = [...texts];
  const missing = [];
  texts.forEach((text, i) => {
    const hit = store[cacheKey(lang, text)];
    if (hit === undefined) missing.push(i);
    else out[i] = hit;
  });
  if (!missing.length) return { texts: out, error: null };

  const result = await translateBatch(missing.map((i) => texts[i]), lang, offset);
  let added = false;
  missing.forEach((cueIdx, k) => {
    out[cueIdx] = result.texts[k];
    if (result.ok[k]) {
      store[cacheKey(lang, texts[cueIdx])] = result.texts[k];
      added = true;
    }
  });
  if (added && gen === cacheGen) await saveCache(store);
  return { texts: out, error: result.error };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'clearCache') {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type !== 'translateBatch') return false;
  translateCached(msg.texts, msg.lang, msg.offset).then(
    (result) => sendResponse(result),
    (err) => sendResponse({ error: err.message }),
  );
  return true; // keeps the channel open for the async reply
});
