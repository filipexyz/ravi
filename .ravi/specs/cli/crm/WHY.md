# CRM agent-first CLI contract / WHY

Agents are heavy consumers of the CRM CLI, and the surface was shaped for humans
reading a terminal. Failures printed free text, so an agent could not tell a
missing entity from a bad flag without parsing prose; exit codes only said
"worked" or "did not work"; and every write executed on the first try, so a
misunderstood command mutated real records with no chance to review.

The contract fixes the three at once: errors become a typed envelope the caller
can branch on, exit codes separate not-found (1) from usage (2) from a policy
brake (3), and braked writes default to a dry-run that prints the plan plus the
literal instruction to re-run with `--execute`. Exit 3 is deliberately not an
error — it is the system refusing to write until the caller confirms.

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
- `pipeline set` and the `task`/`fact`/`contact`/`account` writes stay unbraked
  in this wave to keep the change minimal and reviewable; they are declared debt
  in the spec and the skill lists them explicitly as unbraked.
