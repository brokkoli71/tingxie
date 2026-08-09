"""Edge-TTS relay: GET /tts?text=...&rate=... -> audio/mpeg.

Microsoft's neural voices can't be reached from browser JS (their endpoint
needs a WebSocket header only Edge is allowed to set), so this sits server-side
and does it for us. Fronted by server.js, which proxies /api/tts here.

Responses are cached on disk keyed by (text, voice, rate). The vocab bank is
fixed and small, so after one pass through the deck every clip is a local file
read — instant, and unaffected by Microsoft rate-limiting or going down.
"""

import asyncio
import hashlib
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import edge_tts

PORT = int(os.environ.get("PORT", "5002"))
CACHE_DIR = os.environ.get("CACHE_DIR", "/cache")
VOICE = os.environ.get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")

MAX_TEXT = 200  # vocab items and sentences are far shorter than this
# Only rates edge-tts accepts, e.g. "-30%" / "+0%". Anything else is rejected
# rather than passed through, so nothing user-supplied reaches the SSML.
RATE_RE = re.compile(r"^[+-]\d{1,3}%$")


def cache_path(text, rate):
    key = hashlib.sha256(f"{VOICE}|{rate}|{text}".encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, key + ".mp3")


async def synth(text, rate):
    comm = edge_tts.Communicate(text, VOICE, rate=rate)
    audio = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    if not audio:
        raise RuntimeError("no audio returned")
    return bytes(audio)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter default logging
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, body, ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)

        if url.path == "/health":
            return self._send(200, b'{"ok":true}', "application/json")

        if url.path != "/tts":
            return self._send(404, b"not found")

        params = parse_qs(url.query)
        text = (params.get("text") or [""])[0].strip()
        rate = (params.get("rate") or ["+0%"])[0]

        if not text:
            return self._send(400, b"missing text")
        if len(text) > MAX_TEXT:
            return self._send(413, b"text too long")
        if not RATE_RE.match(rate):
            return self._send(400, b"bad rate")

        path = cache_path(text, rate)
        cached = os.path.exists(path)
        if not cached:
            try:
                audio = asyncio.run(synth(text, rate))
            except Exception as e:  # upstream failure -> caller falls back
                sys.stderr.write("synth failed: %r\n" % (e,))
                return self._send(502, b"tts upstream failed")
            tmp = "%s.%d.tmp" % (path, os.getpid())
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(audio)
            os.replace(tmp, path)  # atomic, so a crash can't leave a partial mp3
        else:
            with open(path, "rb") as f:
                audio = f.read()

        self._send(
            200,
            audio,
            "audio/mpeg",
            {"Cache-Control": "public, max-age=31536000", "X-Cache": "HIT" if cached else "MISS"},
        )


if __name__ == "__main__":
    os.makedirs(CACHE_DIR, exist_ok=True)
    print("tts relay on :%d voice=%s cache=%s" % (PORT, VOICE, CACHE_DIR), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
