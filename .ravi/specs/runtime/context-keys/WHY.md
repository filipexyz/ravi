# Runtime Context Keys Rationale

## Decision

Active provider dispatch issues invocation-scoped `turn-runtime` credentials
with `authorityMode=agent-identity`. The executor agent acts through a
compartment-scoped agent identity, and each turn receives its own auditable
snapshot.

## Why Agent Identity

The previous delegated/intersection model made common operation depend on the
agent, contact, chat, and surface all carrying matching capabilities. That was
secure but too difficult to operate: a valid agent workflow could fail because
the chat had zero capabilities, and agents had to tell operators to grant long
lists of raw command ids.

Agent identity moves durable tool authority to the executor agent profile and
projects it into a compartment such as workspace, chat, DM, or automation.
Contacts and chats remain provenance, interaction policy, and compartment
selectors unless a future overlay provider explicitly constrains them.

## Capability Drift

Capabilities are snapshotted at turn issuance for audit. A grant added after a
denial must be visible on the next turn, and a revoke must stop authorizing by
the next authority check. Long-lived root contexts are not the source of truth.

To force a new snapshot, start a new turn or reset/revoke the session runtime
contexts. The next dispatch creates a fresh agent-identity `turn-runtime`
context.

## Metadata Drift

Runtime metadata can change turn to turn: model override, effort, thinking,
provider, source, approval source, actor resolution, and compartment. The
turn-scoped context records the metadata that was true when that invocation was
created.

## Lifecycle

Session reset and runtime abort are explicit lifecycle boundaries for revoking
live runtime contexts. Cleanup of historical `agent-runtime` records is an
operator action, not a daemon side effect.

## Keys At Rest

A context key is a bearer credential: whoever holds it acts with the
context's authority until expiry or revocation. Storing it in plaintext made
`ravi.db` a credential store, so a readable copy of the database (a backup, a
sync folder, a loose file mode) handed out live authority. The column now
holds a SHA-256 digest with a `kh1:` version prefix, and lookups hash the
presented key first. A generated key is `rctx_` + 18 random bytes
(`randomBytes(18)`, 144 bits, 24 base64url characters), so a fast unsalted
hash is enough: 2^144 candidates leave nothing to guess or precompute, and a
salt or KDF would only slow down every authority check. That argument holds
only for keys as random as generated ones, which is why an imported bootstrap
key (`init-admin-key --from-env`) must be at least `rctx_` + 24 characters.

Lookups hash the presented key and consult a legacy plaintext row only when no
digest matched. A plaintext twin of a hashed key (reachable only by editing
the DB by hand) therefore never shadows the digest row, and the boot
migration skips it rather than overwrite a row it did not create; the skipped
ids are logged and listed by `ravi doctor`, because a plaintext row that
survives a boot is one the operator has to revoke, not one that will fix
itself.

The migration runs at daemon boot rather than on `getDb()` because the daemon
is the single writer of live authority. If a newer CLI hashed rows while an
older daemon still compared plaintext, every live agent would lose its
authority until the daemon restarted. Lookups accept legacy plaintext rows
until boot hashes them, so a mixed-version window is safe in both directions
except for a rollback: a digest cannot be turned back into a key, so a Ravi
that compares plaintext no longer recognizes migrated keys. That costs little,
because turn and child contexts are reissued every turn and the admin
bootstrap key is re-imported from `RAVI_BOOTSTRAP_KEY`.
