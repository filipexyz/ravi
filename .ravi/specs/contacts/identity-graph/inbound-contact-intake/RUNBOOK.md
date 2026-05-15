# Inbound Contact Intake Runbook

## Diagnose A Missing Contact

1. Confirm the channel instance and raw chat id that received the inbound message.
2. Check whether a canonical chat exists for `channel + instance_id + normalized_chat_id`.
3. Check whether the inbound message has a durable message record or only TTL `message_metadata`.
4. Check whether the sender has a `platform_identities` row for `channel + instance_id + normalized_platform_user_id`.
5. Check whether that platform identity owns a `contact`.
6. Check `contact_policies.status` for the contact.
7. Check route/pending state separately from contact state.

## Expected Failure Interpretation

- Chat exists, no contact: intake did not run or was configured `off`.
- Contact exists, no CRM profile: acceptable unless CRM-default profile creation is enabled.
- Pending route exists, contact exists: normal no-route or approval state.
- Pending route exists, no contact for DM: intake gap.
- Group id appears as a contact: migration or resolver bug.
- Message exists only in session history: assigned-agent path worked, but no route-independent conversation ledger exists.
- Message exists only in `message_metadata`: reply/media cache exists, not durable conversation backup.

## One-Time Import Order

1. Ensure the canonical intake service exists.
2. Import DMs from `account_pending`, chats, and message/session traces when needed.
4. Link `chat_participants` to platform identities and contacts.
5. Import message actor metadata where source evidence is strong.
6. Generate duplicate candidates for ambiguous records instead of merging automatically.
7. Verify CLI/API reads canonical contacts.

## Safe Rollout

1. Enable intake in dry-run/report mode for one instance.
2. Compare inbound unique human senders against created/linked contacts.
3. Enable `contact_intake_mode='discovered'` for the instance.
4. Keep reply permissions unchanged.
5. Watch duplicate candidate counts and group/contact boundary checks.
6. Flip CLI reads to canonical when discovered contacts are visible and policy is preserved.

## Suggested Queries

Use the actual DB paths for the running environment.

```sql
-- Platform identities without owners should be rare after intake.
SELECT channel, instance_id, COUNT(*) AS total
FROM platform_identities
WHERE owner_id IS NULL OR owner_type IS NULL
GROUP BY channel, instance_id;
```

```sql
-- Contacts created by automatic intake.
SELECT cp.status, COUNT(*) AS total
FROM contacts c
JOIN contact_policies cp ON cp.contact_id = c.id
WHERE cp.source LIKE '%inbound%'
GROUP BY cp.status;
```

```sql
-- Chat participants still unresolved after intake.
SELECT chat_id, COUNT(*) AS total
FROM chat_participants
WHERE contact_id IS NULL AND agent_id IS NULL AND platform_identity_id IS NULL
GROUP BY chat_id
ORDER BY total DESC;
```
