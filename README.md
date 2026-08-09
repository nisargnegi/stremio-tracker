# 🎬 Watch Tracker for Stremio

A self-hosted, private, free Trakt replacement built specifically for **Stremio**. Tracks what you watch automatically (without needing to click "mark as watched"), notifies you when a new episode airs for a show you're following, and generates personalized recommendations for what to watch next.

Built because Trakt's free tier limits connected applications and its Stremio scrobbling can be unreliable (especially on Android TV). This tool operates independently of Stremio's built-in scrobbler.

---

## 🔥 Key Features

- **Automatic Watch Tracking**: Seamlessly hooks into Stremio's stream requests. Whenever you open an episode or movie, it logs your viewing activity automatically without interfering with your streaming addons.
- **Auto-Advance**: Opening Episode 4 automatically marks Episode 3 as watched.
- **Timeout Sweep**: Automatically marks series finales or single movies watched after a configurable time window.
- **New Episode Notifications**: Daily automated check against TMDB air dates with instant alerts via **Telegram** or **ntfy.sh**.
- **AI-Powered Recommendations**: Generates candidate picks from your viewing history via TMDB, re-ranked with customized one-line summaries using **Gemini 2.5 Flash** or **DeepSeek**.
- **Web Dashboard**: Included interactive web interface to view watch history, manage recommendations, and trigger manual syncs.
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
   - GitHub Actions workflow uses encrypted repository secrets (`VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`).

---

## 📋 Requirements (All Free)

- A small VPS or server that runs 24/7 (Oracle Cloud Always Free, DigitalOcean, Hetzner, Vultr, etc.)
- A free [TMDB API Key](https://www.themoviedb.org/settings/api)
- A Telegram bot or an [ntfy.sh](https://ntfy.sh) topic for notifications
- *(Optional)* A free [Gemini API Key](https://aistudio.google.com/apikey) or [DeepSeek API Key](https://platform.deepseek.com) for AI recommendation re-ranking
- A free [DuckDNS](https://www.duckdns.org) subdomain for automatic HTTPS

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

1. Provision a VPS (e.g. Oracle Cloud Always Free, Ubuntu 22.04 / 24.04 LTS).
2. Connect to your VPS via SSH:
   ```bash
   ssh ubuntu@YOUR_VPS_IP
   ```
3. Install Docker & Docker Compose:
   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose-plugin
   sudo systemctl enable --now docker
   sudo usermod -aG docker $USER
   ```
4. Log out and back in for group permissions to take effect:
   ```bash
   exit
   ssh ubuntu@YOUR_VPS_IP
   ```

### Step 2: Configure Domain & DNS (DuckDNS)

1. Log in at [duckdns.org](https://www.duckdns.org).
2. Create a subdomain (e.g., `my-stremio-tracker` -> `my-stremio-tracker.duckdns.org`) pointing to `YOUR_VPS_IP`.
3. Note down your DuckDNS **token** and **subdomain**.

### Step 3: Open VPS Firewall Ports

Caddy requires ports **80** (HTTP verification) and **443** (HTTPS) open. Internal port `7000` remains closed.

```bash
# Enable UFW rules on Ubuntu
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow OpenSSH
sudo ufw enable
```
*(Note: If using Oracle Cloud, also add Ingress Rules for ports 80 and 443 in the Oracle Cloud Console Security List).*

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

# Notifications (Telegram or ntfy)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Optional AI Recommendations
GEMINI_API_KEY=your_gemini_key

# Security Path Secret
APP_SECRET=your_generated_random_secret_here

# Domain Config (DuckDNS)
DUCKDNS_SUBDOMAIN=my-stremio-tracker
DUCKDNS_TOKEN=your_duckdns_token
DUCKDNS_DOMAIN=my-stremio-tracker.duckdns.org
```

### Step 5: Start the Docker Stack

```bash
docker compose up -d --build
```

Caddy will automatically provision a free Let's Encrypt SSL/TLS certificate.

Verify that your manifest is accessible over HTTPS:
```bash
curl https://my-stremio-tracker.duckdns.org/YOUR_APP_SECRET/manifest.json
```

---

## 🤖 Automated CI/CD (GitHub Actions)

This repository includes an automated deployment workflow `.github/workflows/deploy.yml` that automatically deploys changes to your VPS whenever you push to `main` or `master`.

### Setting Up GitHub Secrets:

Navigate to your GitHub Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret Name | Value Description |
| :--- | :--- |
| `VPS_HOST` | Public IP address or domain of your VPS (e.g. `123.45.67.89`) |
| `VPS_USERNAME` | SSH user on your VPS (e.g. `ubuntu` or `root`) |
| `VPS_SSH_KEY` | Private SSH key (contents of `~/.ssh/id_rsa` or `~/.ssh/id_ed25519`) |

Whenever you push commits to GitHub, the workflow will log in to your VPS via SSH, pull the latest code, and restart the containers via `docker compose up -d --build`.

---

## 📦 Trakt Migration (Import History)

If you have exported your watch history from Trakt:

```bash
# 1. Create directory and extract export files
mkdir -p data/trakt-export
unzip trakt-export.zip -d data/trakt-export

# 2. Run the import script inside the running container
docker compose exec addon node src/importTrakt.js /app/data/trakt-export
```

---

## 📁 Project Directory Overview

```
stremio-tracker/
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Actions auto-deployment pipeline
├── src/
│   ├── index.js            # Express server, Stremio addon routes, security filter
│   ├── watchTracker.js     # Auto-advance & timeout-sweep logic
│   ├── db.js               # SQLite database initialization & query helpers
│   ├── tmdb.js             # TMDB API client
│   ├── notify.js           # Telegram & ntfy.sh notification handler
│   ├── cron.js             # Automated daily background job runner
│   ├── recommend.js        # Recommendation generator with AI re-ranking
│   └── importTrakt.js      # Trakt JSON export importer
├── Caddyfile               # Caddy reverse proxy configuration
├── Dockerfile              # Production Node.js multi-stage container file
├── docker-compose.yml      # Orchestration for addon service & Caddy proxy
├── .env.example            # Environment variables template
├── .gitignore              # Git ignore rules for secrets and runtime data
└── README.md               # Documentation
```

---

## 📄 License

[MIT License](LICENSE) - Open source and free for personal use.
