import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCredentialsDbPath } from "../credentials/store.js";
import { getRaviStateDir } from "../utils/paths.js";
import { assertStateSchemaReady, StateSchemaNotReadyError } from "./schema-owner.js";
import { assertDatabaseTargetAllowed, openStateDatabase } from "./state-boundary.js";

/** Daemon boot prepares every store before consumers or gateway become ready. */
export async function initializeRuntimeState(): Promise<void> {
  const router = (await import("../router/router-db.js")).getDb();
  (await import("../cloud-agents/chat-db.js")).ensureCloudChatSchema(router);
  (await import("../channels/outbound-publish-outbox.js")).ensureChannelOutboundPublishOutboxSchema(router);
  (await import("../channels/slack/automatic-output-circuit.js")).ensureSlackAutomaticOutputSchema(router);
  (await import("../pr/journal.js")).initializePublicationSchema(router);
  (await import("../bridge/store.js")).getBridgeStore();
  (await import("../contacts.js")).ensureContactsDb();
  (await import("../db.js")).getDb();
  (await import("../credentials/store.js")).ensureCredentialTables();
  (await import("../console-scope/store.js")).getConsoleScopeDb();
  (await import("../insights/insight-db.js")).ensureInsightsDb();
  (await import("../knowledge/store/db.js")).ensureKnowledgeDb();
  (await import("../devin/store.js")).ensureDevinSchema();
}

/** Read-only preflight, before NATS connects or a channel starts serving. */
export function assertRuntimeStateReady(env: NodeJS.ProcessEnv = process.env): void {
  const root = getRaviStateDir(env);
  const stores: Array<[string, string[]]> = [
    [
      join(root, "ravi.db"),
      ["router", "cloud-chat", "channel-outbound-publish", "slack-automatic-output", "console-scope", "pr-publication"],
    ],
    [join(root, "chat.db"), ["contacts", "chat"]],
    [getCredentialsDbPath(env), ["credentials"]],
    [join(root, "insights.db"), ["insights"]],
    [join(root, "knowledge.db"), ["knowledge"]],
    [join(root, "devin.db"), ["devin"]],
    [join(root, "human-bridge", "bridge.db"), ["bridge"]],
  ];
  for (const [path, components] of stores) {
    assertDatabaseTargetAllowed(path, { env });
    if (!existsSync(path)) throw new StateSchemaNotReadyError(components.join(", "));
    const db = openStateDatabase(path, { readonly: true, create: false }, { env });
    try {
      for (const component of components) assertStateSchemaReady(db, component);
    } finally {
      db.close();
    }
  }
}
