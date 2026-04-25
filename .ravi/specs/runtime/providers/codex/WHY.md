# Codex Provider Rationale

## Why App-Server Transport

The app-server transport gives Ravi structured thread, turn, item, approval, dynamic tool, and control events. That is a better fit than one-shot CLI JSON because Ravi needs persistent sessions, queueing across turns, dynamic tools, and runtime controls.

## Why Dynamic Tools Go Through Ravi

Codex can call dynamically advertised tools, but Ravi owns the tool catalog and permissions. The provider should advertise only tools the current runtime context can use and execute them through `RuntimeHostServices`.

## Why Cwd Is Stored With Session State

Native thread ids are not enough. Resuming a thread in the wrong cwd can apply context, files, and tool calls to the wrong workspace. Codex session state therefore stores `cwd` and refuses resume when cwd differs.

## Why Fork Is Not A Capability Yet

The transport exposes native fork as a control operation, but the provider does not yet support Ravi session continuity fork semantics. Fork should become a capability only when parent/child session mapping and persistence are defined end-to-end.
