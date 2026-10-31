# Decision and thread review

## Before implementation: rendered prototype and Gestalt gate

Inspected a local browser-rendered prototype of the existing Slack card and proposed waiting/answered states at 1250×800. This is a layout prototype, not a screenshot of the Slack client. Slack controls actual typography, spacing, responsive layout and colors.

Objective: see what needs an answer, answer the explicit question, and return to the same work. Primary action is recording an answer. Order: thread title → pending question → responsible actor → explicit answer → delivery feedback. The pending cue disappears after answer; immutable history stays in the thread and decision detail.

- Hierarchy: existing title is clear; green ongoing status conflicts with a blocking question hidden as progress. Pending question takes subtitle priority and gets a textual waiting label.
- Proximity: question and state stay within one card; details and response belong in its thread. Avoid a disconnected approval dashboard.
- Similarity: retain the same title/body/status structure for open, waiting and complete. Waiting must differ through words as well as color.
- Common region: card boundary correctly groups one work item. Do not put another thread's question in its card.
- Continuity/alignment: single reading axis and stable title avoid a context shift. Native and classic fallback must preserve reading order.
- Figure/ground: bold question stands out; background brief becomes secondary. No second bright call to action.
- Closure: answered is visibly different from delivered. A complete-looking card must not conceal an open decision or uncertain delivery.
- Symmetry: stable structure is useful, but equal weight for progress and a pending question is harmful; question wins.
- Common fate: question label and count update together; reopening/closing and decision state must not drift independently.
- Pragnanz: one question state, one action, one work destination. Do not expose queue claims, session keys or transport ids in normal card copy.

Density and rhythm: retain compact native card limits; long questions are abbreviated only on the root and fully shown in the thread. Typography and whitespace remain Slack-native. Avoid extra controls and competing progress summaries. Text labels supplement color/emoji for accessibility; fallback text includes the pending state. Responsive behavior relies on native wrapping, with checks at narrow and wide prototype widths. Empty: ordinary ongoing card. Pending: oldest question and count. Answered: pending cue removed. Delivery failure: answer remains recorded and retry status is readable via decision detail; uncertainty never says completed. Progressive disclosure: root → full thread question → CLI audit/history. No inferred free-text approval.

## Contract

A decision has exactly one task or managed-thread origin. Thread origin stores lifecycle id, canonical chat id and waiting session key independently. All reads and writes inherit authorization from that origin; owner and --by remain provenance rather than authenticated approval. The waiting worker cannot answer. An explicit parent/operator command records the response; ordinary conversational text never auto-answers.

Every open thread decision prevents close, including nonblocking or agent-owned questions. Undelivered answers also prevent close. No discard/force flag. Task parked retains its existing open+blocking+human fold and does not change lifecycle.

Question and answer effects are persistent. The answer envelope is frozen in the answering transaction. Publication retries share one id; consumer admission verifies the destination and stored envelope and owns a durable receipt. Confirmed publication failure retries with backoff. Crash/exception after runtime admission begins is uncertain and is not automatically repeated; inspect the session trace before explicitly continuing work. Delivery means accepted by the dispatcher, not successful completion of the work.

## Render validation after implementation

Rendered the actual `buildSlackThreadCard` native and fallback payloads in a browser prototype at 1250×1000 and with mobile device metrics 390×1750. Both variants preserve title → question → brief → state. At 390px the question and subtitle wrap without horizontal overflow (viewport 390, body scroll width 358). The waiting cue is textual as well as colored; after an answer it becomes delivery feedback, and after admission that feedback disappears. No controls or competing actions were added. Classic blocks now match native subtitle priority.

This validates composition and generated copy, not Slack's proprietary card renderer or a live delivery. Unit tests validate both Block Kit shapes and field limits. A live Slack smoke is deferred to rollout; no test messages or production migration were performed.

## Recovery and rollout limits

`decisions` needs explicit command grants in addition to origin access. There is no automatic grant expansion. Human free text is not ingested as a decision answer: an authorized parent/operator explicitly records it, preserving the existing distinction between provenance and authenticated approval. `resolve-delivery` is local-operator-only and requires trace evidence; it cannot be used by the waiting worker.

The question outbox freezes its payload before first publication. Answer ids and frozen envelopes survive publication retries. An ambiguous dispatcher outcome requires operator inspection, because database and runtime admission cannot be committed in one transaction. Do not claim exactly-once execution across an unverified crash; the guarantee is durable duplicate suppression after admission and no automatic replay of uncertainty.

## Adversarial review before merge

Reproduced and corrected these gaps:

- Nested authenticated caller identity was honored by authorization but omitted by self-answer validation and actor/relay provenance. Tests now cover thread and task workers, an unrelated caller, read-only grants and an explicitly authorized answerer.
- A shell automation without session fields could reach local-operator recovery. The spawned automation principal now forbids that path.
- Dispatcher success could acknowledge only a volatile debounce buffer, or silently fall back after the assigned agent disappeared. Decision prompts bypass debounce; a verified missing-agent rejection stays failed/retryable. Unknown outcomes still become uncertain rather than replaying automatically.
- Canonical rename previously left active task assignments pointing at a stale session name when the runtime key differed from its display name. Rename now updates active task/session references in the same transaction, preserving decision provenance and checkpoint timing. No checkpoint policy changes.
- The dispatcher may await preflight before resolving its runtime session by name. The frozen envelope now carries the canonical waiting key, checked again at launch to reject a renamed/replaced target.
- A reconciler holding a stale batch could reconstruct a question payload already frozen by another attempt. Claim now re-reads the stored payload and checks its retry deadline. An interleaving/rename test verifies identical retries.
- The waiting card's notification text embedded raw mention syntax and unbounded question text. It now escapes and bounds the note using the existing helper. This preserves the inspected composition and reading order.
- Sessions-skill decision examples now participate in the execute-consumer drift test.

Also checked concurrent admission, close while admission is in progress, original migration field/provenance preservation, rollback on collision, and scope exclusions. The contract is one verified dispatcher admission under retries, with no automatic replay across ambiguous crashes; it does not claim exactly-once execution of arbitrary side effects. Signals, followups and checkpoint logic are unchanged.
