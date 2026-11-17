# Why

A resident runtime is a cache entry once it stops serving work. Keeping it until a five-minute TTL while another session waits makes the cache policy control user latency. Admission therefore evicts eligible idle runtimes synchronously and refuses a truly full lane immediately.

The prompt consumer already orders work per session. New global scheduling or a larger timeout would not fix this incident. Reservations account for in-flight preparations so independent starts can progress without oversubscribing capacity.

The local inbox is the durable fallback allowed by the request. The current transport stream expires prompts after 60 seconds and uses memory storage, so delayed NAK alone cannot justify a promise of indefinite automatic retry. Persist the original envelope and receipt before ACK; an explicit resumption is a new delivery. The operator can inspect slot occupants without exposing other sessions to the requesting chat.

Thirty seconds is a defensive pending-waiter watchdog tied to one liveness-reporting interval. It is independent of idle TTL and is not used to make normal admission wait. Native presence follows receipt and has independent per-session API delivery, so a delayed Slack request cannot make unrelated sessions appear inactive.
