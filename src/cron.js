// cron.js — run daily (via node-cron when the server is always-on, or as a
// system cron job hitting `npm run cron` if you'd rather not keep a process
// resident just for this).

require('dotenv').config();
const { init } = require('./db');
const tmdb = require('./tmdb');
const { notify } = require('./notify');
const { runTimeoutSweep } = require('./watchTracker');

async function checkNewEpisodes(db) {
  const shows = db.prepare(`
    SELECT * FROM items WHERE type = 'series'
  `).all();

  for (const show of shows) {
    try {
      let tmdbId = show.tmdb_id;
      if (!tmdbId) {
        const found = await tmdb.findByImdbId(show.imdb_id);
        tmdbId = found.tv?.id;
        if (tmdbId) {
          const isAnimation = Array.isArray(found.tv.genre_ids) && found.tv.genre_ids.includes(16);
          const isJapanese = found.tv.original_language === 'ja' ||
            (Array.isArray(found.tv.origin_country) && found.tv.origin_country.includes('JP'));
          const isAnime = (isAnimation && isJapanese) ? 1 : 0;
          db.prepare(`UPDATE items SET tmdb_id = ?, title = ?, is_anime = ? WHERE imdb_id = ? AND user_id = ?`)
            .run(tmdbId, found.tv.name, isAnime, show.imdb_id, show.user_id);
        }
      }
      if (!tmdbId) continue;

      const details = await tmdb.getShowDetails(tmdbId);
      const next = details.next_episode_to_air;
      if (!next) continue;

      const alreadyWatched = db.prepare(`
        SELECT 1 FROM watched WHERE user_id = ? AND imdb_id = ? AND season = ? AND episode = ?
      `).get(show.user_id, show.imdb_id, next.season_number, next.episode_number);

      const alreadyNotified = db.prepare(`
        SELECT 1 FROM stream_events WHERE user_id = ? AND imdb_id = ? AND season = ? AND episode = ?
      `).get(show.user_id, show.imdb_id, next.season_number, next.episode_number);

      if (!alreadyWatched && !alreadyNotified && isToday(next.air_date)) {
        // Re-activate show in Continue Watching catalog right as new episode drops
        db.prepare(`UPDATE items SET status = 'watching' WHERE imdb_id = ? AND user_id = ?`)
          .run(show.imdb_id, show.user_id);

        await notify(
          `🆕 *${details.name}* S${next.season_number}E${next.episode_number} "${next.name}" just aired.`
        );
      }
    } catch (err) {
      console.error(`[cron] failed checking ${show.imdb_id}:`, err.message);
    }
  }
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dateStr === today;
}

async function runOnce() {
  const db = init();
  console.log('[cron] checking for new episodes...');
  await checkNewEpisodes(db);

  console.log('[cron] running timeout sweep...');
  const marked = runTimeoutSweep(db);
  console.log(`[cron] marked ${marked} stale item(s) watched`);
}

if (require.main === module) {
  runOnce().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runOnce, checkNewEpisodes };
