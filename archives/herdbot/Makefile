# Makefile for herdbot — Telegram agent bot running on Pi via Dockge
#
# Build on Mac (Apple Silicon → linux/arm64), push to Pi's private registry,
# Dockge on Pi pulls and (re)deploys.

# Local overrides (not tracked)
-include Makefile.local

# --- Variables ---
REGISTRY_URL ?= 192.168.0.110:5000
IMAGE        := herdbot
TAG          ?= latest
FULL_IMAGE   := $(REGISTRY_URL)/$(IMAGE):$(TAG)

# Immutable tag derived from git HEAD (use via `make release-sha`)
GIT_SHA      := $(shell git rev-parse --short=12 HEAD 2>/dev/null)
SHA_IMAGE    := $(REGISTRY_URL)/$(IMAGE):$(GIT_SHA)

export REGISTRY_URL TAG

# --- Local Development ---
.PHONY: dev typecheck

dev:
	pnpm start

typecheck:
	pnpm typecheck

# --- Docker (local dev = compose.dev.yaml; production = compose.yaml, only on Pi) ---
DEV  := docker compose -f compose.dev.yaml
PROD := docker compose -f compose.yaml

.PHONY: build up down restart logs ps shell prod-up prod-down prod-logs

build:
	$(DEV) build

up:
	$(DEV) up -d

down:
	$(DEV) down

restart: down up

logs:
	$(DEV) logs -f --tail=200

ps:
	$(DEV) ps

shell:
	$(DEV) exec herdbot sh

# Convenience for running the *production* compose locally (still pulls registry image)
prod-up:
	$(PROD) up -d

prod-down:
	$(PROD) down

prod-logs:
	$(PROD) logs -f --tail=200

# --- Registry ---
.PHONY: push release release-sha image-sha verify-remote

push:
	@echo "--> Pushing $(FULL_IMAGE)"
	docker push $(FULL_IMAGE)
	@$(MAKE) image-sha --no-print-directory

release: build push
	@echo "--> Released $(FULL_IMAGE)"
	@$(MAKE) image-sha --no-print-directory

# Tag with git SHA + latest; push both. Use this when you want an immutable handle.
release-sha: build
	@if [ -z "$(GIT_SHA)" ]; then echo "Error: not in a git repo"; exit 1; fi
	@if ! git diff-index --quiet HEAD --; then \
		echo "Warning: working tree dirty; SHA tag will not represent committed state"; \
	fi
	docker tag $(FULL_IMAGE) $(SHA_IMAGE)
	docker push $(FULL_IMAGE)
	docker push $(SHA_IMAGE)
	@echo "--> Released $(FULL_IMAGE) + $(SHA_IMAGE)"
	@$(MAKE) image-sha --no-print-directory

# Print the local image identifiers — both image-ID (config blob) and repo digest (manifest).
# Repo digest is what `docker inspect` on the Pi will report; it's the comparable one.
image-sha:
	@ID=$$(docker inspect $(FULL_IMAGE) --format '{{.Id}}' 2>/dev/null); \
	DIGEST=$$(docker inspect $(FULL_IMAGE) --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null \
		| grep "^$(REGISTRY_URL)/$(IMAGE)@" | head -1); \
	echo "Local image ID:    $$ID"; \
	if [ -n "$$DIGEST" ]; then \
		echo "Local repo digest: $$DIGEST"; \
	else \
		echo "Local repo digest: <not pushed yet — run 'make push'>"; \
	fi

# Query the registry directly for the current manifest digest of $(TAG)
verify-remote:
	@DIGEST=$$(curl -sSI -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
		http://$(REGISTRY_URL)/v2/$(IMAGE)/manifests/$(TAG) \
		| awk 'tolower($$1) == "docker-content-digest:" { print $$2 }' | tr -d '\r'); \
	if [ -z "$$DIGEST" ]; then \
		echo "Remote $(FULL_IMAGE): <not found in registry>"; \
	else \
		echo "Remote repo digest: $(REGISTRY_URL)/$(IMAGE)@$$DIGEST"; \
	fi

# Show local + remote SHAs side by side (compare to detect stale push or stale Pi pull)
.PHONY: diagnose
diagnose:
	@$(MAKE) image-sha --no-print-directory
	@$(MAKE) verify-remote --no-print-directory

# --- Help ---
.PHONY: help

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Local development:"
	@echo "  dev            Run herdbot via tsx (host pnpm, not Docker)"
	@echo "  typecheck      tsc --noEmit"
	@echo ""
	@echo "Docker (local — compose.dev.yaml, builds locally):"
	@echo "  build          Build image (tags as $(FULL_IMAGE))"
	@echo "  up / down      Start / stop local dev container"
	@echo "  restart        down + up"
	@echo "  logs           Tail logs"
	@echo "  ps / shell"
	@echo ""
	@echo "Docker (production — compose.yaml, pulls registry image):"
	@echo "  prod-up        Pull registry image and run locally (smoke test deploy)"
	@echo "  prod-down / prod-logs"
	@echo ""
	@echo "Release to Pi's private registry $(REGISTRY_URL):"
	@echo "  push           docker push $(FULL_IMAGE)"
	@echo "  release        build + push (latest tag only)"
	@echo "  release-sha    build + push :latest AND :$(GIT_SHA) (immutable, recommended)"
	@echo "  image-sha      print local image digest"
	@echo "  verify-remote  query registry for the current :$(TAG) digest"
	@echo ""
	@echo "Overrides:"
	@echo "  REGISTRY_URL=$(REGISTRY_URL)"
	@echo "  TAG=$(TAG)"
