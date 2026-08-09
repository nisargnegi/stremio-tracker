require('dotenv').config();
const { init } = require('./db');
const { findByImdbId, getShowDetails, sleep } = require('./tmdb');

async function run() {
  const db = init();

  // Find items missing metadata OR series that haven't been checked for anime yet.
  // We need is_anime to be rechecked for all series because the /find endpoint
  // doesn't reliably return origin_country — we need full show details for that.
  const items = db.prepare(`
    SELECT imdb_id, user_id, type, tmdb_id
    FROM items
    WHERE poster IS NULL OR title IS NULL OR title = '' OR type = 'series'
  `).all();

  console.log(`Found ${items.length} items to check. Fetching from TMDB...`);

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < items.length; i++) {
    const { imdb_id: imdbId, user_id: userId, type, tmdb_id: existingTmdbId } = items[i];

    try {
      let tmdbId = existingTmdbId;
      let genreIds = [];
      let originalLanguage = null;
      let originCountry = [];
      let title = null;
      let year = null;
      let poster = null;

      // For series with a known tmdb_id, use the full details endpoint which
      // includes origin_country — critical for accurate anime detection.
      if (type === 'series' && tmdbId) {
        try {
          const details = await getShowDetails(tmdbId);
          title = details.name || null;
          year = parseInt((details.first_air_date || '').slice(0, 4)) || null;
          poster = details.poster_path ? `https://image.tmdb.org/t/p/w300${details.poster_path}` : null;
          genreIds = details.genres?.map((g) => g.id) || [];
          originalLanguage = details.original_language || null;
          originCountry = details.origin_country || [];
        } catch (_) {
          // Fall through to findByImdbId
        }
      }

      // For movies or series without tmdb_id, use /find endpoint
      if (!tmdbId || (!title && !poster)) {
        const result = await findByImdbId(imdbId);
        const info = type === 'series' ? result.tv : result.movie;
        if (info) {
          tmdbId = tmdbId || info.id;
          title = title || info.name || info.title || null;
          year = year || parseInt((info.first_air_date || info.release_date || '').slice(0, 4)) || null;
          poster = poster || (info.poster_path ? `https://image.tmdb.org/t/p/w300${info.poster_path}` : null);
          if (genreIds.length === 0) genreIds = info.genre_ids || [];
          originalLanguage = originalLanguage || info.original_language || null;
          originCountry = originCountry.length ? originCountry : (info.origin_country || []);
        }
      }

      if (title || poster) {
        const isAnimation = genreIds.includes(16);
        const isJapanese = originalLanguage === 'ja' || originCountry.includes('JP');
        const isAnime = (type === 'series' && isAnimation && isJapanese) ? 1 : 0;

        db.prepare(`
          UPDATE items
          SET title     = COALESCE(?, title),
              year      = COALESCE(?, year),
              tmdb_id   = COALESCE(?, tmdb_id),
              poster    = COALESCE(?, poster),
              is_anime  = ?
          WHERE imdb_id = ? AND user_id = ?
        `).run(title, year, tmdbId, poster, isAnime, imdbId, userId);

        successCount++;
        process.stdout.write(`\rProcessed ${i + 1}/${items.length} (${title || imdbId}) anime=${isAnime}     `);
      } else {
        errorCount++;
      }
    } catch (err) {
      errorCount++;
      console.error(`\n[fillPosters] Failed for ${imdbId}: ${err.message}`);
    }

    // 200ms between items keeps us well under TMDB's 50 req/10s limit.
    await sleep(200);
  }

  console.log(`\n\nFinished! Enriched: ${successCount}, Failed/Not found: ${errorCount}`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
