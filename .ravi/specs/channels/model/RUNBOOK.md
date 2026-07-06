# Channels Model Runbook

1. Add or change canonical entities in this spec before implementation.
2. Keep platform ids in `PlatformIdentity`, not as Ravi primary ids.
3. Keep sessions outside the channel model; connect them through routing/subscriptions.
4. Update capability matrices when a platform supports or lacks a feature.
5. Validate generated SDK/types after schema changes.
