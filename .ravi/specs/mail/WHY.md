# Mail / WHY

Email is the one channel where Ravi cannot own delivery: a remote provider
(Ravi Mail through Console, Gmail, IMAP/SMTP) always sits between an agent and
the recipient. The domain is local-first precisely because of that dependency —
if the provider were the source of truth for conversation state, every provider
outage, rate limit, or credential rotation would blind agents to mail they have
already synced. SQLite holds the normalized mailbox model; providers own
delivery facts and remote ids, and adapt into the local contract instead of
replacing it.

Email addresses are deliberately not contacts. A raw address becoming a
canonical contact by itself would pollute the identity graph with unresolved
strangers, so ingestion resolves addresses through the contacts identity graph
and keeps raw addresses as provenance only.

The inbox projection exists because mail is both durable content and a trigger
for attention. Keeping the durable state in the local mailbox and projecting
unread/actionable messages into inbox items lets automations listen to
`ravi.inbox.mail.received` without coupling triage to provider payloads.

Rejected alternative: treating Console delivery events as the mail store.
Those events remain diagnostic plumbing; they must flow through local mailbox
ingest before becoming durable state, so duplicate provider events can be
deduplicated idempotently and enrichment can be applied under local control.
