# Access editor — pre-implementation Gestalt analysis

## PR1 Bases view-write correction — before catalog code

Re-inspected the actual prior `fleet-policy-editor-fCLpDM` draft1280 and
review390 renders. User objective is granting a form/view write without exposing
direct rows or schema management. Keep the existing subject→project→actions,
save→review→publish order; completed draft/review still disappears. Add one
plain-labelled restricted view-write action in the current disclosure, not a new
screen, modal or competing CTA. Project read and the view's own admission/filter/
columns are still required; this is not implicit write for all readers.

Hierarchy/figure-ground are already clear (active status above white rule cards).
Proximity/common region keep the new choice beside existing actions; similarity
must not imply that write variants are interchangeable. Continuity/alignment and
symmetry preserve the stacked mobile order and desktop grid. Common fate keeps
any changed action invalidating review; closure remains the published state.
Pragnanz favors “Write through permitted Base views only” over engine terminology.
Density is the tradeoff: another checkbox in an existing bounded disclosure,
wrapping full labels at390, no horizontal overflow. Keep current type, contrast,
spacing/rhythm, visible keyboard focus, labels and text feedback. Empty/loading/
error/success states do not change. No new role preset or hidden authority.
Post-change editor keyboard/render validation remains a required gate.

Post-change validation (human-review corrections): real policy API/PG/editor run
`fleet-policy-test-6FS9du`, renders `fleet-policy-editor-zdAIBA`, passed12 browser
checks at1280/390. Inspected draft1280 with the action disclosure open and
review390: the fourth action remains grouped and fully labelled, the mobile flow
stacks without overflow, review stays separate from publish and focus remains
visible. Keyboard checked and then unchecked the new view-write action before
publication, proving the control without accidentally granting it. No new page,
modal or competing CTA was added. Historical analyses below describe older
catalogs; the current four-action catalog includes restricted view write.

Inspected before editor implementation: existing OrgMembersScreen rendered using
its real React/UI components, synthetic owner/viewer data, real compiled Tailwind
and a disposable headless Chrome at1280×900 and390×900. Harness
`scripts/inspect-policy-baseline.tsx`; no provider, user browser or staging.
First render omitted `.rv-app`, so light UI tokens sat on the legacy dark body;
that was a harness error, corrected before analysis. Next/font isn't loaded in
this isolated reference, so font fallback is not a production typography claim.

## Objective, order, completion

The administrator wants to answer who can access which project and change it
without accidentally publishing. Primary task order: understand active state →
edit a draft → simulate a person/action and inspect impact → publish explicitly.
No credential entry, login/group provisioning or code editing belongs here.
After success, draft warnings, preview and publish CTA disappear; compact active
status remains and editing is an explicit next action.

## Perception and composition

- Hierarchy: existing title/people count/list are clear, but the role reference
  competes with membership management and states the obsolete global-project
  rule. New page puts active/draft status and one primary next action above details.
- Proximity: current role selector is close to person but projects are absent,
  inviting the wrong inference. Each rule groups effect, subject, actions and
  project scope within one bounded region. Explanations sit beside the outcome.
- Similarity: retain existing field/button/badge patterns. Allow and deny use
  consistent structure plus words, not color alone. Read/write/admin aren't
  misleadingly presented as automatic hierarchy; choices are explicit.
- Common region: separate project rules from policy managers (control plane),
  and group membership from rules referring to groups. No organization-role
  selector beside a project selector that silently changes SSO admission.
- Continuity/alignment: a single vertical reading order; desktop rule fields
  align in a small grid, mobile stacks in the same DOM/tab order. Review follows
  the saved draft, not a remote modal or another settings page.
- Figure/ground: quiet canvas, bordered white/dark themed cards, ink text and
  persistent inline errors. No dark/light token mixing from the reference harness.
- Closure: each saved/reviewed/published state has a visible label and result.
  A saved draft is explicitly not active. Publication success closes the flow.
- Symmetry: consistent margins/field widths give rhythm; avoid a symmetrical
  two-pane layout that implies edit and publish are equally available.
- Common fate: disable the draft fields and next action together while saving;
  any edit invalidates the displayed preview and makes it impossible to publish
  a stale local view. CAS conflict preserves local input but requires reload/review.
- Pragnanz: plain subjects/projects/actions, not JSON, policy-engine models,
  Vault paths, bearer claims or endpoint names. Advanced group/manager/history
  sections are disclosures, not competing primary tasks.

## Density, states and accessibility

Current member reference is spacious on desktop but a long role-description list
dominates mobile; names/emails truncate while actions consume width. New rules
must wrap labels, expose full selection text and avoid horizontal tables. Keep
14px body, clear larger title, ordinary section headings, 16–24px internal spacing,
and at least native accessible field/button hit areas; no tiny icon-only primary
actions. Preserve text contrast across light/dark and visible keyboard focus.

Empty: no active policy means protected projects are denied; initial proposal is
only a proposal. Loading: named status, no fake empty policy. Error: scoped inline
message, no secret/raw backend body, retry explicit. Conflict: don't overwrite.
Success: aria-live status plus revision, not merely a transient toast. Inputs have
labels, fieldsets/legends and button names; status never relies on color. Keyboard
order follows subject→scope→action and review→publish. No focus jump when adding
rules; ensure added control is discoverable. Validate1280/390, overflow, focus and
actual edit→save→preview→publish (browser plus real API/DB), not screenshots alone.

Tradeoffs: only the product's initial three project actions are editable; schema
management is included in project.write and must be stated. Fine resource catalogs
and authenticated individual-agent transport are not implied. Org policy managers
have explicit org-wide grant authority but no automatic data-read permission.
The UI must say this near manager controls. Existing role-help text needs correction
in the integration patch; onboarding navigation remains separately coordinated.

## Before the role-ID / organization editor revision

Re-inspected the real390px review screenshot from the preceding browser run
(`fleet-policy-editor-vOhlo8/review-390.png`) BEFORE these changes. Its spacing,
field alignment and completed-state closure work, but three expanded rule cards
and name-based role choices imply inherited authority. Adding organization cards
below them would make density/scroll distance worse and blur the resource boundary.

Composition: keep one draft→test→review→publish flow; use one scope selector for
Projects versus Organization. Show only that scope's rules, while the saved policy
and impact always include BOTH. A roles disclosure defines stable named roles,
members/groups and resource scope before rules refer to them. Rename keeps the
same ID; no UUID editing. No owner/admin preset or automatic privilege.

Hierarchy/pragnanz prioritize what access changes, not Casbin or JSON. Proximity,
common region and figure-ground keep each role assignment and each rule distinct;
similar controls and explicit scope labels resolve the conflict between visual
similarity and materially different powers. Continuity/alignment retain one DOM
reading order at1280/390. Symmetric cards keep rhythm, not a competing two-pane
publisher. Common fate invalidates simulation/review after ANY scope/role edit.
Closure still collapses the whole draft after successful publication. The scope
selector must not hide organization changes from final review.

Use the existing14px/16–24px field rhythm, full-width labels, wrapped choices,
visible keyboard focus and native labelled controls. Read-only policy viewers see
active state/history but no mutation CTA. Empty roles explain that names alone
grant nothing; referenced roles cannot be removed without first removing grants.
Errors/CAS preserve input, loading disables the draft together, success remains
aria-live. Validate rename+assignment+organization simulation and review in real
browser/HTTP/DB, including mobile and read-only controls, not only static renders.

## Before adding member actions to the shared action catalog

Inspected the actual390px organization review render `fleet-policy-editor-di5qUU`
before the extension. Hierarchy, vertical alignment and common-region boundaries
remain clear; the long action disclosure is dense but already scrolls and wraps.
Do not add a competing member editor here. Add two plain labels in the existing
organization action group: directory read versus membership management (not roles).
Similarity must not suggest manage implies read or membership implies policy power.
Keep proximity to the existing explicit-grants note, figure/ground contrast and
keyboard-labelled native choices. No new layout symmetry, modal or context switch.
The same draft/review/publication path provides continuity, common fate and closure;
successful publication still hides the draft. Pragnanz favors these two specific
choices over an ambiguous "admin" preset. Empty/loading/error/success and focus
behavior remain unchanged; verify1280/390 rendering after the catalog addition.

Post-implementation check: `fleet-policy-editor-fCLpDM` renders reviewed at1280/390.
The real browser selected directory read with Space, simulated it and published
it without membership-management power. Both labels remain in the same bounded
organization-action disclosure; the list scrolls internally, with keyboard access
to its last option. No page overflow, grouping/context shift or competing CTA;
the completed390 state collapses edit/review. Eleven browser scenarios passed;
identity was synthetic HTTP-session, not real SSO.
