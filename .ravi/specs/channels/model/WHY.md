# Why The Channels Model Exists

The channels model defines the semantic ownership boundary for Ravi.

Adapters can expose transport-specific behavior, but Ravi owns channels, instances, chats, threads, actors, messages, delivery, presence, capabilities and credentials.

Keeping these entities canonical lets the system generate SDKs, test adapters consistently and retire Omni as a semantic dependency without losing compatibility during migration.
