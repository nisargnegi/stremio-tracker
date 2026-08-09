// notify.js — sends a push notification via whichever channel is configured.
// Both options are free; pick one in .env.

const fetch = require('node-fetch');

async function notify(message) {
  const jobs = [];

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    jobs.push(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    }));
  }

  if (process.env.NTFY_TOPIC) {
    jobs.push(fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: 'POST',
      body: message,
    }));
  }

  if (jobs.length === 0) {
    console.warn('[notify] No TELEGRAM_* or NTFY_TOPIC configured — skipping:', message);
    return;
  }

  await Promise.allSettled(jobs);
}

module.exports = { notify };
