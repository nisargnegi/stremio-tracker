// Shared ranking rules. Keep the popularity safeguards even for strong taste matches.
const MIN_VOTES = 80;
const MIN_POPULARITY = 10;
const RECENT_YEARS = 5;
const OLDER_SHARE = 0.2;

function candidateKey(candidate) {
  return `${candidate.type}:${candidate.tmdbId}`;
}

function categoryOf(item) {
  return item.is_anime ? 'Anime' : item.type === 'movie' ? 'Movies' : 'TV Series';
}

function tasteProfile(history, feedback, category) {
  const rows = history.filter(item => categoryOf(item) === category);
  const positive = rows.filter(item => item.status !== 'dropped' && item.status !== 'to_watch' && (!item.rating || item.rating >= 3));
  positive.sort((a, b) => (b.rating || 0) - (a.rating || 0) ||
    String(b.last_activity || '').localeCompare(String(a.last_activity || '')) ||
    a.imdb_id.localeCompare(b.imdb_id));
  return {
    seeds: positive.filter(item => item.tmdb_id).slice(0, category === 'Anime' ? 10 : 15),
    seedTitles: positive.slice(0, 25).map(item => item.title).filter(Boolean),
    highlyRated: rows.filter(item => item.rating >= 4).map(item => item.title).filter(Boolean),
    disliked: rows.filter(item => item.rating && item.rating <= 2).map(item => item.title).filter(Boolean),
    feedback: feedback.filter(item => (!item.type || categoryOf(item) === category) &&
      item.reason !== 'already_watched').slice(0, 30)
      .map(item => ({ title: item.title, reason: item.reason, genres: item.genres || '' })),
  };
}

function releaseYear(candidate) {
  return Number(String(candidate.releaseDate || '').slice(0, 4)) || 0;
}

function isRecent(candidate, now = new Date()) {
  return releaseYear(candidate) >= now.getUTCFullYear() - RECENT_YEARS + 1;
}

function eligible(candidate, now = new Date()) {
  if (!(candidate.voteCount >= MIN_VOTES && candidate.popularity >= MIN_POPULARITY)) return false;
  if (candidate.type !== 'movie') return true;
  const date = candidate.releaseDate || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > now.toISOString().slice(0, 10)) return false;
  return isRecent(candidate, now) ||
    (candidate.strongMatch && candidate.voteAverage >= 7.5 && candidate.voteCount >= 500);
}

function baselineScore(candidate, now = new Date()) {
  const freshness = candidate.type === 'movie' && isRecent(candidate, now) ? 8 : 0;
  return Math.log1p(candidate.popularity) * 3 + candidate.voteAverage * 2 +
    (candidate.strongMatch ? 8 : 0) + freshness;
}

function selectCandidates(candidates, excludedKeys, now = new Date()) {
  return candidates.filter(candidate => !excludedKeys.has(candidateKey(candidate)) && eligible(candidate, now))
    .sort((a, b) => baselineScore(b, now) - baselineScore(a, now))
    .slice(0, 250);
}

function limitOlderMovies(candidates, targetCount, now = new Date()) {
  const recentCount = Math.min(targetCount, candidates.filter(c => c.type !== 'movie' || isRecent(c, now)).length);
  const olderLimit = Math.min(Math.floor(targetCount * OLDER_SHARE),
    Math.floor(recentCount * OLDER_SHARE / (1 - OLDER_SHARE)));
  let olderCount = 0;
  return candidates.filter(candidate => {
    if (candidate.type !== 'movie' || isRecent(candidate, now)) return true;
    return olderCount++ < olderLimit;
  }).slice(0, targetCount);
}

function matchRankedResults(ranked, candidates) {
  const byId = new Map(candidates.map(candidate => [candidateKey(candidate), candidate]));
  const seen = new Set();
  const results = [];
  for (const row of ranked) {
    // IDs distinguish remakes, different media types, and translated titles.
    if (!row || typeof row !== 'object') continue;
    const candidate = byId.get(String(row.id));
    if (!candidate || seen.has(candidateKey(candidate))) continue;
    seen.add(candidateKey(candidate));
    results.push({ ...candidate, reason: typeof row.reason === 'string' ? row.reason : candidate.basedOn });
  }
  return results;
}

module.exports = { candidateKey, categoryOf, tasteProfile, releaseYear, isRecent,
  eligible, selectCandidates, limitOlderMovies, matchRankedResults };
