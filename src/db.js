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
      is_anime INTEGER DEFAULT 0,
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

    -- Items user explicitly dismissed/hidden from recommendations
    CREATE TABLE IF NOT EXISTS hidden_items (
      user_id TEXT NOT NULL DEFAULT 'default',
      imdb_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, imdb_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stream_events_lookup
      ON stream_events (user_id, imdb_id, requested_at);
  `);

  try {
    db.prepare("ALTER TABLE items ADD COLUMN is_anime INTEGER DEFAULT 0").run();
  } catch (_) {}

  try {
    db.prepare("ALTER TABLE items ADD COLUMN rating INTEGER").run();
  } catch (_) {}

  try {
    db.prepare("ALTER TABLE recommendations_cache ADD COLUMN genres TEXT").run();
  } catch (_) {}

  try {
    db.prepare("ALTER TABLE recommendations_cache ADD COLUMN impressions INTEGER DEFAULT 0").run();
  } catch (_) {}

  try {
    db.prepare("ALTER TABLE recommendations_cache ADD COLUMN last_seen TEXT").run();
  } catch (_) {}

  // Additive migrations preserve existing libraries and saved feedback.
  db.transaction(() => {
    const additions = {
      ratings: { rating_scale: 'INTEGER', title: 'TEXT', type: 'TEXT', is_anime: 'INTEGER', tmdb_id: 'INTEGER' },
      recommendations_cache: { tmdb_id: 'INTEGER', release_year: 'INTEGER', impression_days: 'INTEGER DEFAULT 0' },
      hidden_items: { reason: "TEXT DEFAULT 'not_interested'", type: 'TEXT', is_anime: 'INTEGER', genres: 'TEXT', tmdb_id: 'INTEGER' },
    };
    for (const [table, fields] of Object.entries(additions)) {
      const existing = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
      for (const [name, definition] of Object.entries(fields)) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    // Trakt exports use ten points and ISO timestamps. Dashboard ratings use five points.
    db.exec(`UPDATE ratings SET rating_scale = CASE
      WHEN rating > 5 OR instr(COALESCE(rated_at, ''), 'T') > 0 THEN 10 ELSE 5 END
      WHERE rating_scale IS NULL`);
    db.exec(`CREATE TABLE IF NOT EXISTS recommendation_runs (
      user_id TEXT PRIMARY KEY, token TEXT NOT NULL, started_at TEXT DEFAULT (datetime('now'))
    )`);
  }).immediate();

  return db;
}

module.exports = { init, DB_PATH };
