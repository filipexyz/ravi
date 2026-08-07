# Pages agent-first CLI contract / WHY

Pages is the surface where a local file becomes a URL anyone can open. A
misunderstood `pages publish` is not a local mistake — bytes land on a hosted
site and, by default, a release goes live. The same logic covers the password
pair (`set` flips the route policy, `remove` can widen access up to fully
public) and the visibility switch to `public`, which exposes content that is
ALREADY hosted. Those are exactly the braked ops. Everything that only reduces
or prepares exposure stays immediate: `create` uploads nothing (the canonical
flow is create → braked publish), reducing visibility is the emergency path
that must never be slowed down, and `domains` only takes effect for someone who
also controls the external DNS record.

Decisions specific to this domain:

- **Conditional brake on `update`/`visibility`.** Braking every visibility
  change would put exit-3 friction inside "make it private NOW". The brake
  keys off the requested value: `public` → dry-run; `private`/`protected_link`
  → immediate. The rule is directional exposure, not the op name.
- **Brake before scope resolution.** `pages publish` resolves the Console
  project scope before publishing; the brake fires even before that, so a
  dry-run works offline and unauthenticated — the plan shows the parsed
  intent (`(Console scope default)` placeholders) instead of resolved refs.
- **Brake before the password prompt.** A `password set` dry-run must never
  read a secret; the plan carries site/route/action only.
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

Pages has no dedicated skill — the `artifacts` skill hosts the Pages guidance
today. That gap is registered in the SPEC for a follow-up wave, as is the
parser-level usage contract (owned by `src/cli/index.ts`, outside this wave).
