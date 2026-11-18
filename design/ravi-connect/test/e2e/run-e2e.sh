#!/bin/sh
# Runs the two-gateway end-to-end test (see README.md). Needs bun, node and Playwright's Chromium.
#   RAVI_SRC=<Ravi source checkout with dependencies installed>   (default: the repository this folder is in)
#   TMPDIR=<where the throwaway state, homes and browser profiles go>   (deleted at the end; E2E_KEEP=1 keeps them)
# Gateways and CLI calls run with cwd = $RAVI_SRC, isolated RAVI_STATE_DIR, NATS_URL=nats://127.0.0.1:1,
# RAVI_SUPPRESS_AUDIT_EVENTS=1, bun --no-env-file, and no proxy variables. Result: e2e-result.json.
cd "$(dirname "$0")" && exec env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy node e2e.cjs
