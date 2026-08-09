// tmdb.js — thin wrapper around TMDB's free API.
// Used for: converting Stremio's imdb ids -> tmdb ids, pulling next-episode
// air dates, and generating recommendation candidates.

const fetch = require('node-fetch');

const BASE = 'https://api.themoviedb.org/3';

// Read key lazily (inside each call) so dotenv load order doesn't matter.
function key() {
  const k = process.env.TMDB_API_KEY;
  if (!k) throw new Error('TMDB_API_KEY is not set in .env');
  return k;
}

async function tmdbGet(endpoint, params = {}) {
  const url = new URL(BASE + endpoint);
  url.searchParams.set('api_key', key());
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

async function getSimilar(tmdbId, type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/${tmdbId}/similar`, { page });
  return data.results || [];
}

// Trending — supports 'day' or 'week' window; defaults to week.
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

// Popular — separate signal from top_rated; catches mainstream/recent hits.
async function getPopular(type, page = 1) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/${kind}/popular`, { page });
  return data.results || [];
}

// Now playing (movies) / On the air (TV) — currently releasing content.
async function getNowPlayingOrOnAir(type, page = 1) {
  const endpoint = type === 'movie' ? '/movie/now_playing' : '/tv/on_the_air';
  const data = await tmdbGet(endpoint, { page });
  return data.results || [];
}

// Discover — the most powerful TMDB endpoint. Filter by genre IDs,
// vote average, language, etc. Returns up to 20 results per page.
// genreIds: array of TMDB genre IDs (e.g. [28, 12] for Action+Adventure)
async function discover(type, { genreIds = [], minVote = 6.5, language = null, page = 1 } = {}) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const params = {
    page,
    'vote_average.gte': minVote,
    'vote_count.gte': 100, // filter out obscure titles with 1-star from 5 people
    sort_by: 'vote_average.desc',
  };
  if (genreIds.length > 0) params.with_genres = genreIds.join(',');
  if (language) params.with_original_language = language;
  const data = await tmdbGet(`/discover/${kind}`, params);
  return data.results || [];
}

// Fetch the list of all TMDB genres for a given type.
async function getGenres(type) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const data = await tmdbGet(`/genre/${kind}/list`);
  return data.genres || []; // [{ id, name }, ...]
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
  getGenres,
};
