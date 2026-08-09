// watchTracker.js
//
// The core "never click watched" logic:
//
// 1. Every stream request Stremio makes gets logged (logStreamRequest).
// 2. When a NEW request comes in for a show, whatever episode came right
//    before it (same show, lower episode number) gets marked watched.
//    This is the "auto-advance" heuristic.
// 3. A periodic sweep (runTimeoutSweep) catches the one case auto-advance
//    can't: the LAST episode of a run, which has no "next" request to
//    trigger off of. If enough time has passed since the last request for
//    an item with nothing newer logged after it, mark it watched anyway.
//
// Nothing here requires the user to press a button.

const TIMEOUT_HOURS = parseInt(process.env.WATCH_TIMEOUT_HOURS || '3', 10);

function logStreamRequest(db, { userId = 'default', imdbId, type, season, episode }) {
  db.prepare(`
    INSERT INTO stream_events (user_id, imdb_id, type, season, episode)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, imdbId, type, season ?? null, episode ?? null);

  db.prepare(`
    INSERT INTO items (imdb_id, user_id, type, status)
    VALUES (?, ?, ?, 'watching')
    ON CONFLICT(imdb_id, user_id) DO NOTHING
  `).run(imdbId, userId, type);

  if (type === 'series' && season != null && episode != null) {
    autoAdvance(db, { userId, imdbId, season, episode });
  } else if (type === 'movie') {
    // Movies: mark watched as soon as a *different* item is opened next.
    // Handled lazily in autoAdvance-equivalent for movies below.
    markPreviousMovieIfAny(db, userId, imdbId);
  }
}

// Mark the episode immediately before the one just requested as watched,
// for the same show. E.g. opening S1E4 marks S1E3 (if not already marked).
function autoAdvance(db, { userId, imdbId, season, episode }) {
  const prevEpisode = db.prepare(`
    SELECT DISTINCT season, episode FROM stream_events
    WHERE user_id = ? AND imdb_id = ?
      AND (season < ? OR (season = ? AND episode < ?))
    ORDER BY season DESC, episode DESC
    LIMIT 1
  `).get(userId, imdbId, season, season, episode);

  if (prevEpisode) {
    markWatched(db, {
      userId, imdbId, type: 'series',
      season: prevEpisode.season, episode: prevEpisode.episode,
      source: 'heuristic',
    });
  }
}

// If the user opens a movie, and a different movie was opened before it
// with no "watched" record yet, mark the earlier one watched.
function markPreviousMovieIfAny(db, userId, currentImdbId) {
  const prevMovie = db.prepare(`
    SELECT DISTINCT imdb_id FROM stream_events
    WHERE user_id = ? AND type = 'movie' AND imdb_id != ?
    ORDER BY requested_at DESC
    LIMIT 1
  `).get(userId, currentImdbId);

  if (prevMovie) {
    markWatched(db, {
      userId, imdbId: prevMovie.imdb_id, type: 'movie',
      season: null, episode: null, source: 'heuristic',
    });
  }
}

function markWatched(db, { userId = 'default', imdbId, type, season, episode, source = 'heuristic' }) {
  db.prepare(`
    INSERT INTO watched (user_id, imdb_id, type, season, episode, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id, season, episode) DO NOTHING
  `).run(userId, imdbId, type, season ?? null, episode ?? null, source);
}

// Run on a schedule (see cron.js). Catches series finales / last-watched
// movies that never got a "next" request to trigger auto-advance.
function runTimeoutSweep(db) {
  const cutoff = `-${TIMEOUT_HOURS} hours`;

  // Latest stream event per (imdb_id, season, episode) that has no
  // matching watched row and is older than the timeout window.
  const stale = db.prepare(`
    SELECT se.user_id, se.imdb_id, se.type, se.season, se.episode, MAX(se.requested_at) as last_seen
    FROM stream_events se
    LEFT JOIN watched w
      ON w.user_id = se.user_id AND w.imdb_id = se.imdb_id
      AND ((w.season IS se.season) AND (w.episode IS se.episode))
    WHERE w.id IS NULL
      AND se.requested_at <= datetime('now', ?)
    GROUP BY se.user_id, se.imdb_id, se.season, se.episode
  `).all(cutoff);

  for (const row of stale) {
    markWatched(db, {
      userId: row.user_id, imdbId: row.imdb_id, type: row.type,
      season: row.season, episode: row.episode, source: 'timeout',
    });
  }

  return stale.length;
}

module.exports = { logStreamRequest, markWatched, runTimeoutSweep };
