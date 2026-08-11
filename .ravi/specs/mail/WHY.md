# Mail / WHY

The mail domain examples consume the confirmation policy owned by `cli` and
the operation classification owned by `cli/mail`; they do not redefine either
contract here.

External send and reply operations are difficult to undo, so examples that
intend to deliver mail include `--execute`. Local mailbox behavior remains
owned by `mail/local-mailbox`.
