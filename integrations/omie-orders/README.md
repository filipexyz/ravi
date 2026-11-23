# Protected Omie order queries

This is a generic, read-only host integration. The fixed builtin
`apps.omie-orders.read` calls the packaged adapter through the existing Apps
router. A CLI app named `omie-orders` calls `host-read` with its original child
context. The host never imports executable app files and never sends credentials
to the child. There is no external handler registration API or new RPC protocol.

## Private host configuration

The operator supplies `$RAVI_STATE_DIR/integrations/omie-orders.json` (under the
normal Ravi state directory). It is host configuration, not app metadata or a
request argument. No installation defaults are built in. Missing, malformed or
changed configuration fails closed. Do not put this file in a source repository.
Keep it readable only by the daemon user (mode 0600). This trusts the daemon
filesystem and does not isolate hostile code running under the same OS user.
Use `scope.example.json` only as a field reference; every value except the generic
app id is synthetic and must be replaced by the operator's verified binding.

Fields: `app` (fixed `omie-orders`), `channelType` (which registered conversation
adapter serves the binding, e.g. `slack`), `account` (channel account), `channel`
(conversation id on that channel, checked by the adapter), `canonicalChat` (root
canonical chat), `executor` (agent id), `connection` (Omie broker connection name)
and `channelConnection` (broker connection the channel adapter uses for its
membership read, which need not equal the account). For `slack`, the channel must
use that broker connection; Hub gateway transport is not supported by this pilot.
Secrets and appHash remain exclusively
in the protected broker payload, not in this configuration. The same binding is
used by the host's identity check, membership client, exact delegation, broker
resolution and connection recheck. Configuration changes during an invocation
are refused.

Legacy (removal scheduled for 2027-01-31): a file without `channelType` that names
`slackConnection` is still read as `channelType: "slack"`. Write the current fields
in new installations.

The executor does not know any channel. The daemon registers one conversation
adapter per channel type (Slack today, `src/channels/slack/omie-conversation-authority.ts`);
a `channelType` with no adapter fails closed with `OMIE_CHANNEL_UNAVAILABLE`.

Only eight read queries are allowed: orders (`ListarPedidos`, `ConsultarPedido`,
`StatusPedido`), invoicing stages (`ListarEtapasFaturamento`), customers
(`ListarClientes`, `ConsultarCliente`) and products (`ListarProdutos`,
`ConsultarProduto`). The host owns their endpoints and classifications. Bank
details (`dadosBancarios`) are removed from every provider response.
Writes, revision enforcement and token lifecycle remain unavailable; native
reads never open the durable write ledger. The retained adapter/ledger contracts
are tested with fake effects and do not make writes operational.

## Identity and authorization

The host verifies a live app child, live ancestry to a native human turn,
persisted inbound message, canonical thread/channel, contact ownership and
contact block/opt-out. A reply destination cannot prove origin. Instance aliases
use the native resolver; conflicting owners fail closed.

Every protected call re-resolves the current contact-chat permission overlay.
A turn originally governed by that overlay remains governed even if the last
grant is removed. All query capabilities must still be allowed by both the live
contact overlay (when applicable) and the child/executor ceiling. An ungoverned
chat does not acquire an artificial contact grant requirement. Channel membership
is separately queried fresh and paginated. Permissions and identity are checked
again after awaits, before secret resolution and before Omie HTTP.

The broker's in-process `beforeResolve` callback only adds a restriction, after
approval and before secret access. CLI input cannot supply it. The broker then
rechecks the active connection and caller. The executor also rejects a replaced
connection before HTTP. A 20-second deadline bounds network work with at most
12 seconds per request. There are no automatic mutation retries.

Safe OMIE error codes survive the protected host transport. The outer Apps CLI
still returns generic `APP_OPERATION_FAILED` when its child exits nonzero; never
forward failed child stdout/stderr to recover details. Unknown exception text
is sanitized because it can contain credential payloads or private identifiers.

## Candidate client preparation

```sh
python3 integrations/omie-orders/prepare-client.py <generic-app-source> <new-candidate> --scope-file <private-scope.json>
```

The input app must already use the generic `omie-orders` id and the documented
adapter seams. Renaming an existing private app, its policy binding and commands
is an installation migration, not an implicit side effect of this script.
The script refuses symlinks and scope files inside the source, then creates a
candidate excluding known state/env/database and VCS paths. It connects
`bridge.ts` and `api/cli.ts`, and requests exact capabilities for the configured
connections. It neither installs the candidate nor grants those capabilities.
The source app's policy/executor binding must agree with the private scope.
Review that private candidate separately; it is not an artifact for publication.

Release/deployment requires separate authorization. The operator must install a
runtime with the builtin and an aligned client; validate the app manifest and
perform a real participant-originated query in the channel and a thread. Verify
safe denial outside scope and on revocation without removing a real participant
just to test. Health reporting must reflect the actual host/connection state.
This repository does not contain installation identities, authentication evidence
or production order data.

## Focused checks

`bun run test:omie-orders` is included in `test:shard-1`, which is required by the
CI Quality Gate. It runs only the integration directory under isolated-state
preload. Tests include the original adapter/provider contracts, real child CLI
transport, canonical identity, membership/permission revocation, real permission
tag removal with a retained child, secret redaction and external configuration.
Router and broker focused tests cover their shared contract separately. The full
suite and build run in CI, not on a production host.
