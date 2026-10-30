FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends libimage-exiftool-perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./

# Built only by scripts/deploy.sh: a failing test fails the deploy
FROM base AS test
RUN npm ci
COPY . .
RUN npm test

FROM base AS production
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY views ./views
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
