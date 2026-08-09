// recommend.js — run periodically (default: every 6 hours via docker-compose cron).
//
// Three-stage recommendation pipeline:
// 1. GATHER: Pull candidates from many TMDB sources (similar, recommended,
//    discover by user's preferred genres, trending, popular, now-playing).
// 2. FILTER: Remove anything the user has already watched/dismissed.
// 3. RANK: Use Gemini or DeepSeek to re-rank with personalized reasons.
//    Falls back to TMDB popularity order if no AI key is set.
// Results are cached in recommendations_cache for the addon to read from.

require('dotenv').config();
const fetch = require('node-fetch');
const { init } = require('./db');
const tmdb = require('./tmdb');

// ---- Helpers ----------------------------------------------------------------

// TMDB genre ID 16 = Animation. Combined with Japanese origin = anime.
function detectAnime(item) {
  const isAnimation = Array.isArray(item.genre_ids) && item.genre_ids.includes(16);
  const isJapanese =
    item.original_language === 'ja' ||
    (Array.isArray(item.origin_country) && item.origin_country.includes('JP'));
  return isAnimation && isJapanese;
}

// Simple rate-limiter: delay between parallel TMDB batches to stay under
// the free-tier limit of ~50 req/10 s.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Normalize a title for fuzzy matching: lowercase, strip years in parens,
// collapse whitespace. Handles "The Office (US)" === "The Office".
function normalizeTitle(t = '') {
  return t
    .toLowerCase()
    .replace(/\s*\(\d{4}\)/g, '')       // strip "(2005)"
    .replace(/\s*\([^)]*\)/g, '')       // strip "(US)", "(BBC)"
    .replace(/[^a-z0-9\s]/g, '')        // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Candidate gathering ----------------------------------------------------

async function getGenrePreferences(db, userId) {
  // Pull tmdb_ids of highly-rated or recently watched items, fetch their
  // genre lists, and return the top genre IDs for movie and series separately.
  const seeds = db.prepare(`
    SELECT i.tmdb_id, i.type
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL
    ORDER BY COALESCE(r.rating, 5) DESC
    LIMIT 30
  `).all(userId);

  const genreCount = { movie: {}, series: {} };
  const BATCH = 8;
  for (let i = 0; i < seeds.length; i += BATCH) {
    await Promise.all(seeds.slice(i, i + BATCH).map(async (s) => {
      try {
        const details = s.type === 'movie'
          ? await tmdb.getMovieDetails(s.tmdb_id)
          : await tmdb.getShowDetails(s.tmdb_id);
        const bucket = s.type === 'movie' ? genreCount.movie : genreCount.series;
        for (const g of (details.genres || [])) {
          bucket[g.id] = (bucket[g.id] || 0) + 1;
        }
      } catch (_) { /* non-fatal */ }
    }));
    await sleep(250);
  }

  const topIds = (bucket) =>
    Object.entries(bucket)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id]) => Number(id));

  return {
    movie: topIds(genreCount.movie),
    series: topIds(genreCount.series),
  };
}

async function gatherCandidates(db, userId) {
  // --- Seeds: top-rated or most-watched items in the user's library ---
  const getSeeds = (type) =>
    db.prepare(`
      SELECT i.imdb_id, i.tmdb_id, i.type, i.title
      FROM items i
      LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
      WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL AND i.type = ?
      ORDER BY COALESCE(r.rating, 0) DESC, RANDOM()
      LIMIT 25
    `).all(userId, type);

  const seeds = [...getSeeds('movie'), ...getSeeds('series')];
  const candidates = new Map(); // tmdbId -> candidate object

  function addResult(r, type, source) {
    if (!r?.id || candidates.has(r.id)) return;
    candidates.set(r.id, {
      tmdbId: r.id,
      type,
      title: r.title || r.name || '',
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
      isAnime: type === 'series' ? detectAnime(r) : false,
      popularity: r.popularity || 0,
      voteAverage: r.vote_average || 0,
      basedOn: source,
      genreIds: r.genre_ids || [],
    });
  }

  // --- 1. Per-seed: recommendations + similar (pages 1-3) ---
  console.log(`[recommend] Gathering candidates from ${seeds.length} seeds...`);
  const SEED_BATCH = 8;
  for (let i = 0; i < seeds.length; i += SEED_BATCH) {
    const batch = seeds.slice(i, i + SEED_BATCH);
    await Promise.all(batch.map(async (seed) => {
      try {
        const [recs1, recs2, recs3, sim1, sim2] = await Promise.all([
          tmdb.getRecommendations(seed.tmdb_id, seed.type, 1),
          tmdb.getRecommendations(seed.tmdb_id, seed.type, 2),
          tmdb.getRecommendations(seed.tmdb_id, seed.type, 3),
          tmdb.getSimilar(seed.tmdb_id, seed.type, 1),
          tmdb.getSimilar(seed.tmdb_id, seed.type, 2),
        ]);
        for (const r of [...recs1, ...recs2, ...recs3, ...sim1, ...sim2]) {
          addResult(r, seed.type, `Because you watched ${seed.title}`);
        }
      } catch (err) {
        console.error(`[recommend] Seed lookup failed for ${seed.title}:`, err.message);
      }
    }));
    await sleep(300);
  }

  console.log(`[recommend] After seed pass: ${candidates.size} candidates`);

  // --- 2. Genre-aware discover ---
  try {
    const genrePrefs = await getGenrePreferences(db, userId);
    console.log('[recommend] Genre prefs:', genrePrefs);

    const discoverSources = [];
    for (const type of ['movie', 'series']) {
      const gids = genrePrefs[type];
      if (gids.length === 0) continue;
      // Two discover passes: top genres combined, then each top-2 genre solo
      discoverSources.push(
        tmdb.discover(type, { genreIds: gids.slice(0, 3), minVote: 7.0, page: 1 }),
        tmdb.discover(type, { genreIds: gids.slice(0, 3), minVote: 7.0, page: 2 }),
        tmdb.discover(type, { genreIds: gids.slice(0, 3), minVote: 7.0, page: 3 }),
        ...(gids.slice(0, 2).map((gid) => tmdb.discover(type, { genreIds: [gid], minVote: 6.5 }))),
      );
    }
    // Also discover anime specifically (genre 16, Japanese origin)
    discoverSources.push(
      tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 7.0, page: 1 }),
      tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 7.0, page: 2 }),
    );

    const discoverResults = await Promise.all(discoverSources);
    let discoverAdded = 0;
    for (const results of discoverResults) {
      for (const r of results) {
        const type = r.title ? 'movie' : 'series';
        if (!candidates.has(r.id)) discoverAdded++;
        addResult(r, type, 'Matches your genre preferences');
      }
    }
    console.log(`[recommend] Discover added ${discoverAdded} new candidates`);
  } catch (err) {
    console.error('[recommend] Discover pass failed:', err.message);
  }

  await sleep(300);

  // --- 3. Trending, Popular, Top-Rated, Now-Playing (multi-page) ---
  try {
    const broadSources = await Promise.all([
      tmdb.getTrending('movie', 'day', 1),
      tmdb.getTrending('movie', 'week', 1),
      tmdb.getTrending('movie', 'week', 2),
      tmdb.getTrending('series', 'day', 1),
      tmdb.getTrending('series', 'week', 1),
      tmdb.getTrending('series', 'week', 2),
      tmdb.getTopRated('movie', 1),
      tmdb.getTopRated('movie', 2),
      tmdb.getTopRated('movie', 3),
      tmdb.getTopRated('series', 1),
      tmdb.getTopRated('series', 2),
      tmdb.getTopRated('series', 3),
      tmdb.getPopular('movie', 1),
      tmdb.getPopular('movie', 2),
      tmdb.getPopular('series', 1),
      tmdb.getPopular('series', 2),
      tmdb.getNowPlayingOrOnAir('movie', 1),
      tmdb.getNowPlayingOrOnAir('series', 1),
    ]);

    let broadAdded = 0;
    for (const results of broadSources) {
      for (const r of results) {
        const type = r.title ? 'movie' : 'series';
        if (!candidates.has(r.id)) broadAdded++;
        addResult(r, type, 'Trending & highly rated');
      }
    }
    console.log(`[recommend] Broad sources added ${broadAdded} new candidates. Total: ${candidates.size}`);
  } catch (err) {
    console.error('[recommend] Broad sources failed:', err.message);
  }

  return [...candidates.values()];
}

// ---- AI Ranking -------------------------------------------------------------

async function rankWithGemini(candidates, seedTitles, genrePrefs) {
  if (!process.env.GEMINI_API_KEY || candidates.length === 0) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  // Limit candidates sent to AI to top 150 by vote average to stay within token limits
  const top = [...candidates]
    .sort((a, b) => b.voteAverage - a.voteAverage)
    .slice(0, 150);

  const prompt = `You are a personalized movie & TV recommendation engine.

The user has watched and enjoyed: ${seedTitles.join(', ')}.

Here are ${top.length} candidate titles to rank (title | type):
${top.map((c) => `${c.title} | ${c.type}`).join('\n')}

Return a JSON array of the top 60 best personalized matches. Each item must have exactly:
- "title": exact title from the list above
- "type": "movie" or "series"  
- "reason": one punchy sentence (max 15 words) explaining why this fits the user's taste

Rules:
- Mix movies and series roughly proportionally unless the user clearly prefers one
- Prioritize quality over popularity
- Avoid recommending anything too similar to the very last item repeatedly
- Output raw JSON array only — no markdown fences, no explanation, no prose`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 6000, temperature: 0.35, responseMimeType: 'application/json' },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in Gemini response');
    const ranked = JSON.parse(raw.slice(start, end + 1));

    // Match by normalized title to handle "The Office" vs "The Office (US)" etc.
    const titleMap = new Map(top.map((c) => [normalizeTitle(c.title), c]));
    return ranked
      .map((r, i) => {
        const candidate = titleMap.get(normalizeTitle(r.title));
        if (!candidate) return null;
        return { ...candidate, reason: r.reason || '', score: 100 - i };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[recommend] Gemini ranking failed:', err.message);
    return null;
  }
}

async function rankWithDeepSeek(candidates, seedTitles) {
  if (!process.env.DEEPSEEK_API_KEY || candidates.length === 0) return null;

  const top = [...candidates]
    .sort((a, b) => b.voteAverage - a.voteAverage)
    .slice(0, 100);

  const prompt = `You are a movie & TV recommendation engine. The user enjoyed: ${seedTitles.join(', ')}.

Candidates (title | type):
${top.map((c) => `${c.title} | ${c.type}`).join('\n')}

Return JSON array of top 60 matches: [{"title":"...","type":"movie|series","reason":"one short sentence"}]. JSON only, no prose.`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,  // was 1600 — too low, caused JSON truncation
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in DeepSeek response');
    const ranked = JSON.parse(text.slice(start, end + 1));

    const titleMap = new Map(top.map((c) => [normalizeTitle(c.title), c]));
    return ranked
      .map((r, i) => {
        const candidate = titleMap.get(normalizeTitle(r.title));
        if (!candidate) return null;
        return { ...candidate, reason: r.reason || '', score: 100 - i };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[recommend] DeepSeek ranking failed:', err.message);
    return null;
  }
}

async function rankCandidates(candidates, seedTitles, genrePrefs) {
  if (candidates.length === 0) return [];
  // Try Gemini first, fall back to DeepSeek, fall back to vote-average order
  return (
    (await rankWithGemini(candidates, seedTitles, genrePrefs)) ??
    (await rankWithDeepSeek(candidates, seedTitles)) ??
    [...candidates]
      .sort((a, b) => b.voteAverage - a.voteAverage)
      .map((c, i) => ({ ...c, score: 100 - i }))
  );
}

// ---- Main run ---------------------------------------------------------------

async function run(userId = 'default') {
  console.log(`[recommend] ── Starting recommendation run for userId="${userId}" ──`);
  const db = init();

  // Seed titles for AI context
  const seedTitles = db.prepare(`
    SELECT title FROM items
    WHERE user_id = ? AND title IS NOT NULL
    ORDER BY RANDOM() LIMIT 30
  `).all(userId).map((r) => r.title);

  console.log(`[recommend] Seeds (${seedTitles.length}):`, seedTitles.slice(0, 8).join(', '));

  // Build exclusion set: items the user already has in their library
  const alreadyOwned = new Set(
    db.prepare('SELECT imdb_id FROM items WHERE user_id = ?').all(userId).map((r) => r.imdb_id)
  );
  console.log(`[recommend] Excluding ${alreadyOwned.size} already-watched items`);

  // Gather genre preferences for discover queries
  let genrePrefs = { movie: [], series: [] };
  try {
    genrePrefs = await getGenrePreferences(db, userId);
  } catch (err) {
    console.error('[recommend] Genre preference fetch failed:', err.message);
  }

  // Gather all candidates from TMDB
  const allCandidates = await gatherCandidates(db, userId);
  console.log(`[recommend] Total candidate pool: ${allCandidates.length}`);

  // AI ranking
  const aiRanked = await rankCandidates(allCandidates, seedTitles, genrePrefs);
  console.log(`[recommend] AI-ranked: ${aiRanked.length} items`);

  // Append unranked candidates after AI picks (sorted by vote average)
  const aiIds = new Set(aiRanked.map((c) => c.tmdbId));
  const fallback = allCandidates
    .filter((c) => !aiIds.has(c.tmdbId))
    .sort((a, b) => b.voteAverage - a.voteAverage)
    .map((c, i) => ({ ...c, score: -(i + 1) }));

  const toCache = [...aiRanked, ...fallback].slice(0, 300);
  console.log(`[recommend] Caching up to ${toCache.length} recommendations`);

  // Clear old cache and write new results
  db.prepare('DELETE FROM recommendations_cache WHERE user_id = ?').run(userId);

  const upsert = db.prepare(`
    INSERT INTO recommendations_cache (user_id, imdb_id, type, title, poster, is_anime, score, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET
      title = excluded.title, poster = excluded.poster, is_anime = excluded.is_anime,
      score = excluded.score, reason = excluded.reason, updated_at = datetime('now')
  `);

  // Resolve IMDb IDs in parallel batches
  let cached = 0;
  const DETAIL_BATCH = 12;
  for (let i = 0; i < toCache.length; i += DETAIL_BATCH) {
    const batch = toCache.slice(i, i + DETAIL_BATCH);
    await Promise.all(batch.map(async (c) => {
      try {
        const details = c.type === 'movie'
          ? await tmdb.getMovieDetails(c.tmdbId)
          : await tmdb.getShowDetails(c.tmdbId);
        const imdbId = details.external_ids?.imdb_id || details.imdb_id;
        if (!imdbId || alreadyOwned.has(imdbId)) return;

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
        console.error(`[recommend] Failed resolving IMDb id for ${c.title}:`, err.message);
      }
    }));
    await sleep(250);
  }

  console.log(
    `[recommend] ✓ Done. Cached ${cached} recommendations for ${userId}` +
    ` (${aiRanked.length} AI-ranked + ${Math.max(0, cached - aiRanked.length)} by vote average).`
  );
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
