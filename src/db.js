// db.js — SQLite schema + connection helper.
// Single file, zero external DB server. Works fine for one household's data.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/tracker.db';

function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    -- One row per user (single-user installs just have one row, id='default')
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Shows/movies you're tracking, keyed by imdb id (Stremio's native id space)
    CREATE TABLE IF NOT EXISTS items (
      imdb_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,              -- 'movie' | 'series'
      tmdb_id INTEGER,
      title TEXT,
      year INTEGER,
      poster TEXT,
      status TEXT DEFAULT 'watching',  -- 'watching' | 'completed' | 'dropped'
      PRIMARY KEY (imdb_id, user_id)
    );

    -- Every stream request Stremio sends through the addon — the raw signal
    -- the auto-advance heuristic is built on.
    CREATE TABLE IF NOT EXISTS stream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      imdb_id TEXT NOT NULL,
      type TEXT NOT NULL,              -- 'movie' | 'series'
      season INTEGER,
      episode INTEGER,
      requested_at TEXT DEFAULT (datetime('now'))
    );

    -- Confirmed watched episodes/movies (what the addon's catalogs read from)
    CREATE TABLE IF NOT EXISTS watched (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      imdb_id TEXT NOT NULL,
      type TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      watched_at TEXT DEFAULT (datetime('now')),
      source TEXT DEFAULT 'heuristic', -- 'heuristic' | 'timeout' | 'import' | 'manual'
      UNIQUE(user_id, imdb_id, season, episode)
    );

    -- Ratings imported from your Trakt export (optional, feeds recommendations)
    CREATE TABLE IF NOT EXISTS ratings (
      user_id TEXT NOT NULL DEFAULT 'default',
      imdb_id TEXT NOT NULL,
      rating INTEGER,
      rated_at TEXT,
      PRIMARY KEY (user_id, imdb_id)
    );

    -- Populated periodically by recommend.js so the addon's catalog handler
    -- never has to call TMDB/DeepSeek on a live request.
    CREATE TABLE IF NOT EXISTS recommendations_cache (
      user_id TEXT NOT NULL DEFAULT 'default',
      imdb_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      poster TEXT,
      is_anime INTEGER DEFAULT 0,
      score REAL DEFAULT 0,
      reason TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, imdb_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stream_events_lookup
      ON stream_events (user_id, imdb_id, requested_at);
  `);

  return db;
}

module.exports = { init, DB_PATH };
