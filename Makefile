.PHONY: help install dev build test test-watch lint format format-check type-check check fix clean publish

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	bun install

dev: ## Start dev server with watch mode
	bun run dev

build: ## Production build
	bun run build

test: ## Run tests
	bun run test

test-watch: ## Run tests in watch mode
	bun run test:watch

lint: ## Run ESLint
	bun run lint

format: ## Format with Prettier
	bun run format

format-check: ## Check formatting
	bun run format:check

type-check: ## TypeScript type checker
	bun run type-check

check: ## Full quality gate (lint + format + type-check + test)
	bun run check

fix: ## Lint fix + format
	bun run lint -- --fix && bun run format

clean: ## Remove dist/ and node_modules/
	rm -rf dist/ node_modules/

publish: check build ## Bump version and publish to npm (v=patch|minor|major, default: patch)
	npm version $(or $(v),patch) && npm publish
