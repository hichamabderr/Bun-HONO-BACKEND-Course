# examples/capstone-saas-reference/Dockerfile
# Production Multi-Stage Dockerfile for Bun v1.4.2 Backend (API & Worker)

FROM oven/bun:1.4.2-alpine AS base
WORKDIR /app

# Stage 1: Install Production Dependencies Deterministically
FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2: Verify Types & Tests in CI Build Stage
FROM base AS verify
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run typecheck

# Stage 3: Minimal Non-Root Production Runtime Image
FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy only production node_modules and application source
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./package.json
COPY --chown=bun:bun src ./src

# Never run production containers as root!
USER bun

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/liveness'); process.exit(r.ok ? 0 : 1);"

CMD ["bun", "run", "src/entrypoints/api.ts"]
