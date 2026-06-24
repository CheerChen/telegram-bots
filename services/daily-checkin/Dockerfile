# Self-contained Dockerfile — build context = this directory (services/daily-checkin).
# Does not depend on pnpm workspace (daily-checkin has no workspace deps).

FROM --platform=linux/arm64 node:22-alpine AS base
WORKDIR /app

# --- deps stage: npm install (no pnpm workspace needed) ---
FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev

# --- runtime stage ---
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN chmod +x scripts/run-checkin.sh scripts/start-scheduler.sh

ENV NODE_ENV=production

WORKDIR /app

CMD ["/bin/sh", "/app/scripts/start-scheduler.sh"]
