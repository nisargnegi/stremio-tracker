// tmdb.js — thin wrapper around TMDB's free API.
// Used for: converting Stremio's imdb ids -> tmdb ids, pulling next-episode
// air dates, and generating recommendation candidates.

const fetch = require('node-fetch');

const BASE = 'https://api.themoviedb.org/3';

function key() {
  const k = process.env.TMDB_API_KEY;
  if (!k) throw new Error('TMDB_API_KEY is not set in .env');
  return k;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retries on 429 (rate limit) with Retry-After header backoff.
async function tmdbGet(endpoint, params = {}) {
  const url = new URL(BASE + endpoint);
  url.searchParams.set('api_key', key());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') || '8', 10) * 1000;
      console.warn(`[tmdb] 429 rate-limit on ${endpoint}, waiting ${wait}ms…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`TMDB ${endpoint} failed: ${res.status}`);
    return res.json();
  }
  throw new Error(`TMDB ${endpoint} failed after retries`);
}

// Stremio/Cinemeta content is keyed by IMDb id. TMDB needs its own numeric id.
async function findByImdbId(imdbId) {
  const data = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  return {
    movie: data.movie_results?.[0] || null,
    tv: data.tv_results?.[0] || null,
  };
}

// append_to_response=external_ids gives us the imdb_id in one call.
// We also request keywords so downstream code can detect anime more reliably.
async function getShowDetails(tmdbId) {
  return tmdbGet(`/tv/${tmdbId}`, { append_to_response: 'external_ids,keywords' });
}

async function getMovieDetails(tmdbId) {
  return tmdbGet(`/movie/${tmdbId}`, { append_to_response: 'external_ids' });
}

async function getRecommendations(tmdbId, type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/${tmdbId}/recommendations`, { page });
  return data.results || [];
}

async function getSimilar(tmdbId, type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/${tmdbId}/similar`, { page });
  return data.results || [];
}

async function getTrending(type, window = 'week', page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/trending/${kind}/${window}`, { page });
  return data.results || [];
}

async function getTopRated(type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/top_rated`, { page });
  return data.results || [];
}

async function getPopular(type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/popular`, { page });
  return data.results || [];
}

async function getNowPlayingOrOnAir(type, page = 1) {
  const endpoint = type === 'movie' ? '/movie/now_playing' : '/tv/on_the_air';
  const data = await tmdbGet(endpoint, { page });
  return data.results || [];
}

// Discover — filter by genre IDs, vote average, language, etc.
async function discover(type, { genreIds = [], minVote = 6.5, language = null, page = 1 } = {}) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const params = {
    page,
    'vote_average.gte': minVote,
    'vote_count.gte': 100,
    sort_by: 'vote_average.desc',
  };
  if (genreIds.length > 0) params.with_genres = genreIds.join(',');
  if (language) params.with_original_language = language;
  const data = await tmdbGet(`/discover/${kind}`, params);
  return data.results || [];
}

module.exports = {
  findByImdbId,
  getShowDetails,
  getMovieDetails,
  getRecommendations,
  getSimilar,
  getTrending,
  getTopRated,
  getPopular,
  getNowPlayingOrOnAir,
  discover,
  sleep,
};
