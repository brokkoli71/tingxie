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

Frontend is a single self-contained `index.html` — no build step, no npm
dependencies; everything (data, styling, logic) lives in that one file.
Alongside it, `server.js` serves that file and a small progress API from the
same origin, so progress syncs across devices. `server.js` is Node stdlib only
— still no dependencies anywhere in the project. Deployment (Docker +
Cloudflare Tunnel) is documented in `DEPLOY.md`.

## Tech stack (current)

- Plain HTML/CSS/JS, ES2017-ish, no framework
- Google Fonts via CDN `<link>` (Noto Serif SC, Source Serif 4, JetBrains Mono)
- Web Speech API (`speechSynthesis`) for TTS, with a fallback (see below)
- Storage: abstracted behind a `Storage.get/set` object (see below) — do not
  call `window.storage` or `localStorage` directly elsewhere in the code

## Storage / sync (done)

The prototype used `window.storage`, a Claude.ai **artifact-only** API. That's
gone: `Storage.get/set` in the `<script>` block now talks to the backend, with
`localStorage` demoted to an offline cache (write-through on save, read
fallback when the server is unreachable). Every save PUTs the *whole* progress
object, so a failed sync self-heals on the next one.

Still true: all persistence must go through `Storage.get(key)` /
`Storage.set(key, value)` — do not call `fetch` or `localStorage` for progress
anywhere else.

API (`server.js`, deliberately this small):
```
GET  /api/progress   -> { "<itemId>": {box, next, seen, correct}, ... }
PUT  /api/progress   <- same shape, overwrites (last-write-wins, single user)
GET  /api/health     -> {"ok":true}
```
Backed by a flat JSON file at `$DATA_DIR/progress.json`, written temp-file +
rename. Optional `TINGXIE_TOKEN` env enables an `X-Tingxie-Token` check; unset
it when running behind Cloudflare Access.

## Deployment target: TrueNAS

Goal: host on the TrueNAS box (same host as the existing Nextcloud AIO setup)
so progress is reachable from any device, following the existing pattern:
Docker container(s) + Cloudflare Tunnel + a subdomain of `hannesspitz.de`
(e.g. `tingxie.hannesspitz.de`).

**Decided: one container, not two.** `server.js` serves the static frontend
*and* the API from the same origin — no nginx/caddy, no CORS, one thing to
keep running. `Dockerfile` + `docker-compose.yml` are in the repo; step-by-step
tunnel setup is in `DEPLOY.md`. Port is bound to `127.0.0.1` so the tunnel is
the only ingress. Progress persists via the `./data` bind mount.

If the Edge-TTS relay lands, it goes in this same service as `/api/tts`.

## TTS chain

Playback speed: words play at 1.0, sentences default to 0.85 (`RATE_SENTENCE`)
because a full-speed sentence blurs together before it can be parsed. The
"langsam" toggle (`slowMode`, 0.7) overrides both and persists across cards
until switched off.

**Current order** (best first), see `speak()` in `index.html`:

0. **`/api/tts`** — Edge-TTS neural relay (`tts/tts.py`, service `tts` in
   compose), voice `zh-CN-XiaoxiaoNeural`. Same audio on every device. Clips
   are cached on disk by (text, voice, rate), so the fixed vocab bank is
   synthesised once and thereafter served locally. Slow playback re-synthesises
   at `-30%` server-side rather than resampling, so pitch and tones survive.
   `serverTts` flips off permanently on the first failure, so an unreachable
   relay costs one request per session.

Fallbacks, in order:

1. **Local browser voice** via `speechSynthesis`, if `getVoices()` returns
   anything with `lang` starting `zh`. Phones generally have a good one.
   This deliberately misses espeak-ng on Linux, which reports `cmn` rather
   than `zh`: its formant synthesis renders tones unreliably, which is worse
   than useless in a listening trainer. Don't "fix" the filter to match `cmn`.
2. **Google Translate's unofficial TTS endpoint**, via a plain
   `<audio src="https://translate.google.com/translate_tts?...">` (no key, and
   no CORS problem since it's a media element, not a `fetch`). Undocumented —
   could break or get rate limited without notice. Flagged in the UI when
   active.

The relay is why the app is no longer purely dependency-free: `tts/tts.py`
needs the `edge-tts` package, installed at container start (see compose) so
there is still no build step. `server.js` and `index.html` remain
dependency-free.

## Data model

```js
// ITEMS: static vocab/sentence bank
{ id: 'w01', hanzi: '大家', pinyin: 'dàjiā', meaning: 'alle (Personen)', level: 2, type: 'word' }
// type is 'word' | 'sentence'; level is an approximate HSK 2.0-standard tag, not exam-precise

// EXAMPLES: one usage sentence per word id, same three fields, no id/level/type
{ w01: { hanzi: '大家好,我叫小明。', pinyin: 'Dàjiā hǎo, wǒ jiào Xiǎomíng.', meaning: '…' } }

// progress: spaced-repetition state, keyed "<itemId>:<mode>" — one Leitner
// box per (item, exercise mode), since recognition and production decay
// differently. Item ids never contain ':'.
{ 'w01:listen': { box: 1-5, next: <timestamp ms>, seen: <count>, correct: <count> } }
```

`migrateProgress()` rewrites pre-modes keys (bare `w01`) to `w01:listen` on
load and saves immediately; it's idempotent, so it can stay indefinitely.

## Exercise modes

Three named types (`MODES` in `index.html`), *not* an input×output matrix —
the matrix yields 12 mostly-degenerate combinations and turns the app into a
settings screen. User vocabulary for the axes is pinyin / deutsch / hanzi.

| id | chip | prompt | answer (word) | answer (sentence) |
|----|------|--------|---------------|-------------------|
| `listen` | Hören | audio only | type pinyin | type pinyin |
| `de2hz` | Schreiben | German meaning | draw the hanzi | **not offered** |
| `hz2de` | Lesen | hanzi | German meaning, self-assessed — no input | same |

Two rules in code, `modeApplies()` and `answerFormat()`, and both are
pedagogical rather than technical:

- **Listening is always typed, never drawn.** What a listening card tests is
  whether you heard and parsed it, not whether you can form the strokes. The
  canvas belongs to `de2hz` alone, where producing the character from its
  meaning *is* the skill. Pinyin is entered plain — no tone marks.
- **`de2hz` is not offered for sentences** — writing a whole sentence in hanzi
  from a German prompt is a translation exercise well beyond HSK2/3.

Deck size is therefore 78×3 + 20×2 = **274**, not 294. Anything that walks
(item × mode) must filter through `modeApplies()` — queue building, stats, and
the "keep practising" path all do.

Audio is available in *every* mode by design — in `de2hz` it's a pronunciation
hint, and whether to use it is the learner's call. Sessions **mix** modes
rather than blocking by type; chips in the header toggle modes on/off (stored
per-device in `localStorage`, not in synced progress) and the last enabled mode
cannot be switched off. `NEW_PER_SESSION` (12) caps unseen cards per session —
without it the first session would introduce all ~294.

Leitner intervals (`INTERVAL_MS` in the code): box1 = 10 min, box2 = 1 day,
box3 = 3 days, box4 = 7 days, box5 = 21 days. Grading "Nochmal" resets to
box1 and reinserts the card ~4 cards later in the current session queue.
"Gut" = +1 box, "Einfach" = +2 boxes (capped at 5).

Vocab currently: 98 items (78 words split HSK2/HSK3, 20 sentences), hand
-picked from mandarinbean.com's HSK2/HSK3 (2.0-standard) lists. Extending the
list is just appending objects to the `ITEMS` array — no other code changes
needed.

## Example sentences (`EXAMPLES`)

Every word has one example sentence, keyed by word id in the `EXAMPLES` object
next to `ITEMS`. It is shown on reveal of a word card — in *every* mode — as a
seal-red margin note under the answer, with its own small play button (sentence
rate, honouring "langsam").

Two deliberate constraints:

- **Examples are not cards.** They're context, not drill material; making them
  drillable would double the deck and re-introduce exactly the difficulty
  ceiling that the sentence rewrite removed. Deck size stays 274.
- **The frame around the new word is HSK1.** The point is that the target word
  is the only unknown in the sentence, so the usage reads off immediately.
  When adding vocab, add its example in the same spirit — short, concrete, and
  built from 我/你/他, 是/有/在, 很/不/都, and HSK1 nouns.

Sentence *cards* (`type: 'sentence'`, `level: 1`) were rewritten down to HSK1
too: the old bank drilled 虽然…但是, 越…越, 把 and 一边…一边, which tests grammar
parsing rather than listening. Keep new sentence cards short and HSK1-shaped;
grammar beyond that belongs in a different exercise, not in dictation.

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
- **Signature element:** answers are handwritten on 米字格 cells (`.write-cell`,
  one canvas per character, dashed cross-and-diagonal guides) — squared
  practice paper, not a text field. The level/type tag on each card is a small
  rotated seal-stamp-style badge. Keep these motifs for any new input/tag UI.
  The old ruled-paper `textarea.grid-paper` rule is unused but kept as a
  reference for the ruled-line treatment.

## Conventions

- Code (identifiers, comments): English
- User-facing UI strings: German
- Flat layout, no `/frontend` + `/backend` split: `index.html` and `server.js`
  sit next to each other. Keep it that way unless there's a real reason.
- No dependencies, in either file. Both are stdlib/browser-only, which is why
  there is no build step, no lockfile, and no install in the Dockerfile.

## Security invariants

Only the things that are load-bearing and easy to break by accident:

- **Writes stay `PUT` + `Content-Type: application/json`.** This is the whole
  CSRF defence: neither is reachable from a cross-origin HTML form, and the
  server sends no CORS headers, so the preflight they force fails. Re-adding
  `POST` or dropping the content-type check reopens it — a form with
  `enctype="text/plain"` is a no-preflight "simple request" and the write would
  land. Don't assume Cloudflare Access covers this; `CF_Authorization` is
  typically `SameSite=None`.
- **Static files come from the `STATIC` whitelist, never from `url.pathname`.**
  Building a path from the request is how traversal gets in.
- **`ITEMS` and `EXAMPLES` are trusted because they're hardcoded.** `showAnswer`
  interpolates `hanzi`/`pinyin`/`meaning` from both straight into `innerHTML`
  (the example block included). If vocab ever comes
  from the API or user input, escape at those sites first — that's the one live
  XSS sink in the app.
- Progress data reaching the DOM must stay numeric-only (the `validateProgress`
  check enforces it server-side); it's currently used as array indices, not
  rendered as text.

Cloudflare Access (One-time PIN, single allowed email) fronts the public
hostname — see DEPLOY.md. It does *not* cover the LAN: the container binds all
interfaces so `cloudflared` can reach it, so anyone on the home network can
read and write progress directly. Accepted for now; revisit if the app ever
holds anything beyond dictation progress.

Not addressed, deliberately: no rate limiting (single user behind Access), and
`TINGXIE_TOKEN` lives in `localStorage` when used.

## Open TODOs (roughly priority order)

1. Session shaping: `NEW_PER_SESSION` caps new cards *per session*, not per
   day — reloading grants another 12. A real daily cap needs a persisted
   date+count; the progress API accepts extra fields, so a `__meta` entry
   would pass validation, but it's a hack worth thinking about first.
3. Vocab expansion beyond the initial 98 items

Done: backend sync + `Storage` swap; Docker/compose + tunnel docs
(`tingxie.hannesspitz.de`).

## Local dev

No build step, no dependencies:

```sh
node server.js     # http://localhost:8080, progress in ./data/progress.json
```

Opening `index.html` as a `file://` URL still renders, but every save will fail
(no `/api/progress` origin) and fall back to `localStorage` — use the server.
