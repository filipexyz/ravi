#!/usr/bin/env bash
# Cloud Agent install: idempotent dependency + toolchain refresh for Ravi.
# Runs from /workspace after checkout. Must terminate and be safe to re-run.
set -euo pipefail

echo "==> Ravi Cloud Agent install"

# Prefer /usr/local/bin (global, needs sudo) but degrade to ~/.local/bin so the
# script works whether or not sudo is available in the pod.
USER_BIN="$HOME/.local/bin"
mkdir -p "$USER_BIN"
export PATH="/usr/local/bin:$USER_BIN:$HOME/.bun/bin:$PATH"

have_sudo() { command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; }

# link_global <target> <linkname>: make an executable resolvable on a global PATH.
link_global() {
  local target="$1" name="$2"
  if have_sudo; then
    sudo ln -sf "$target" "/usr/local/bin/$name" 2>/dev/null && return 0
  fi
  ln -sf "$target" "$USER_BIN/$name"
}

# install_global <src> <name>: place a real binary on a global PATH.
install_global() {
  local src="$1" name="$2"
  if have_sudo && sudo install -m 0755 "$src" "/usr/local/bin/$name" 2>/dev/null; then
    return 0
  fi
  install -m 0755 "$src" "$USER_BIN/$name"
}

# --- Bun (required runtime; package.json engines.bun >= 1.0.0) --------------
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
if ! "$BUN_INSTALL/bin/bun" --version >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$BUN_INSTALL/bin:$PATH"
link_global "$BUN_INSTALL/bin/bun" bun
link_global "$BUN_INSTALL/bin/bunx" bunx
echo "==> Bun $(bun --version)"

# --- nats-server (embedded JetStream event bus the daemon connects to) ------
NATS_VERSION="v2.10.22"
if ! command -v nats-server >/dev/null 2>&1; then
  echo "==> Installing nats-server ${NATS_VERSION}"
  case "$(uname -m)" in
    x86_64) NARCH=amd64 ;;
    aarch64 | arm64) NARCH=arm64 ;;
    *) NARCH=amd64 ;;
  esac
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-linux-${NARCH}.tar.gz" -o "$TMP/nats.tgz"
  tar -xzf "$TMP/nats.tgz" -C "$TMP"
  install_global "$TMP/nats-server-${NATS_VERSION}-linux-${NARCH}/nats-server" nats-server
  rm -rf "$TMP"
fi
mkdir -p "$HOME/.ravi/bin"
cp -f "$(command -v nats-server)" "$HOME/.ravi/bin/nats-server" 2>/dev/null || true
echo "==> nats-server $(nats-server --version)"

# --- JavaScript dependencies + CLI/daemon bundle ----------------------------
echo "==> bun install"
bun install --frozen-lockfile

echo "==> bun run build"
bun run build

echo "==> Ravi install complete"
