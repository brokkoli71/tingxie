// tingxie server: serves the static frontend and persists progress as a JSON
// file. Single user, low write volume, last-write-wins — no DB needed.
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

const MAX_BODY = 2 * 1024 * 1024; // progress for a few thousand items, generously

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readProgress() {
  try {
    return JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // first run
    throw e;
  }
}

// Write to a temp file and rename, so a crash mid-write can never leave a
// truncated progress.json behind.
async function writeProgress(obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fs.rename(tmp, PROGRESS_FILE);
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

  if (url.pathname !== '/api/progress') {
    return sendJson(res, 404, { error: 'not found' });
  }

  if (req.method === 'GET') {
    return sendJson(res, 200, await readProgress());
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
    const problem = validateProgress(data);
    if (problem) return sendJson(res, 400, { error: problem });
    await writeProgress(data);
    return sendJson(res, 200, { ok: true, items: Object.keys(data).length });
  }

  return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PUT' });
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
    return send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': entry.type });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('request failed', req.method, url.pathname, e);
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'internal error' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`tingxie listening on :${PORT} (data: ${PROGRESS_FILE}${TOKEN ? ', token auth on' : ''})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
