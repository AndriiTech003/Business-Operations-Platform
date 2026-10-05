.PHONY: install infra build dev stack stop seed reseed lint typecheck test test-integration e2e smoke loadtest mcp up down clean-test-objects

install:
	pnpm install

infra:
	../devinfra/start.sh

build:
	pnpm build

dev:
	bash scripts/dev-stack.sh start && pnpm --filter @bop/web dev

stack:
	bash scripts/dev-stack.sh start

stop:
	bash scripts/dev-stack.sh stop

seed:
	pnpm seed

reseed:
	node packages/core/dist/cli/seed.js --reset

lint:
	pnpm lint && pnpm format:check

typecheck:
	pnpm typecheck

test:
	pnpm test

test-integration: build
	pnpm test:integration

e2e: build
	pnpm test:e2e

smoke:
	pnpm smoke

loadtest: build
	pnpm loadtest

mcp:
	node apps/ops-mcp/dist/main.js --http

up:
	docker compose up --build

down:
	docker compose down -v

clean-test-objects:
	node scripts/clean-test-objects.mjs
