# Gateway CORS / WHY

Browser clients on a different port than the daemon are cross-origin. The
previous policy only allowed `chrome-extension://`, so Flutter web on
`http://127.0.0.1:8088` failed preflight against `http://127.0.0.1:7777`.

A wildcard ACAO cannot be used because the Dart SDK sends
`Authorization: Bearer rctx_*`. Reflecting every Origin would turn the
gateway into an open relay for credentialed browser calls.

The allowlist is explicit and exact. The localhost flag is opt-in so a
forgotten production env cannot expose every loopback page origin.
