// recommend.js — run weekly (or whenever). Two-stage recommendation:
// 1. TMDB "similar/recommended" endpoints generate free candidates from
//    your highly-rated/watched items (no LLM cost).
// 2. Gemini 2.5 Flash (optional, free tier) re-ranks the pool and writes a
//    one-line "why" for each pick. Falls back to DeepSeek if DEEPSEEK_API_KEY
//    is set instead. Falls back to plain TMDB order if neither key is present.
// Results are cached in recommendations_cache for the addon to read from.

require('dotenv').config();
const fetch = require('node-fetch');
const { init } = require('./db');
const tmdb = require('./tmdb');

async function gatherCandidates(db, userId) {
  const seeds = db.prepare(`
    SELECT i.imdb_id, i.tmdb_id, i.type, i.title
    FROM items i
    LEFT JOIN ratings r ON r.imdb_id = i.imdb_id AND r.user_id = i.user_id
    WHERE i.user_id = ?
    ORDER BY COALESCE(r.rating, 0) DESC
    LIMIT 15
  `).all(userId);

  const candidates = new Map();
  for (const seed of seeds) {
    if (!seed.tmdb_id) continue;
    try {
      const recs = await tmdb.getRecommendations(seed.tmdb_id, seed.type);
      for (const r of recs.slice(0, 10)) {  // 10 candidates per seed (was 5)
        candidates.set(r.id, {
          tmdbId: r.id,
          type: seed.type,
          title: r.title || r.name,
          poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
          basedOn: seed.title,
        });
      }
    } catch (err) {
      console.error(`[recommend] TMDB lookup failed for ${seed.title}:`, err.message);
    }
  }
  return [...candidates.values()];
}

// Re-rank candidates using Gemini (Google AI Studio free tier).
async function rankWithGemini(candidates, seedTitles) {
  if (!process.env.GEMINI_API_KEY || candidates.length === 0) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const prompt = `Given someone who enjoyed: ${seedTitles.join(', ')}.
Here are candidate titles: ${candidates.map((c) => c.title).join(', ')}.
Return a JSON array of the top 10 best matches, each object having exactly two keys: "title" and "reason" (one short sentence). Output raw JSON only — no markdown, no code fences, no extra text.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 2000,   // raised from 1000 to avoid truncation
          temperature: 0.4,
          responseMimeType: 'application/json', // tell Gemini to return clean JSON
        },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    // Extract the JSON array robustly — find first '[' and last ']'
    // so any surrounding prose or markdown fences are ignored.
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
    return null; // signals caller to try next fallback
  }
}

// Fallback: re-rank using DeepSeek (kept for backward compat).
async function rankWithDeepSeek(candidates, seedTitles) {
  if (!process.env.DEEPSEEK_API_KEY || candidates.length === 0) return null;

  const prompt = `Given someone who enjoyed: ${seedTitles.join(', ')}.
Here are candidate titles: ${candidates.map((c) => c.title).join(', ')}.
Return a JSON array of the top 10, each as {"title": "...", "reason": "one short sentence"}. JSON only, no prose.`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
      }),
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

// Try Gemini first, then DeepSeek, then plain TMDB order.
async function rankCandidates(candidates, seedTitles) {
  if (candidates.length === 0) return [];
  const result =
    (await rankWithGemini(candidates, seedTitles)) ??
    (await rankWithDeepSeek(candidates, seedTitles)) ??
    candidates.map((c, i) => ({ ...c, score: 100 - i }));
  return result;
}

async function run(userId = 'default') {
  const db = init();

  const seedTitles = db.prepare(`
    SELECT title FROM items WHERE user_id = ? AND title IS NOT NULL LIMIT 15
  `).all(userId).map((r) => r.title);

  const candidates = await gatherCandidates(db, userId);
  const ranked = await rankCandidates(candidates, seedTitles);

  const upsert = db.prepare(`
    INSERT INTO recommendations_cache (user_id, imdb_id, type, title, poster, score, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET
      title = excluded.title, poster = excluded.poster,
      score = excluded.score, reason = excluded.reason, updated_at = datetime('now')
  `);

  for (const c of ranked) {
    // recommendations_cache is keyed by imdb_id; TMDB gives us tmdb_id, so
    // resolve it (external_ids endpoint) before caching.
    try {
      const details = c.type === 'movie'
        ? await tmdb.getMovieDetails(c.tmdbId)
        : await tmdb.getShowDetails(c.tmdbId);
      // Movies return imdb_id directly; TV shows need external_ids (now appended).
      const imdbId = details.external_ids?.imdb_id || details.imdb_id;
      const poster = c.poster
        || (details.poster_path ? `https://image.tmdb.org/t/p/w300${details.poster_path}` : null);
      if (imdbId) upsert.run(userId, imdbId, c.type, c.title, poster, c.score || 0, c.reason || '');
    } catch (err) {
      console.error(`[recommend] failed resolving imdb id for ${c.title}:`, err.message);
    }
  }

  console.log(`Cached ${ranked.length} recommendations for ${userId}.`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
