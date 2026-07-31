# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# @discordjs/opus compiles native bindings, so build tooling is required here
# (but not in the runtime image).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we will copy forward.
RUN npm prune --omit=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# ffmpeg-static ships its own binary, but libopus/libsodium are loaded at
# runtime by the voice stack.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libopus0 libsodium23 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The cache directory must be writable by the unprivileged user.
RUN mkdir -p /app/.cache/audio && chown -R node:node /app/.cache
USER node

# No port is exposed: the bot is an outbound gateway client, not a server.
CMD ["node", "dist/index.js"]
