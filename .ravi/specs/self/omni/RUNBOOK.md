# Self Transport Bridge / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get self/omni --mode rules --json`.
2. Run `ravi self context --json` (or `ravi self chat --json`) in the
   affected session and check that the chat, actor and route come from Ravi
   records, not raw transport ids.
3. If a raw JID/LID or provider id appears outside `provenance`/`debug`, find
   the semantic record that is missing (chat binding, platform identity,
   route) and report it as a gap instead of patching the output.
4. If the transport looks unavailable, check it separately:
   `ravi instances status <name>` and `ravi channels status` for WhatsApp,
   `ravi daemon status --json` (`infrastructure.legacyBridge`) for
   Telegram/Discord.

## Validation

```bash
rg -n "omni|whatsapp" src/cli/commands/self.ts
```

The command SHOULD print nothing: `ravi self` reads Ravi records and does not
import a transport directly.
