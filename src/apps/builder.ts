import type { RaviAppBuilderGuidance } from "./types.js";

export const RAVI_APP_BUILDER_SKILL = "ravi-dev-app-creator";
export const RAVI_APP_BUILDER_SPEC = "apps/builder";

export const RAVI_APP_BUILDER_REVIEW_CHECKLIST = [
  "Source contract: record the official API or CLI documentation, resource model, operation matrix, pagination, quotas, and error envelope.",
  "CLI boundary: choose one real implementation command; keep the public ravi <app-id> alias out of interfaces.cli.command to avoid router recursion.",
  "Authentication: choose a Ravi credential-broker or managed connector boundary; never place tokens, refresh tokens, client secrets, or secret paths in manifests, argv, stdout, specs, or skills.",
  "Permissions: classify read, sensitive read, write, and destructive operations; declare operation permissions and the smallest child-context ceiling in context.allow.",
  "Skill visibility: create the app operating skill, verify it is indexed for the target runtime, and grant it to restricted agents when their allowlist requires an explicit grant.",
  "Machine contract: define stable --json output, typed errors, exit status, pagination cursors, idempotency behavior, and bounded timeouts for every public operation.",
  "Product surfaces: make an explicit yes/no decision for storage, events, artifacts, and semantic UI; add only the surfaces that create reuse, lineage, audit, recovery, or operator value.",
  "Failure behavior: prove missing auth fails before network access, provider errors are sanitized, retries are bounded, and destructive actions require explicit authorization.",
  "Functional validation: exercise the public ravi <app-id> <operation> route with fake credentials and fake HTTP or a deterministic fake CLI, not only manifest validation.",
  "Release gate: run app, CLI, router, permission, skill, spec, type, formatting, generated-contract, and full-suite checks before claiming the app is ready.",
] as const;

export function buildRaviAppBuilderGuidance(): RaviAppBuilderGuidance {
  return {
    skill: RAVI_APP_BUILDER_SKILL,
    command: `ravi skills show ${RAVI_APP_BUILDER_SKILL} --json`,
    spec: RAVI_APP_BUILDER_SPEC,
    reviewChecklist: [...RAVI_APP_BUILDER_REVIEW_CHECKLIST],
  };
}
