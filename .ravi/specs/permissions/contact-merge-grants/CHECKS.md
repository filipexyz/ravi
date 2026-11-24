# Checks

- A merge MUST move an ordinary chat grant to the surviving contact; `contact-merge-grants.test.ts` fails if the merge hook is removed.
- A merge MUST drop a break-glass grant (`admin:system:*`, `admin:system:<narrow>`, `execute:executable:*`); the test fails if the drop is disabled or the predicate narrowed.
- A merge or repair MUST keep the last grant covering a scope; the test fails if that guard is removed.
- A self-merge MUST move and drop nothing; the test fails without the guard.
- The boot repair MUST NOT move rows to the survivor and MUST leave live contacts alone; the test fails if the repair moves rows.
- The merge chain MUST be followed past 16 hops; the test fails with a hop cap.
- The boot repair MUST be idempotent: a second run returns no work.
- A merge MUST revoke the source's live runtime contexts carrying a moved or dropped grant; the test fails if either revocation is removed.
- `resolveMergedContactId` MUST stop on a cycle in merge links; without the guard the test hangs and is killed.
