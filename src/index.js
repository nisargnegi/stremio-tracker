// index.js — the Stremio addon itself.
//
// How the tracking hook works: Stremio calls every installed addon's
// /stream/{type}/{id} endpoint whenever you open a movie/episode page
// (to collect playable links from all your addons at once). We use that
// call purely as a "user is about to watch this" signal, log it, and
// return zero streams of our own — your real streaming addons (Torrentio,
// debrid addons, etc.) still provide the actual playback links exactly as
// before. This addon never touches playback itself.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { init } = require('./db');
const { logStreamRequest } = require('./watchTracker');
const recommend = require('./recommend');

const db = init();

const manifest = {
  id: 'community.stremio-tracker',
  version: '0.1.0',
  name: 'Watch Tracker',
  description: 'Self-hosted Trakt replacement: auto-tracks what you watch, alerts on new episodes, and recommends what to watch next. No account, no manual marking.',
  resources: ['stream', 'catalog'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'series', id: 'tracker-continue', name: 'Continue Watching' },
    { type: 'movie', id: 'tracker-recommended', name: 'Recommended For You' },
    { type: 'series', id: 'tracker-recommended', name: 'Recommended For You' },
    { type: 'series', id: 'tracker-recommended-anime', name: 'Recommended Anime' },
  ],
  idPrefixes: ['tt'], // IMDb ids, same space Cinemeta uses
  behaviorHints: { configurable: true },
};

const builder = new addonBuilder(manifest);

// ---- Stream handler: logging hook, returns no streams ----
builder.defineStreamHandler(({ type, id }) => {
  try {
    const [imdbId, season, episode] = id.split(':');
    logStreamRequest(db, {
      imdbId,
      type,
      season: season ? parseInt(season, 10) : null,
      episode: episode ? parseInt(episode, 10) : null,
    });
  } catch (err) {
    console.error('[stream handler] logging failed:', err.message);
  }
  // Intentionally empty — other installed addons supply the real links.
  return Promise.resolve({ streams: [] });
});

// ---- Catalog handler: "Continue Watching" ----
builder.defineCatalogHandler(({ type, id }) => {
  if (id === 'tracker-continue' && type === 'series') {
    const rows = db.prepare(`
      SELECT DISTINCT imdb_id, title, poster FROM items
      WHERE type = 'series' AND status = 'watching'
      ORDER BY imdb_id
    `).all();

    return Promise.resolve({
      metas: rows.map((r) => ({
        id: r.imdb_id,
        type: 'series',
        name: r.title || r.imdb_id,
        poster: r.poster || undefined,
      })),
    });
  }

  if (id === 'tracker-recommended') {
    const rows = db.prepare(`
      SELECT imdb_id, title, poster FROM recommendations_cache
      WHERE type = ? AND (is_anime = 0 OR type = 'movie')
      ORDER BY score DESC
      LIMIT 100
    `).all(type);

    return Promise.resolve({
      metas: rows.map((r) => ({ id: r.imdb_id, type, name: r.title || r.imdb_id, poster: r.poster || undefined })),
    });
  }

  if (id === 'tracker-recommended-anime') {
    const rows = db.prepare(`
      SELECT imdb_id, title, poster FROM recommendations_cache
      WHERE type = 'series' AND is_anime = 1
      ORDER BY score DESC
      LIMIT 100
    `).all();

    return Promise.resolve({
      metas: rows.map((r) => ({ id: r.imdb_id, type: 'series', name: r.title || r.imdb_id, poster: r.poster || undefined })),
    });
  }

  return Promise.resolve({ metas: [] });
});

// ---- Lock the addon behind a secret URL path ----
//
// This addon has to be reachable from the public internet for Stremio on
// Android TV to call it. Without something guarding it, anyone who found
// the URL (or just scanned for it) could hit /stream/... and pollute your
// watch history, or spam TMDB/DeepSeek calls through your key. A random
// secret segment in the path means the addon 404s for everyone except
// whoever has the exact install URL you generated.

const SECRET = (process.env.APP_SECRET || '').trim().replace(/^["']|["']$/g, '');
const INSECURE_DEFAULT = 'change-me-to-a-random-string';

if (!SECRET || SECRET === INSECURE_DEFAULT) {
  console.error(
    '\n[fatal] APP_SECRET is missing or still set to the placeholder value.\n' +
    'Generate a real one and put it in .env, e.g.:\n\n' +
    '  openssl rand -hex 16\n\n' +
    'Refusing to start with an unprotected addon URL.\n'
  );
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.disable('x-powered-by');

// 120 requests/minute is generous for one person's Stremio client but
// blunts casual scanning/abuse if the secret ever leaks.
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

app.use(express.json());

// Public health check — intentionally no secret required so Docker / Caddy
// health probes can reach it without knowing APP_SECRET.
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Authenticated sub-router: Dashboard + API + Stremio addon ----
// Everything below requires the correct APP_SECRET in the URL path.
// Requests without it fall through to the 404 handler at the bottom.

app.use(`/${SECRET}`, (req, res, next) => {
  const url = req.url || '';

  // Dashboard HTML
  if (url === '/dashboard' || url === '/dashboard/') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    } catch (err) {
      return res.status(500).send(`Dashboard read error: ${err.message}`);
    }
  }

  // API: list recommendations
  if (url === '/api/recommendations' && req.method === 'GET') {
    try {
      const rows = db.prepare(`
        SELECT imdb_id, type, title, poster, is_anime, score, reason, updated_at
        FROM recommendations_cache
        WHERE user_id = 'default'
        ORDER BY score DESC
      `).all();
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // API: watch history
  if (url === '/api/history' && req.method === 'GET') {
    try {
      const rows = db.prepare(`
        SELECT imdb_id, type, title, poster, year, status, is_anime
        FROM items
        WHERE user_id = 'default'
        ORDER BY imdb_id DESC
      `).all();
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // API: dismiss a recommendation
  if (url === '/api/dismiss' && req.method === 'POST') {
    const { imdbId } = req.body || {};
    if (!imdbId) return res.status(400).json({ error: 'imdbId required' });
    try {
      db.prepare(`DELETE FROM recommendations_cache WHERE imdb_id = ? AND user_id = 'default'`).run(imdbId);
      return res.json({ ok: true, message: `${imdbId} dismissed` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // API: trigger manual recommendation refresh
  if (url === '/api/recommend/refresh' && req.method === 'POST') {
    console.log('[refresh] Manual refresh triggered via dashboard');
    try {
      recommend.run('default')
        .then(() => console.log('[refresh] ✓ Recommendation refresh complete.'))
        .catch((err) => console.error('[refresh] ✗ Recommendation refresh FAILED:', err.message, err.stack));
      return res.json({ ok: true, message: 'Recommendation refresh triggered!' });
    } catch (err) {
      console.error('[refresh] Sync error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // API: debug — test Gemini connectivity and env vars from the VPS
  if (url === '/api/debug' && req.method === 'GET') {
    const geminiKey = process.env.GEMINI_API_KEY;
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const tmdbKey = process.env.TMDB_API_KEY;
    const info = {
      GEMINI_API_KEY: geminiKey ? `set (${geminiKey.slice(0, 6)}...)` : 'NOT SET',
      GEMINI_MODEL: geminiModel,
      TMDB_API_KEY: tmdbKey ? `set (${tmdbKey.slice(0, 6)}...)` : 'NOT SET',
      node_version: process.version,
    };
    if (!geminiKey) return res.json({ ...info, gemini_test: 'skipped_no_key' });
    const nodeFetch = require('node-fetch');
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;
    nodeFetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly the JSON: {"ok":true}' }] }] }),
    })
      .then((r) => r.json())
      .then((data) => res.json({ ...info, gemini_test: data.error ? 'api_error' : 'success', gemini_raw: data }))
      .catch((err) => res.json({ ...info, gemini_test: 'network_error', error: err.message }));
    return;
  }

  next();
});

app.post(`/${SECRET}/mark-watched`, (req, res) => {
  const { imdbId, type } = req.body || {};
  if (!imdbId || !['movie', 'series'].includes(type)) {
    return res.status(400).json({ error: 'imdbId and type (movie|series) required' });
  }
  try {
    db.prepare(`
      INSERT INTO items (imdb_id, user_id, type, status)
      VALUES (?, 'default', ?, 'watching')
      ON CONFLICT(imdb_id, user_id) DO NOTHING
    `).run(imdbId, type);
    db.prepare(`
      INSERT INTO watched (user_id, imdb_id, type, source)
      VALUES ('default', ?, ?, 'manual')
      ON CONFLICT(user_id, imdb_id, season, episode) DO NOTHING
    `).run(imdbId, type);
    db.prepare(`DELETE FROM recommendations_cache WHERE imdb_id = ?`).run(imdbId);
    res.json({ ok: true, message: `${imdbId} marked as watched` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete(`/${SECRET}/mark-watched`, (req, res) => {
  const { imdbId } = req.body || {};
  if (!imdbId) return res.status(400).json({ error: 'imdbId required' });
  try {
    db.prepare(`DELETE FROM watched WHERE imdb_id = ? AND user_id = 'default'`).run(imdbId);
    db.prepare(`DELETE FROM items WHERE imdb_id = ? AND user_id = 'default'`).run(imdbId);
    res.json({ ok: true, message: `${imdbId} removed from watched` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stremio SDK Router — handles manifest, catalog, stream requests
app.use(`/${SECRET}`, getRouter(builder.getInterface()));

// Anything outside the secret path (including a bare "/") gets nothing
// useful back — no hints about what this server is.
app.use((req, res) => res.status(404).end());


const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  // NOTE: this port is only safe to bind broadly because docker-compose.yml
  // does NOT publish it to the host/internet — only the "caddy" container,
  // on the same private Docker network, can reach it by service name. Caddy
  // is the only thing exposed to the outside world (ports 80/443). If you
  // ever run this outside Docker, bind '127.0.0.1' instead and put a real
  // reverse proxy in front of it.
  console.log(`Watch Tracker addon listening internally on port ${PORT}`);
  console.log(`Install URL (behind your reverse proxy): https://YOUR_DOMAIN/${SECRET}/manifest.json`);
});
