# Why

A resident runtime is a cache entry once it stops serving work. Keeping it until a five-minute TTL while another session waits makes the cache policy control user latency. Admission therefore evicts eligible idle runtimes synchronously and refuses a truly full lane immediately.

The prompt consumer already orders work per session. New global scheduling or a larger timeout would not fix this incident. Reservations account for in-flight preparations so independent starts can progress without oversubscribing capacity.

The local inbox is the durable fallback allowed by the request. The current transport stream expires prompts after 60 seconds and uses memory storage, so delayed NAK alone cannot justify a promise of indefinite automatic retry. Persist the original envelope and receipt before ACK; an explicit resumption is a new delivery. The operator can inspect slot occupants without exposing other sessions to the requesting chat.

The receipt text exists for a person waiting on a reply. On 2026-11-24 the three-hourly `ravi-updates blog` cron, whose reply surface is a WhatsApp group that can include outsiders, was refused at 21:01Z for background capacity (8 of 8 slots; the inbox item lists the occupants). The runtime posted "Sem capacidade agora ... Recibo: inbox_item_..." into that group (inbox item `inbox_item_8bab0a24…`; session trace `agent:ravi-updates:cron:699a4730`, three `dispatch.start_rejected` at 21:01:31, 21:01:47 and 21:01:58Z). An automation turn has nobody waiting, so its inbox item and the operator event are its whole receipt. The SQLite capacity notice in the same consumer already skipped background turns; the admission receipt did not.

Thirty seconds is a defensive pending-waiter watchdog tied to one liveness-reporting interval. It is independent of idle TTL and is not used to make normal admission wait. Native presence follows receipt and has independent per-session API delivery, so a delayed Slack request cannot make unrelated sessions appear inactive.
