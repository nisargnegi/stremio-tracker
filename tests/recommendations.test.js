const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const policy = require('../src/recommendationPolicy');
const feedback = require('../src/recommendationFeedback');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tests-'));
process.env.DB_PATH = path.join(folder, 'tracker.db');
const { init } = require('../src/db');
const now = new Date('2026-11-08T12:00:00Z');
const movie = overrides => ({ type: 'movie', tmdbId: 1, title: 'Example', releaseDate: '2025-01-01',
  voteCount: 500, voteAverage: 8, popularity: 20, strongMatch: false, ...overrides });

function emptyDb() {
  const db = init();
  for (const table of ['items', 'watched', 'stream_events', 'ratings', 'hidden_items', 'recommendations_cache', 'recommendation_runs']) {
    db.exec(`DELETE FROM ${table}`);
  }
  return db;
}
function cached(db, id = 'tt1', user = 'default') {
  db.prepare(`INSERT INTO recommendations_cache (user_id, imdb_id, type, title, genres, tmdb_id, score)
    VALUES (?, ?, 'movie', 'Example', 'Horror', 1, 90)`).run(user, id);
}

test('vote and popularity safeguards apply to recent movies and strong matches', () => {
  assert.equal(policy.eligible(movie({ voteCount: 79, strongMatch: true }), now), false);
  assert.equal(policy.eligible(movie({ popularity: 9 }), now), false);
  assert.equal(policy.eligible(movie({ voteCount: undefined }), now), false);
  assert.equal(policy.eligible(movie(), now), true);
});
test('older movies need a strong taste connection and higher quality', () => {
  assert.equal(policy.eligible(movie({ releaseDate: '1999-01-01' }), now), false);
  assert.equal(policy.eligible(movie({ releaseDate: '1999-01-01', strongMatch: true }), now), true);
  assert.equal(policy.eligible(movie({ releaseDate: '1999-01-01', strongMatch: true, voteAverage: 7.4 }), now), false);
  assert.equal(policy.eligible(movie({ releaseDate: '1999-01-01', strongMatch: true, voteCount: 499 }), now), false);
  assert.equal(policy.eligible(movie({ releaseDate: '2027-01-01' }), now), false);
});
test('old movies never exceed 20 percent even if the model ranks them first', () => {
  const older = Array.from({ length: 100 }, (_, id) => movie({ tmdbId: id, releaseDate: '1999-01-01' }));
  const newer = Array.from({ length: 100 }, (_, id) => movie({ tmdbId: id + 100 }));
  for (const recent of [newer, newer.slice(0, 10), newer.slice(0, 1)]) {
    const rows = policy.limitOlderMovies([...older, ...recent], 100, now);
    assert.ok(rows.filter(c => !policy.isRecent(c, now)).length <= rows.length * 0.2);
  }
});
test('movie freshness does not reject older series with current seasons', () => {
  assert.equal(policy.eligible(movie({ type: 'series', releaseDate: '2005-01-01' }), now), true);
});
test('typed IDs distinguish same-name remakes and reject duplicate or invented AI rows', () => {
  const candidates = [movie(), movie({ tmdbId: 2 }), movie({ tmdbId: 1, type: 'series' })];
  const ranked = policy.matchRankedResults([null, { id: 'movie:2' }, { id: 'movie:2' },
    { id: 'series:1' }, { id: 'movie:999' }, { title: 'Example' }], candidates);
  assert.deepEqual(ranked.map(policy.candidateKey), ['movie:2', 'series:1']);
});
test('excluded identities never enter the ranking pool', () => {
  assert.deepEqual(policy.selectCandidates([movie()], new Set(['movie:1']), now), []);
});
test('taste profiles separate categories and favor rated, recent positive history', () => {
  const rows = [
    { imdb_id: 'a', tmdb_id: 1, title: 'Old favorite', rating: 5, type: 'movie', status: 'completed' },
    { imdb_id: 'b', tmdb_id: 2, title: 'Recent favorite', rating: 5, type: 'movie', last_activity: '2026-11-01', status: 'completed' },
    { imdb_id: 'c', title: 'Disliked', rating: 1, type: 'movie' },
    { imdb_id: 'd', title: 'TV favorite', rating: 5, type: 'series' },
    { imdb_id: 'e', title: 'Watchlist', type: 'movie', status: 'to_watch' },
  ];
  const profile = policy.tasteProfile(rows, [{ title: 'Seen', type: 'movie', reason: 'already_watched' }], 'Movies');
  assert.deepEqual(profile.seedTitles, ['Recent favorite', 'Old favorite']);
  assert.deepEqual(profile.disliked, ['Disliked']);
  assert.deepEqual(profile.feedback, []);
});
test('impressions count unique UTC days, deduplicate input and isolate users', () => {
  const db = emptyDb(); cached(db); cached(db, 'tt1', 'other');
  assert.equal(feedback.recordImpressions(db, 'default', ['tt1', 'tt1']), 1);
  assert.equal(feedback.recordImpressions(db, 'default', ['tt1']), 0);
  db.prepare("UPDATE recommendations_cache SET last_seen = datetime('now', '-1 day') WHERE user_id = 'default'").run();
  assert.equal(feedback.recordImpressions(db, 'default', ['tt1']), 1);
  assert.equal(db.prepare("SELECT impression_days FROM recommendations_cache WHERE user_id='default'").get().impression_days, 2);
  assert.equal(db.prepare("SELECT impression_days FROM recommendations_cache WHERE user_id='other'").get().impression_days, 0);
  db.exec("UPDATE recommendations_cache SET impression_days = 100 WHERE user_id='default'");
  assert.equal(db.prepare(`SELECT score - (${feedback.IMPRESSION_PENALTY}) AS score FROM recommendations_cache WHERE user_id='default'`).get().score, 82);
  db.close();
});
test('dismissal stores genre and identity feedback atomically, preserving another user', () => {
  const db = emptyDb(); cached(db); cached(db, 'tt1', 'other');
  feedback.dismissRecommendation(db, 'default', 'tt1', 'Example', 'wrong_genre');
  const row = db.prepare('SELECT * FROM hidden_items').get();
  assert.equal(row.reason, 'wrong_genre'); assert.equal(row.genres, 'Horror'); assert.equal(row.tmdb_id, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recommendations_cache').get().n, 1);
  feedback.dismissRecommendation(db, 'default', 'tt1', 'Example', 'already_watched');
  assert.equal(db.prepare('SELECT * FROM hidden_items').get().tmdb_id, 1);
  assert.throws(() => feedback.dismissRecommendation(db, 'default', 'tt1', '', 'invalid'));
  db.close();
});
test('existing schemas migrate without losing feedback and imported ratings retain their scale', () => {
  const db = emptyDb();
  db.prepare("INSERT INTO ratings (imdb_id,rating,rated_at) VALUES ('tt1',4,'2020-01-01T00:00:00Z'),('tt2',4,'2026-11-01 00:00:00')").run();
  db.close();
  const migrated = init();
  assert.equal(migrated.prepare("SELECT rating * 5.0 / rating_scale AS rating FROM ratings WHERE imdb_id='tt1'").get().rating, 2);
  assert.equal(migrated.prepare("SELECT rating * 5.0 / rating_scale AS rating FROM ratings WHERE imdb_id='tt2'").get().rating, 4);
  migrated.close();
});

// Mock external services for a complete refresh. No credentials or external API calls are used.
const tmdb = require('../src/tmdb');
tmdb.sleep = async () => {};
let aiResponse = [];
let aiCandidates = [];
let onAiResponse = () => {};
const fetchFile = require.resolve('node-fetch');
require.cache[fetchFile].exports = async (url, options) => {
  const prompt = JSON.parse(options.body).messages[0].content;
  const encoded = prompt.split('Candidates (JSON):\n')[1].split('\nReturn a JSON')[0];
  aiCandidates.push(...JSON.parse(encoded));
  onAiResponse();
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(aiResponse) } }] }) };
};
const recommend = require('../src/recommend');

test('AI outage or missing key still returns guarded, useful recommendations', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const result = await recommend.rankChannelWithDeepSeek([movie()], 'Movies', { seedTitles: [], highlyRated: [], disliked: [], feedback: [] });
  assert.equal(result.length, 1); assert.ok(result[0].score > 0);
});
test('full refresh excludes watched and hidden titles before AI and replaces stale cache rows', async () => {
  const db = emptyDb();
  db.prepare("INSERT INTO items (imdb_id, tmdb_id, type, title, status, rating) VALUES ('tt-seed',10,'movie','Favorite','completed',5)").run();
  db.prepare("INSERT INTO hidden_items (imdb_id,title,reason) VALUES ('tt-hidden','Hidden','not_interested')").run();
  db.prepare("INSERT INTO recommendations_cache (imdb_id,type,title,score) VALUES ('tt-stale','movie','Stale',999)").run();
  db.prepare("INSERT INTO recommendations_cache (imdb_id,type,title,is_anime,score) VALUES ('tt-legacy-anime-film','movie','Legacy animated film',1,999)").run();
  db.close();
  const year = new Date().getUTCFullYear();
  const raw = [10, 20, 30].map(id => ({ id, title: 'Same title', release_date: `${year - 1}-01-01`,
    vote_count: 1000, vote_average: 8, popularity: 50, genre_ids: [28] }));
  tmdb.getRecommendations = async (id, type) => type === 'movie' ? raw : [];
  tmdb.getSimilar = async () => [];
  tmdb.getTrending = async type => type === 'movie' ? raw : [];
  tmdb.discover = async type => type === 'movie' ? raw : [];
  tmdb.getPopular = async () => [];
  tmdb.getTopRated = async () => [];
  tmdb.getNowPlayingOrOnAir = async () => [];
  tmdb.getMovieDetails = async id => ({ imdb_id: id === 10 ? 'tt-seed' : id === 20 ? 'tt-hidden' : 'tt-new', genres: [{ name: 'Action' }] });
  process.env.DEEPSEEK_API_KEY = 'test-only'; aiResponse = [{ id: 'movie:30', reason: 'Matches Favorite' }]; aiCandidates = [];
  await recommend.run();
  assert.deepEqual(aiCandidates.map(c => c.id), ['movie:30']);
  const result = init();
  assert.deepEqual(result.prepare('SELECT imdb_id FROM recommendations_cache').all(), [{ imdb_id: 'tt-new' }]);
  assert.equal(result.prepare('SELECT COUNT(*) AS n FROM recommendation_runs').get().n, 0);
  result.close();
});
process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));

test('dashboard script compiles and dismissal choices remain available', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new (require('node:vm').Script)(script);
  for (const reason of feedback.DISMISSAL_REASONS) assert.ok(html.includes(`submitDismissal('${reason}')`));
});

test('HTTP feedback and impression entry points preserve legacy callers', async () => {
  const db = emptyDb(); cached(db); db.close();
  const net = require('node:net');
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const secret = 'recommendation-test-only-secret-1234567890';
  const child = require('node:child_process').spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, APP_SECRET: secret, PORT: String(port) }, stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch (_) {}
      if (up) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(up, 'Test server must start');
    const post = (route, data) => fetch(`${base}/${secret}/api/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    assert.equal((await (await post('impression', { imdbIds: ['tt1', 'tt1'] })).json()).count, 1);
    assert.equal((await (await post('impression', { imdbIds: ['tt1'] })).json()).count, 0);
    assert.equal((await post('hide', { imdbId: 'tt1', reason: 'bad-reason' })).status, 400);
    assert.equal((await post('hide', { imdbId: 'tt1', title: 'Legacy request' })).status, 200);
    const result = init();
    assert.equal(result.prepare("SELECT reason FROM hidden_items WHERE imdb_id='tt1'").get().reason, 'not_interested');
    result.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
});

test('ratings on recommendation cards retain their taste metadata after cache replacement', () => {
  const db = emptyDb(); cached(db);
  feedback.recordRating(db, 'default', 'tt1', 5);
  db.prepare('DELETE FROM recommendations_cache').run();
  const row = db.prepare('SELECT * FROM ratings').get();
  assert.equal(row.title, 'Example'); assert.equal(row.type, 'movie'); assert.equal(row.tmdb_id, 1);
  assert.equal(row.rating_scale, 5);
  const profile = policy.tasteProfile([{ ...row, status: 'rated' }], [], 'Movies');
  assert.deepEqual(profile.highlyRated, ['Example']);
  db.close();
});


test('feedback arriving during AI ranking cannot reappear in the published cache', async () => {
  const db = emptyDb();
  db.prepare("INSERT INTO items (imdb_id,tmdb_id,type,title,status,rating) VALUES ('tt-seed',10,'movie','Favorite','completed',5)").run();
  db.close();
  onAiResponse = () => {
    const connection = init();
    feedback.dismissRecommendation(connection, 'default', 'tt-new', 'Changed my mind', 'not_interested');
    connection.close();
  };
  try {
    await recommend.run();
    const connection = init();
    assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM recommendations_cache WHERE imdb_id='tt-new'").get().n, 0);
    connection.close();
  } finally { onAiResponse = () => {}; }
});

test('simultaneous refreshes cannot overwrite one another', async () => {
  const db = emptyDb();
  db.prepare("INSERT INTO recommendation_runs (user_id,token) VALUES ('default','existing-run')").run();
  db.close();
  await assert.rejects(recommend.run(), /already running/);
  const connection = init();
  assert.equal(connection.prepare('SELECT token FROM recommendation_runs').get().token, 'existing-run');
  connection.close();
});
