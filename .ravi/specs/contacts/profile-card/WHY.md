# Why

Luis wants to start with his own contact profile and then scale the same pattern to other contacts.

The risk is creating one special-purpose runtime agent per person or letting an agent rewrite profile state from weak conversational hints. That would make identity, context, and permissions drift away from the contacts model.

The profile card keeps the product surface centered on contacts:

- one canonical contact remains the target
- messages and sessions remain evidence
- timeline events preserve history
- scoped metadata represents current context
- `contact-profiler` is generic and receives `target_contact_id`

This gives Ravi a safe path from "profile for Luis" to "profile for any known contact".
