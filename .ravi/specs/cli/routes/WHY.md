# Routes read-only agent-first CLI contract / WHY

The previous surface could report a configured WhatsApp group route as absent
when the stored and queried forms differed. It also accepted arbitrary fields
and channel hints, and described an in-process calculation over persisted
configuration as a “live” check. Those failures are especially dangerous for
agents because a false absence can lead a caller toward creating a duplicate
route in the neighboring mutation domain.

The canonicalizer lives in the pure router resolver, and exact matching uses
it too. This avoids a second equivalence table that could drift away from real
routing. Glob patterns deliberately remain outside concrete simulation: a glob
describes a set, so simulating the glob text itself would manufacture evidence.

`show` remains literal by design because the stored string is route identity
for inspection and mutation compatibility. `explain` is the semantic lookup:
it tries the literal first, then one equivalent. Multiple equivalents without
an exact match are an ambiguity, not permission to pick the first database row.

Channel hints are validated from configured facts: native channel names and
providers, instance channel values, and channel values already present on
routes. This preserves valid WhatsApp/provider hints while rejecting invented
values before they can influence a verdict.

No daemon sensor was added. The result therefore says exactly what it is:
simulation using persisted config read by the command. A wall-clock timestamp
was intentionally omitted because it would date the read, not the underlying
configuration, and would break deterministic output without proving freshness.

The facade bypasses the normal lazy database initializer. A missing database
therefore remains missing, while an existing one is opened with
`readonly:true/create:false`; this prevents schema creation and migration. The
standard SQLite read path is retained because the daemon may write
concurrently. `immutable=1` would keep sidecar bytes stable but can return
incorrect data when that assumption is false. SQLite may update its `-shm`
coordination index during a safe WAL read; this is not a route-config mutation.

The live config projection now retains each route's channel. Without that
field, a simulation could honor a channel restriction that runtime routing had
silently discarded, producing a precise but operationally false explanation.

The legacy `items` plus `routes` duplication remains for compatibility. The
strict field set is supplied to the shared foundation so invalid projection
fails even on an empty page.
