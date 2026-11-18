# Convit Omie: protected order queries

This change prepares a **read-only** native executor. It does not activate the
installed app, create credentials, grant capabilities, confirm a production
query, or implement commercial writes / portal token management.

## What was missing

The inspected host runs Ravi `3.261102.1`. Its `ProtectedRuntime` name belongs to
`convit-omie/host/adapter.ts`, not to a Ravi registration API. The installed
client throws `OMIE_HOST_ADAPTER_REQUIRED`. `credentials broker exec` only returns
resolution metadata and remains CLI-only. Changing that command or a manifest
flag cannot provide the missing executor.

The core registers the fixed `apps.convit-omie.read` builtin in the existing Apps
router. The companion app calls `ravi apps run convit-omie host-read` with its
original child environment. The host never dynamically imports app files and
never sends credentials to the child. No new command or separate RPC protocol is
introduced.

## Scope and security

The runtime allows `ListarPedidos`, `ConsultarPedido`, `StatusPedido` and
`ListarEtapasFaturamento` from the packaged orders catalogue. Client `list`, `get`
and `stages`, `api-read`, and matching business aliases use this boundary.
Other modules, writes and token lifecycle are not enabled. The original adapter
and durable ledger contract are retained and tested with fake HTTP, but the
native read path neither opens a ledger nor accepts an approval as permission to
write. Original full-app write/revision/token callbacks still need a separate
implementation before the entire original activation brief can be called done.

The compartment is pinned by `access.ts` to this installation's app, executor,
Slack account, channel and root chat. It is deliberately not configurable through
request arguments or the app manifest. Changing installations requires reviewing
that binding; do not silently broaden it.

For every call, the host verifies a live app child, live ancestry to a native
human turn, persisted inbound message, contact ownership and current contact
policy. Session names and relay destinations cannot supply a human actor. Slack
threads are verified against their own canonical chat and persisted parent
channel, independently of the outbound reply target. Instance aliases use the
native Slack resolver and conflicting owners fail closed.

Membership is fetched fresh through the native Slack client, with pagination,
before Omie secret resolution and before Omie HTTP. After awaiting membership,
identity and permission are checked again. The broker's optional host-only
`beforeResolve` guard adds a restriction; it cannot replace capability checks or
approvals. The broker rechecks the connection and caller after that guard. The
native executor also refuses a disabled/replaced connection before HTTP.

Only exact provider/action pairs classify these queries as read-only. Credential
use and provider execution capabilities remain mandatory. Missing authority
fails closed; no grants or policy overlays are installed. The declared
`context.allow` is a ceiling: Convit's registered delegation selects just the
capabilities of the requested query, so a read does not require write authority.
The Convit child also preserves its caller's actor/surface metadata for the
existing app permission provider. Other apps retain their existing metadata
projection.

The companion permission provider still checks actor, chat surface and executor;
canonical channel/thread enforcement moves to the native handler, which can
verify the persisted graph. This avoids treating a thread's different canonical
chat id as a different authorized channel. It never makes arbitrary app code a
credential consumer.

Native network work shares a 20-second deadline and each request is bounded by
12 seconds. This fits within the existing Apps gateway budget in the normal
case; slow process startup or credential backend work can still exhaust the
outer transport budget. Calls are read-only and never become a delayed mutation.
Provider errors are sanitized; echoed credential values are stripped even under
unexpected field names.

The protected `host-read` CLI and client bridge retain safe `OMIE_*` error codes.
The outer Apps CLI wrapper still reports `APP_OPERATION_FAILED` when its CLI child
exits nonzero; this existing generic error envelope is not changed here. Failed
child stdout/stderr must not be forwarded to recover richer diagnostics.

## Prepare the client (does not install)

After a Ravi release containing this handler is available, prepare a fresh
candidate tree with the companion script:

```sh
python3 integrations/convit-omie/prepare-client.py <installed-app-directory> <new-candidate-directory>
```

The script refuses an existing output or changed activation seam, copies the
app without state/env/database files, replaces `bridge.ts`, connects `api/cli.ts`,
and adds the read-only builtin operation. It requests exact required delegation
capabilities without granting any. Review the candidate diff and validate it
against the **new installed runtime** before replacing installed app code. Keep
existing ledger/database directories and rollback copies of client code. Do not
patch the old installed bundle.

The minimum caps for a particular query include app use, Apps command access,
the exact domain read, the fixed Omie credential and provider action, and the
configured Slack credential plus `conversations.members`. Inspect actual
executor authority before rollout; this PR does not grant them. An insufficient
caller must be reported instead of expanding privileges implicitly.

## Identity readiness and production acceptance

The operational inspection matched both intended contacts' canonical
`platform_identity` records to IDs in a fresh `members-list` result. Their names
were discovery hints only; authorization uses those IDs and the actual inbound
turn. Personal identifiers stay in the private operational record, not this repo.
No context key or synthetic turn was created for them.

Release acceptance remains:

1. Deploy the reviewed runtime release and candidate client through normal
   operational deployment. Validate `ravi apps check convit-omie --json`.
2. The operator registers `omie:convit-pedidos` using the original protected
   registration flow with appHash, App Key and App Secret. No secrets in Slack,
   argv, files in this repository, or app process environment.
3. A real participant asks for an order query in the channel and in a thread.
   Verify authenticated inbound identity, current membership and the Omie answer
   returning to that conversation.
4. Verify denial from another channel and after removal/revocation. Synthetic
   tests cover both; production acceptance must not remove a real person just
   for testing without explicit authorization.
5. Only then announce availability. No order creation, invoicing, stock movement
   or payment is required for acceptance.

## Source and verification

The adapter, provider, domain, access, connection and ledger contract originated
from the existing app's reviewed host modules. `operations.json` is the generated
orders/etapas subset of that app's OpenAPI-derived catalogue, with documentation
examples removed. Endpoint and method are host-owned, never caller-provided.

Focused tests use isolated state and fake Slack/Omie. They cover real child
issuance, human origin, actual thread chat shape, alias wiring, read-only
classification, membership/permission/root revocation during awaited work,
connection replacement, secret redaction, durable deduplication, and the
companion CLI preserving child context. Full suite/build and repository-wide
static checks belong to CI. There is no live Omie authentication evidence yet.
