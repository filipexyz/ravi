# CRM agent-first CLI contract / WHY

Agents are heavy consumers of the CRM CLI, and the surface was shaped for humans
reading a terminal. Failures printed free text, so an agent could not tell a
missing entity from a bad flag without parsing prose; exit codes only said
"worked" or "did not work"; and every write executed on the first try, so a
misunderstood command mutated real records with no chance to review.

The contract makes errors typed, separates not-found (1), usage (2), and policy
blocks (3), and applies confirmation only when the actual effect warrants it.
CRM pipeline/opportunity creation and stage movement are routine internal
persistence, so they execute in one call and remain permissioned mutations.

Measured on a 270-execution benchmark across three domains: unsafe writes went
from 27/27 executed to 0/27, task completion held (86.1% to 86.7%), and
discovery got cheaper (2.33 to 1.60 help calls per task). The contract lands on
`pipeline` and `opportunity`, the surfaces the benchmark exercised; the rest of
the CRM ops keep their current behavior until they migrate under the same
invariants.

Decisions:

- The spec lives at `cli/crm` (not `crm/agent-first-cli` as in the original
  pilot branch) so every migrated domain follows one predictable id shape:
  `cli/<domain>`.
- The helpers were generalized into `src/cli/agent-contract.ts`
  (`contractFail`, `contractDryRun`, `installUsageContract(program, domain)`)
  instead of a per-domain copy, so sibling domains migrate without duplicating
  the contract layer.
- `pipeline`, `opportunity`, `task`, `fact`, `contact`, and `account` writes are
  local CRM persistence and stay unbraked under the global risk policy.
