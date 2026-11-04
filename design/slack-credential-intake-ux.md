# Slack credential intake: UX review before implementation

## Evidence and task

Inspected the requested flow and Slack's native modal lifecycle and plain-text input reference before implementation:
- https://docs.slack.dev/surfaces/modals/
- https://docs.slack.dev/reference/block-kit/block-elements/plain-text-input-element/

This is a new native Slack surface. Slack requires a user click and a fresh trigger to open it; the bot cannot open a modal unsolicited. A plain-text input is visible while editing, not a password control. Native Slack owns the typography, contrast, modal focus trap, keyboard controls and mobile presentation.

The person's objective is to authorize one named integration without leaving Slack or learning host commands. Natural order: read why access is needed; review the destination and effective scope; explicitly open the private form; paste once; save; see a safe receipt. The input must disappear immediately after submission or cancellation. No competing configuration editor or permission expansion belongs in this flow.

## Diagnosis and proposed composition

Use a private invitation with one action, “Adicionar credencial”. The modal contains a short purpose paragraph, one compact destination/scope/label group, a short disclosure that Slack processes the token, then the labeled credential fields. Generic providers and env keys need one token field. A Slack connection needs two fields, “Token do app” and “Token do bot”; users must not construct the internal JSON representation. Destination metadata is fixed by the authorized request; editing it here would ambiguously expand authority. The footer has native Cancel and one Save action. After Save, replace the entire form with a short processing view; then show a receipt containing only a fingerprint and any required reload notice. Errors replace the form with a fixed explanation and request a new invitation; never retain or echo the input.

The native modal resolves figure-ground and attention better than an inline channel form. It also keeps confirmation out of shared history. Host env scope is explicitly called “Este servidor”; broker connections say “Conexão do provedor; permissões atuais dos agentes”. Session/agent scope must not be implied if the underlying store does not enforce it.

## Gestalt assessment

- **Hierarchy:** one title, purpose, destination, input and Save in that order. The warning is adjacent to the input but visually secondary to the task. No duplicated primary action.
- **Proximity:** provider/key, scope and label form one group; token label and hint sit with the input. A single gap separates explanatory text from action.
- **Similarity:** all metadata uses the same plain-text treatment. Action buttons follow Slack's native semantics. Do not style metadata as editable fields.
- **Common region:** the modal is the single protected task region; metadata is grouped in one section. Avoid nested cards that compete with the modal boundary.
- **Continuity and alignment:** one vertical reading column, consistent left alignment and native footer. No side-by-side fields that wrap unpredictably on phones.
- **Figure-ground:** native backdrop isolates the task. Critical disclosure remains text, not color alone. The private invitation doesn't make the channel look like the place to paste a secret.
- **Closure:** success names the completed action and supplies a fingerprint; the form is removed. “Fechar” is the only terminal control. A loading label is not a success claim.
- **Symmetry:** native balanced footer is retained, but Save has primary emphasis. Perfect visual symmetry would weaken the action hierarchy, so metadata and input remain asymmetric in emphasis.
- **Common fate:** the secret field and Save disappear together on submission. All destination metadata remains tied to the same request; no independently drifting scope selectors.
- **Pragnanz:** one request, one credential, one save. Separate screens for metadata confirmation and paste would add ceremony without additional authority. Slack's two tokens are presented as two named inputs in the same form; constructing a JSON object would expose implementation and add an avoidable task.

## Density, feedback and access

Keep the modal to a short paragraph, one metadata section, one warning and one input (two only for the Slack token pair). Use native type scale and spacing. Native labels are real labels, placeholders are optional hints, and no emoji or color carries essential meaning. Avoid autofocus so keyboard and screen-reader users encounter the purpose first. Use native single-column wrapping at desktop and mobile widths; long targets wrap rather than causing horizontal scroll.

Empty input is prevented by Slack's required input and server validation. Saving immediately removes the input; loading says “Salvando…”. Success shows only fingerprint, store scope and reload requirement. Expired, replayed, unauthorized, malformed and failed requests use fixed safe messages, without reflecting values. Cancellation clears/consumes the request. No persisted request, trace, generic interaction or audit may contain the secret or a raw response URL.

Progressive disclosure stops at the native modal: permission policy remains outside this form. The concrete effective scope is shown because it affects the person's decision. Internal context IDs, view IDs, callback IDs, vault details and command syntax remain invisible.

## Validation plan

Verify generated Block Kit contains only the required token inputs and one primary submit, no initial value or input dispatch, and no secret in any receipt/error. Render an equivalent static prototype at desktop and narrow mobile widths to inspect rhythm, wrapping, primary-action prominence and terminal states. This prototype checks composition, not Slack's renderer; real Slack rendering requires a deployed runner and a human click.

## Rendered refinement before token-pair implementation

The desktop prototype confirmed the hierarchy and spacing, but its JSON instruction
made the person construct an internal storage object. Replace that single JSON
field with two vertically aligned inputs labeled “Token do app” and “Token do bot”.
Group the fields by adjacency and shared save action; assemble the validated JSON
only inside the sensitive handler after its server-side request lookup. This adds
one necessary input while removing serialization knowledge and ambiguous quoting.

## Post-implementation rendered validation

Reviewed the generated equivalent prototype using Chrome CDP viewport emulation
at 1200px and 390px. The form's document width matched its scroll width at both
sizes, all credential fields and Save were visible, and the destination group
wrapped without horizontal overflow. The named app/bot inputs remained clear in
one vertical column. At 390px, success and verification states showed only the
receipt or recovery instruction and Close; no credential input remained.

Evidence: `/tmp/ravi-credential-intake-preview/form-1200.png`, `form-390.png`,
`stored-390.png`, and `verify-390.png`. These are local screenshots of the static
equivalent generated from the actual Block Kit builders, not a claim of real
Slack-client rendering. Native Slack validation still requires deployment and
an authorized person's click. An earlier Chrome command-line screenshot clipped
at its minimum window size; the CDP captures established the intended 390px
viewport and did not reproduce a layout overflow.

## Replay correction: rendered diagnosis before implementation

Inspected `form-390.png` and `verify-390.png` from the existing local prototype
before changing the callback. The objective remains delivering one credential to
the reviewed destination. The natural order is purpose, destination, token, Save,
then receipt; the token fields and Save must disappear together after submission.

- **Hierarchy:** the form title and Save are dominant, while the terminal view
  has one title, one explanation and Close. Preserve that order.
- **Proximity / common region:** destination metadata and each label/input/hint
  already form coherent groups inside the modal; no new status panel is needed.
- **Similarity:** app and bot fields look alike but explicit labels distinguish
  them. A repeated callback should produce the same receipt as the original.
- **Continuity / alignment:** the vertical column and aligned footer remain
  readable at 390px. Keep the complete replacement of the form.
- **Figure-ground:** the modal separates the private operation from channel
  conversation. Status must remain text, not rely on success/error colors.
- **Closure:** the current replay failure contradicts the completed operation
  and invites unnecessary re-entry. Stored replays must recover the receipt;
  pending replays must say verification is needed and prohibit resending.
- **Symmetry:** the balanced modal and right-aligned Close are sufficient;
  adding Retry would introduce an unjustified competing action.
- **Common fate:** fields, hints and Save disappear as one unit. A pending
  callback must not visually revert any part of the task to a new submission.
- **Pragnanz:** one request has one result. Do not expose callback IDs, one-use
  claims or retry mechanics to explain a duplicate delivery.

Density, whitespace, typography, contrast and rhythm remain those inspected in
the prototype. The short verification text wraps without crowding; the existing
receipt fits in one column. Empty input keeps native required-field feedback;
processing removes editable input; known failure may request a new invitation;
uncertain or pending storage must not claim failure; success shows the existing
fingerprint and, for env, the reload notice. Progressive disclosure does not add
technical detail. Native labeled controls and text-only status preserve the
accessible composition, but keyboard, focus, screen reader and actual Slack
contrast require validation in Slack and are not established by this prototype.

Implementation direction: preserve the layout and native controls, validate the
current actor plus account/workspace/user/view binding before consulting result
state, and recover stored/pending results without asking for or storing another
token. Validate actual builders again at 390px and 1200px after the change.

## Replay correction: post-implementation validation

Generated fresh HTML from the actual Block Kit builders with synthetic metadata,
under the isolated-runtime test preload. Chrome CDP captured form, saving,
stored, verify and failed at 390×844 and 1200×900 in
`/tmp/ravi-credential-intake-f5-preview/`. Every document's scroll width matched
its viewport; each complete modal fit vertically. Form retained two named token
inputs and Cancel/Save; every status retained zero inputs and only Close. Visual
inspection of mobile receipts/verification and desktop form/verification
confirmed readable wrapping and the same hierarchy, grouping and closure as the
initial composition. This validates the local equivalent, not live Slack,
keyboard/focus behavior or assistive-technology behavior.

The isolated callback tests verify stored and pending replays, including a
get/claim race, never claim or write again and do not ask for another token.
Stored replays retain the original fingerprint/reload instruction; pending and
incomplete-result records retain verification. Status/fingerprint getter probes
are untouched when account, workspace, user, current authority, canonical actor,
view or callback validation fails. A failed replay ACK also preserves the known
receipt instead of replacing success with failure.
