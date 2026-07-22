# Ravi App failure contract v1

Every failed Ravi App operation exposes one `failure` object with `version` set to
`ravi.app.failure/v1`. The required fields are `code`, `category`, `message`,
`retryable`, and `exitCode`. Optional `details` are restricted to the sanitized
allowlist `source`, `httpStatus`, and `retryAfterSeconds`; raw child output,
credentials, paths, and upstream response bodies are not part of the contract.

## Stream and exit policy

- JSON mode writes exactly one complete public result document to stdout and no
  diagnostic text to stderr. A failure exits with `failure.exitCode`.
- Human mode writes success output to stdout and a single concise failure message
  to stderr. It uses the same non-zero `failure.exitCode` and does not append a
  second generic child-process diagnostic.
- A child failure is normalized at the router boundary. Raw child stdout/stderr
  are not copied into a public failure.

## Stable failure matrix

| Condition | Code | Category | Retryable | Exit |
| --- | --- | --- | ---: | ---: |
| Missing app operation | `APP_OPERATION_NOT_FOUND` | `not_found` | no | 2 |
| Missing Tiny required input | `TINY_INPUT_REQUIRED` | `validation` | no | 2 |
| Missing/inactive Tiny credential | `TINY_CREDENTIAL_MISSING` | `authentication` | no | 3 |
| Tiny HTTP 403 | `TINY_HTTP_FORBIDDEN` | `authorization` | no | 4 |
| Tiny HTTP 429 | `TINY_HTTP_RATE_LIMITED` | `rate_limit` | yes | 5 |
| Tiny HTTP 500 | `TINY_HTTP_SERVER_ERROR` | `upstream` | yes | 6 |
| Tiny response parse failure | `TINY_RESPONSE_PARSE_ERROR` | `protocol` | no | 7 |
| Tiny request timeout | `TINY_REQUEST_TIMEOUT` | `timeout` | yes | 8 |

`retryable` describes whether a caller may safely consider a later retry. It does
not authorize the Ravi App or Tiny client to retry automatically.
