# =============================================================================
# Fluxer Chat Backend — Production Dockerfile
# =============================================================================
# Multi-stage build for minimal image size on Render's free tier.
# =============================================================================

# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

# ── Stage 2: Production image ──────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 fluxer && \
    adduser --system --uid 1001 fluxer

COPY --from=deps /app/node_modules ./node_modules

COPY . .

USER fluxer

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-10000}/health || exit 1

CMD ["node", "server.js"]
