.PHONY: quality lint typecheck build clean install dev

# Quality check - lint + typecheck (no auto-fix)
quality: lint typecheck
	@echo "✓ Quality checks passed"

# Lint with eslint (report only, no fix)
lint:
	@echo "Running eslint..."
	@bun eslint src/ --max-warnings=0

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

# Help
help:
	@echo "Available targets:"
	@echo "  quality   - Run lint + typecheck (no auto-fix)"
	@echo "  lint      - Run eslint only"
	@echo "  typecheck - Run tsc --noEmit only"
	@echo "  build     - Compile TypeScript"
	@echo "  clean     - Remove dist/"
	@echo "  install   - Install dependencies"
	@echo "  dev       - Run in dev mode"
	@echo "  daemon    - Start ravi daemon"
