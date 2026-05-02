# Observer Rules / WHY

## Rationale

Observer behavior needs to be configurable without editing code or rewriting worker prompts. Rules provide a durable policy layer that can be queried, validated, and explained.

Agent defaults cover the common case: every session of an agent should receive a standard observer set. Task/profile rules cover structured work. Tag rules are the flexible operator surface for temporary or semantic behavior.

## Why Tags Matter

Tags are already a natural way to label agents, sessions, tasks, projects, and contacts. Using tags as rule selectors lets operators say:

- this project captures memory;
- this task needs quality watch;
- this agent is cost-sensitive;
- this session needs auto-reporting.

The risk is that tags stop being harmless labels. Once a tag activates an observer rule, it becomes runtime policy. That is why tag rules must be explainable, scoped, and explicit about inheritance.

## Why Rules Are Separate from the Plane

The Observation Plane should not know why an observer exists. It should only execute bindings. Rules own selection, matching, conflicts, and future editability.

This separation lets future sources create bindings directly without using rules, and lets rules evolve without changing event delivery semantics.

## Rejected Alternatives

- **Hard-code observer startup in agents**: rejected because the behavior would be scattered and hard to audit.
- **Infer observers from tag names only**: rejected because tags need explicit rule definitions before they change runtime behavior.
- **Apply all tags transitively**: rejected because project/contact tags could accidentally affect unrelated sessions.
- **Delete bindings automatically on rule edit**: rejected because observer session state may contain useful history and should not disappear without reconciliation policy.
