# Makefile for daily-checkin — Slack check-in bot running on Pi via Dockge
#
# Deploys via rsync (source to Pi) + docker compose up --build on the Pi.
# Unlike clawbot/stake-odds, this service does NOT use the private registry.

PI_HOST ?= pi
STACK_DIR ?= /opt/stacks/daily-checkin
SERVICE ?= daily-checkin

RSYNC_OPTS := -avz --no-owner --no-group --rsync-path="sudo rsync"

.PHONY: pi-deploy pi-test pi-logs auth typecheck

# Sync source files to the Pi stack dir, then rebuild + restart the container.
# Skips .env and state/ — those are maintained on the Pi.
pi-deploy:
	rsync $(RSYNC_OPTS) Dockerfile compose.yaml package.json tsconfig.json $(PI_HOST):$(STACK_DIR)/
	rsync $(RSYNC_OPTS) src/ $(PI_HOST):$(STACK_DIR)/src/
	rsync $(RSYNC_OPTS) --delete scripts/ $(PI_HOST):$(STACK_DIR)/scripts/
	ssh $(PI_HOST) 'cd $(STACK_DIR) && sudo docker compose up -d --build'
	ssh $(PI_HOST) 'cd $(STACK_DIR) && sudo docker compose ps && sudo docker compose logs --tail=20 $(SERVICE)'

# Run a one-shot check-in inside the container (bypasses scheduler window).
pi-test:
	ssh $(PI_HOST) 'cd $(STACK_DIR) && sudo docker compose run --rm $(SERVICE) ./scripts/run-checkin.sh'

pi-logs:
	ssh $(PI_HOST) 'cd $(STACK_DIR) && sudo docker compose logs --tail=200 -f $(SERVICE)'

# Local: interactive MSAL login to generate/refresh token cache.
# Run on Mac, then scp state/.msal_cache.json to the Pi.
auth:
	npx tsx src/auth.ts

typecheck:
	pnpm typecheck
