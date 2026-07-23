# Channel Mentions / WHY

Native mentions are transport-specific payloads, but the intent to mention a
participant is Ravi-owned. Ravi must resolve mentions from chats, participants,
contacts, sessions, and outbound intent before Omni sends channel payloads.

This prevents agents from addressing raw WhatsApp ids directly, mixing source
and output chats in multi-chat sessions, or rendering unsafe channel ids as
human mention labels.
