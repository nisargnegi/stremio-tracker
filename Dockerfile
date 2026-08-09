FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs build tools to compile its native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

VOLUME ["/app/data"]
EXPOSE 7000

# Health check — hits the public /health endpoint (no APP_SECRET required)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/index.js"]
