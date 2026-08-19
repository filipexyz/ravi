#!/usr/bin/env bash
# Cloud Agent start: per-boot reconciliation. Brings up the NATS JetStream
# event bus the Ravi daemon connects to. Idempotent; returns once NATS is ready.
set -euo pipefail

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="/usr/local/bin:$BUN_INSTALL/bin:$PATH"

NATS_PORT="${NATS_PORT:-4222}"

nats_up() { (exec 3<>"/dev/tcp/127.0.0.1/${NATS_PORT}") 2>/dev/null; }

if nats_up; then
  echo "==> nats-server already running on 127.0.0.1:${NATS_PORT}"
  exit 0
fi

mkdir -p "$HOME/.ravi/jetstream"
echo "==> starting nats-server (JetStream) on 127.0.0.1:${NATS_PORT}"
nohup nats-server -js -sd "$HOME/.ravi/jetstream" -p "${NATS_PORT}" \
  >"$HOME/.ravi/nats-server.log" 2>&1 &

for _ in $(seq 1 40); do
  if nats_up; then
    echo "==> nats-server ready on 127.0.0.1:${NATS_PORT}"
    exit 0
  fi
  sleep 0.25
done

echo "!! nats-server did not become ready; see $HOME/.ravi/nats-server.log" >&2
exit 1
