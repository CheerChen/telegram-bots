# Build context = repo root (set in compose.yaml)
# Target platform = linux/arm64 (Raspberry Pi 4+)
#
# Uses Debian (bookworm-slim) instead of alpine because ctxd's Python venv
# is created on the Pi host (glibc) and bind-mounted into the container.
# alpine's musl libc cannot run the host's glibc-linked Python binary.
#
# ctxd CLI is prepared on the Pi host (uv tool install + ~/.config/ctxd/config)
# and bind-mounted via compose.yaml. The image only needs Node + the Claude
# Agent SDK binary (bundled via npm optionalDependencies).

FROM --platform=linux/arm64 node:22-bookworm-slim AS base
# python3 is needed because ctxd's uv-managed venv symlinks to /usr/bin/python3.
# ctxd itself is bind-mounted from the Pi host, so we only need the interpreter.
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.1.0 --activate
WORKDIR /app

# --- deps stage: install herdbot's dep tree ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY services/herdbot/package.json services/herdbot/
RUN pnpm install --frozen-lockfile --filter herdbot...

# --- runtime stage ---
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/services/herdbot/node_modules ./services/herdbot/node_modules
COPY tsconfig.base.json package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY services/herdbot ./services/herdbot

# PATH includes the bind-mounted host bin dir because the agent's Bash tool
# runs bare `ctxd` (the allowedTools rule only matches the bare command).
ENV NODE_ENV=production \
    HERD_DATA_DIR=/app/services/herdbot/data \
    CTXD_BIN=/home/pi/.local/bin/ctxd \
    HOME=/root \
    PATH="/home/pi/.local/bin:${PATH}"

WORKDIR /app/services/herdbot

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
