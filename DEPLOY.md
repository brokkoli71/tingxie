# Deploy

One container: `server.js` serves `index.html` **and** the progress API from the
same origin, so there is no CORS setup and no second service to keep alive.
Progress lives in a single JSON file on a bind mount (`./data/progress.json`).

## Local run

```sh
node server.js              # http://localhost:8080
PORT=3000 node server.js    # different port
```

No install step — `server.js` uses only the Node standard library. Needs Node 18+
(uses `fs/promises`, global `URL`).

## On the TrueNAS box

```sh
git clone <this repo> /mnt/<pool>/apps/tingxie
cd /mnt/<pool>/apps/tingxie
mkdir -p data
docker compose up -d --build
curl localhost:8477/api/health
```

The compose file binds the port to `127.0.0.1` only, so nothing is exposed on
the LAN — the tunnel is the sole way in.

## Via Dockge

Dockge runs `docker compose` over a stack directory; it does not build images
and cannot create the source files for you. So put the repo where Dockge looks
for stacks, and use the no-build compose:

```sh
git clone <this repo> /opt/stacks/tingxie      # or wherever DOCKGE_STACKS_DIR points
cd /opt/stacks/tingxie
cp compose.nobuild.yml compose.yaml            # Dockge expects this name
mkdir -p data && chown 1000:1000 data
```

The stack then shows up in Dockge; hit *Start*. Updates are `git pull` in that
directory, then *Restart* — there is no image to rebuild.

Editing `compose.yaml` from Dockge's UI is fine; just don't expect it to manage
`server.js`/`index.html`, which come from git.

## Via TrueNAS custom app

Only on TrueNAS SCALE 24.10 (Electric Eel) or newer, where apps run on Docker.
On older releases apps run on k3s and this won't apply — use plain compose over
SSH instead.

The custom-app form takes an **image reference and cannot build a Dockerfile**,
so use the same no-build approach: image `node:22-alpine`, command
`node /app/server.js`, and host-path mounts for the checked-out repo (`/app`,
read-only) and the data directory (`/data`). Host port 8477 → container port 8080 (8080 is taken on TrueNAS). If your version offers
*Install via YAML*, paste `compose.nobuild.yml` directly and adjust the relative
paths to absolute ones under `/mnt/<pool>/apps/tingxie`.

Either way, clone the repo to the host first — the app needs the source on disk.

### Run-as user (TrueNAS gotcha)

The container must run as an id that can read the checkout and write `./data`.
TrueNAS datasets are rarely owned by uid 1000, and getting this wrong fails as
`Cannot find module '/app/server.js'` — Node surfaces a permission failure on
the parent directory as `MODULE_NOT_FOUND`, not as `EACCES`. Note that a plain
`docker run` test won't reproduce it: that runs as root and skips the check.

Pin the ids to whatever owns the directory:

```sh
cd /mnt/<pool>/apps/tingxie
printf 'TINGXIE_UID=%s\nTINGXIE_GID=%s\n' "$(stat -c %u .)" "$(stat -c %g .)" >> .env
mkdir -p data && sudo chown "$(stat -c %u .):$(stat -c %g .)" data
```

## Cloudflare Tunnel → tingxie.hannesspitz.de

Same pattern as `cloud.hannesspitz.de`. If that tunnel already runs on this host,
just add a hostname to it (step 2) instead of creating a new tunnel.

1. **Cloudflare dashboard** → Zero Trust → Networks → Tunnels → your existing
   tunnel → *Configure*. (Or *Create a tunnel* → type `cloudflared` → name it
   `truenas`, then install the connector with the command it shows.)
2. **Public Hostname** tab → *Add a public hostname*:
   - Subdomain `tingxie`, Domain `hannesspitz.de`
   - Service: **HTTP** → URL `http://<host-LAN-IP>:8477`, e.g.
     `http://192.168.10.34:8477` — the same form the other routes on this
     tunnel use. `cloudflared` here does not reach origins over loopback, so
     `127.0.0.1:8477` would 502.

   In the current dashboard this lives under the tunnel's **Published
   application routes** tab; the old *Configure → Public Hostname* flow is
   gone. Don't use *CIDR routes* or *Hostname routes* — those are private
   network access via WARP, not public web access.
3. Save. The DNS CNAME is created automatically — no manual DNS record.
4. Visit `https://tingxie.hannesspitz.de`. Grade one card, reload, confirm it
   stuck; then open it on the phone and confirm the same box counts show up.

### Locking it down

The API has no auth by default. Pick one:

- **Cloudflare Access** (recommended, matches the Nextcloud setup): Zero Trust →
  Access → Applications → *Add* → Self-hosted → `tingxie.hannesspitz.de` →
  policy `Emails == h.spitz@outlook.de`. Nothing to change in the app.
- **Shared secret**, if you'd rather skip Access: set `TINGXIE_TOKEN=<random>` in
  a `.env` next to `docker-compose.yml`, then on each device once, in the browser
  console: `localStorage.setItem('tingxie-token','<random>')`. Note this is weak
  — the token sits in a static page's storage; it stops drive-by scanners, not a
  determined attacker.

## Backup

Everything that matters is `data/progress.json`. Snapshot the dataset, or:

```sh
curl -s https://tingxie.hannesspitz.de/api/progress > progress-$(date +%F).json
```

Restore with a `PUT` of the same file to `/api/progress`.

## API

```
GET  /api/progress   -> { "<itemId>": {box, next, seen, correct}, ... }
PUT  /api/progress   <- same shape, overwrites wholesale (last-write-wins)
GET  /api/health     -> {"ok":true}
```

Writes are validated against that shape and land via temp-file + rename, so a
crash mid-write can't truncate the file. Bodies over 2 MB are rejected.

Writes require `PUT` **and** `Content-Type: application/json` — neither is
reachable from a cross-origin HTML form, and the server sends no CORS headers,
so the preflight such a request would need always fails. That's what keeps a
random page you visit from silently overwriting your progress. Don't relax
either check (in particular, don't re-add `POST`) without putting a real CSRF
token in its place. Static files are served from a hardcoded whitelist, not
from the request path, so there is no traversal surface.

## Offline behaviour

The frontend writes to `localStorage` first, then PUTs. If the server is
unreachable the grading is still saved locally and the next successful save
pushes the whole object up, so a dropped connection mid-session self-heals.
Caveat: this is last-write-wins with no merge — if you train offline on the
phone *and* on the laptop before either syncs, the later sync wins outright.
Single user, so this is a deliberate non-problem, but don't rely on it.
