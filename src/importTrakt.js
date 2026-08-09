// importTrakt.js — one-time migration: seeds this tool's database from a
// Trakt.tv "Data Export" zip (Settings -> Data Export on trakt.tv, free,
// no VIP required). Run once, then you're fully independent of Trakt.
//
// Usage: node src/importTrakt.js /path/to/extracted-export-folder

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { init } = require('./db');

function readJson(dir, file) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run(exportDir, userId = 'default') {
  const db = init();

  const watchedShows = readJson(exportDir, 'watched-shows.json') || [];
  const watchedMovies = readJson(exportDir, 'watched-movies.json') || [];
  const ratingsShows = readJson(exportDir, 'ratings-shows.json') || [];
  const ratingsMovies = readJson(exportDir, 'ratings-movies.json') || [];

  const insertItem = db.prepare(`
    INSERT INTO items (imdb_id, user_id, type, tmdb_id, title, year, status)
    VALUES (?, ?, ?, ?, ?, ?, 'completed')
    ON CONFLICT(imdb_id, user_id) DO NOTHING
  `);
  const insertWatched = db.prepare(`
    INSERT INTO watched (user_id, imdb_id, type, season, episode, source)
    VALUES (?, ?, ?, ?, ?, 'import')
    ON CONFLICT(user_id, imdb_id, season, episode) DO NOTHING
  `);
  const insertRating = db.prepare(`
    INSERT INTO ratings (user_id, imdb_id, rating, rated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET rating = excluded.rating
  `);

  let showCount = 0;
  for (const entry of watchedShows) {
    const imdb = entry.show?.ids?.imdb;
    if (!imdb) continue;
    insertItem.run(imdb, userId, 'series', entry.show.ids.tmdb || null, entry.show.title, entry.show.year);
    // Trakt's watched-shows.json gives per-show totals, not per-episode —
    // per-episode detail lives in watched-history-*.json files if present.
    showCount++;
  }

  let movieCount = 0;
  for (const entry of watchedMovies) {
    const imdb = entry.movie?.ids?.imdb;
    if (!imdb) continue;
    insertItem.run(imdb, userId, 'movie', entry.movie.ids.tmdb || null, entry.movie.title, entry.movie.year);
    insertWatched.run(userId, imdb, 'movie', null, null);
    movieCount++;
  }

  // Per-episode history, if the export includes watched-history-N.json files
  const historyFiles = fs.readdirSync(exportDir).filter((f) => /^watched-history-\d+\.json$/.test(f));
  let episodeCount = 0;
  for (const file of historyFiles) {
    const history = readJson(exportDir, file) || [];
    for (const entry of history) {
      if (entry.type === 'episode' && entry.show?.ids?.imdb) {
        insertWatched.run(
          userId, entry.show.ids.imdb, 'series',
          entry.episode.season, entry.episode.number
        );
        episodeCount++;
      }
    }
  }

  let ratingCount = 0;
  for (const entry of [...ratingsShows, ...ratingsMovies]) {
    const imdb = (entry.show || entry.movie)?.ids?.imdb;
    if (!imdb) continue;
    insertRating.run(userId, imdb, entry.rating, entry.rated_at);
    ratingCount++;
  }

  console.log(`Imported: ${showCount} shows, ${movieCount} movies, ${episodeCount} watched episodes, ${ratingCount} ratings.`);
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node src/importTrakt.js /path/to/extracted-export-folder');
    process.exit(1);
  }
  run(dir);
}

module.exports = { run };
