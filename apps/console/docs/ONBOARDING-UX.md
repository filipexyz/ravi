# Onboarding — analysis before product UI changes

## Members — diagnosis BEFORE replacement, 2026-10-24

Final guide review BEFORE copy/step addition: actual Next390 screenshot
`fleet-browser-test-79LxTd/guide-390.png` confirms four similarly bounded panels
and one completion region. Natural order lacks authority between identity/login
and optional integrations. Add a same-weight policy explanation after Login, not
a competing primary button or forced grant step. Preserve proximity, continuity,
alignment, spacing, figure-ground and keyboard order of the first two tasks;
progressively reveal only the independently readable policy link. No extra status
claim, dense glossary, new completion prerequisite or hidden initial grant.
This extends the recorded guide Gestalt, not an after-the-fact redesign rationale.

Post-change validation: member directory and confirmation inspected in real Next
at1280/390 (`fleet-browser-test-79LxTd`), no overflow; keyboard Enter/Escape and
focus return PASS. Component fixtures verify read-only/denied and reactivation
warning at both sizes (VCV2FZ/JrNvqJ/BsfDOp). Names are no longer truncated on
mobile. Guide policy step inspected in OJh55m390; original conflict/review/retry
suite remains7checks per size. No new mandatory grant/step or implicit authority.

Rendered the original screen at1280/390 (`fleet-ui-before-pR6Jld`). Goal: inspect
admission and suspend/remove/reactivate an existing provisioned identity, not
assign policy. Natural order is identify person → read current state → choose
change → review consequence → confirm → refresh. Confirmation disappears after
success; the directory remains. Existing alignment, row proximity, rounded common
region, type scale and figure-ground work. But two competing invite/add CTAs and
a long fixed-role glossary conflict with that hierarchy and with actual authority;
mobile truncates identities while giving the glossary most space. Role select and
trash icon ambiguously mix admission, authority and deletion. Empty invites and
"only owner" copy expose unsupported/incorrect concepts.

Composition: remove invite/add/role selectors and glossary, keep a single bordered
directory; identity, email and textual status share each row. Similar/symmetric
row controls support scanning, consistent alignment and rhythm; mobile stacks them
instead of truncating identity. Common fate: pending change freezes its controls,
not unrelated navigation. Pragnanz/closure: one clearly named status action and
confirmation, no inferred grant. Policy link is secondary and independently gated.
Whitespace separates explanation from the list without inflating density. Retain
contrast/focus labels, real dialog focus trap/Escape, text beyond status colors,
loading/error/retry/empty/success states and read-only explanation. Reveal detailed
revocation/reactivation consequences only in confirmation; stale CAS requires fresh
review, transport retry keeps the same operation/payload. Validate desktop/mobile,
keyboard, denied/read-only, error and retry after implementation. UI is not a gate.

## Project creation affordance — diagnosis BEFORE edits, 2026-10-24

Rendered the unchanged form1280/390 in `fleet-ui-before-P5IYH6`. One narrow panel
groups name→address→description→visibility→submit; alignment, proximity and common
region support natural order. Typography/contrast/spacing and mobile wrapping are
legible, primary dark submit has clear figure-ground, keyboard focus visible.
Keep these, including conditional address preview and optional description.
Do not move policy editing into this form. Replace nominal-role denial with current
server-observed create permission; explain separate future-project read/write
requirements in one short local note, not claims of creator ownership. Pending
shows skeleton, error offers retry, denied hides fields; completed creation leaves
the form via its existing destination. Revocation remains checked by API.

Empty Projects currently repeats New project and Create a project with equivalent
weight; keep only the contextual empty-state CTA until data exists (closure and
Pragnanz). Membership-based empty copy is now false: say no project is authorized.
Creation choice does not expose technical policy JSON; settings remain distinct.
Keep similar controls and natural rhythm, no extra cards/banners competing with
submit. Common fate pairs disabled submit with pending request. Test owner/admin
without grants denied, custom label with explicit create reachable, direct API
denied without data grants, and successful real browser creation at both sizes.

## Shared navigation — diagnosis BEFORE edits, 2026-10-24

Inspected actual Next render `fleet-browser-test-5AGiB0/failure.png`: header is
well aligned and the guide groups each task/action in a clear common region, but
organization tabs disappear on onboarding/SSO/credentials routes. The path switch
breaks continuity and closure; the legacy Settings entry also misrepresents a
custom-role policy reader with no project data. Preserve the two-level hierarchy:
organization Projects/Members/Settings, then settings destinations including
Access policies. Choose the first currently readable settings destination rather
than an owner/admin label. No new project authority follows from these links.

Keep matching tab shapes/typographic rhythm, aligned baseline and focus ring;
selected underline supplies figure-ground, so proximity/similarity do not imply
that separate read/manage permissions are equal. Avoid another dashboard or
duplicate action. Pending/error access observations expose no policy destinations;
the destination itself retains explicit loading/error/denied feedback. Independent
metadata screens remain separate common regions; the optional completed guide
does not become a permanent task step. At390 keep horizontal tab scrolling inside
its region (not viewport overflow), keyboard order and visible focus. Existing
desktop whitespace and symmetry need no extra cards. Validate a policy-only reader
with zero projects and disabled legacy settings feature, plus denied/revoked state;
navigation is affordance only, the API still rechecks every request.

## First-access readiness — diagnosis BEFORE correction, 2026-10-24

Inspected the actual Next/browser failure screenshot, not the component fixture:
the password field held43characters but Continue remained disabled after loading,
with no JS/asset error. The form was editable in its server-rendered inert state;
the user cannot tell that its change listener is not ready. This breaks feedback,
closure and common fate between input and submit. Do not solve by forced clicks
or repeated typing in the acceptance test. Make the SSR input explicitly disabled
and the form busy until client readiness, then enable normal typing once only.
Keep the primary button and local loading text in the same common region, with
no new competing action, no layout shift and no token exposed in diagnostics.

The real setup route also inherits legacy dark body colors outside the light
card, leaving dark hints low-contrast. Component previews used a canvas wrapper
and hid this mismatch. Put the full viewport on semantic canvas/ink, with the
existing narrow form centered inside. Preserve proximity, symmetry, typography,
alignment and spacing; improve figure-ground and contrast without changing task
order or adding density. At390 wrap hints and retain label/focus/keyboard order.
Validate SSR-before-JS disabled state, hydration readiness, one fill→normal submit,
desktop/mobile and the same real bootstrap flow, never a synthetic login bypass.

Validation after correction: real Next/IdP/PG browser passed27assertions including
blocked SSR before scripts, one fill and normal submit. Rendered setup1280/390
inspected in `fleet-ui-before-h2EQgS`: full canvas has readable title/hints, form
remains one region, label/focus and natural order preserved, no overflow/errors.
The original two failures remain recorded; no retry typing/force-click workaround.

## Policy integration — rendered diagnosis BEFORE edits, 2026-10-24

Inspected actual SSO and credentials components in sandboxed Chrome at 1280/390,
using the current committed UI and synthetic data. Paths `fleet-ui-before-XO7afu`
and `fleet-ui-before-UsLYOJ` are private temporary evidence. No page errors or
horizontal overflow. This is component evidence, not SSO/API authorization proof.

Objective remains configuring this installation. First understand current state,
then change only what the person is allowed to administer; the guide still
disappears only on explicit completion. Read access and manage access are distinct.

- Hierarchy: heading/current login/form/save is clear. The prominent Owner label
  conflicts with explicit grants, suggesting powers it cannot guarantee; remove
  it from administrative tab chrome. Keep organization identity.
- Proximity and common region: fields/hints and candidate controls are well
  grouped. Keep an explicit read-only notice alongside the state, not in a modal
  or global banner. Put missing credential-read dependency near create controls.
- Similarity: equal-looking five role fields falsely imply a fixed universal
  role catalog. Replace them with one optional, issuer-bound admission group list;
  policy roles/groups remain separate and are not auto-created from OIDC claims.
- Continuity/alignment: preserve tab order and vertical form rhythm. Policy-derived
  tabs must not expose a dead permissions route until the sibling UI exists.
- Figure/ground: current semantic surfaces and contrast work. Keep current login
  as stable reference while candidate edits/test errors remain in their own panel.
- Closure/common fate: readonly users see state without edit affordances. Refresh
  authorization on focus and recheck EVERY backend effect; stale UI is never a
  capability. Credential/config revisions still invalidate prior login proofs.
- Symmetry: retain aligned controls, not equal-size permission tiles. Removing
  five fixed-role inputs reduces the mobile form's excessive height.
- Pragnanz: say "who may sign in" separately from "what they may do"; avoid role
  enums, Vault paths or policy-engine vocabulary in the form.

Density, type scale, spacing and focus are already legible. Preserve them. Empty
state must not instruct a readonly user to click a missing create button; loading
and dependency errors need explicit retry, not infinite skeletons. Hide mutation
controls on readonly access, but show an understandable denied state for a direct
URL. Keep one primary next action and do not duplicate forms in the guide.
At 390px wrap hints/actions and retain label associations, keyboard order and
textual status (not color alone). After changes test full/readonly/denied views,
API denials, group admission, desktop/mobile and keyboard against this diagnosis.

### Integration rendered validation

Actual component fixtures passed full SSO form and read-only/denied states for
settings, guide, credentials, installations and SSO at1280/390. Inspected the
images, not only DOM: retained organization identity/spacing, removed Owner badge,
read-only notice stays beside readable data, denied view contains no form or
misleading edit action. The optional admission section is one fieldset, with no
five-role hierarchy; mobile hints wrap. Existing mixed-language General copy is
preserved, not claimed as a complete localization pass.

Guide conflict recovery passed7checks per size after correcting a regression:
transient refresh failure may preserve the disabled review/recovery panel, while
401/403 must replace data with denial. This does not grant access from cached UI;
each backend request checks current policy. Component evidence is synthetic and
does not substitute for the separately pending full Next/browser acceptance.

## Observed reference

2026-10-23: rendered the unchanged `OrgGeneralScreen` in Chromium at 1280×900 and
390×900 using its actual components/tokens, synthetic workspace/query data and
stubbed navigation. No network beyond a temporary loopback server. This is a
component inspection, not deployed auth or whole-shell E2E. Both renders had no
page errors or horizontal overflow. Screenshots: temporary `fleet-ui-before-*`.
The black lower area belongs to the preview's missing shell and is not claimed as
a deployed visual defect.

## Objective and composition

An authenticated administrator wants to make their own installation usable,
understand what is already operational and change a connection without losing
access. Primary action is the next meaningful step, not completing every possible
integration. Natural order: organization identity → sign-in → credentials →
installations → review. Existing SSO may already satisfy the sign-in step.
The setup guide disappears after completion; the same sections remain settings.

## Gestalt diagnosis

- Hierarchy: current heading/card/save are clear, but no installation readiness
  hierarchy exists. Use a compact setup summary and one primary action per section.
- Proximity: labels, hints and fields already form useful groups; keep error text
  at its field. Put validation timestamp/version with the connection, not in a
  distant global banner.
- Similarity: consistent fields/buttons work. Credential and connection rows should
  share layout, but their states must be named: stored, needs test, verified,
  active, revoked. Never make “saved” look like successful activation.
- Common region: the current bounded identity panel is effective. Separate identity,
  sign-in and credentials into real sections; avoid one giant env-variable form.
- Continuity/alignment: keep the label/input/action vertical rhythm. On small
  screens the order remains the same, rather than moving primary actions away.
- Figure/ground: semantic surface/canvas separation works. Use modest contrast for
  metadata, strong contrast for next action and persistent errors. Color is not
  the only carrier of meaning.
- Closure: completing a step must show what changed and what remains; never close
  the flow after only saving a form. The existing disabled Save conveys unchanged
  state but does not convey service health.
- Symmetry: aligned forms are predictable; do not add equal-size cards to make
  unrelated or optional services appear equally urgent.
- Common fate: validation belongs to a specific configuration and credential
  revision; editing either invalidates their shared verified state visibly.
- Pragnanz: organize around user concepts (“Sign-in”, “Credentials”, “Ravi
  installations”), not env names, Vault paths or provider implementation details.

## Detailed interaction decisions

Current density is low and readable; keep forms narrow and avoid metric tiles.
Use existing typography/spacing tokens, visible keyboard focus and explicit
labels. “Address” currently means org slug, not network endpoint: clarify this.
The hardcoded `.ravi.page` example is not a suitable readiness claim for self-host.
Keep optional settings progressively disclosed. Empty credential/installations
lists name the next action. Loading preserves structure; errors remain inline with
retry; successful save and successful test have distinct feedback. No auto-retry
of secret mutations with new keys. Unsaved changes must not disappear silently.
Secret fields clear after success and are never repopulated from metadata APIs.
Rotation/revocation require clear consequences and confirmation, not a bare toggle.
At 390px, actions stack without horizontal overflow. Keyboard order follows task
order; statuses use live regions sparingly, errors use accessible descriptions.

## Validation after implementation

Repeat actual rendered checks at 1280/390, keyboard traversal, error/success/empty
states and API negatives. Distinguish the component harness from end-to-end auth,
Vault and SSH tests. Do not claim the historical Page409 issue is fixed here.

## First slice rendered review

Credentials and installations, empty and create states, rendered at 1280/390 with
the actual new components: zero JS errors, no horizontal overflow, labels/focus
working and save disabled until fingerprint confirmation. Screens were visually
reviewed. Panels preserve the original rhythm and primary-action hierarchy;
port/user fields stack on mobile. The transport limitation remains visible.
Shortened the stored-status badge and moved its explanatory sentence outside it
to avoid an unbreakable badge on mobile. This is fixture UI evidence, not SSO/API
or live Vault acceptance. Populated/error/success states still need coverage.
# SSO composition, before implementation

Keep the active login as the visual reference at the top, separate from candidate
cards. Each candidate has one next action: save → sign in to test → review and
activate. No toggle that makes “saved” look “live”. A successful redirect alone
does not paint success; the persisted, actor-bound proof does. A warning explains
session revocation and identity mapping before activation.

Credential selection supplies immutable issuer/client identity, avoiding repeated
editable fields that could disagree. Private network permission is adjacent to
that identity. Optional group constraints are progressively disclosed and grouped
by existing role, not a JSON editor. Empty/loading/error and expired proof states
keep the previous active provider visible. The modal uses the existing accessible
Dialog; mobile stacks actions, long URLs wrap, labels remain explicit. No secret
value, token or protocol callback query appears in cards or toasts.

## First access and guide, before implementation

First access has one action: enter the operator-provided setup code and continue
to the configured IdP. Never show a public “create administrator” form or ask for
a password to store locally. The code is masked, not put in a URL or toast; error
feedback says the setup could not be verified without revealing org/owner state.
After the verified owner returns, the short guide groups organization, login,
credentials and installations in task order, each linking to the same persistent
settings screens rather than duplicating forms. Optional transport setup can be
skipped explicitly. Completion hides the guide, not the settings. “Reviewed” is
not “connected”, and “transport active” never means an agent conversation works.

Use a narrow single column, one primary completion action, clear step statuses
with text (not color alone), visible keyboard focus and mobile-wrapping labels.
Keep the guide discoverable from General until completed; do not hijack existing
Pages/Bases navigation with a forced global redirect. Existing installations can
review the guide using their current authorized owner without a setup token.

## Stale review recovery — observed before changing the interaction

Rendered the actual guide at 1280/390 with a synthetic API version-conflict
response. At 390 the inline error says to update and review but offers no update
action; the review stays checked and Complete remains enabled. This is a closure
and affordance failure, not a backend authorization failure. Existing card order,
spacing, contrast, typography, mobile wrapping and keyboard order work.

Keep the error, recovery action and review in their common panel (proximity/common
region). While stale, prioritize one recovery action, disable completion and clear
the review; don't introduce a competing global banner. Refresh loads the current
snapshot, then requires explicit review of that snapshot. Background changes also
invalidate the check (common fate); network retry of the same intent preserves its
operation key. New reviewed state receives a new intent only when submitted.
Use an accessible inline alert plus the existing focused button/checkbox pattern;
loading disables conflicting actions without shifting the four-card structure.
Success still removes the guide. No change to the established alignment, symmetry,
figure/ground or simple task order is needed. Validate error → refresh → review →
completion at both sizes, including a failed refresh and ordinary network retry.

## Final rendered validation

The actual guide passed 7 checks at each of 1280/390: stale review is cleared,
completion is disabled, failed refresh retains recovery, a new snapshot requires
review, ordinary retry keeps the operation key, keyboard interaction works and
success removes the guide. Both final renders were visually inspected against
the diagnosis above.

An independent real Next HTTPS/PG/IdP browser test also completed first access,
review and persistence after restarting its own local server. Its 1280/390
screenshots were reviewed: task order and primary action remain legible, cards
wrap without page overflow, settings navigation uses its existing horizontal
scroll region on mobile. Development overlays in these fixture screenshots are
not shipped product UI. This is not a deployed/customer-IdP acceptance test.
