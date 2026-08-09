FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs build tools to compile its native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

VOLUME ["/app/data"]
EXPOSE 7000

CMD ["node", "src/index.js"]
