# Checks

- A merge MUST move an ordinary chat grant to the surviving contact; `contact-merge-grants.test.ts` fails if the merge hook is removed.
- A merge MUST drop a break-glass grant (`admin:system:*`, `admin:system:<narrow>`, `execute:executable:*`); the test fails if the drop is disabled or the predicate narrowed.
- The boot repair MUST follow the merge chain, drop break-glass, remove never-merged orphans and leave live contacts alone; the test fails if live contacts are swept.
- The boot repair MUST be idempotent: a second run returns no work.
