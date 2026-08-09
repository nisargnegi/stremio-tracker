// recommend.js — run weekly (or whenever). Two-stage recommendation:
// 1. TMDB "similar/recommended" endpoints generate free candidates from
//    your highly-rated/watched items (no LLM cost).
// 2. DeepSeek (optional) re-ranks the pool and writes a one-line "why" —
//    a few hundred tokens per run, effectively free at personal scale.
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
      for (const r of recs.slice(0, 5)) {
        candidates.set(r.id, {
          tmdbId: r.id,
          type: seed.type,
          title: r.title || r.name,
          basedOn: seed.title,
        });
      }
    } catch (err) {
      console.error(`[recommend] TMDB lookup failed for ${seed.title}:`, err.message);
    }
  }
  return [...candidates.values()];
}

async function rankWithDeepSeek(candidates, seedTitles) {
  if (!process.env.DEEPSEEK_API_KEY || candidates.length === 0) return candidates;

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
    })).filter((c) => c.tmdbId);
  } catch (err) {
    console.error('[recommend] DeepSeek ranking failed, falling back to TMDB order:', err.message);
    return candidates.map((c, i) => ({ ...c, score: 100 - i }));
  }
}

async function run(userId = 'default') {
  const db = init();

  const seedTitles = db.prepare(`
    SELECT title FROM items WHERE user_id = ? AND title IS NOT NULL LIMIT 15
  `).all(userId).map((r) => r.title);

  const candidates = await gatherCandidates(db, userId);
  const ranked = await rankWithDeepSeek(candidates, seedTitles);

  const upsert = db.prepare(`
    INSERT INTO recommendations_cache (user_id, imdb_id, type, title, score, reason)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, imdb_id) DO UPDATE SET
      score = excluded.score, reason = excluded.reason, updated_at = datetime('now')
  `);

  for (const c of ranked) {
    // recommendations_cache is keyed by imdb_id; TMDB gives us tmdb_id, so
    // resolve it (external_ids endpoint) before caching.
    try {
      const details = c.type === 'movie'
        ? await tmdb.getMovieDetails(c.tmdbId)
        : await tmdb.getShowDetails(c.tmdbId);
      const imdbId = details.external_ids?.imdb_id || details.imdb_id;
      if (imdbId) upsert.run(userId, imdbId, c.type, c.title, c.score || 0, c.reason || '');
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
