# Watch Tracker for Stremio

A self-hosted, free Trakt replacement built for Stremio. Tracks what you watch
automatically (no "mark as watched" clicks), tells you when a new episode
airs for a show you're following, and recommends what to watch next.

Built because Trakt's free tier now limits you to one connected app and its
Stremio scrobbling is unreliable — especially on Android TV. This tool
doesn't depend on Stremio's built-in scrobbler at all.

## How it works

- Installed as a normal Stremio addon. Every time you open a movie or
  episode, Stremio asks all your addons for streams — this addon uses that
  moment purely as a "you're about to watch this" signal and logs it. It
  returns zero actual streams, so your real streaming addons are unaffected.
- **Auto-advance**: opening episode 4 marks episode 3 watched. No clicking.
- **Timeout sweep**: catches the last episode of a series (nothing "comes
  after" it to trigger auto-advance) — marked watched a few hours after
  it's opened if nothing newer shows up.
- **New episode alerts**: a daily check against TMDB's air-date data pushes
  a Telegram/ntfy notification when a show you're tracking has a new
  episode out.
- **Recommendations**: TMDB's free recommendation engine generates
  candidates from your history; an optional DeepSeek API call re-ranks them
  and writes a one-line reason (costs pennies a month).

## What you need (all free)

- A small VPS or server that's on 24/7 (see hosting steps below)
- A [TMDB API key](https://www.themoviedb.org/settings/api) (free, instant)
- A Telegram bot **or** an [ntfy.sh](https://ntfy.sh) topic, for notifications
- Optionally, a [DeepSeek API key](https://platform.deepseek.com) for the
  recommendation re-ranking (optional — everything else works without it)

## Quick start (local test)

```bash
git clone <this-repo>
cd stremio-tracker
cp .env.example .env
# edit .env: add your TMDB_API_KEY and a notification method
npm install
npm start
```

Open Stremio → Addons → paste `http://localhost:7000/manifest.json` → Install.

If you have an old Trakt account, migrate your history first:

```bash
unzip trakt-export.zip -d trakt-export
npm run import-trakt trakt-export
```

## Hosting it for real (beginner walkthrough)

You need a server that stays on all the time — your own laptop won't work
unless it never sleeps. The cheapest reliable option is a free-tier VPS.

**Why this setup needs more than "just open a port":** Stremio requires
HTTPS for any addon URL that isn't `127.0.0.1` — a plain `http://your-ip:7000`
address will not work from Android TV or any remote device. On top of that,
your addon is reachable from the entire internet once it's HTTPS-exposed,
so it needs something stopping strangers from finding and hitting it. This
setup handles both with two free tools: **DuckDNS** (a free domain name) and
**Caddy** (automatic HTTPS + reverse proxy), plus a secret-path URL baked
into the app itself.

### Step 1: Get a free VPS (Oracle Cloud "Always Free" tier)

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/).
   Needs a card for identity verification but the Always Free tier genuinely
   never charges you as long as you stay within its limits (plenty for this).
2. Create a new **Compute Instance**:
   - Image: **Ubuntu 22.04** (or newer)
   - Shape: pick one of the "Always Free eligible" shapes (VM.Standard.E2.1.Micro
     or the Ampere ARM option — either works fine for this project)
3. Download the SSH key it generates when you create the instance — you'll
   need it to log in.
4. Note the instance's **public IP address**, shown on the instance's page.

### Step 2: Connect to your server

On Mac/Linux (or Windows with WSL/PowerShell):

```bash
chmod 400 path/to/downloaded-key.key
ssh -i path/to/downloaded-key.key ubuntu@YOUR_SERVER_IP
```

You're now typing commands directly on your VPS.

### Step 3: Install Docker

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Log out and back in (`exit`, then reconnect via SSH) for the permission
change to apply.

### Step 4: Get a free domain name (DuckDNS)

1. Go to [duckdns.org](https://www.duckdns.org) and sign in (GitHub/Google —
   no separate account to create).
2. Create a subdomain, e.g. `jarvis-tracker` → gives you
   `jarvis-tracker.duckdns.org`, pointed at your server's IP.
3. Copy the **token** shown on the DuckDNS page — you'll need it below.

### Step 5: Get the project onto the server

```bash
git clone <this-repo>
cd stremio-tracker
cp .env.example .env
```

Generate a real secret for your addon's install URL — **do not skip this**:

```bash
openssl rand -hex 16
```

Copy the output, then edit the config:

```bash
nano .env
```

Fill in:
- `TMDB_API_KEY` — from themoviedb.org
- `APP_SECRET` — the random string you just generated
- `DUCKDNS_SUBDOMAIN` — just the subdomain part, e.g. `jarvis-tracker`
- `DUCKDNS_TOKEN` — from the DuckDNS page
- `DUCKDNS_DOMAIN` — the full domain, e.g. `jarvis-tracker.duckdns.org`
- Your notification method (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, or `NTFY_TOPIC`)

Save with `Ctrl+X`, then `Y`, then `Enter`.

### Step 6: Open only the ports you actually need

Oracle's cloud firewall blocks ports by default, separate from Ubuntu's own
`ufw`. You only need **80** (for HTTPS certificate setup) and **443**
(actual HTTPS traffic) open to the world — never 7000, since that's the
addon's internal-only port now.

1. In the Oracle Cloud console: your instance → **Subnet** → **Security
   Lists** → **Default Security List** → **Add Ingress Rule**.
   Add two rules: Source CIDR `0.0.0.0/0`, Destination Ports `80` and `443`,
   Protocol TCP.
2. On the server itself:
   ```bash
   sudo ufw allow 80
   sudo ufw allow 443
   sudo ufw allow OpenSSH   # don't lock yourself out of SSH
   sudo ufw enable
   ```

### Step 7: Run it

```bash
docker compose up -d --build
```

Give it a minute for Caddy to fetch its HTTPS certificate, then check:

```bash
curl https://YOUR_DUCKDNS_DOMAIN/YOUR_APP_SECRET/manifest.json
```

Should return JSON. If it doesn't, check logs: `docker compose logs -f caddy`
and `docker compose logs -f addon`.

### Step 8: Install in Stremio

On your Android TV (or any device), in Stremio → Addons (puzzle icon) →
search bar at the top → paste:

```
https://YOUR_DUCKDNS_DOMAIN/YOUR_APP_SECRET/manifest.json
```

→ Install. Keep this full URL private — treat it like a password, since it's
what protects your addon from strangers.

If you had a Trakt export, import it once from inside the container:

```bash
mkdir -p data/trakt-export
unzip trakt-export.zip -d data/trakt-export
docker compose exec addon node src/importTrakt.js /app/data/trakt-export
```

### Keeping it updated

```bash
cd stremio-tracker
git pull
docker compose up -d --build
```

## Security notes

- **The install URL is the only thing protecting your data.** Anyone with
  it can view/pollute your watch history. Don't post it publicly, don't
  commit `.env` to a public repo (it's already in `.gitignore`), and if you
  ever suspect it's leaked, change `APP_SECRET` and reinstall the addon in
  Stremio with the new URL.
- **Port 7000 is never exposed to the internet** — only Caddy (ports 80/443)
  is reachable externally; the addon container only talks to Caddy over
  Docker's private internal network.
- **Rate limiting** is built into the app (120 requests/minute) to blunt
  casual scanning even if the secret leaks.
- **Containers run with `no-new-privileges` and a read-only root filesystem**
  where possible, limiting what an attacker could do even with code
  execution inside a container.
- This setup is sized for **one person or a small friend group** self-hosting
  their own instance each — it is not designed to be a public multi-tenant
  service. If you want to run one instance for many strangers, you'd want
  proper auth (not just a secret path) and a security review first.

## Sharing this with others (multi-user notes)

This repo defaults to single-user (`user_id = 'default'`), which is the
simplest and most reliable setup for one household. If you want to host one
instance for a friend group:

- Set `MULTI_USER=true` in `.env`
- Give each person a unique addon install URL
  (`http://your-server:7000/USER_ID/manifest.json`) — this is a stub in the
  current schema (the `user_id` column already supports it) but the routing
  layer to generate per-user URLs isn't wired up in this initial version.
  Flagging it here so anyone building on this knows where to start; PRs
  welcome.
- Everyone's data stays isolated by `user_id` in the same SQLite file — no
  separate databases needed for a small group.

## Project structure

```
src/
  index.js         — the Stremio addon server + tracking hook
  db.js            — SQLite schema
  watchTracker.js  — auto-advance + timeout-sweep logic
  tmdb.js          — TMDB API wrapper
  notify.js        — Telegram/ntfy push notifications
  cron.js          — daily new-episode check + timeout sweep
  recommend.js      — weekly recommendation refresh (TMDB + optional DeepSeek)
  importTrakt.js   — one-time Trakt export importer
```

## License

MIT — do whatever you want with it.
