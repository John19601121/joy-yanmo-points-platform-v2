FROM node:24-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY schema.sql server.js ./
COPY scripts ./scripts
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/app.sqlite

RUN mkdir -p /data

EXPOSE 3000

CMD ["sh", "-c", "node scripts/init-db.js && node server.js"]
