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

## MCP isolation

Codex loads MCP servers from its own configuration and calls them without any Ravi decision. Registered servers reach a Codex agent through `ravi mcp tools` and `ravi mcp call` instead, so Codex's own servers are turned off at launch. The overrides follow what Codex 0.172.0 actually does: `-c mcp_servers={}` merges and clears nothing, a `-c` path cannot quote a key, and an override for a key Codex did not load stops Codex from starting, which is why untrusted project layers are left out and why unaddressable keys are refused before launch. The overrides alone are not trusted: Codex still lists a disabled server, so the status check after every thread start accepts only entries reported disabled, and an MCP tool call item fails the turn. Every uncertain case (a file Ravi cannot read, a trust rule Ravi predicts wrongly, a plugin server the overrides do not name) ends in a refused session, never in a server that runs unseen.
