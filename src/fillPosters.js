require('dotenv').config();
const { init } = require('./db');
const { findByImdbId } = require('./tmdb');

async function run() {
  const db = init();
  
  // Find all items missing a poster or title (usually from imports)
  const items = db.prepare(`
    SELECT imdb_id, user_id, type 
    FROM items 
    WHERE poster IS NULL OR title IS NULL OR title = ''
  `).all();

  console.log(`Found ${items.length} items missing metadata. Fetching from TMDB...`);
  
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < items.length; i++) {
    const { imdb_id: imdbId, user_id: userId, type } = items[i];
    
    try {
      const result = await findByImdbId(imdbId);
      const info = type === 'series' ? result.tv : result.movie;
      
      if (info) {
        const title = info.name || info.title || null;
        const year = parseInt((info.first_air_date || info.release_date || '').slice(0, 4)) || null;
        const tmdbId = info.id || null;
        const poster = info.poster_path ? \`https://image.tmdb.org/t/p/w300\${info.poster_path}\` : null;
        
        db.prepare(\`
          UPDATE items SET title = COALESCE(?, title), year = COALESCE(?, year), tmdb_id = COALESCE(?, tmdb_id), poster = ?
          WHERE imdb_id = ? AND user_id = ?
        \`).run(title, year, tmdbId, poster, imdbId, userId);
        
        successCount++;
        process.stdout.write(\`\\rProcessed \${i + 1}/\${items.length} (\${title || imdbId})          \`);
      } else {
        errorCount++;
      }
    } catch (err) {
      errorCount++;
      console.error(\`\\n[fillPosters] Failed for \${imdbId}: \${err.message}\`);
    }

    // Small delay to respect TMDB rate limits (50 req/sec max)
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(\`\\n\\nFinished! Successfully enriched: \${successCount}, Failed: \${errorCount}\`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
