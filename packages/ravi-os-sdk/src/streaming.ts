// This file is now a re-export of `./streaming.generated.ts`, which is
// produced by `ravi sdk client generate` from the declarative channel
// metadata in `src/sdk/gateway/streaming/channels.ts`. The previous
// hand-written implementation drifted from the gateway every time a new
// channel was added — this layer ensures TypeScript, Swift, and any future
// client SDK share a single source of truth.
//
// Add/modify channels in the gateway; regenerate with
// `bun run sdk:generate`; `bun run sdk:check` enforces drift.
export * from "./streaming.generated.js";
