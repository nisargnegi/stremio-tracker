// tmdb.js — thin wrapper around TMDB's free API.
// Used for: converting Stremio's imdb ids -> tmdb ids, pulling next-episode
// air dates, and generating recommendation candidates.

const fetch = require('node-fetch');

const BASE = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

async function tmdbGet(endpoint, params = {}) {
  if (!KEY) throw new Error('TMDB_API_KEY is not set in .env');
  const url = new URL(BASE + endpoint);
  url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${endpoint} failed: ${res.status}`);
  return res.json();
}

// Stremio/Cinemeta content is keyed by IMDb id. TMDB needs its own numeric id.
async function findByImdbId(imdbId) {
  const data = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  return {
    movie: data.movie_results?.[0] || null,
    tv: data.tv_results?.[0] || null,
  };
}

// append_to_response=external_ids gives us the imdb_id in one call —
// without it, TV show responses don't include imdb_id and recommendations break.
async function getShowDetails(tmdbId) {
  return tmdbGet(`/tv/${tmdbId}`, { append_to_response: 'external_ids' });
}

async function getMovieDetails(tmdbId) {
  return tmdbGet(`/movie/${tmdbId}`, { append_to_response: 'external_ids' });
}

async function getRecommendations(tmdbId, type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/${tmdbId}/recommendations`, { page });
  return data.results || [];
}

async function getSimilar(tmdbId, type) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/${tmdbId}/similar`);
  return data.results || [];
}

module.exports = { findByImdbId, getShowDetails, getMovieDetails, getRecommendations, getSimilar };

