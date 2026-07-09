---
id: memory
title: "Memory Curation Runbook"
kind: domain
domain: memory
status: draft
---

# Memory Curation Runbook

## Enroll An Agent (Or The Whole Fleet)

```bash
# single agent
ravi memory enroll --agent <id>
# every registered agent (idempotent — safe after every deploy)
ravi memory enroll --all
```

Provisions `<agentCwd>/MEMORY.md` (cold-start stub) + `memory/` dir and registers
the global `memory-curator` Stop hook that dispatches `curador-memoria` on cadence
(default every 10 turns; `--cadence-turns <n>`, minimum 2).

## Inspect Memory Footprint

```bash
ravi memory list --json                 # who has memory, how much, last modified
ravi memory show --agent <id>           # print an agent's MEMORY.md
ravi memory show --agent <id> --topic <slug>
```

## Force A Curation Cycle Now

```bash
ravi memory curate --agent <id>            # dispatch curador-memoria immediately
ravi memory curate --agent <id> --dry-run  # propose without persisting
```

Requires `<agentCwd>/CURATOR_TRANSCRIPT.md` to exist (the Stop hook writes it from
the SQL `messages` delta; for a manual run point `--transcript <path>` at a real one).

## Route A Write Through The Guard (curator-internal)

```bash
ravi memory guard --target <abs>/MEMORY.md --candidate "<entry>" \
  --agent <id> --session-key <key> --processed-through-message-id <n>
```

The curator LLM MUST call this instead of `Write`. `--target` must resolve inside a
registered agent cwd. On a successful write it nudges the watermark forward; the
authoritative advance happens in the runtime on task `done`.

## Deploy A Runtime Change

```bash
bun run build && bun pm pack
bun add -g "$(pwd)/ravi.bot-<version>.tgz"   # bun global is what the daemon loads
ravi daemon restart -m "<reason>"            # brief WhatsApp reconnect blip
ravi daemon status --json                    # confirm online + omni back
```

## Confirm The Loop Is Live

```bash
ravi tasks list --json           # look for profileId=curador-memoria tasks
ravi memory list --json          # MEMORY.md growing past the ~40c stub = real saves
```
