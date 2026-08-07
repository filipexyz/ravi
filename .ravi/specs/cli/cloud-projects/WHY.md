# Cloud Projects agent-first CLI contract / WHY

`cloud projects create` is the only mutation in this domain, and it is a
textbook brake candidate: it creates a billable, organization-scoped remote
resource, optionally with a default Pages site, and the RBBT incident recorded
in `cli/console-scope` shows agents actually reaching for it in the wrong
organization ("pages list returned 0, so let me create the project"). The
dry-run plan surfaces the exact slug, effective name, visibility, and
default-site decision so the agent (or the human reading the transcript) can
catch a wrong-org create before it exists remotely.

Two ordering decisions matter:

- Visibility validation runs before the brake. `--visibility bogus` fails the
  same way with or without `--execute`; otherwise the dry-run would bless a
  plan that the real run rejects, and the agent would learn a false "plan ok"
  signal.
- The plan shows EFFECTIVE values (`name ?? slug`, `visibility ?? "private"`),
  not the raw flags, because Console applies those defaults server-side and
  the plan's job is to predict the write.

`list` stays a plain read with `--fields`. Not-found suggestions do not apply:
projects are listed, not addressed by id, and the corpus is remote. The funnel
keeps stable CloudAuthError codes, while the shared transport maps them to the
global exit taxonomy. The ContractError rethrow guard ensures the brake's exit
3 survives agent context.
