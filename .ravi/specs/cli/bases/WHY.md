# Bases agent-first CLI contract / WHY

Bases are shared, project-scoped data. Agents read and write them on behalf of
people, so the CLI has to be safe to retry, explicit about concurrency, and
honest about who decides access.

- Transport only. View policy, filters, and authorization are decided by the
  Console for every caller. If the CLI evaluated any of it, a CLI bug could
  leak rows a view hides. Keeping specs opaque also lets the Console evolve the
  Query AST and view model without an OSS release.
- Idempotency on every row write. Agents retry on timeouts. A per-call key in
  both the header and the body makes a retry replay the first result instead
  of creating a second row. Import derives keys from the file and mapping, so
  re-running the same command after a failure resumes safely.
- Explicit concurrency for rows. Rows are edited by people through generated
  Ravi Pages and by agents at the same time. Requiring `--expected-version` or an explicit
  `--last-write-wins` makes overwrites a visible choice, and the conflict
  response carries the current row so the agent can merge.
- Brakes where the blast radius is large. Purge is irreversible; archiving a
  base, view, or chart breaks Pages and charts that depend on it; type changes
  and property deletes migrate data. Row add/update/archive stay unbraked
  because they are versioned, restorable, and frequent.
- The 409 fix. The shared Console client used to read any 409 as
  "authentication pending", which would have turned every version conflict
  into a retry loop. The pending meaning now applies only to the login flow.
- Scope hint. Bases introduced new OAuth scopes. Existing logins fail with an
  access error that looks like a permission problem; naming the missing scopes
  and `ravi login` saves a support round-trip.
- No Console UI. Bases is backend only: the useful screen differs per team,
  and an agent can generate exactly that screen as a Ravi Page over a view.
  The view stays the single access contract for pages, agents, and exports,
  and `--uses` makes each page's reach explicit at ship time.
- Events reuse the inbox bridge. Bases row events are inbox items with
  `category: "bases"`, so triggers filter them with the existing predicate
  grammar and no new NATS subject has to be secured or documented.
