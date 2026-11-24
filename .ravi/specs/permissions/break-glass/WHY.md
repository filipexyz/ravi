# Why

## Why power, not name

The #799 guard refused `permissions allow full-access --apply`, matching the
profile name. On 23/11 the same power passed under another name:
`permissions allow chat-admin --capabilities 'admin:system:*' --apply`. A guard
by name is a list of spellings to remember; a guard by power is one question
asked of every grant. The Luís decided on 24/11 to close it.

## Why execute:executable:* counts

Running any host command reaches the database, the credentials and the daemon.
The runtime already accepts `execute:executable:*` in place of admin for shell
jobs and provider settings. Leaving it out would leave the same hole open with a
different capability.

## Why tagging is guarded for agents and not for the terminal

`permission-owner|admin|superadmin` confer admin by name. The docs told operators
that a full-access agent could run `ravi contacts tag <contact> permission-owner`:
any admin agent could make any contact an admin. The terminal keeps that path
because a fresh install has no approver yet; the first owner is made at the
keyboard. Agents never make anyone an admin.
