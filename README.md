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
  - Recommendations you repeatedly view on the dashboard without clicking gradually sink down the list (`final_score = ai_score - impressions * 2.5`).
  - Fresh AI discoveries naturally rise to the top.
- **🌐 Interactive Web Dashboard**:
  - **Type Filter Pills**: 🎬 Movies, 📺 Series, 🌸 Anime.
  - **🏷️ Dynamic Genre Pills**: Filter by genre (*Action, Sci-Fi, Comedy, Drama, Thriller, Horror, Animation, etc.*).
  - **📌 "To Watch" (Plan to Watch) Tab**: Move recommendations into a dedicated watchlist tab.
  - **➕ Real-Time TMDB Search**: Search and add any movie, series, or anime directly to your watchlist from the dashboard.
  - **⭐ 5-Star Interactive Ratings**: Rate items to feed DeepSeek positive (4-5★) and negative (1-2★) taste guidance.
  - **✕ Persistent Hide / Not Interested**: Dismissed items never reappear.
  - **📱 Mobile Responsive UI**: Touch-optimized 2-column mobile layout and responsive modals.
- **⏱️ Weekly Automated Background Schedule**: Automated cron runs **weekly (every 7 days)** to update recommendations without wasting API credits, with manual refresh available anytime from the dashboard button.
- **Automated CI/CD**: Built-in GitHub Actions workflow for zero-downtime SSH deployment to your VPS.

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
   - GitHub Actions workflow uses encrypted repository secrets (`VPS_HOST`, `VPS_USERNAME`, `VPS_PASSWORD`, `VPS_PORT`).

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

> 💡 **Multi-App VPS Tip**: If you are running multiple web applications on a single VPS behind a global reverse proxy, create `docker-compose.override.yml` on your server disk to expose port `"7000:7000"` and disable the bundled Caddy container. `docker-compose.override.yml` is ignored by Git, so your custom server routing will never be overwritten by updates!

---

## 🤖 Automated CI/CD (GitHub Actions)

This repository includes an automated deployment workflow `.github/workflows/deploy.yml` that automatically deploys changes to your VPS whenever you push to `main` or `master`.

### Setting Up GitHub Secrets:

Navigate to your GitHub Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret Name | Value Description | Default Fallback |
| :--- | :--- | :--- |
| `VPS_HOST` | Public IP address or domain of your VPS | *(Required)* |
| `VPS_USERNAME` | SSH user on your VPS | `root` |
| `VPS_PASSWORD` | SSH password for your VPS user | *(Required)* |
| `VPS_PORT` | SSH port on your VPS | `22` |

Whenever you push commits to GitHub, the workflow will log in to your VPS via SSH, pull the latest code, and rebuild the containers with zero downtime.

---

## 📄 License

[MIT License](LICENSE) - Open source and free for personal use.
