// Runs background.js with a fake chrome API and fake fetch. No network, no real key.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calls = [];
let listener;
// Storage stands in for chrome.storage.local.
const store = { apiKey: 'test-key' };
// A batch whose first cue id is 40 always returns an empty reply, to exercise retry and failure.
const EMPTY_BATCH_START = 40;

const sandbox = {
  console,
  setTimeout,
  chrome: {
    storage: {
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : Object.keys(keys);
          return Object.fromEntries(list.map((k) => [k, store[k]]));
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (key) => { delete store[key]; },
      },
    },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
  },
  fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, body });
    const input = JSON.parse(body.messages[0].content);
    // Any batch containing a flagged cue fails with MiniMax's content-filter error.
    if (input.some((c) => c.text.includes('FLAGGED'))) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => '{"error":{"message":"input new_sensitive (1026)"}}' };
    }
    if (input[0].i === EMPTY_BATCH_START) {
      return { ok: true, json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: 'x' }] }), text: async () => '' };
    }
    const out = input.map((c) => ({ i: c.i, text: `ZH:${c.text}` }));
    // Wrap in prose and a code fence, as models sometimes do.
    const text = 'Here you go:\n```json\n' + JSON.stringify(out) + '\n```';
    return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }), text: async () => '' };
  },
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), sandbox);

function send(msg) {
  return new Promise((resolve) => {
    const keepOpen = listener(msg, {}, resolve);
    assert.strictEqual(keepOpen, true, 'translateBatch must keep the channel open');
  });
}

// Cues that a call sent to MiniMax, flattened across calls.
const sentTexts = (from) => calls.slice(from).flatMap((c) => JSON.parse(c.body.messages[0].content).map((x) => x.text));

(async () => {
  const texts = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const first = calls.length;
  const reply = await send({ type: 'translateBatch', texts, lang: 'zh-Hans', offset: 0 });
  assert.ok(!reply.error, 'no error on success');
  assert.strictEqual(reply.texts.length, 40, 'one output per input, in order');
  assert.strictEqual(reply.texts[0], 'ZH:line 0');
  assert.strictEqual(reply.texts[39], 'ZH:line 39');

  const req = calls[first].body;
  assert.strictEqual(req.model, 'MiniMax-M3.1-Flash-Preview');
  assert.match(req.system, /Simplified Chinese/);
  assert.match(req.system, /Never merge, split, skip, or reorder/);
  assert.strictEqual(req.output_config.effort, 'low');
  assert.strictEqual(calls[first].opts.headers['x-api-key'], 'test-key');
  assert.strictEqual(JSON.parse(req.messages[0].content)[0].i, 0, 'ids follow the offset');

  // Cached cues are not sent again. Replaying the same batch costs no calls.
  const replayStart = calls.length;
  const replay = await send({ type: 'translateBatch', texts, lang: 'zh-Hans', offset: 0 });
  assert.strictEqual(calls.length, replayStart, 'replay makes no API calls');
  assert.deepStrictEqual([...replay.texts], [...reply.texts]);

  // A mixed batch sends only the cue that is not cached.
  const mixedStart = calls.length;
  const mixed = await send({ type: 'translateBatch', texts: ['line 1', 'brand new cue'], lang: 'zh-Hans', offset: 0 });
  assert.deepStrictEqual(sentTexts(mixedStart), ['brand new cue']);
  assert.deepStrictEqual([...mixed.texts], ['ZH:line 1', 'ZH:brand new cue']);

  // The cache is kept in storage under the model, language, and text.
  assert.ok(store.translationCache['MiniMax-M3.1-Flash-Preview|zh-Hans|line 0'] === 'ZH:line 0', 'translation stored');

  // Another language does not reuse these translations.
  const otherLangStart = calls.length;
  await send({ type: 'translateBatch', texts: ['line 0'], lang: 'ja', offset: 0 });
  assert.deepStrictEqual(sentTexts(otherLangStart), ['line 0'], 'different language is a cache miss');

  // A failed or flagged cue keeps its source text and is not cached.
  const flaggedRun = await send({ type: 'translateBatch', texts: ['ok one', 'FLAGGED line', 'ok two'], lang: 'ja', offset: 0 });
  assert.deepStrictEqual([...flaggedRun.texts], ['ZH:ok one', 'FLAGGED line', 'ZH:ok two']);
  assert.match(flaggedRun.error, /new_sensitive/);
  assert.ok(!('MiniMax-M3.1-Flash-Preview|ja|FLAGGED line' in store.translationCache), 'flagged cue is not cached');
  assert.ok(store.translationCache['MiniMax-M3.1-Flash-Preview|ja|ok one'] === 'ZH:ok one', 'translated neighbours are cached');
  const flaggedCalls = calls.filter((c) => JSON.parse(c.body.messages[0].content).some((x) => x.text.includes('FLAGGED')));
  assert.strictEqual(flaggedCalls.length, 3, 'batch, its left half, and the flagged cue alone; no retries');

  // A failing batch splits, so only the cue that fails keeps its source text.
  const failing = await send({ type: 'translateBatch', texts: ['a', 'b'], lang: 'ja', offset: EMPTY_BATCH_START });
  assert.match(failing.error, /empty reply \(stop_reason=max_tokens, blocks=thinking\)/);
  assert.deepStrictEqual([...failing.texts], ['a', 'ZH:b'], 'failed half keeps source, other half translates');
  const cue40Calls = calls.filter((c) => JSON.parse(c.body.messages[0].content)[0].i === EMPTY_BATCH_START).length;
  assert.strictEqual(cue40Calls, 4, 'batch and its single-cue half each retried once');

  // Clearing removes the stored cache, so the same line is requested from MiniMax again.
  const cleared = await new Promise((resolve) => listener({ type: 'clearCache' }, {}, resolve));
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(store.translationCache, undefined, 'stored cache removed');
  const afterClear = calls.length;
  await send({ type: 'translateBatch', texts: ['line 0'], lang: 'zh-Hans', offset: 0 });
  assert.deepStrictEqual(sentTexts(afterClear), ['line 0'], 'cleared cue is requested again');

  store.apiKey = '';
  const noKey = await send({ type: 'translateBatch', texts: ['no key yet'], lang: 'ja', offset: 0 });
  assert.match(noKey.error, /No MiniMax API key/);

  assert.strictEqual(listener({ type: 'something-else' }, {}, () => {}), false);

  console.log('background tests passed');
})();
