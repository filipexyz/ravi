# Claude Code Provider Checks

## Required Tests

- SSH and NATS spawn factories strip both SDK encodings of local plugin paths
  and setting sources, preserving following model/effort/output arguments;
  verify with `bun test src/remote-spawn.test.ts src/remote-spawn-nats.test.ts`.
- Stream delta maps to `text.delta`.
- Assistant text maps to `assistant.message`.
- Assistant tool-use maps to `tool.started`.
- User tool-result maps to `tool.completed`.
- Success result maps to `turn.complete` with session state and usage.
- Non-success result maps to recoverable `turn.failed`.
- Query exception maps to recoverable `turn.failed`.
- `setModel` updates active query when possible and always affects next query.
- A live provider session snapshots the current Ravi env for every query: a
  rotated `RAVI_CONTEXT_KEY` appears on the next turn, removed managed values do
  not survive, and the Claude session id is still resumed.
- Resume session id is read from `RuntimeSessionState.params`.
- Fork is passed only when requested by session continuity.
- A real POSIX shell preserves a single auth token and multiple forwarded auth,
  context and gateway values read from stdin, including shell metacharacters,
  backslashes and literal `\\n` sequences; a value with a real newline is
  refused, and no forwarded value appears in the ssh argv or the ssh child env.
- A loopback SSH agent receives the enabled daemon HTTP gateway URL; an
  unrelated remote host does not receive an inferred loopback URL.
- An explicit gateway URL takes precedence, invalid HTTP ports do not create a
  URL, and unrelated secrets never enter the forwarded environment.
- Gateway derivation follows the listener's configuration precedence: an
  explicitly empty HTTP port disables fallback to the webhook port, and HTTP
  and webhook host values are trimmed before selecting the IPv6 loopback URL.

## Model Compatibility Acceptance

- `bun test src/runtime/claude-provider.test.ts src/runtime/model-catalog.test.ts`
  covers unchanged selectors for `fable`, `claude-mythos-5`, and
  `claude-fable-5-2`, as well as unknown ids, future versions and names that
  contain `sonnet`, `opus` or `haiku`. Surrounding whitespace is trimmed.
- Missing and blank names select the provider default; unknown ids pass through
  even when a local display catalog exists. Incompatible-runtime cases retain
  their existing fallback and validation behavior.
- The same tests cover the `off`/`normal`/`verbose` adaptive thinking contract
  for Fable 5, 5-1, 5-2, future versions, the short `fable` alias, and Mythos.
  Sonnet and lookalikes such as `claude-fableish-5` and `my-fable-model` still
  receive disabled thinking for `off`.
- With the updated installed SDK, create a Ravi session using
  `--provider claude --model claude-fable-5-2`, send a unique response marker,
  and verify the returned text plus the session's successful terminal turn.
  Record the SDK version and tested commit in the PR; unit tests are not this
  real-session acceptance proof.

## Regression Cases

- Native interruption throws an abort-like error after Ravi requested interrupt.
- Provider emits partial text but no assistant message.
- Provider emits assistant message before a tool result.
- Provider emits result with missing usage.
- Hooks are missing for an agent that requires restricted tool access.
- Plugin attachment exists but provider capabilities are false.
- Spec server attachment exists for non-spec agents.
