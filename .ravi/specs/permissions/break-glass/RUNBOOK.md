# Runbook

## Someone needs full access

```bash
ravi permissions request full-access --to contact:<id> --chat <chat-id> --agent <executor> --execute
ravi permissions request-status <request-id>
```

The operator approves on the card (Slack) or by replying (WhatsApp).

## A grant was refused with FULL_ACCESS_APPROVAL_REQUIRED

`details.breakGlass` lists what made it break-glass: an admin profile name, or
`admin:system:*` / `execute:executable:*` among the capabilities. Narrow the
capabilities (`execute:executable:git`) or ask for approval as above.

## Make the first owner of a fresh install

From the operator terminal, not from an agent:

```bash
ravi contacts tag <your-contact-id> permission-owner
```
