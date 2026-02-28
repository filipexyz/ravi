.PHONY: quality lint typecheck build clean install dev docs docs-check

# Quality check - lint + typecheck (no auto-fix)
quality: lint typecheck
	@echo "✓ Quality checks passed"

# Lint with biome (report only, no fix)
lint:
	@echo "Running biome check..."
	@bunx biome check src/

# TypeScript type checking
typecheck:
	@echo "Running typecheck..."
	@bun tsc --noEmit

# Build
build:
	@echo "Building..."
	@bun run build

# Clean build artifacts
clean:
	@rm -rf dist
	@echo "Cleaned dist/"

# Install dependencies
install:
	@bun install

# Dev mode
dev:
	@bun run dev

# Run daemon
daemon:
	@bun run cli -- daemon start

# Docs dev server
docs:
	@bun run docs:dev

# Docs lint + link check
docs-check:
	@bun run check:docs

# Help
help:
	@echo "Available targets:"
	@echo "  quality   - Run lint + typecheck (no auto-fix)"
	@echo "  lint      - Run biome check only"
	@echo "  typecheck - Run tsc --noEmit only"
	@echo "  build     - Compile TypeScript"
	@echo "  clean     - Remove dist/"
	@echo "  install   - Install dependencies"
	@echo "  dev       - Run in dev mode"
	@echo "  daemon    - Start ravi daemon"
	@echo "  docs      - Start docs dev server"
	@echo "  docs-check - Lint + check doc links"
