# Build context = repo root (set in compose.yaml)
# Target platform = linux/arm64 (Raspberry Pi 4+)

FROM --platform=linux/arm64 node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
WORKDIR /app

# --- deps stage: install only stake-odds' dep tree ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY services/stake-odds/package.json services/stake-odds/
RUN pnpm install --frozen-lockfile --filter stake-odds...

# --- runtime stage: only stake-odds + shared sources ---
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/services/stake-odds/node_modules ./services/stake-odds/node_modules
COPY tsconfig.base.json package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY services/stake-odds ./services/stake-odds

ENV NODE_ENV=production \
    STAKE_ODDS_PORT=8080 \
    STAKE_ODDS_HOST=0.0.0.0 \
    STAKE_ODDS_DATA_DIR=/app/services/stake-odds/data

WORKDIR /app/services/stake-odds
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
