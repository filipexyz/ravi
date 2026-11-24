# Checks: session clone

- `src/sessions/clone.test.ts`: name rules; credential masking; one fenced line per message (a copied `[System]` line cannot start a line); dry-run writes nothing; execute provisions for the same agent, creates the session under the provisioner's key and seeds it in the new chat, origin untouched; refusals (invalid, taken, unbound, unsupported) before any write; provisioning failure creates nothing; a seed failure names the chat that exists.
- `src/channels/slack/session-clone-provisioner.test.ts`: private channel routed to the agent, only Slack user ids invited; failed invite reported; unrouted channel, missing id and invisible route refused.
- `src/chat-commands/engine.test.ts` (`clone <name>`): grammar; access to the session and the clone command's capability are both asked; refused without either and without mutating metadata; core refusals said as facts.
- `src/channels/slack/slash-command-clone.test.ts`: Slack asks what the CLI declares for `sessions clone` (mutate, confirmed); results and refusals worded; help lists `clone`.
- Mutants killed: removing the name-taken check, the line flattening, the unsupported-channel refusal, the session access check for clone, the clone command capability, the Slack invite filter and the route check each fail a test.
