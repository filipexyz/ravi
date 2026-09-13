import { BUG_REPORT_SCHEMA_ID, BUG_REPORT_SEVERITIES } from "./schema.js";

export const BUG_REPORT_SESSION_PROMPT = `If you hit a product or runtime bug, ask the user whether to file a Ravi bug report. Do not spam this question. If they say yes, run \`ravi bug report\` to collect and sanitize evidence into schema \`${BUG_REPORT_SCHEMA_ID}\`. Only re-run with \`--execute\` after the dossier is ready and the user confirmed. Do not submit without confirmation. Do not use \`ravi feedback\` for product/runtime bugs.`;

export const BUG_REPORT_COLLECTION_PROMPT = `Collect a sanitized bug dossier matching schema ${BUG_REPORT_SCHEMA_ID}. Do not POST yet.

Required fields:
- title: short, specific
- summary: what broke and why it matters
- severity: ${BUG_REPORT_SEVERITIES.join("|")}

Optional fields:
- surface: product surface (cli, runtime, slack, pages, ...)
- reproduction: { steps[], expected, actual, frequency }
- environment: { raviVersion, os, runtime, agentNames[] }
- evidence: { logs[], notes[], redactions[] }
- context: { organizationRef, projectRef, sessionHints }  (optional hints only; this command is GLOBAL)
- sanitization: { rulesApplied[] }

Hard rules:
1. Collect evidence first (repro, logs, environment).
2. Sanitize before submit: redact tokens, cookies, private keys, credentials, and unnecessary PII. Record what you redacted.
3. Ask the user to confirm filing. Do not submit without that yes.
4. Re-run: ravi bug report --dossier-json '<json>' --execute --json
5. Do not use ravi feedback for product/runtime bugs.
6. Dry-run (this command without --execute) never leaves the machine.`;
