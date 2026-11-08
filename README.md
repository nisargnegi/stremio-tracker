# 🎬 Watch Tracker for Stremio

A self-hosted, private, free Trakt replacement built specifically for **Stremio**. Tracks what you watch automatically (without needing to click "mark as watched"), auto-cleans your Continue Watching list when you're caught up, and generates personalized AI recommendations.

Built because Trakt's free tier limits connected applications and its Stremio scrobbling can be unreliable (especially on Android TV). This tool operates independently of Stremio's built-in scrobbler.

---

## 🔥 Key Features

- **Automatic Watch Tracking**: Seamlessly hooks into Stremio's stream requests. Whenever you open an episode or movie, it logs your viewing activity automatically without interfering with your streaming addons.
- **Auto-Advance**: Opening Episode 4 automatically marks Episode 3 as watched.
- **Smart Completion & Catalog Cleanup**:
  - Automatically marks shows as **`completed`** once you've watched up to the latest released episode (or finished an ended show / imported from Trakt).
  - Automatically **hides completed shows from Stremio's "Continue Watching"** catalog so your homepage stays clean.
  - Automatically **re-activates shows back to `watching` on release day** when a brand-new episode drops!
- **🤖 Per-Category AI Recommendation Engine**:
  - 3 dedicated recommendation channels: **Movies (100)**, **TV Series (100)**, and **Anime (60)** for up to 260 total recommendations per run.
  - Candidate pools generated from your viewing history via TMDB, re-ranked with personalized one-line explanations using **DeepSeek** (primary) or **Gemini** (fallback).
- **📉 Smart Impression Score-Decay**:
  - Recommendations seen on different UTC days gradually move down the list. Repeat page visits on the same day count once, with a maximum penalty of eight points.
  - Fresh AI discoveries naturally rise to the top.
- **🌐 Interactive Web Dashboard**:
  - **Type Filter Pills**: 🎬 Movies, 📺 Series, 🌸 Anime.
  - **🏷️ Dynamic Genre Pills**: Filter by genre (*Action, Sci-Fi, Comedy, Drama, Thriller, Horror, Animation, etc.*).
  - **📌 "To Watch" (Plan to Watch) Tab**: Move recommendations into a dedicated watchlist tab.
  - **➕ Real-Time TMDB Search**: Search and add any movie, series, or anime directly to your watchlist from the dashboard.
  - **⭐ 5-Star Interactive Ratings**: Rate items to feed DeepSeek positive (4-5★) and negative (1-2★) taste guidance.
  - **✕ Persistent Hide / Feedback**: Dismissed items never reappear.
  - **📱 Mobile Responsive UI**: Touch-optimized 2-column mobile layout and responsive modals.
- **⏱️ Automated Background Schedule**: Checks episodes daily and refreshes recommendations once per UTC week. Movie recommendations favor releases from the last five years, with up to 20% older, highly rated taste matches. The minimum vote count and popularity safeguards remain in place. Successful run dates persist across container restarts. Manual recommendation refresh is available from the dashboard.
- **Automated CI/CD**: Built-in GitHub Actions workflow for SSH key deployment with backups and health checks.

---

## 🔒 Security & Public Git Safety

This codebase is **100% safe for public GitHub repositories**. All sensitive data, domain names, and credentials are fully externalized:

1. **Environment Separation (`.env`)**:
   - All secret tokens, API keys, and database paths are loaded via environment variables.
   - `.env` files and SQLite databases (`*.db`, `data/`) are strictly ignored by `.gitignore`.
2. **Secret Path URL Hardening (`APP_SECRET`)**:
   - Your Stremio addon manifest is served behind a cryptographically random secret URL path (`https://yourdomain.com/YOUR_APP_SECRET/manifest.json`).
   - Requests outside this secret path return `404 Not Found`, preventing unauthorized access or scanning.
3. **Network & Container Isolation**:
   - The addon server runs on internal port `7000` and is **never exposed directly to the public internet**.
   - All traffic routes strictly through **Caddy** via Docker internal DNS.
   - Containers run with `read_only: true` filesystems and `no-new-privileges: true`.
4. **CI/CD Security**:
   - GitHub Actions workflow uses encrypted repository secrets (`VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `VPS_PORT`).

---

## 📋 Requirements

- A small VPS or server that runs 24/7 (Oracle Cloud Always Free, DigitalOcean, Hetzner, RackNerd, Vultr, etc.)
- A free [TMDB API Key](https://www.themoviedb.org/settings/api)
- A [DeepSeek API Key](https://platform.deepseek.com) or [Gemini API Key](https://aistudio.google.com/apikey) for AI recommendation re-ranking
- A free [DuckDNS](https://www.duckdns.org) subdomain for automatic HTTPS
- *(Optional)* An [ntfy.sh](https://ntfy.sh) topic or Telegram bot token for push notifications

---

## 🚀 Quick Start (Local Development)

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/stremio-tracker.git
cd stremio-tracker

# 2. Copy the environment configuration template
cp .env.example .env

# 3. Edit .env and set your TMDB_API_KEY and APP_SECRET
nano .env

# 4. Install dependencies and start the server
npm install
npm start
```

Open Stremio → Addons → Search Bar → Paste:
`http://localhost:7000/YOUR_APP_SECRET/manifest.json` → Click **Install**.

---

## 🌐 Production VPS Deployment (Docker + Caddy + HTTPS)

### Step 1: Set Up Your VPS (Ubuntu/Debian)

1. Provision a VPS (e.g. RackNerd, DigitalOcean, Hetzner, Ubuntu 22.04 / 24.04 LTS).
2. Connect to your VPS via SSH:
   ```bash
   ssh root@YOUR_VPS_IP
   ```
3. Install Docker & Docker Compose:
   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose-plugin
   sudo systemctl enable --now docker
   ```

### Step 2: Configure Domain & DNS (DuckDNS)

1. Log in at [duckdns.org](https://www.duckdns.org).
2. Create a subdomain (e.g., `my-stremio-tracker` -> `my-stremio-tracker.duckdns.org`) pointing to `YOUR_VPS_IP`.
3. Note down your DuckDNS **token** and **subdomain**.

### Step 3: Open VPS Firewall Ports

Caddy requires ports **80** (HTTP verification) and **443** (HTTPS) open. Internal port `7000` remains closed.

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow OpenSSH
sudo ufw enable
```

### Step 4: Clone & Configure Project on VPS

```bash
git clone https://github.com/YOUR_USERNAME/stremio-tracker.git
cd stremio-tracker
cp .env.example .env
```

Generate a secure random secret for your addon URL:
```bash
openssl rand -hex 16
```

Edit `.env`:
```bash
nano .env
```
Fill in the values:
```env
TMDB_API_KEY=your_tmdb_key_here
PORT=7000
DB_PATH=./data/tracker.db

# AI Recommendations (DeepSeek primary, Gemini fallback)
DEEPSEEK_API_KEY=sk-your-deepseek-key
GEMINI_API_KEY=your-gemini-key

# Security Path Secret
APP_SECRET=your_generated_random_secret_here

# Domain Config (DuckDNS)
DUCKDNS_SUBDOMAIN=my-stremio-tracker
DUCKDNS_TOKEN=your_duckdns_token
DUCKDNS_DOMAIN=my-stremio-tracker.duckdns.org

# (Optional) Push Notifications
NTFY_TOPIC=my-private-tracker-topic
```

### Step 5: Start the Docker Stack

```bash
docker compose up -d --build
```

Caddy will automatically provision a free Let's Encrypt SSL/TLS certificate.

For a shared reverse proxy, use the checked-in [Compose override example](deploy/compose.shared-proxy.example.yml). It binds the optional host port to loopback and lets your existing proxy reach the addon over its Docker network.

---

## 🤖 Automated CI/CD (GitHub Actions)

Pushes to `main` validate the application and can deploy the exact commit using a dedicated SSH key. Deployment includes an online SQLite backup, an application image build, health checks, and code/image rollback on failure.

Follow the [deployment setup](deploy/README.md) to install the VPS helpers, configure GitHub secrets, and enable deployment for your repository. The same guide covers migrating an existing VPS override to daily episode checks and weekly recommendations.

---

## 📄 License

[MIT License](LICENSE) - Open source and free for personal use.

### Recommendation preferences

Movie and TV/anime taste profiles use highly rated and recently watched titles. Imported Trakt ratings are interpreted on their original ten-point scale, while dashboard ratings use five stars. Watched, tracked, disliked, and hidden titles are removed before AI ranking. Model results are matched by typed TMDB IDs so remakes with the same title stay distinct.

Recent movies must still have at least 80 votes and popularity 10. Older movies also need an average rating of at least 7.5, at least 500 votes, and a connection to a highly rated or completed title. They occupy at most 20% of the returned movie list. A series' original premiere date does not limit its eligibility.

Choose **Hide** to distinguish **Already watched**, **Wrong genre for me**, and **Not interested in this title**. The latter two feed the next AI refresh. Legacy hidden titles remain excluded. Successfully refreshed channels replace stale cached rows, while channels with unavailable upstream metadata keep their previous results. When AI ranking is unavailable, the same popularity and freshness rules apply to the deterministic fallback.
