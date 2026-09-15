# Sessions agent-first CLI contract / WHY

Sessions are how agents talk to each other and to humans; the messaging loop
(`send`, `ask`, `answer`, `inform`) runs dozens of times per task. Putting a
brake there would add an exit-3 round-trip to every coordination step, so the
contract deliberately leaves messaging unbraked and brakes only the four ops
that destroy something that cannot be rebuilt: `reset` (the conversation
context), `delete` (the session itself), and `delete-message`/`edit-message`
(messages already delivered to a real channel). Runtime `follow-up`,
`rollback` and `fork` are also braked because they queue triggered work or
alter runtime history. `interrupt` remains immediate as an emergency stop;
`steer` remains immediate for correction of work already running.

`SESSION_NOT_FOUND` carries no suggestions, unlike the crm/tasks envelopes.
This is a security decision, not an omission: scope isolation intentionally
answers "not found" for sessions the caller is not allowed to see, and a
suggestions list built from live session names would let a scoped agent
enumerate other agents' sessions by probing.

`prune` already had the exact `--execute` semantics this contract generalizes —
it is the origin of the pattern. Its dry-run answers with a rich candidates
payload (and exit 0), which is strictly more useful than the generic
`WRITE_REQUIRES_EXECUTE` envelope, so it keeps its shape and is declared as a
grandfathered exception rather than being flattened.

The braked commands are also taught by live surfaces outside the skill: the
session action hints emitted to agents, the ephemeral TTL warning, and the
prompt-builder guidance. All were updated in the same change — a hint teaching
an unbraked syntax would walk every agent straight into exit 3.
