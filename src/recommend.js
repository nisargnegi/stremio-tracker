// recommend.js — run periodically (default: daily via docker-compose cron).
//
// Per-Category Recommendation Pipeline:
// 1. GATHER: Separate 300-item candidate pools for Movies, Series, and Anime.
// 2. FILTER: Remove anything the user already watched or hidden.
// 3. RANK: Dedicated DeepSeek AI calls per category (Movies -> 100, Series -> 100, Anime -> 60).
// Results are cached in recommendations_cache for the addon catalog to read.

require('dotenv').config();
const fetch = require('node-fetch');
const { init } = require('./db');
const tmdb = require('./tmdb');
const { sleep } = tmdb;

// ---- Helpers ----------------------------------------------------------------

function detectAnime(item) {
  const isAnimation = Array.isArray(item.genre_ids) && item.genre_ids.includes(16);
  const isJapanese =
    item.original_language === 'ja' ||
    (Array.isArray(item.origin_country) && item.origin_country.includes('JP'));
  return isAnimation && isJapanese;
}

function normalizeTitle(t = '') {
  return t
    .toLowerCase()
    .replace(/\s*\(\d{4}\)/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Candidate gathering (Per-Category) -------------------------------------

async function gatherMovieCandidates(db, userId) {
  const seeds = db.prepare(`
    SELECT i.imdb_id, i.tmdb_id, i.type, i.title
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL AND i.type = 'movie'
    ORDER BY COALESCE(r.rating, 0) DESC, RANDOM()
    LIMIT 15
  `).all(userId);

  const candidates = new Map();
  function addResult(r, source) {
    if (!r?.id || candidates.has(r.id)) return;
    candidates.set(r.id, {
      tmdbId: r.id,
      type: 'movie',
      title: r.title || r.name || '',
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
      isAnime: false,
      popularity: r.popularity || 0,
      voteAverage: r.vote_average || 0,
      voteCount: r.vote_count || 0,
      basedOn: source,
      genreIds: r.genre_ids || [],
    });
  }

  // Pass 1: Seeds
  for (let i = 0; i < seeds.length; i += 5) {
    const batch = seeds.slice(i, i + 5);
    await Promise.all(batch.map(async (seed) => {
      try {
        const [recs, sim] = await Promise.all([
          tmdb.getRecommendations(seed.tmdb_id, 'movie', 1),
          tmdb.getSimilar(seed.tmdb_id, 'movie', 1),
        ]);
        for (const r of [...recs, ...sim]) addResult(r, `Because you watched ${seed.title}`);
      } catch (_) {}
    }));
    await sleep(300);
  }

  // Pass 2: Genre discover
  const genreCount = {};
  for (const c of candidates.values()) {
    for (const gid of (c.genreIds || [])) genreCount[gid] = (genreCount[gid] || 0) + 1;
  }
  const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => Number(id));

  if (topGenres.length) {
    try {
      const disc = await Promise.all([
        tmdb.discover('movie', { genreIds: topGenres, minVote: 6.5, page: 1 }),
        tmdb.discover('movie', { genreIds: topGenres, minVote: 6.5, page: 2 }),
      ]);
      for (const results of disc) {
        for (const r of results) addResult(r, 'Matches your movie genre taste');
      }
    } catch (_) {}
  }

  // Pass 3: Broad sources
  try {
    const broad = await Promise.all([
      tmdb.getTrending('movie', 'week', 1),
      tmdb.getTrending('movie', 'week', 2),
      tmdb.getTopRated('movie', 1),
      tmdb.getTopRated('movie', 2),
      tmdb.getPopular('movie', 1),
      tmdb.getNowPlayingOrOnAir('movie', 1),
    ]);
    for (const results of broad) {
      for (const r of results) addResult(r, 'Popular & Trending Movies');
    }
  } catch (_) {}

  return [...candidates.values()];
}

async function gatherSeriesCandidates(db, userId) {
  const seeds = db.prepare(`
    SELECT i.imdb_id, i.tmdb_id, i.type, i.title
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL AND i.type = 'series' AND i.is_anime = 0
    ORDER BY COALESCE(r.rating, 0) DESC, RANDOM()
    LIMIT 15
  `).all(userId);

  const candidates = new Map();
  function addResult(r, source) {
    if (!r?.id || candidates.has(r.id) || detectAnime(r)) return;
    candidates.set(r.id, {
      tmdbId: r.id,
      type: 'series',
      title: r.name || r.title || '',
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
      isAnime: false,
      popularity: r.popularity || 0,
      voteAverage: r.vote_average || 0,
      voteCount: r.vote_count || 0,
      basedOn: source,
      genreIds: r.genre_ids || [],
    });
  }

  // Pass 1: Seeds
  for (let i = 0; i < seeds.length; i += 5) {
    const batch = seeds.slice(i, i + 5);
    await Promise.all(batch.map(async (seed) => {
      try {
        const [recs, sim] = await Promise.all([
          tmdb.getRecommendations(seed.tmdb_id, 'series', 1),
          tmdb.getSimilar(seed.tmdb_id, 'series', 1),
        ]);
        for (const r of [...recs, ...sim]) addResult(r, `Because you watched ${seed.title}`);
      } catch (_) {}
    }));
    await sleep(300);
  }

  // Pass 2: Genre discover
  const genreCount = {};
  for (const c of candidates.values()) {
    for (const gid of (c.genreIds || [])) genreCount[gid] = (genreCount[gid] || 0) + 1;
  }
  const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => Number(id));

  if (topGenres.length) {
    try {
      const disc = await Promise.all([
        tmdb.discover('series', { genreIds: topGenres, minVote: 6.5, page: 1 }),
        tmdb.discover('series', { genreIds: topGenres, minVote: 6.5, page: 2 }),
      ]);
      for (const results of disc) {
        for (const r of results) addResult(r, 'Matches your TV show taste');
      }
    } catch (_) {}
  }

  // Pass 3: Broad sources
  try {
    const broad = await Promise.all([
      tmdb.getTrending('series', 'week', 1),
      tmdb.getTrending('series', 'week', 2),
      tmdb.getTopRated('series', 1),
      tmdb.getTopRated('series', 2),
      tmdb.getPopular('series', 1),
      tmdb.getNowPlayingOrOnAir('series', 1),
    ]);
    for (const results of broad) {
      for (const r of results) addResult(r, 'Popular & Trending Series');
    }
  } catch (_) {}

  return [...candidates.values()];
}

async function gatherAnimeCandidates(db, userId) {
  const seeds = db.prepare(`
    SELECT i.imdb_id, i.tmdb_id, i.type, i.title
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL AND (i.is_anime = 1 OR i.type = 'series')
    ORDER BY i.is_anime DESC, COALESCE(r.rating, 0) DESC, RANDOM()
    LIMIT 10
  `).all(userId);

  const candidates = new Map();
  function addResult(r, source) {
    if (!r?.id || candidates.has(r.id)) return;
    if (!detectAnime(r) && !Array.isArray(r.genre_ids)?.includes(16)) return;
    candidates.set(r.id, {
      tmdbId: r.id,
      type: 'series',
      title: r.name || r.title || '',
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
      isAnime: true,
      popularity: r.popularity || 0,
      voteAverage: r.vote_average || 0,
      voteCount: r.vote_count || 0,
      basedOn: source,
      genreIds: r.genre_ids || [],
    });
  }

  // Pass 1: Seeds
  for (let i = 0; i < seeds.length; i += 5) {
    const batch = seeds.slice(i, i + 5);
    await Promise.all(batch.map(async (seed) => {
      try {
        const [recs, sim] = await Promise.all([
          tmdb.getRecommendations(seed.tmdb_id, 'series', 1),
          tmdb.getSimilar(seed.tmdb_id, 'series', 1),
        ]);
        for (const r of [...recs, ...sim]) addResult(r, `Because you watched ${seed.title}`);
      } catch (_) {}
    }));
    await sleep(300);
  }

  // Pass 2: Japanese Anime Discover
  try {
    const disc = await Promise.all([
      tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 6.8, page: 1 }),
      tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 6.8, page: 2 }),
      tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 6.8, page: 3 }),
    ]);
    for (const results of disc) {
      for (const r of results) addResult(r, 'Top Rated Anime');
    }
  } catch (_) {}

  return [...candidates.values()];
}

// ---- DeepSeek Channel Ranking -----------------------------------------------

async function rankChannelWithDeepSeek(candidates, categoryName, userPref, targetCount = 100) {
  if (!process.env.DEEPSEEK_API_KEY || candidates.length === 0) return [];

  const top = [...candidates]
    .filter((c) => c.voteCount >= 80 && c.popularity >= 10)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 250);

  const { seedTitles = [], highlyRated = [], disliked = [] } = userPref || {};

  const prompt = `Dedicated ${categoryName} recommendation engine.
User watch history includes: ${seedTitles.join(', ')}.
User highly rated (4-5 stars): ${highlyRated.length ? highlyRated.join(', ') : 'None specified'}.
User disliked / low rated (1-2 stars): ${disliked.length ? disliked.join(', ') : 'None specified'}.

Candidates (title | type):
${top.map((c) => `${c.title} | ${c.type}`).join('\n')}

Return JSON array of top ${targetCount} best ${categoryName} recommendations matching the user's taste: [{"title":"...","type":"movie|series","reason":"one short sentence"}]. JSON only.`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10000,
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error(`No JSON array in DeepSeek ${categoryName} response`);
    const ranked = JSON.parse(text.slice(start, end + 1));

    const titleMap = new Map(top.map((c) => [normalizeTitle(c.title), c]));
    const results = ranked
      .map((r, i) => {
        const candidate = titleMap.get(normalizeTitle(r.title));
        if (!candidate) return null;
        return { ...candidate, reason: r.reason || r.Reason || r.REASON || '', score: targetCount - i };
      })
      .filter(Boolean);

    console.log(`[recommend] DeepSeek ranked ${results.length} ${categoryName}`);
    return results;
  } catch (err) {
    console.error(`[recommend] DeepSeek ${categoryName} ranking failed:`, err.message);
    return [...top].slice(0, targetCount).map((c, i) => ({ ...c, score: -(i + 1) }));
  }
}

// ---- Main run ---------------------------------------------------------------

async function run(userId = 'default') {
  console.log(`[recommend] ── Starting per-category run for userId="${userId}" ──`);
  const db = init();

  const seedTitles = db.prepare(`
    SELECT title FROM items
    WHERE user_id = ? AND title IS NOT NULL
    ORDER BY RANDOM() LIMIT 25
  `).all(userId).map((r) => r.title);

  const ratedRows = db.prepare(`
    SELECT i.title, COALESCE(r.rating, i.rating) as rating
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ? AND (r.rating IS NOT NULL OR i.rating IS NOT NULL)
  `).all(userId);

  const highlyRated = ratedRows.filter((r) => r.rating >= 4).map((r) => r.title);
  const disliked = ratedRows.filter((r) => r.rating <= 2).map((r) => r.title);

  const excludedIds = new Set([
    ...db.prepare('SELECT imdb_id FROM items WHERE user_id = ?').all(userId).map((r) => r.imdb_id),
    ...db.prepare('SELECT imdb_id FROM hidden_items WHERE user_id = ?').all(userId).map((r) => r.imdb_id),
  ]);
  console.log(`[recommend] Excluding ${excludedIds.size} items (watched + hidden)`);

  const userPref = { seedTitles, highlyRated, disliked };

  // 1. Gather 3 independent candidate pools
  console.log('[recommend] Gathering Movies candidate pool…');
  const movieCandidates = await gatherMovieCandidates(db, userId);
  console.log(`[recommend] Movie candidates: ${movieCandidates.length}`);

  console.log('[recommend] Gathering Series candidate pool…');
  const seriesCandidates = await gatherSeriesCandidates(db, userId);
  console.log(`[recommend] Series candidates: ${seriesCandidates.length}`);

  console.log('[recommend] Gathering Anime candidate pool…');
  const animeCandidates = await gatherAnimeCandidates(db, userId);
  console.log(`[recommend] Anime candidates: ${animeCandidates.length}`);

  // 2. Rank each category with DeepSeek independently
  console.log('[recommend] Ranking Movies with DeepSeek…');
  const rankedMovies = await rankChannelWithDeepSeek(movieCandidates, 'Movies', userPref, 100);

  console.log('[recommend] Ranking Series with DeepSeek…');
  const rankedSeries = await rankChannelWithDeepSeek(seriesCandidates, 'TV Series', userPref, 100);

  console.log('[recommend] Ranking Anime with DeepSeek…');
  const rankedAnime  = await rankChannelWithDeepSeek(animeCandidates, 'Anime', userPref, 60);

  const toCache = [...rankedMovies, ...rankedSeries, ...rankedAnime];
  console.log(`[recommend] Total ranked recommendations to cache: ${toCache.length}`);

  db.prepare('DELETE FROM recommendations_cache WHERE user_id = ?').run(userId);

  const upsert = db.prepare(`
    INSERT INTO recommendations_cache (user_id, imdb_id, type, title, poster, is_anime, score, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET
      title = excluded.title, poster = excluded.poster, is_anime = excluded.is_anime,
      score = excluded.score, reason = excluded.reason, updated_at = datetime('now')
  `);

  let cached = 0;
  const DETAIL_BATCH = 10;
  for (let i = 0; i < toCache.length; i += DETAIL_BATCH) {
    const batch = toCache.slice(i, i + DETAIL_BATCH);
    await Promise.all(batch.map(async (c) => {
      try {
        const details = c.type === 'movie'
          ? await tmdb.getMovieDetails(c.tmdbId)
          : await tmdb.getShowDetails(c.tmdbId);
        const imdbId = details.external_ids?.imdb_id || details.imdb_id;
        if (!imdbId || excludedIds.has(imdbId)) return;

        const poster = c.poster ||
          (details.poster_path ? `https://image.tmdb.org/t/p/w300${details.poster_path}` : null);

        const genreIds = details.genres?.map((g) => g.id) || [];
        const isAnime = c.isAnime ||
          (genreIds.includes(16) &&
            (details.original_language === 'ja' ||
              (Array.isArray(details.origin_country) && details.origin_country.includes('JP'))));

        upsert.run(userId, imdbId, c.type, c.title, poster, isAnime ? 1 : 0, c.score ?? 0, c.reason || '');
        cached++;
      } catch (err) {
        console.error(`[recommend] IMDb resolution failed for "${c.title}":`, err.message);
      }
    }));
    await sleep(300);
  }

  console.log(`[recommend] ✓ Done. ${cached} recommendations cached successfully.`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
