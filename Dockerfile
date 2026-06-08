# D&D poll bot — Fly.io image.
# Debian (glibc) base: better-sqlite3 + bcrypt compile native addons and must
# not run against musl. Node 20 matches package.json engines (>=20).
FROM node:20-bookworm-slim

# System Chromium for whatsapp-web.js/Puppeteer + the fonts WhatsApp's web UI
# and our emoji-laced messages (🎲) need to render. Build toolchain is required
# to compile better-sqlite3 and bcrypt during `npm ci`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Use the apt Chromium, not Puppeteer's bundled download. findChromePath() in
# src/whatsapp.js probes /usr/bin/chromium, so no launch-path config is needed.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

WORKDIR /app

# Install prod deps first for layer caching; native modules build here.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# App source. Runtime state (config.json, state.db, .wwebjs_auth, logs) lives on
# the /data volume, not in the image — see docker-entrypoint.sh.
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
