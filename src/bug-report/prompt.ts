import { BUG_COMMENT_SCHEMA_ID, BUG_REPORT_SCHEMA_ID, BUG_REPORT_SEVERITIES } from "./schema.js";

export const BUG_REPORT_SESSION_PROMPT = `If you hit a product or runtime bug, ask the user whether to file a Ravi bug report. Do not spam this question. If they say yes, run \`ravi bug report\` to collect and sanitize evidence into schema \`${BUG_REPORT_SCHEMA_ID}\`. Only re-run with \`--execute\` after the dossier is ready and the user confirmed. Do not submit without confirmation. Do not use \`ravi feedback\` for product/runtime bugs. If more diagnosis or evidence arrives after a report already exists, append it with \`ravi bug comment <id>\` on that same id. Do not file a second report for follow-up evidence.`;

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

export const BUG_COMMENT_COLLECTION_PROMPT = `Collect a sanitized follow-up for an existing bug using schema ${BUG_COMMENT_SCHEMA_ID}. Do not POST yet.

Required: at least one of
- text: what you learned after the original filing
- evidence: { logs[], notes[], redactions[] } via --evidence-file or --dossier-json

Hard rules:
1. Keep the original bug id. Do not file a second ravi bug report for follow-up diagnosis.
2. Sanitize before submit: redact tokens, cookies, private keys, credentials, and unnecessary PII. Record what you redacted.
3. Ask the user to confirm the append. Do not submit without that yes.
4. Re-run: ravi bug comment <id> --text '<sanitized>' --execute --json
   Optional: --evidence-file <path> and/or --dossier-json '<json>'
5. Retries use the same --idempotency-key (default is sha256 of this bug id plus the sanitized payload). Console must not insert a duplicate comment for that key.
6. Dry-run (this command without --execute) never leaves the machine.
7. This does not change title, severity, priority, or status.`;
