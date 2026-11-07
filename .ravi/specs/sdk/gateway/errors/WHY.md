# Why

The source handler already produced `--instructions is required`, but fail() classified it as COMMAND_FAILED and the remote CLI replaced all uncatalogued failures with a generic sentence. Endpoint-specific catalogs fixed symptoms, not the shared boundary. The old gateway diagnostic path only covered handler UNHANDLED_ERROR; authentication, authorization/validation plumbing and return validation could escape without a stack or correlation id.

A shared request context and error projection preserve useful public copy while keeping exception diagnostics local. UUIDs are generated on the server rather than reflecting attacker-controlled headers. Rate limiting uses a bounded signature of sanitized diagnostics and preserves a pointer to the first request.
