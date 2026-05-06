# Codex Provider Rationale

## Why App-Server Transport

The app-server transport gives Ravi structured thread, turn, item, approval, and control events. That is a better fit than one-shot CLI JSON because Ravi needs persistent sessions, queueing across turns, runtime controls, and traceable approval handling.

## Why Ravi Commands Stay In The CLI Path

Ravi CLI registry commands are the operational interface for agents. Codex MUST NOT receive them as native dynamic tools, because that creates a second execution surface with different delivery, context, and reporting behavior.

The model should call `ravi ...` or `bin/ravi ...` through the shell. The runtime must pass `RAVI_CONTEXT_KEY` into the Codex app-server process so those CLI calls resolve identity, permissions, approvals, and report routing through the same context path as every other Ravi CLI.

If a CLI process launched from a Codex turn does not see `RAVI_CONTEXT_KEY`, the failure belongs at the runtime/tool boundary. Re-enabling Codex dynamic tools would hide that bug and split the contract again.

## Why Cwd Is Stored With Session State

Native thread ids are not enough. Resuming a thread in the wrong cwd can apply context, files, and tool calls to the wrong workspace. Codex session state therefore stores `cwd` and refuses resume when cwd differs.

## Why Fork Is Not A Capability Yet

The transport exposes native fork as a control operation, but the provider does not yet support Ravi session continuity fork semantics. Fork should become a capability only when parent/child session mapping and persistence are defined end-to-end.
