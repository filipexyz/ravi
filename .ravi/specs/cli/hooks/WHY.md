# Hooks agent-first CLI contract / WHY

Hooks are durable runtime automations: an event (`SessionStart`, `PostToolUse`,
`FileChanged`, ...) wired to an action (`inject_context`, `append_history`,
`comment_task`, ...). They keep acting long after they are created, so the risk
profile is asymmetric: creating a hook is easy to undo (`rm`), but deleting one
destroys configuration, cooldown state and fire counters with no inverse — and
the daemon silently stops doing whatever that hook did. That is why `rm` is the
only braked op in this domain.

`enable`/`disable` stay immediate because they are the reversible pair agents
use constantly to pause/resume behavior; braking them would put exit-3 friction
in the routine path without protecting anything destructive. `test` executes
the hook once with a synthetic event — it is the debug loop for hook authors
and is declared unbraked; its side effect is a single, intentional action run.

`hooks rm` also carries aliases (`delete`, `remove`); the brake lives in the
single command body, so every alias inherits it — there is no alias that
bypasses `--execute`.

There is no shipped `hooks` skill. The `hooks list` human output is the only
internal surface that teaches `rm`, and it now carries `--execute`. The skill
gap is registered in SPEC.md.
