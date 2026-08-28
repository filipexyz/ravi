---
id: sdk/gateway
title: "SDK Gateway"
kind: capability
domain: sdk
capability: gateway
capabilities:
  - gateway
  - cors
  - streaming
tags:
  - sdk
  - gateway
  - cors
  - http
applies_to:
  - src/sdk/gateway
  - src/webhooks/http-server.ts
owners:
  - dev
status: active
normative: true
---

# SDK Gateway

## Intent

The SDK gateway is the HTTP surface for generated clients. It mounts on the
daemon's single listener under `/api/v1/*` and shares auth, audit, and CORS
policy across command POSTs and SSE streams.

## Invariants

- Gateway routes MUST live under `/api/v1`.
- Command routes MUST be `POST /api/v1/<group-segments>/<command>`.
- Stream routes MUST be `GET /api/v1/_stream/<channel>`.
- CORS MUST be applied by the shared request wrapper so SSE and command
  responses receive the same headers. See `sdk/gateway/cors`.
