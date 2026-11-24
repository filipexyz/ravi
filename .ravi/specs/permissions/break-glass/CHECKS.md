# Checks

- `permissions allow --apply` MUST be refused, before any profile, grant, tag or agent ceiling write, for a profile of any name whose capabilities include `admin:system:*` or `execute:executable:*`, for an admin profile by name (`admin`, `owner`, `superadmin`), and for a stored profile that already carries break-glass.
- A narrow profile, including `execute:executable:<pattern>` other than `*`, MUST still apply.
- The preview of a break-glass profile MUST carry no `nextCommand` and MUST say it is break-glass.
- An agent turn holding `admin:system:*` MUST NOT tag a contact `permission-admin|owner|superadmin` (any spelling) or with a profile that carries break-glass, through `contacts tag`, `contacts set tags` or `tags attach`.
- The local operator terminal MUST still tag a contact `permission-owner`, and an admin agent MUST still remove it.
- `tags create` and `tags set` MUST refuse a permission definition that carries break-glass, for every caller; a plain tag with the same metadata MUST NOT be refused.
- An existing grant that carries break-glass MUST NOT be revoked by a refused apply.
- `src/permissions/break-glass.ts` MUST NOT name any channel.
- `bun test src/cli/commands/permissions.test.ts src/permissions/privileged-contact-writes.test.ts src/permissions/break-glass.test.ts` MUST pass.
- `bun run typecheck` MUST pass.
