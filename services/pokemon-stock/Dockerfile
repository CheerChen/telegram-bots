# Build context = repo root (set in compose.yaml)
# Target platform = linux/arm64 (Raspberry Pi 4+)

FROM --platform=linux/arm64 node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
WORKDIR /app

# --- deps stage: install only pokemon-stock's dep tree ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY services/pokemon-stock/package.json services/pokemon-stock/
RUN pnpm install --frozen-lockfile --filter pokemon-stock...

# --- runtime stage: only pokemon-stock + shared sources ---
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/services/pokemon-stock/node_modules ./services/pokemon-stock/node_modules
COPY tsconfig.base.json package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY services/pokemon-stock ./services/pokemon-stock

ENV NODE_ENV=production \
    POKEMON_STOCK_PORT=8080 \
    POKEMON_STOCK_HOST=0.0.0.0 \
    POKEMON_STOCK_DATA_DIR=/app/services/pokemon-stock/data

WORKDIR /app/services/pokemon-stock
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
