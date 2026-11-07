# =============================================================================
# Fluxer Chat Backend — Production Dockerfile
# =============================================================================
# Multi-stage build for minimal image size on Render's free tier.
# Optimized for Node.js with WebSocket support.
# =============================================================================

# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json ./

# Install production dependencies only
RUN npm install --omit=dev

# ── Stage 2: Production image ──────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 fluxer && \
    adduser --system --uid 1001 fluxer

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Switch to non-root user
USER fluxer

# Render uses PORT env var (default 10000 for free tier)
EXPOSE 10000

# Health check for Docker & Render
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-10000}/health || exit 1

CMD ["node", "server.js"]
