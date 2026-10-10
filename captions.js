// Pure caption helpers. Loaded as a content script and required by test/captions.test.cjs.

// Converts a YouTube json3 timedtext payload into [{ start, end, text }] in seconds.
function parseJson3(data) {
  const cues = [];
  for (const ev of (data && data.events) || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (ev.dDurationMs || 0) / 1000, text });
  }
  return cues;
}

// "HH:MM:SS.mmm" or "MM:SS.mmm" to seconds.
function toSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 2) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Parses a WebVTT file into [{ start, end, text }] in seconds.
function parseVtt(vtt) {
  const cues = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    const [a, b] = lines[timing].split('-->').map((s) => s.trim().split(' ')[0]);
    const text = lines.slice(timing + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start: toSeconds(a), end: toSeconds(b), text });
  }
  return cues;
}

// TTML clock times: "HH:MM:SS.mmm", "MM:SS.mmm", "HH:MM:SS:FF" (frames), or offsets like
// "1.5s", "1500ms", "10000000t" (ticks), "2m", "1h", "30f" (frames). Returns NaN if unreadable.
function ttmlTime(ts, tickRate, frameRate) {
  const offset = ts.match(/^([\d.]+)(ms|s|m|h|t|f)$/);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case 'ms': return n / 1000;
      case 's': return n;
      case 'm': return n * 60;
      case 'h': return n * 3600;
      case 't': return n / tickRate;
      case 'f': return n / frameRate;
    }
  }
  const frames = ts.match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (frames) {
    return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) + Number(frames[4]) / frameRate;
  }
  return toSeconds(ts);
}

function ttmlAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]+)"`));
  return m && m[1];
}

// Parses a TTML (DFXP) file into [{ start, end, text }] in seconds.
function parseTtml(xml) {
  // TTML defaults: 10000000 ticks per second, 30 frames per second.
  const tickRate = Number((xml.match(/tickRate="(\d+)"/) || [])[1]) || 10000000;
  const frameRate = Number((xml.match(/frameRate="(\d+)"/) || [])[1]) || 30;
  const cues = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const begin = ttmlAttr(m[1], 'begin');
    const end = ttmlAttr(m[1], 'end');
    if (!begin || !end) continue;
    const start = ttmlTime(begin, tickRate, frameRate);
    const stop = ttmlTime(end, tickRate, frameRate);
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
    const text = m[2]
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) cues.push({ start, end: stop, text });
  }
  return cues;
}

// True if the text looks like a WebVTT or TTML subtitle file.
function isSubtitleText(text) {
  const head = text.trimStart().slice(0, 200);
  return head.startsWith('WEBVTT') || (/<tt[\s>]/.test(text) && /<p[\s>]/.test(text));
}

// Parses either format.
function parseSubtitle(text) {
  return text.trimStart().startsWith('WEBVTT') ? parseVtt(text) : parseTtml(text);
}

// Returns the cue active at time t. Linear scan: fine for a few thousand cues.
// ponytail: linear scan per timeupdate, binary search if a video ever has 10k+ cues.
function findCue(cues, t) {
  let hit;
  for (const cue of cues) {
    if (cue.start <= t && t < cue.end) hit = cue;
  }
  return hit;
}

const LRCaptions = { parseJson3, parseVtt, parseTtml, parseSubtitle, isSubtitleText, findCue };
if (typeof module !== 'undefined') module.exports = LRCaptions;
