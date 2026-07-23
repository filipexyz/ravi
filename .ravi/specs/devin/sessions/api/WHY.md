# Why Devin Session API Adapter

The API adapter exists to isolate HTTP-level concerns from CLI commands and
higher-level Ravi workflows.

## Key Decisions

- **Single boundary.** One typed client class handles all Devin HTTP access.
  No scattered fetch calls.
- **Explicit field sending.** v3 fields like `devin_mode`, `platform`, `resumable`,
  `session_secrets`, and `structured_output_required` are only included in the
  request body when explicitly provided or configured. Undefined fields are
  omitted, never defaulted by the adapter.
- **Compact request construction.** Uses `compactObject` to strip undefined/empty
  values. Never sends `null` for omitted optional fields.
- **Error classification.** HTTP status codes map to stable error codes
  (`devin.auth.invalid`, `devin.rate_limited`, etc.) for consistent upstream handling.
- **No secret leakage.** Bearer token stays in headers, never in URLs or logs.
  Session secrets are write-only (sent to API, never stored locally).
- **Idempotent creation via query param.** The upstream API accepts `devin_id`
  as a query parameter for idempotent session creation, not as a body field.

## Upstream v3 Fields (Verified)

Session creation body fields supported by upstream API v3:

| Field | Type | Notes |
|-------|------|-------|
| `prompt` | string | Required |
| `title` | string | Optional |
| `tags` | string[] | Optional |
| `devin_mode` | enum: normal, fast, lite, ultra | Optional, overrides agent mode |
| `platform` | string | Optional, org-specific VM platform |
| `resumable` | boolean | Optional, default true upstream |
| `repos` | string[] | Optional |
| `max_acu_limit` | integer | Optional |
| `playbook_id` | string | Optional |
| `child_playbook_id` | string | Optional |
| `create_as_user_id` | string | Optional, requires ImpersonateOrgSessions |
| `secret_ids` | string[] | Optional, references org secrets |
| `session_secrets` | {key,value,sensitive}[] | Optional, inline secrets (write-only) |
| `session_links` | string[] | Optional |
| `knowledge_ids` | string[] | Optional |
| `attachment_urls` | string[] | Optional |
| `bypass_approval` | boolean | Optional |
| `structured_output_schema` | object | Optional, JSON Schema Draft 7 |
| `structured_output_required` | boolean | Optional |

Query parameters:
| Field | Type | Notes |
|-------|------|-------|
| `devin_id` | string | Idempotent creation key |

## Fields NOT Supported Upstream

- `advanced_mode`: Legacy field from earlier API versions. The upstream v3 API
  uses `devin_mode` instead. The adapter preserves `advanced_mode` for backward
  compatibility but new usage should prefer `devin_mode`.
- `snapshot_id`: Referenced in earlier specs but not present in current v3 docs.
  Kept in local model for legacy data but not sent to the API.
