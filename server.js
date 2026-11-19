// tingxie server: serves the static frontend and persists progress as JSON
// files, one per user. Low write volume, last-write-wins — no DB needed.
// Dependency-free on purpose (Node stdlib only), so the image needs no install
// step and there is no lockfile to keep patched.

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
// Optional shared secret. If set, every /api request must send it as
// X-Tingxie-Token. Leave unset when the app sits behind Cloudflare Access.
const TOKEN = process.env.TINGXIE_TOKEN || '';
// Users are told apart by the email Cloudflare Access puts on every request it
// lets through. The owner keeps the original progress.json (so nothing needs
// migrating); everyone else gets users/<sha256(email)>.json. Requests without
// the header — local dev, or the LAN path that bypasses Access — fall back to
// progress.json too.
const OWNER = (process.env.TINGXIE_OWNER || '').trim().toLowerCase();
const USERS_DIR = path.join(DATA_DIR, 'users');
const EMAIL_HEADER = 'cf-access-authenticated-user-email';
// Base URL of the edge-tts relay (see tts/tts.py). Unset = feature off, and
// the frontend falls back to a local voice or Google Translate.
const TTS_URL = process.env.TTS_URL || '';

const MAX_BODY = 2 * 1024 * 1024; // progress for a few thousand items, generously

// Explicit whitelist: paths are never built from the request, so there is no
// traversal surface. Add a line here when adding a served file.
const HTML = 'text/html; charset=utf-8';
const PNG = 'image/png';
const YEAR = 'public, max-age=31536000';
const STATIC = {
  '/': { file: 'index.html', type: HTML },
  '/index.html': { file: 'index.html', type: HTML },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', type: PNG, cache: YEAR },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', type: PNG, cache: YEAR },
  '/icons/icon-maskable-512.png': { file: 'icons/icon-maskable-512.png', type: PNG, cache: YEAR },
  '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: PNG, cache: YEAR },
  '/icons/favicon-32.png': { file: 'icons/favicon-32.png', type: PNG, cache: YEAR },
  '/favicon.ico': { file: 'icons/favicon-32.png', type: PNG, cache: YEAR },
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

// Per-user data files. The owner (and requests without the Access header)
// keep the original names in DATA_DIR; everyone else gets
// users/<sha256(email)><suffix>. The file name is a hex digest, never the
// header itself, so a crafted header cannot steer the path anywhere.
const KINDS = {
  progress: { owner: PROGRESS_FILE, suffix: '.json' },
  vocab: { owner: path.join(DATA_DIR, 'vocab.json'), suffix: '.vocab.json' },
};
function userFileFor(req, kind) {
  const k = KINDS[kind];
  const email = String(req.headers[EMAIL_HEADER] || '').trim().toLowerCase();
  if (!email || email === OWNER) return k.owner;
  const id = crypto.createHash('sha256').update(email).digest('hex');
  return path.join(USERS_DIR, `${id}${k.suffix}`);
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // first run
    throw e;
  }
}

// Write to a temp file and rename, so a crash mid-write can never leave a
// truncated file behind. Writes to one file are chained: two PUTs in flight
// at once (quick taps) used to share a temp name, and the second rename then
// failed with ENOENT. Chaining also keeps them landing in arrival order.
const writeChains = new Map();
function writeJsonFile(file, obj) {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fs.rename(tmp, file);
  };
  const next = (writeChains.get(file) || Promise.resolve()).then(run, run);
  writeChains.set(file, next);
  next.finally(() => { if (writeChains.get(file) === next) writeChains.delete(file); }).catch(() => {});
  return next;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Accepts only the documented shape: { "<itemId>": {box, next, seen, correct} }.
// Keeps a malformed client from writing garbage that breaks the next load.
function validateProgress(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return 'expected a JSON object keyed by item id';
  }
  for (const [id, entry] of Object.entries(data)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return `entry "${id}" is not an object`;
    }
    for (const field of ['box', 'next', 'seen', 'correct']) {
      const v = entry[field];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
        return `entry "${id}" has a non-numeric "${field}"`;
      }
    }
  }
  return null;
}

// User word lists. Unlike the bank in index.html these are user input and do
// reach the DOM, so the frontend escapes them; this check only keeps the
// shape and sizes sane. Anything not listed here is rejected, not ignored.
const VOCAB_ID = /^[a-z0-9]{1,24}$/;
const VOCAB_SOURCES = /^(hsk[123]|sent|l[a-z0-9]{1,23})$/;
const VOCAB_LIMITS = { lists: 200, itemsPerList: 500, words: 5000, sources: 210 };
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function strOk(v, max, allowEmpty = false) {
  return typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0);
}
function onlyKeys(obj, keys) { return Object.keys(obj).every((k) => keys.includes(k)); }
function validateVocab(data) {
  if (!isObj(data) || !onlyKeys(data, ['sources', 'lists', 'words'])) {
    return 'expected {sources, lists, words}';
  }
  const { sources = [], lists = [], words = {} } = data;
  if (!Array.isArray(sources) || sources.length > VOCAB_LIMITS.sources
      || !sources.every((x) => typeof x === 'string' && VOCAB_SOURCES.test(x))) {
    return 'bad sources';
  }
  if (!Array.isArray(lists) || lists.length > VOCAB_LIMITS.lists) return 'bad lists';
  for (const l of lists) {
    if (!isObj(l) || !onlyKeys(l, ['id', 'name', 'created', 'items'])) return 'bad list entry';
    if (typeof l.id !== 'string' || !VOCAB_ID.test(l.id)) return 'bad list id';
    if (!strOk(l.name, 40)) return 'bad list name';
    if (typeof l.created !== 'number' || !Number.isFinite(l.created)) return 'bad list created';
    if (!Array.isArray(l.items) || l.items.length > VOCAB_LIMITS.itemsPerList
        || !l.items.every((x) => typeof x === 'string' && VOCAB_ID.test(x))) {
      return 'bad list items';
    }
  }
  if (!isObj(words) || Object.keys(words).length > VOCAB_LIMITS.words) return 'bad words';
  for (const [id, w] of Object.entries(words)) {
    if (!VOCAB_ID.test(id)) return 'bad word id';
    if (!isObj(w) || !onlyKeys(w, ['hanzi', 'pinyin', 'meaning'])) return `bad word "${id}"`;
    if (!strOk(w.hanzi, 30) || !strOk(w.pinyin, 80, true) || !strOk(w.meaning, 120, true)) {
      return `bad word "${id}" fields`;
    }
  }
  return null;
}

// Constant-time compare, so a wrong token leaks nothing through response timing.
function tokenOk(supplied) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleApi(req, res, url) {
  if (TOKEN && !tokenOk(req.headers['x-tingxie-token'])) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/tts') {
    return proxyTts(req, res, url);
  }

  const kind = url.pathname === '/api/progress' ? 'progress'
    : url.pathname === '/api/vocab' ? 'vocab' : null;
  if (!kind) return sendJson(res, 404, { error: 'not found' });
  const file = userFileFor(req, kind);

  if (req.method === 'GET') {
    return sendJson(res, 200, await readJsonFile(file));
  }

  // PUT only, and only with a JSON content type. Both are deliberate CSRF
  // defences: an HTML form can issue cross-origin POSTs with text/plain
  // bodies without a preflight, but it can send neither PUT nor
  // application/json — those force a preflight that fails, since this server
  // sends no CORS headers.
  if (req.method === 'PUT') {
    const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') {
      return sendJson(res, 415, { error: 'expected Content-Type: application/json' });
    }
    const raw = await readBody(req);
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const problem = kind === 'progress' ? validateProgress(data) : validateVocab(data);
    if (problem) return sendJson(res, 400, { error: problem });
    await writeJsonFile(file, data);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PUT' });
}

// Proxies /api/tts to the edge-tts relay so the browser stays same-origin.
// TTS_URL is fixed by config and only the query is forwarded, so there is no
// attacker-controlled destination here. If TTS_URL is unset or the relay is
// down we fail fast and the frontend falls back to its other voices.
function proxyTts(req, res, url) {
  if (!TTS_URL) return sendJson(res, 503, { error: 'tts not configured' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  const text = url.searchParams.get('text') || '';
  const rate = url.searchParams.get('rate') || '+0%';
  if (!text) return sendJson(res, 400, { error: 'missing text' });

  const target = new URL('/tts', TTS_URL);
  target.searchParams.set('text', text);
  target.searchParams.set('rate', rate);

  const upstream = http.request(target, { method: 'GET', timeout: 20000 }, (up) => {
    res.writeHead(up.statusCode, {
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
      // Clips never change for a given text+rate, so let the browser keep them.
      'Cache-Control': up.statusCode === 200 ? 'public, max-age=31536000' : 'no-store',
    });
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('tts timeout')));
  upstream.on('error', (e) => {
    console.error('tts proxy failed', e.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'tts unavailable' });
    else res.end();
  });
  upstream.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    const entry = STATIC[url.pathname];
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const body = await fs.readFile(path.join(__dirname, entry.file));
    return send(res, 200, req.method === 'HEAD' ? '' : body, {
      'Content-Type': entry.type,
      ...(entry.cache ? { 'Cache-Control': entry.cache } : {}),
    });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('request failed', req.method, url.pathname, e);
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'internal error' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`tingxie listening on :${PORT} (data: ${PROGRESS_FILE}${TOKEN ? ', token auth on' : ''}${OWNER ? ', owner set' : ', TINGXIE_OWNER unset: owner progress.json only reachable without Access'})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
