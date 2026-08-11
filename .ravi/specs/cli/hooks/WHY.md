# Hooks agent-first CLI contract / WHY

Hooks are durable runtime automations: an event (`SessionStart`, `PostToolUse`,
`FileChanged`, ...) wired to an action (`inject_context`, `append_history`,
`comment_task`, ...). They keep acting long after they are created, so the risk
profile is asymmetric: creating a hook is easy to undo (`rm`), but deleting one
destroys configuration, cooldown state and fire counters with no inverse — and
the daemon silently stops doing whatever that hook did. That is why `rm` is
unconditionally braked.

`enable`/`disable` stay immediate because they are the reversible pair agents
use constantly to pause/resume behavior; braking them would put exit-3 friction
in the routine path without protecting anything destructive. `test` is
conditional: `inject_context` and `send_session_event` deliver into live
sessions and need confirmation, while action types without session delivery
keep the fast synthetic debug loop.

`hooks rm` also carries aliases (`delete`, `remove`); the brake lives in the
single command body, so every alias inherits it — there is no alias that
bypasses `--execute`.

The hook id plus action and scope types are enough to confirm deletion or test
delivery. Repeating the human name, event name, or scope value could disclose a
workspace path or session target without improving the confirmation decision.

There is no shipped `hooks` skill. The `hooks list` human output is the only
internal surface that teaches `rm`, and it now carries `--execute`. The skill
gap is registered in SPEC.md.
