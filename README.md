# Dual Subtitles

A Chrome extension that shows a second subtitle line on YouTube and Netflix.

- **YouTube** shows the video's own caption track, with a second line in your chosen language from YouTube's built-in translation. Click any word to open it in Wiktionary.
- **Netflix** translates the whole subtitle file with the MiniMax API, then shows each translated line above Netflix's own subtitle. Netflix's original subtitle stays on screen.

The extension is Manifest V3 and has no build step.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**.
3. Select the repository folder.

## Setup

Open the extension popup.

- **Native language.** Pick the language for the second line: English, Japanese, Thai, or Chinese (Simplified).
- **MiniMax API key.** Paste your key. It's saved in this browser only, in `chrome.storage.local`. It is not written to any file in the project, and it is needed only for Netflix.
- **Clear translation cache.** Deletes all saved Netflix translations. Lines are requested from MiniMax again the next time they appear.

Reload the extension after pulling changes, and reload any open YouTube or Netflix tabs.

## How it works

### YouTube

`page-world.js` runs in the page's main world and reads the player's caption tracks. `content.js` downloads the track, and YouTube translates it into your language with its `tlang` parameter. No API key is needed. The line is drawn by `overlay.js` and styled by `overlay.css`.

### Netflix

1. `netflix-world.js` runs in the page's main world, wraps `fetch` and `XMLHttpRequest`, and watches for responses that look like WebVTT or TTML subtitle files. It matches on content, not URL, because Netflix's CDN URLs are opaque.
2. `netflix.js` parses the file into timed cues and sends them to the background worker in batches of 40, eight at a time. A progress line shows on the player while this runs.
3. `background.js` calls the MiniMax API (`MiniMax-M3.1-Flash-Preview`) with a system prompt that asks for a JSON array back. It retries once on a bad reply and splits a batch in half when a reply is empty or unparseable. Each batch is split until a cue the content filter flags is isolated, and only that cue keeps its source text.
4. Translated cues are shown at the playback time, above Language Reactor's subtitle if it is on screen, otherwise above Netflix's own subtitle. The line copies Netflix's font size.
5. An eye button in Netflix's control bar shows or hides the translated line. The choice is saved.

### Translation cache

Each translated cue is cached under its model, language, and text. Replaying a movie, or meeting the same line in another movie, makes no API calls for cues already cached. Only real translations are cached. A cue that failed or was flagged keeps its source text and is requested again next time. The cache keeps up to 20,000 entries and drops the oldest first.

## Project layout

| File | Role |
|---|---|
| `manifest.json` | Extension manifest and content script setup |
| `background.js` | Service worker. The only code that calls MiniMax, and the cache |
| `netflix-world.js` | Main-world hook that captures Netflix subtitle files |
| `netflix.js` | Netflix batching, timing, overlay line, and eye button |
| `page-world.js` | Main-world reader of YouTube caption tracks |
| `content.js` | YouTube timing and overlay |
| `captions.js` | Pure parsers for JSON3, WebVTT, and TTML, and cue lookup |
| `overlay.js`, `overlay.css` | Shared overlay rendering and styles |
| `popup.html`, `popup.js` | Settings popup |
| `test/` | Node tests for the parsers and the background worker |

## Tests

No dependencies are needed.

```sh
node test/captions.test.cjs
node test/background.test.cjs
```

The background test runs the worker with a fake Chrome API and a fake `fetch`, so it makes no network calls and needs no key.

## Limitations

- **Netflix is not verified on every title.** The subtitle capture was tested on one title. Netflix may load subtitles another way for other titles, and the overlay position depends on Netflix's current page layout.
- **YouTube may return empty captions.** YouTube sometimes returns an empty caption file unless a proof-of-origin token is present. If YouTube captions do not appear, that is the likely cause.
- **Words split on spaces.** Japanese and Thai have no spaces, so a whole phrase becomes one clickable word on YouTube.
- **Content filter.** MiniMax may flag some lines. Those lines show their original text.
- **Model thinking.** The MiniMax model cannot turn off its thinking, and that thinking uses part of each reply's token budget. Translation uses low effort to keep batches fast.
- **Storage.** The manifest requests `unlimitedStorage`, so the translation cache can grow past the default browser limit.
- **Key handling.** The API key is stored in the browser profile in plain text. Do not share a browser profile you have set up with a key.

## License

No license has been chosen yet.
