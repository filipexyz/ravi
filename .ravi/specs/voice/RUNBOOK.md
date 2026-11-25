---
id: voice
title: Voice Runbook
kind: domain
domain: voice
tags:
  - voice
owners:
  - ravi-dev
status: active
normative: false
---

# Runbook

## Turn it on

- Push-to-talk: `ELEVENLABS_API_KEY` and `GROQ_API_KEY` (or `OPENAI_API_KEY`) in `~/.ravi/.env`.
- Live: `RAVI_VOICE_OPENAI_API_KEY` (a separate OpenAI project key with a spend limit).
- Hands-free: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and the worker from
  `packages/ravi-voice-worker` running on Node 24.
- `ravi voice engines check` lists what is missing for each engine.

## A local web page

Set `RAVI_HTTP_PORT` (loopback) and `RAVI_CORS_LOCALHOST=1`, pair the browser with
`ravi voice devices pair --contact <id> --session <name> --execute`, and use the printed key with
`@ravi-os/voice`.

## A call is stuck

`ravi voice calls show <call>` and `ravi voice calls events <call>`; `ravi voice calls end <call>`
always works. A `live` call does not survive a daemon restart; start a new one.

## Reach from outside

Not through the Console relay. Run a private overlay network you own and point the gateway at it
(`RAVI_GATEWAY_NETWORK_AUTHORIZED=1`), never expose the gateway raw to the internet.
