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
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { init } = require('./db');
const { logStreamRequest } = require('./watchTracker');

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
      SELECT DISTINCT imdb_id, title FROM items
      WHERE type = 'series' AND status = 'watching'
      ORDER BY imdb_id
    `).all();

    return Promise.resolve({
      metas: rows.map((r) => ({
        id: r.imdb_id,
        type: 'series',
        name: r.title || r.imdb_id,
      })),
    });
  }

  if (id === 'tracker-recommended') {
    // Populated by the recommendations cron (see recommend.js) into a cache
    // table — kept out of the hot path here since it calls TMDB/DeepSeek.
    const rows = db.prepare(`
      SELECT imdb_id, title FROM recommendations_cache
      WHERE type = ?
      ORDER BY score DESC
      LIMIT 25
    `).all(type);

    return Promise.resolve({
      metas: rows.map((r) => ({ id: r.imdb_id, type, name: r.title || r.imdb_id })),
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

const SECRET = process.env.APP_SECRET;
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
app.use(helmet());
app.disable('x-powered-by');

// 120 requests/minute is generous for one person's Stremio client but
// blunts casual scanning/abuse if the secret ever leaks.
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// Everything the addon serves lives under /<secret>/... — this is what
// makes the install URL effectively a bearer token.
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
