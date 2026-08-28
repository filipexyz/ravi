# Pages agent-first CLI contract / WHY

Pages is the surface where a local file becomes a URL anyone can open. A
misunderstood `pages publish` is not a local mistake — bytes land on a hosted
site and, by default, a release goes live. The same logic covers the password
pair (`set` flips the route policy, `remove` can widen access up to fully
public) and the visibility switch to `public`, which exposes content that is
ALREADY hosted. `create` and `domains` do not upload bytes, but they still
change provider-backed Console state and routing, so they are braked as
external service mutations. Reducing visibility remains the emergency path
that must never be slowed down.

Decisions specific to this domain:

- **Conditional brake on `update`/`visibility`.** Braking every visibility
  change would put exit-3 friction inside "make it private NOW". The brake
  keys off the requested value: `public` → dry-run; `private`/`protected_link`
  → immediate. The rule is directional exposure, not the op name.
- **Brake before scope resolution.** `pages create`, `pages domains`,
  `pages publish` and `pages ship` resolve the Console project scope before
  publishing; the brake fires even before that, so a
  dry-run works offline and unauthenticated — the plan shows the parsed
  intent (`(Console scope default)` placeholders) instead of resolved refs.
- **One-shot `ship`, host-only `create`.** Agents were choreographing
  `create` + `publish` (or worse, `artifacts publish`) to get a URL.
  `create` stays a host record. `ship` ensures the host (reuse existing slug)
  and publishes in one command. The `pages` skill teaches only `ship` as
  “create a page”.
- **Brake before the password prompt.** A `password set` dry-run must never
  read a secret; the plan carries site/action and `routePresent` metadata only.
- **Message-based not-found mapping.** Console reports unknown sites/routes as
  generic 404/PAYLOAD_INVALID errors. Only recognizable "site/route not found"
  messages map to `SITE_NOT_FOUND`/`ROUTE_NOT_FOUND` (with listing
  suggestedAction — sites live in Console, there is no cheap local candidate
  source for similarity suggestions); anything else keeps its stable
  CloudAuthError code, normalized by the shared transport to the global exit
  taxonomy. The funnel still rethrows ContractError first (mail.ts model) so
  policy blocks retain their exact semantics.
- **Validation before the brake on `password remove`.** The replacement
  visibility requirement exists so removing a password can never make a page
  public by accident; the check stays ahead of the brake so a dry-run already
  surfaces the payload error.

The dedicated `pages` skill (`ravi-system-pages`) is the discovery surface.
The `artifacts` skill only points “hospedar HTML → skill pages”. The
parser-level usage contract remains owned by `src/cli/index.ts`.
