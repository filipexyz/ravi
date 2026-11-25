# Ravi hands-free voice worker

A LiveKit Agents (Node) worker for `handsfree` calls. It joins the call's room,
turns speech into text and sends it to the call, and speaks each reply the call
emits. It never thinks or decides: the Ravi session is the brain, and the
worker key can only serve hands-free calls (it cannot approve, cancel or end).

```bash
ravi voice devices pair --worker --contact <owner> --label livekit --execute   # prints the key once
export RAVI_BASE_URL=... RAVI_VOICE_WORKER_KEY=...
export LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...
export OPENAI_API_KEY=... ELEVEN_API_KEY=...
npm install && npm run start
```

The daemon needs the same `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` to mint room tokens. Status: written against
`@livekit/agents` 1.10; not run in CI.
