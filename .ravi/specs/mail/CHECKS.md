# Mail / CHECKS

- Send and reply examples that intend delivery MUST include `--execute`.
- A send or reply without `--execute` MUST return exit `3` and MUST NOT create
  a message, enqueue an outbox row, emit an event, or call a provider.
- Mail-specific classification and errors MUST remain owned by `cli/mail`;
  this domain MUST NOT redefine the global CLI contract.
