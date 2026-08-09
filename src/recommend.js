// recommend.js — run weekly (or whenever). Two-stage recommendation:
// 1. TMDB "similar/recommended" endpoints generate free candidates from
//    your highly-rated/watched items (no LLM cost).
// 2. Gemini (optional, free tier) re-ranks the pool and writes a one-line
//    "why" for each pick. Falls back to DeepSeek if DEEPSEEK_API_KEY is set.
//    Falls back to plain TMDB order if neither key is present.
// Results are cached in recommendations_cache for the addon to read from.

require('dotenv').config();
const fetch = require('node-fetch');
const { init } = require('./db');
const tmdb = require('./tmdb');

// TMDB genre ID 16 = Animation. Combined with Japanese origin = anime.
function detectAnime(item) {
  const isAnimation = Array.isArray(item.genre_ids) && item.genre_ids.includes(16);
  const isJapanese = item.original_language === 'ja' ||
    (Array.isArray(item.origin_country) && item.origin_country.includes('JP'));
  return isAnimation && isJapanese;
}

async function gatherCandidates(db, userId) {
  const getSeeds = (type) => db.prepare(`
    SELECT i.imdb_id, i.tmdb_id, i.type, i.title
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ? AND i.tmdb_id IS NOT NULL AND i.type = ?
    ORDER BY COALESCE(r.rating, 0) DESC
    LIMIT 20
  `).all(userId, type);

  const seeds = [...getSeeds('movie'), ...getSeeds('series')];
  const candidates = new Map();

  // Fetch TMDB recommendations (pages 1 & 2) and similar titles in parallel batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < seeds.length; i += BATCH_SIZE) {
    const batch = seeds.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (seed) => {
      try {
        const [recs1, recs2, similar] = await Promise.all([
          tmdb.getRecommendations(seed.tmdb_id, seed.type, 1),
          tmdb.getRecommendations(seed.tmdb_id, seed.type, 2),
          tmdb.getSimilar(seed.tmdb_id, seed.type)
        ]);
        const pool = [...recs1, ...recs2, ...similar];
        for (const r of pool) {
          if (!candidates.has(r.id)) {
            candidates.set(r.id, {
              tmdbId: r.id,
              type: seed.type,
              title: r.title || r.name,
              poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
              isAnime: seed.type === 'series' ? detectAnime(r) : false,
              basedOn: seed.title,
            });
          }
        }
      } catch (err) {
        console.error(`[recommend] TMDB lookup failed for ${seed.title}:`, err.message);
      }
    }));
  }
  return [...candidates.values()];
}

async function rankWithGemini(candidates, seedTitles) {
  if (!process.env.GEMINI_API_KEY || candidates.length === 0) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const prompt = `Given someone who enjoyed: ${seedTitles.join(', ')}.
Here are candidate titles: ${candidates.map((c) => c.title).join(', ')}.
Return a JSON array of the top 40 best matches, each object having exactly two keys: "title" and "reason" (one short sentence why it fits). Output raw JSON only — no markdown, no code fences, no extra text.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.4, responseMimeType: 'application/json' },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array found in Gemini response');
    const ranked = JSON.parse(raw.slice(start, end + 1));
    return ranked.map((r, i) => ({
      ...candidates.find((c) => c.title === r.title),
      reason: r.reason,
      score: 100 - i,
    })).filter((c) => c?.tmdbId);
  } catch (err) {
    console.error('[recommend] Gemini ranking failed:', err.message);
    return null;
  }
}

async function rankWithDeepSeek(candidates, seedTitles) {
  if (!process.env.DEEPSEEK_API_KEY || candidates.length === 0) return null;

  const prompt = `Given someone who enjoyed: ${seedTitles.join(', ')}.
Here are candidate titles: ${candidates.map((c) => c.title).join(', ')}.
Return a JSON array of the top 40, each as {"title": "...", "reason": "one short sentence"}. JSON only, no prose.`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 1600 }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    const ranked = JSON.parse(text.replace(/```json|```/g, '').trim());
    return ranked.map((r, i) => ({
      ...candidates.find((c) => c.title === r.title),
      reason: r.reason,
      score: 100 - i,
    })).filter((c) => c?.tmdbId);
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
    candidates.map((c, i) => ({ ...c, score: 100 - i }))
  );
}

async function run(userId = 'default') {
  const db = init();

  const seedTitles = db.prepare(`
    SELECT title FROM items WHERE user_id = ? AND title IS NOT NULL LIMIT 25
  `).all(userId).map((r) => r.title);

  const alreadyOwned = new Set(
    db.prepare('SELECT imdb_id FROM items WHERE user_id = ?').all(userId).map((r) => r.imdb_id)
  );

  const allCandidates = await gatherCandidates(db, userId);
  const aiRanked = await rankCandidates(allCandidates, seedTitles);
  const aiIds = new Set(aiRanked.map((c) => c.tmdbId));
  const tmdbFallback = allCandidates
    .filter((c) => !aiIds.has(c.tmdbId))
    .map((c, i) => ({ ...c, score: -(i + 1) }));

  const toCache = [...aiRanked, ...tmdbFallback].slice(0, 200);

  const upsert = db.prepare(`
    INSERT INTO recommendations_cache (user_id, imdb_id, type, title, poster, is_anime, score, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET
      title = excluded.title, poster = excluded.poster, is_anime = excluded.is_anime,
      score = excluded.score, reason = excluded.reason, updated_at = datetime('now')
  `);

  db.prepare(`DELETE FROM recommendations_cache WHERE user_id = ?`).run(userId);

  // Resolve TMDB details in parallel batches of 15
  let cached = 0;
  const DETAIL_BATCH_SIZE = 15;
  for (let i = 0; i < toCache.length; i += DETAIL_BATCH_SIZE) {
    const batch = toCache.slice(i, i + DETAIL_BATCH_SIZE);
    await Promise.all(batch.map(async (c) => {
      try {
        const details = c.type === 'movie'
          ? await tmdb.getMovieDetails(c.tmdbId)
          : await tmdb.getShowDetails(c.tmdbId);
        const imdbId = details.external_ids?.imdb_id || details.imdb_id;
        if (!imdbId || alreadyOwned.has(imdbId)) return;

        const poster = c.poster
          || (details.poster_path ? `https://image.tmdb.org/t/p/w300${details.poster_path}` : null);

        const genreIds = details.genres?.map((g) => g.id) || [];
        const isAnime = c.isAnime ||
          (genreIds.includes(16) && (details.original_language === 'ja' ||
            (Array.isArray(details.origin_country) && details.origin_country.includes('JP'))));

        upsert.run(userId, imdbId, c.type, c.title, poster, isAnime ? 1 : 0, c.score || 0, c.reason || '');
        cached++;
      } catch (err) {
        console.error(`[recommend] failed resolving imdb id for ${c.title}:`, err.message);
      }
    }));
  }

  console.log(`Cached ${cached} recommendations for ${userId} (${aiRanked.length} AI-ranked + ${Math.max(0, cached - aiRanked.length)} TMDB fallback).`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
