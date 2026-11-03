-- Page Chat starts on for every organization that exists today and off for
-- organizations created later (console.pages.chat is entitlement-required).
-- An organization that already has a console.pages.chat row keeps it.
WITH granted AS (
  INSERT INTO "entitlements" ("organization_id", "key", "value_json", "source")
  SELECT "id", 'console.pages.chat', '{"enabled": true}'::jsonb, 'page_chat_rollout'
  FROM "organizations"
  ON CONFLICT ("organization_id", "key") DO NOTHING
  RETURNING "id", "organization_id"
)
INSERT INTO "audit_events" ("organization_id", "actor_type", "target_type", "target_id", "action", "after_json", "metadata_json")
SELECT "organization_id", 'system', 'entitlement', "id"::text, 'admin.entitlement.granted',
  '{"key": "console.pages.chat", "valueJson": {"enabled": true}, "source": "page_chat_rollout"}'::jsonb,
  '{"featureKey": "console.pages.chat", "reason": "Page Chat rollout to existing organizations", "source": "page_chat_rollout"}'::jsonb
FROM granted;
