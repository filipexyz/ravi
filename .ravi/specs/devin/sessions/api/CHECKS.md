# Devin Session API Adapter Checks

## Unit Tests

```bash
bun test src/devin/client.test.ts
```

Must verify:
- Request body MUST include only explicitly provided fields
- `devin_mode`, `platform`, `resumable`, `session_secrets`, `structured_output_required`
  MUST be omitted from the payload when not set
- Idempotency key MUST be sent as query param, not body field
- Error mapping MUST produce stable codes for 401/403/404/429/422/5xx
- Base URL MUST be normalized without trailing slash
- Auth header MUST be present; credentials MUST NOT appear in the URL

## Integration Validation

```bash
ravi devin auth check --json
```

## Acceptance

- Test MUST fail if a field is sent to the API without being explicitly provided or configured
- Session secrets MUST NOT be stored locally (write-only to API)
- All error responses MUST produce typed `DevinApiError` with stable codes
- Backward compatibility: `advanced_mode` MUST still be accepted by the client
