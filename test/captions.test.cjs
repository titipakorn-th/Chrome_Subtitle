const assert = require('node:assert');
const { parseJson3, parseVtt, parseTtml, parseSubtitle, isSubtitleText, findCue } = require('../captions.js');

const cues = parseJson3({
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
    { tStartMs: 2000, dDurationMs: 1000 },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
    { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: '  spaced\n  out ' }] },
  ],
});

assert.deepStrictEqual(cues, [
  { start: 0, end: 2, text: 'Hello world' },
  { start: 4, end: 5.5, text: 'spaced out' },
]);

assert.strictEqual(findCue(cues, 1).text, 'Hello world');
assert.strictEqual(findCue(cues, 2), undefined, 'gap between cues is empty');
assert.strictEqual(findCue(cues, 5.5), undefined, 'end is exclusive');
assert.strictEqual(findCue(cues, 4.2).text, 'spaced out');

const vtt = parseVtt([
  'WEBVTT',
  '',
  '1',
  '00:00:01.000 --> 00:00:02.500 align:start',
  '<i>Where are you?</i>',
  '',
  '00:01:02.250 --> 00:01:03.000',
  'Line one',
  'line two',
  '',
  '00:02:00.000 --> 00:02:01.000',
  '',
].join('\r\n'));

assert.deepStrictEqual(vtt, [
  { start: 1, end: 2.5, text: 'Where are you?' },
  { start: 62.25, end: 63, text: 'Line one line two' },
]);

const ttml = parseTtml(
  '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
  '<p begin="00:00:01.000" end="00:00:02.000">Tom &amp; Jerry<br/>say &lt;hi&gt;</p>' +
  '<p begin="3.5s" end="4000ms">Short</p>' +
  '<p begin="5s" end="6s"></p>' +
  '</div></body></tt>'
);
assert.deepStrictEqual(ttml, [
  { start: 1, end: 2, text: 'Tom & Jerry say <hi>' },
  { start: 3.5, end: 4, text: 'Short' },
]);

const ticks = parseTtml(
  '<tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000" ttp:frameRate="25">' +
  '<body><div>' +
  '<p begin="10000000t" end="20000000t">Ticks</p>' +
  '<p begin="00:00:01:15" end="00:00:02:00">Frames</p>' +
  '<p begin="bogus" end="00:00:03.000">Dropped</p>' +
  '</div></body></tt>'
);
assert.deepStrictEqual(ticks.map((c) => [c.start, c.end, c.text]), [
  [1, 2, 'Ticks'],
  [1.6, 2, 'Frames'], // frame 15 at 25 fps is 0.6s after the second
]);
assert.ok(ticks.every((c) => Number.isFinite(c.start) && Number.isFinite(c.end)), 'no NaN times');

assert.strictEqual(isSubtitleText('WEBVTT\n\n1'), true);
assert.strictEqual(isSubtitleText('<tt><body><p>x</p></body></tt>'), true);
assert.strictEqual(isSubtitleText('{"json": true}'), false);
assert.strictEqual(parseSubtitle('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi').length, 1);

console.log('captions tests passed');
