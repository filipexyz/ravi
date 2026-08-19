#!/usr/bin/env bash
# Cloud Agent install: idempotent dependency + toolchain refresh for Ravi.
# Runs after the repository is checked out. Must terminate and be safe to re-run.
set -euo pipefail

echo "==> Ravi Cloud Agent install"

# --- Bun (required runtime; package.json engines.bun >= 1.0.0) --------------
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
if ! "$BUN_INSTALL/bin/bun" --version >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$BUN_INSTALL/bin:$PATH"

# Make bun/bunx available to every shell (interactive, start, terminals).
sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun 2>/dev/null || true
sudo ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx 2>/dev/null || true
echo "==> Bun $(bun --version)"

# --- nats-server (embedded JetStream event bus the daemon connects to) ------
# Pin a canonical location on the global PATH so start/terminals always find it.
NATS_VERSION="v2.10.22"
NATS_BIN="/usr/local/bin/nats-server"
if [ ! -x "$NATS_BIN" ]; then
  if command -v nats-server >/dev/null 2>&1; then
    sudo install -m 0755 "$(command -v nats-server)" "$NATS_BIN"
  else
    echo "==> Installing nats-server ${NATS_VERSION}"
    case "$(uname -m)" in
      x86_64) NARCH=amd64 ;;
      aarch64 | arm64) NARCH=arm64 ;;
      *) NARCH=amd64 ;;
    esac
    TMP="$(mktemp -d)"
    curl -fsSL "https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-linux-${NARCH}.tar.gz" -o "$TMP/nats.tgz"
    tar -xzf "$TMP/nats.tgz" -C "$TMP"
    sudo install -m 0755 "$TMP/nats-server-${NATS_VERSION}-linux-${NARCH}/nats-server" "$NATS_BIN"
    rm -rf "$TMP"
  fi
fi
mkdir -p "$HOME/.ravi/bin"
cp -f "$NATS_BIN" "$HOME/.ravi/bin/nats-server" 2>/dev/null || true
echo "==> nats-server $("$NATS_BIN" --version)"

# --- JavaScript dependencies + CLI/daemon bundle ----------------------------
echo "==> bun install"
bun install --frozen-lockfile

echo "==> bun run build"
bun run build

echo "==> Ravi install complete"
