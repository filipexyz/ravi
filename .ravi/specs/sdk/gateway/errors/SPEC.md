---
id: sdk/gateway/errors
title: "Gateway error observability"
kind: feature
domain: sdk
capability: gateway
feature: errors
tags:
  - errors
  - observability
applies_to:
  - src/sdk/gateway
  - src/cli/agent-contract.ts
  - src/cli/remote-gateway.ts
  - packages/ravi-os-sdk/src/errors.ts
owners:
  - dev
status: draft
normative: true
---

# Gateway error observability

- Every gateway HTTP 4xx/5xx MUST carry the canonical error envelope: `success:false`, `op`, `exitCode`, `outcome`, and `error:{code,message,retryable,suggestedAction,requestId}`.
- Request ids MUST be server-generated UUIDs, isolated across concurrent requests, also exposed as `x-request-id`. Caller-supplied ids MUST NOT be trusted or logged.
- Validation MUST identify fields in `issues[].path`; missing required handler flags (`--flag is required`) MUST additionally carry `field`, `argument`, `VALIDATION_ERROR`, exit 2 and HTTP 422. Schema/body usage errors remain HTTP 400, exit 2.
- CLI and SDK MUST preserve correlation ids and typed field/argument information. The CLI MUST show the request id in text mode as well as JSON mode.
- Local CLI/tool failures without an HTTP request MUST identify the operation without asking for a nonexistent request id. The gateway adds correlation-specific copy with the server-generated id.
- Public expected error messages and suggested actions MUST survive the common remote boundary after bounded sanitization. Arbitrary provider bodies, exception properties, stacks, credentials and secret-bearing paths MUST NOT cross it.
- Generic fallbacks `Remote command failed` and `Inspect redacted remote logs` MUST NOT be rendered. Unusable upstream errors MUST identify the operation, code/status and a concrete next action.
- Unexpected failures before, during or after handler execution MUST produce HTTP 500 with a safe envelope. They MUST NOT escape into Bun's unstructured error response.
- Internal error logs MUST retain bounded stack frames and cause chains, correlated by requestId and operation. They MUST NOT copy inputs, headers, argv or arbitrary exception properties, and MUST redact credential tokens, secret assignments and URLs.
- Diagnostics MUST emit the first occurrence at error level, suppress identical repeats for 60 seconds, and include the suppression count on the next emitted occurrence. The cache MUST be bounded (256 signatures). A suppressed response MUST carry `diagnosticRequestId` pointing to the emitted first occurrence. Repeated access logs MUST NOT defeat suppression.
- Validation MUST be non-retryable. Unexpected errors and malformed responses MUST NOT encourage automatic write retries: execution may already have occurred.
