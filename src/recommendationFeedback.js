const DISMISSAL_REASONS = new Set(['not_interested', 'wrong_genre', 'already_watched']);
const IMPRESSION_PENALTY = 'MIN(COALESCE(impression_days, 0), 8) * 1.0';

function recordImpressions(db, userId, ids) {
  const statement = db.prepare(`UPDATE recommendations_cache
    SET impressions = COALESCE(impressions, 0) + 1,
        impression_days = COALESCE(impression_days, 0) + 1, last_seen = datetime('now')
    WHERE user_id = ? AND imdb_id = ?
      AND (last_seen IS NULL OR date(last_seen) < date('now'))`);
  return db.transaction(() => [...new Set(ids)].slice(0, 30)
    .reduce((count, id) => count + statement.run(userId, id).changes, 0))();
}

function dismissRecommendation(db, userId, imdbId, title, reason = 'not_interested') {
  if (!DISMISSAL_REASONS.has(reason)) throw new Error('Invalid dismissal reason');
  db.transaction(() => {
    const cached = db.prepare('SELECT * FROM recommendations_cache WHERE user_id = ? AND imdb_id = ?').get(userId, imdbId);
    db.prepare(`INSERT INTO hidden_items (user_id, imdb_id, title, reason, type, is_anime, genres, tmdb_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, imdb_id) DO UPDATE SET
        title = excluded.title, reason = excluded.reason, created_at = datetime('now'),
        type = COALESCE(excluded.type, hidden_items.type),
        is_anime = COALESCE(excluded.is_anime, hidden_items.is_anime),
        genres = COALESCE(excluded.genres, hidden_items.genres),
        tmdb_id = COALESCE(excluded.tmdb_id, hidden_items.tmdb_id)`)
      .run(userId, imdbId, cached?.title || title || '', reason, cached?.type || null,
        cached?.is_anime ?? null, cached?.genres || null, cached?.tmdb_id || null);
    db.prepare('DELETE FROM recommendations_cache WHERE user_id = ? AND imdb_id = ?').run(userId, imdbId);
  })();
}

function recordRating(db, userId, imdbId, rating) {
  const metadata = db.prepare(`SELECT title, type, is_anime, tmdb_id FROM recommendations_cache
    WHERE user_id = ? AND imdb_id = ? UNION ALL
    SELECT title, type, is_anime, tmdb_id FROM items WHERE user_id = ? AND imdb_id = ? LIMIT 1`)
    .get(userId, imdbId, userId, imdbId) || {};
  db.prepare(`INSERT INTO ratings (user_id, imdb_id, rating, rated_at, rating_scale, title, type, is_anime, tmdb_id)
    VALUES (?, ?, ?, datetime('now'), 5, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET rating = excluded.rating,
      rated_at = excluded.rated_at, rating_scale = 5, title = COALESCE(excluded.title, ratings.title),
      type = COALESCE(excluded.type, ratings.type), is_anime = COALESCE(excluded.is_anime, ratings.is_anime),
      tmdb_id = COALESCE(excluded.tmdb_id, ratings.tmdb_id)`)
    .run(userId, imdbId, rating, metadata.title || null, metadata.type || null,
      metadata.is_anime ?? null, metadata.tmdb_id || null);
}

module.exports = { DISMISSAL_REASONS, IMPRESSION_PENALTY, recordImpressions, dismissRecommendation, recordRating };
