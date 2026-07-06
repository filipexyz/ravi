# Why Channel Delivery Exists

Delivery is the durable boundary between a Ravi runtime response and a platform send.

Ravi needs this boundary so channel adapters can retry, reconcile, audit and recover outbound messages without tying user-visible delivery to the lifetime of one agent process.

Delivery is intentionally separate from runtime status. A message can be delivered while an agent status is still rendering, complete or failed.
