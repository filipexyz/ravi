# Why Channel Chat Actions Exist

Ravi previously had three conflicting sources of truth: prompt capability
prose, a hard-coded session action list, and adapter-specific executors. A chat
surface was enough for the catalog to claim an action was available even when
the native adapter could not execute it.

The typed resolver makes discovery and execution use the same facts. It also
separates provider-confirmed success from queue acceptance, preventing silent
reaction drops and false success responses.

## Rejected Alternatives

- Keep hard-coded actions in `sessions.ts`: this drifts from adapters.
- Use Omni mappings for every provider: native channels are not Omni accounts.
- Expose a raw provider API tool: this bypasses typed permissions and target
  ownership.
