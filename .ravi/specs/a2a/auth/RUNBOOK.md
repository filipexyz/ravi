# A2A Authorization / RUNBOOK

## Debug Flow

1. Read the active contract:
   `ravi specs get a2a/auth --mode rules --json`.
2. Inspect the selected remote agent and security scheme. The Agent Card may
   describe auth, but the allow decision must come from Ravi policy.
3. Check the `a2a_auth_bindings` equivalent for status, tenant, allowed scopes,
   allowed skills, credential ref, and owner principal.
4. Inspect the invocation auth context for policy decision id, selected binding,
   non-secret credential fingerprint, and remote scopes.
5. Confirm no bearer token, API key, or raw secret appears in `card_json`,
   `auth_context_json`, logs, or prompt hints.

## Triage

- If a call is denied, verify caller principal, tenant, target remote agent,
  allowed skill ids, and context/task scope before changing credentials.
- If a callback URL is involved, validate that it cannot target private network
  addresses.
