# Build context = repo root (set in compose.yaml)
# Target platform = linux/arm64 (Raspberry Pi 4+)

FROM --platform=linux/arm64 node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
WORKDIR /app

# --- deps stage: install only clawbot's dep tree ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/ilink/package.json packages/ilink/
COPY packages/shared/package.json packages/shared/
COPY bots/clawbot/package.json bots/clawbot/
COPY bots/katakana/package.json bots/katakana/
COPY bots/xvideo/package.json bots/xvideo/
COPY bots/ctxd/package.json bots/ctxd/
RUN pnpm install --frozen-lockfile --filter clawbot...

# --- runtime stage: only clawbot + ilink sources ---
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/ilink/node_modules ./packages/ilink/node_modules
COPY --from=deps /app/bots/clawbot/node_modules ./bots/clawbot/node_modules
COPY tsconfig.base.json package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ilink ./packages/ilink
COPY bots/clawbot ./bots/clawbot

ENV NODE_ENV=production \
    CLAW_PORT=8080 \
    CLAW_HOST=0.0.0.0 \
    CLAW_DATA_DIR=/app/bots/clawbot/data

WORKDIR /app/bots/clawbot
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
