# Self Transport Bridge / CHECKS

- A WhatsApp-originated `ravi self` context MUST show the Ravi `chat` first.
- A raw JID/LID MUST appear only under provenance/debug fields by default.
- A missing chat binding or unresolved participant MUST be reported as a gap
  with the diagnostic to run, never replaced by a raw transport id.
- `src/cli/commands/self.ts` MUST NOT import the WhatsApp runner client or the
  Omni client directly.
- A transport outage (WhatsApp runner down, legacy bridge not configured)
  MUST be reported explicitly while Ravi semantic context is still shown.
