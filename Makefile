# Common development commands for the EasyCode workspace.

.DEFAULT_GOAL := help

PNPM ?= pnpm
DOCKER_COMPOSE ?= docker compose
POSTGRES_URL ?= postgres://easycode:easycode@localhost:5432/easycode
ARGS ?=

.PHONY: help install build typecheck lint test test-e2e contracts-generate contracts-check dev-lan dev-server dev-desktop dev-mobile mobile-preview desktop-inspect docker-up docker-down docker-logs migrate-postgres flutter-analyze flutter-test clean

help: ## Show available make commands.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make <command>\n\nCommon commands:\n"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install pnpm workspace dependencies.
	$(PNPM) install

build: ## Build the full TypeScript workspace.
	$(PNPM) build

typecheck: ## Run TypeScript type checks across the workspace.
	$(PNPM) typecheck

lint: ## Run workspace lint checks.
	$(PNPM) lint

test: ## Run unit tests and script tests.
	$(PNPM) test

test-e2e: ## Build the project and run the end-to-end smoke test.
	$(PNPM) test:e2e

contracts-generate: ## Regenerate protocol JSON Schema and relay OpenAPI files.
	$(PNPM) contracts:generate

contracts-check: ## Check that protocol JSON Schema and OpenAPI files are in sync.
	$(PNPM) contracts:check

dev-lan: ## Start the relay, mobile web client, and desktop agent together; pass extra args with ARGS="--adapter codex".
	$(PNPM) dev:lan -- $(ARGS)

dev-server: ## Start the local relay server development process.
	$(PNPM) dev:server -- $(ARGS)

dev-desktop: ## Start the desktop agent development process; pass extra args with ARGS="--adapter mock --server http://localhost:8787".
	$(PNPM) dev:desktop -- $(ARGS)

dev-mobile: ## Start the mobile web Vite development server.
	$(PNPM) dev:mobile -- $(ARGS)

mobile-preview: ## Preview the production mobile web build.
	$(PNPM) --filter @easycode/mobile-web preview -- $(ARGS)

desktop-inspect: ## Run the desktop agent macOS accessibility inspection tool.
	$(PNPM) --filter @easycode/desktop-agent inspect -- $(ARGS)

docker-up: ## Build and start relay, PostgreSQL, and Redis with Docker Compose.
	$(DOCKER_COMPOSE) up --build

docker-down: ## Stop and remove Docker Compose service containers.
	$(DOCKER_COMPOSE) down

docker-logs: ## Follow Docker Compose service logs.
	$(DOCKER_COMPOSE) logs -f

migrate-postgres: ## Run relay database migrations against local PostgreSQL; override the connection string with POSTGRES_URL=...
	EASYCODE_POSTGRES_URL="$(POSTGRES_URL)" $(PNPM) --filter @easycode/relay-server migrate:postgres

flutter-analyze: ## Run static analysis in the Flutter mobile app.
	cd apps/mobile-flutter && flutter analyze

flutter-test: ## Run Flutter tests in the Flutter mobile app.
	cd apps/mobile-flutter && flutter test

clean: ## Remove TypeScript and Vite build artifacts.
	rm -rf apps/*/dist apps/mobile-web/dist apps/mobile-web/dist-test packages/*/dist
