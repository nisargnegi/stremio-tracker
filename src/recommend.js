// recommend.js — run periodically (default: every 6 hours via docker-compose cron).
//
// Three-stage recommendation pipeline:
// 1. GATHER: Pull candidates from TMDB using the user's watch history as seeds
//    (similar, recommended) plus broad sources (trending, popular, top-rated,
//    discover by genre). Genre preferences are derived from candidate results
//    already collected — no extra API round-trips.
// 2. FILTER: Remove anything the user already has in their items table.
// 3. RANK: Gemini re-ranks the pool with personalized reasons.
//    Falls back to DeepSeek, then to vote-average order.
// Results are cached in recommendations_cache for the addon catalog to read.

require('dotenv').config();
const fetch = require('node-fetch');
const { init } = require('./db');
const tmdb = require('./tmdb');
const { sleep } = tmdb;

// ---- Helpers ----------------------------------------------------------------

function detectAnime(item) {
  // genre 16 = Animation; Japanese origin inferred from language or keywords.
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

// ---- Candidate gathering ----------------------------------------------------

async function gatherCandidates(db, userId) {
  // Seeds: best-rated / most recently active items in user's library.
  // Keep total low (15 per type) to control API usage.
  const getSeeds = (type) =>
    db.prepare(`
      SELECT i.imdb_id, i.tmdb_id, i.type, i.title
      FROM items i
      LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
      WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL AND i.type = ?
      ORDER BY COALESCE(r.rating, 0) DESC, RANDOM()
      LIMIT 15
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
      voteCount: r.vote_count || 0,
      basedOn: source,
      genreIds: r.genre_ids || [],
    });
  }

  // --- Pass 1: Per-seed recommendations + similar (2 pages each) ---
  // Batch size 5 with 400ms sleep → stays well under TMDB's 50 req/10s limit.
  console.log(`[recommend] Seed pass: ${seeds.length} seeds`);
  const SEED_BATCH = 5;
  for (let i = 0; i < seeds.length; i += SEED_BATCH) {
    const batch = seeds.slice(i, i + SEED_BATCH);
    await Promise.all(batch.map(async (seed) => {
      try {
        const [recs1, sim1] = await Promise.all([
          tmdb.getRecommendations(seed.tmdb_id, seed.type, 1),
          tmdb.getSimilar(seed.tmdb_id, seed.type, 1),
        ]);
        for (const r of [...recs1, ...sim1]) {
          addResult(r, seed.type, `Because you watched ${seed.title}`);
        }
      } catch (err) {
        console.error(`[recommend] Seed lookup failed for "${seed.title}":`, err.message);
      }
    }));
    await sleep(400);
  }
  console.log(`[recommend] After seed pass: ${candidates.size} candidates`);

  // --- Pass 2: Genre-aware discover ---
  // Derive genre preferences from candidates already collected — zero extra
  // API calls, unlike the previous approach of fetching full show details.
  const genreCount = { movie: {}, series: {} };
  for (const c of candidates.values()) {
    const bucket = c.type === 'movie' ? genreCount.movie : genreCount.series;
    for (const gid of (c.genreIds || [])) {
      bucket[gid] = (bucket[gid] || 0) + 1;
    }
  }
  const topGenres = (bucket, n = 3) =>
    Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => Number(id));

  const movieGenres = topGenres(genreCount.movie);
  const seriesGenres = topGenres(genreCount.series);
  console.log('[recommend] Top genres — movies:', movieGenres, 'series:', seriesGenres);

  const discoverCalls = [];
  if (movieGenres.length)  discoverCalls.push(
    tmdb.discover('movie',  { genreIds: movieGenres,  minVote: 7.0, page: 1 }),
    tmdb.discover('movie',  { genreIds: movieGenres,  minVote: 7.0, page: 2 }),
  );
  if (seriesGenres.length) discoverCalls.push(
    tmdb.discover('series', { genreIds: seriesGenres, minVote: 7.0, page: 1 }),
    tmdb.discover('series', { genreIds: seriesGenres, minVote: 7.0, page: 2 }),
  );
  // Always add anime discover
  discoverCalls.push(
    tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 7.0, page: 1 }),
    tmdb.discover('series', { genreIds: [16], language: 'ja', minVote: 7.0, page: 2 }),
  );

  try {
    const discoverResults = await Promise.all(discoverCalls);
    let added = 0;
    for (const results of discoverResults) {
      for (const r of results) {
        const type = r.title ? 'movie' : 'series';
        if (!candidates.has(r.id)) added++;
        addResult(r, type, 'Matches your genre preferences');
      }
    }
    console.log(`[recommend] Discover added ${added} candidates. Total: ${candidates.size}`);
  } catch (err) {
    console.error('[recommend] Discover pass failed:', err.message);
  }

  await sleep(400);

  // --- Pass 3: Broad sources (trending, popular, top-rated, now-playing) ---
  try {
    const broadResults = await Promise.all([
      tmdb.getTrending('movie',  'week', 1),
      tmdb.getTrending('movie',  'week', 2),
      tmdb.getTrending('series', 'week', 1),
      tmdb.getTrending('series', 'week', 2),
      tmdb.getTopRated('movie',  1),
      tmdb.getTopRated('movie',  2),
      tmdb.getTopRated('series', 1),
      tmdb.getTopRated('series', 2),
      tmdb.getPopular('movie',   1),
      tmdb.getPopular('series',  1),
      tmdb.getNowPlayingOrOnAir('movie',  1),
      tmdb.getNowPlayingOrOnAir('series', 1),
    ]);
    let added = 0;
    for (const results of broadResults) {
      for (const r of results) {
        const type = r.title ? 'movie' : 'series';
        if (!candidates.has(r.id)) added++;
        addResult(r, type, 'Trending & highly rated');
      }
    }
    console.log(`[recommend] Broad sources added ${added}. Total: ${candidates.size}`);
  } catch (err) {
    console.error('[recommend] Broad sources failed:', err.message);
  }

  return [...candidates.values()];
}

// ---- AI Ranking -------------------------------------------------------------

async function rankWithGemini(candidates, seedTitles) {
  if (!process.env.GEMINI_API_KEY || candidates.length === 0) return null;

  // Send the top 120 by vote average to stay within token limits.
  const top = [...candidates]
    .filter((c) => c.voteCount >= 100 && c.popularity >= 15)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 120);

  const prompt = `You are a personalized movie & TV recommendation engine.

The user has watched and enjoyed: ${seedTitles.join(', ')}.

Candidates (title | type):
${top.map((c) => `${c.title} | ${c.type}`).join('\n')}

Return a JSON array of the top 60 best personalized matches. Each item must have exactly these three fields:
- "title": exact title from the list above
- "type": "movie" or "series"
- "reason": one punchy sentence (max 15 words) explaining why this fits the user's taste (this field is MANDATORY)

Output raw JSON array only — no markdown, no explanation.`;

  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  try {
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 6000, temperature: 0.35 },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Gemini API error: ${data.error.message}`);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in Gemini response');
    const ranked = JSON.parse(raw.slice(start, end + 1));

    const titleMap = new Map(top.map((c) => [normalizeTitle(c.title), c]));
    const results = ranked
      .map((r, i) => {
        const candidate = titleMap.get(normalizeTitle(r.title));
        if (!candidate) return null;
        return { ...candidate, reason: r.reason || r.Reason || r.REASON || '', score: 100 - i };
      })
      .filter(Boolean);

    console.log(`[recommend] Gemini ranked ${results.length} items`);
    return results;
  } catch (err) {
    console.error('[recommend] Gemini ranking failed:', err.message);
    return null;
  }
}

async function rankWithDeepSeek(candidates, seedTitles) {
  if (!process.env.DEEPSEEK_API_KEY || candidates.length === 0) return null;

  const top = [...candidates]
    .filter((c) => c.voteCount >= 100 && c.popularity >= 15)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 100);

  const prompt = `Movie & TV recommendation engine. User enjoyed: ${seedTitles.join(', ')}.

Candidates (title | type):
${top.map((c) => `${c.title} | ${c.type}`).join('\n')}

Return JSON array of top 60: [{"title":"...","type":"movie|series","reason":"one short sentence"}]. JSON only.`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
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
        return { ...candidate, reason: r.reason || r.Reason || r.REASON || '', score: 100 - i };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[recommend] DeepSeek ranking failed:', err.message);
    return null;
  }
}

async function rankCandidates(candidates, seedTitles) {
  if (candidates.length === 0) return [];
  return (
    (await rankWithGemini(candidates, seedTitles)) ??
    (await rankWithDeepSeek(candidates, seedTitles)) ??
    [...candidates].sort((a, b) => b.voteAverage - a.voteAverage).map((c, i) => ({ ...c, score: 100 - i }))
  );
}

// ---- Main run ---------------------------------------------------------------

async function run(userId = 'default') {
  console.log(`[recommend] ── Starting run for userId="${userId}" ──`);
  const db = init();

  // Seed titles for AI context (random sample to keep prompt size reasonable)
  const seedTitles = db.prepare(`
    SELECT title FROM items
    WHERE user_id = ? AND title IS NOT NULL
    ORDER BY RANDOM() LIMIT 25
  `).all(userId).map((r) => r.title);

  console.log(`[recommend] ${seedTitles.length} seed titles`);

  const alreadyOwned = new Set(
    db.prepare('SELECT imdb_id FROM items WHERE user_id = ?').all(userId).map((r) => r.imdb_id)
  );
  console.log(`[recommend] Excluding ${alreadyOwned.size} already-watched items`);

  const allCandidates = await gatherCandidates(db, userId);
  console.log(`[recommend] Total candidate pool: ${allCandidates.length}`);

  const aiRanked = await rankCandidates(allCandidates, seedTitles);
  console.log(`[recommend] AI-ranked: ${aiRanked.length}`);

  const aiIds = new Set(aiRanked.map((c) => c.tmdbId));
  const fallback = allCandidates
    .filter((c) => !aiIds.has(c.tmdbId) && (c.voteCount >= 100 && c.popularity >= 15))
    .sort((a, b) => b.popularity - a.popularity)
    .map((c, i) => ({ ...c, score: -(i + 1) }));

  const toCache = [...aiRanked, ...fallback].slice(0, 300);
  console.log(`[recommend] Resolving IMDb IDs for ${toCache.length} items…`);

  db.prepare('DELETE FROM recommendations_cache WHERE user_id = ?').run(userId);

  const upsert = db.prepare(`
    INSERT INTO recommendations_cache (user_id, imdb_id, type, title, poster, is_anime, score, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET
      title = excluded.title, poster = excluded.poster, is_anime = excluded.is_anime,
      score = excluded.score, reason = excluded.reason, updated_at = datetime('now')
  `);

  // Resolve TMDB IDs -> IMDb IDs in batches; 429 is handled inside tmdb.js.
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
        console.error(`[recommend] IMDb resolution failed for "${c.title}":`, err.message);
      }
    }));
    await sleep(400);
  }

  console.log(
    `[recommend] ✓ Done. ${cached} cached` +
    ` (${aiRanked.length} AI-ranked + ${Math.max(0, cached - aiRanked.length)} by vote avg)`
  );
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
