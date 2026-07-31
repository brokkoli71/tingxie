# CLAUDE.md

Project context for Claude Code. Read this before making changes.

## What this is

**tingxie** (听写, "dictation") is a browser-based Chinese listening-dictation
trainer. Core loop: play an audio clip of a Hanzi word/sentence → user writes
down what they heard → reveal the answer (Hanzi, Pinyin, German meaning) →
user self-grades (Nochmal / Gut / Einfach) → a Leitner-box spaced-repetition
scheduler decides when the card comes back.

Built for a learner who already has ~HSK2, learns fastest by writing (not by
reading/listening passively), and specifically wants to drill listening
comprehension — hence the dictation-first design instead of a
recognize-and-tap format like Duolingo/standard flashcard apps.

## Current state

Single self-contained `tingxie.html` — no build step, no npm dependencies.
Everything (data, styling, logic) lives in one file. This was fine as a
Claude.ai artifact prototype; see "Open TODOs" for what needs to change to
run well as a self-hosted app.

## Tech stack (current)

- Plain HTML/CSS/JS, ES2017-ish, no framework
- Google Fonts via CDN `<link>` (Noto Serif SC, Source Serif 4, JetBrains Mono)
- Web Speech API (`speechSynthesis`) for TTS, with a fallback (see below)
- Storage: abstracted behind a `Storage.get/set` object (see below) — do not
  call `window.storage` or `localStorage` directly elsewhere in the code

## ⚠️ First thing to fix: storage doesn't sync across devices

The prototype used `window.storage`, which is a Claude.ai **artifact-only**
API — it does not exist outside claude.ai. It's already been patched to fall
back to `localStorage` (see the `Storage` object near the top of the
`<script>` block) so the app doesn't silently break when self-hosted. But
`localStorage` is per-browser/per-device — progress will NOT sync between
phone, the CachyOS machine, and the Omarchy laptop.

**Planned fix:** small backend + REST persistence, deployed alongside the
static frontend on TrueNAS (see Deployment below). The frontend already
isolates all persistence behind `Storage.get(key)` / `Storage.set(key, value)`
— swap the body of those two functions to `fetch()` calls against the new API
instead of `localStorage`, and the rest of the app (Leitner logic, rendering)
needs no changes.

Suggested API shape (keep it this small):
```
GET  /api/progress          -> { "<itemId>": {box, next, seen, correct}, ... }
PUT  /api/progress          -> body: same shape, overwrites (last-write-wins is fine, single user)
```
SQLite or even a flat JSON file behind a tiny FastAPI/Flask/Express app is
plenty — this is single-user, low-write-volume, no need for anything heavier.
No auth needed if it sits behind the same Cloudflare Tunnel access pattern
already used for `cloud.hannesspitz.de`; otherwise add a single shared-secret
header.

## Deployment target: TrueNAS

Goal: host on the TrueNAS box (same host as the existing Nextcloud AIO setup)
so progress is reachable from any device, following the existing pattern:
Docker container(s) + Cloudflare Tunnel + a subdomain of `hannesspitz.de`
(e.g. `tingxie.hannesspitz.de`).

Two containers is the natural split once the backend exists:
1. Static file server (nginx/caddy) for the frontend
2. Small API service for `/api/progress` (and optionally the TTS relay below)

A `docker-compose.yml` + Cloudflare Tunnel config for this doesn't exist yet
— that's an open TODO, not something already decided in detail.

## TTS chain

1. **Preferred:** local browser voice via `speechSynthesis`, if
   `getVoices()` returns anything with `lang` starting `zh`.
2. **Fallback (currently active):** Google Translate's unofficial TTS
   endpoint, played via a plain `<audio src="https://translate.google.com/translate_tts?...">`
   element (no API key, no CORS issue since it's a media element, not a
   `fetch`). This is undocumented/unofficial — could break or get rate
   limited without notice. Flagged clearly in the UI when it's the active
   path.
3. **Considered, not implemented:** Microsoft Edge-TTS neural voices
   (e.g. `zh-CN-XiaoxiaoNeural`) — free, no key, noticeably better prosody
   than both options above. Can't be called directly from arbitrary browser
   JS: Microsoft's endpoint requires a WebSocket header
   (`Sec-WebSocket-Version`) that only the real Edge browser is allowed to
   set, so Chrome/Firefox fail. Workaround is a tiny server-side relay
   (e.g. Python `edge-tts` package, or the `edge-tts-universal` npm package
   in Node) — a good candidate to bundle into the same TrueNAS backend
   container as the progress API, exposed as e.g. `GET /api/tts?text=...`
   returning an mp3.

## Data model

```js
// ITEMS: static vocab/sentence bank
{ id: 'w01', hanzi: '大家', pinyin: 'dàjiā', meaning: 'alle (Personen)', level: 2, type: 'word' }
// type is 'word' | 'sentence'; level is an approximate HSK 2.0-standard tag, not exam-precise

// progress: per-item spaced-repetition state, keyed by item id
{ box: 1-5, next: <timestamp ms, due date>, seen: <count>, correct: <count> }
```

Leitner intervals (`INTERVAL_MS` in the code): box1 = 10 min, box2 = 1 day,
box3 = 3 days, box4 = 7 days, box5 = 21 days. Grading "Nochmal" resets to
box1 and reinserts the card ~4 cards later in the current session queue.
"Gut" = +1 box, "Einfach" = +2 boxes (capped at 5).

Vocab currently: 98 items (78 words split HSK2/HSK3, 20 sentences), hand
-picked from mandarinbean.com's HSK2/HSK3 (2.0-standard) lists. Extending the
list is just appending objects to the `ITEMS` array — no other code changes
needed.

## Design system — preserve this, don't default back to generic styling

Deliberate "Chinese exercise-book" identity, not a generic flashcard-app
look. If extending the UI, stay inside this system rather than introducing
new colors/components ad hoc:

- **Palette:** paper `#f1ede2`, ink `#211f1a`, ink-soft `#57534a`, seal red
  `#b3352a` / `#8c2a21` (primary actions, corner tag), jade green `#3d6a55`
  (mastery/success), grid line `#b9c3cf`, card surface `#fbf9f3`
- **Type:** "Noto Serif SC" for Hanzi display, "Source Serif 4" for German
  body text, "JetBrains Mono" for Pinyin, labels, and stats (all via Google
  Fonts CDN)
- **Signature element:** the dictation `<textarea>` is styled with a
  repeating horizontal-rule background to look like ruled practice paper
  (`.grid-paper`), and the level/type tag on each card is a small
  rotated seal-stamp-style badge. Keep this motif for any new input/tag UI.

## Conventions

- Code (identifiers, comments): English
- User-facing UI strings: German
- Keep it a single static file for as long as reasonable; only split into
  `/frontend` + `/backend` once the sync API actually lands

## Open TODOs (roughly priority order)

1. Backend for cross-device progress sync (see above) + swap `Storage` impl
2. Docker + Cloudflare Tunnel setup for TrueNAS, subdomain decision
3. Optional: Edge-TTS relay endpoint for better audio quality
4. Session shaping: currently introduces *all* due/new items uncapped;
   consider an Anki-style daily new-card limit
5. Vocab expansion beyond the initial 98 items

## Local dev

No build step — just open `tingxie.html` in a browser. Once the backend
exists, document its run command here.
