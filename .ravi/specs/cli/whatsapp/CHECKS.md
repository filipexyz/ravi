# WhatsApp agent-first CLI contract / CHECKS

## Checks

- Every braked op (`group send|create|add|remove|promote|demote|revoke-invite|join|leave|rename|description|settings`, `dm send`) invoked without `--execute` MUST exit 3 with `dryRun: true` and a `plan`, and MUST NOT make any provider/NATS call — not even the group-metadata read on the send path.
- Every braked op invoked with `--execute` MUST perform the real write through the same provider path it planned.
- `whatsapp group info <unknown>` with `--json` MUST exit 1 with the `GROUP_NOT_FOUND` envelope and suggestions built only from the group list already fetched during resolution.
- `whatsapp group create|add` with an unknown participant MUST exit 1 with `CONTACT_NOT_FOUND` (local contacts DB suggestions) BEFORE the brake and BEFORE any provider call.
- `whatsapp dm send|read|ack` with an unresolvable contact MUST exit 1 with the `CONTACT_NOT_FOUND` envelope.
- `whatsapp group create` in dry-run MUST NOT create the group, the agent (`--create-agent`), the local chat, the route, or the session.
- The unbraked ops (`group list`, `group info`, `group invite`, `dm read`, `dm ack`) MUST keep immediate behavior, and the shipped `whatsapp` skill MUST list them explicitly as unbraked.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still exit 3 with the envelope — the registry dispatcher MUST preserve `ContractError.exitCode`.
- `whatsapp group list --fields a,b --json` and `whatsapp dm read <contact> --fields a,b --json` MUST return items containing only the requested fields.
- `bun test src/cli/commands/group.test.ts` SHOULD pass after any change to the whatsapp contract surface.
