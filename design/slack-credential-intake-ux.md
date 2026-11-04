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
