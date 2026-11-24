---
id: voice
title: Voice Why
kind: domain
domain: voice
tags:
  - voice
  - architecture
owners:
  - ravi-dev
status: active
normative: false
---

# Why the session is the brain

Luís wants to build apps on the SDK that talk to his sessions. The sessions already hold the
workspace, the tools, the memory and the permissions. A second brain (a realtime model that answers
on its own and only sometimes calls the session) would know less, act outside the permission chain
and keep a memory nobody can read. The industry converged on the same split: GPT-Live client
delegation, Pipecat `LLMWithBackend`, LiveKit Agents "thin voice door".

# Why push-to-talk first

It needs no media infrastructure: the batch STT and the ElevenLabs TTS Ravi already uses are enough.
It also keeps the microphone closed by default, which is the safest default for a door that can
start real work.

# Why tap-only approvals

An open microphone never authenticates the speaker. A spoken "sim" from a TV, a callee or a meeting
participant must not approve a tool call.

# Why the door lives in the daemon

The daemon owns sessions, the prompt stream, approvals and the gateway. `ravi-channels` serves
native chat channels; a call is not a chat and must not write `last_channel`.

# Why a separate key for live

Codex inherits `OPENAI_API_KEY`. A voice key with spend limits must not become the coding runtime's
key, and the coding key must not pay for voice minutes.
