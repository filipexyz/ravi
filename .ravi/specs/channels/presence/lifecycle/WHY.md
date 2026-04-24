# Presence Lifecycle / WHY

## Rationale

Presence is a trust signal. If it stays active after work ends, users interpret idle sessions as active work.

The lifecycle must be owned by Ravi because the transport only knows how to deliver presence updates, not whether a runtime turn is still valid.

## Tradeoffs

- Delayed renewal after non-final WhatsApp sends improves fluidity for long streamed answers.
- Terminal and silent paths must override renewal because false activity is worse than brief absence of typing.
