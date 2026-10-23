import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createContact, getContact } from "../contacts.js";
import { readAgentRuntimePermissionsConfig } from "../permissions/agent-default-capabilities-provider.js";
import {
  readProfileCapabilityStrings,
  resolveContactChatOverlay,
} from "../permissions/contact-policy-permissions-provider.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../permissions/contact-chat-grants.js";
import { dbCreateAgent, dbUpsertChat } from "../router/router-db.js";
import { dbCreateTagDefinition, dbGetTagDefinition } from "../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { applyPermissionGrant } from "./apply-grant.js";

const CAPABILITY = { permission: "use", objectType: "tool", objectId: "Bash" };

let stateDir: string | null = null;

function seedContact(): string {
  const contact = createContact({ phone: "+15550009001", name: "Grant Target", tags: ["lead"] });
  return contact.id;
}

describe("apply permission grant", () => {
  let contactId = "";
  let chatA = "";
  let chatB = "";

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-grant-test-");
    // A plain chat row is enough: grants are keyed on the canonical chat id.
    contactId = seedContact();
    chatA = dbUpsertChat({ channel: "slack", instanceId: "main", platformChatId: "C-GRANT-A", chatType: "group" }).id;
    chatB = dbUpsertChat({ channel: "slack", instanceId: "main", platformChatId: "C-GRANT-B", chatType: "group" }).id;
    dbCreateAgent({ id: "grant-agent", cwd: "/tmp/grant-agent" });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("applies a chat scoped exact grant: profile, chat grant and agent ceiling", () => {
    const result = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:chat:1",
    });

    expect(result.profile).toBe("permission-use-tool-bash");
    expect(result.changed).toBe(true);
    expect(result.operations.map((operation) => operation.kind)).toEqual([
      "profile",
      "contact-chat-grant",
      "agent-ceiling",
    ]);
    expect(dbGetTagDefinition("permission-use-tool-bash")).toMatchObject({
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Bash"] } },
    });
    expect(
      dbGetContactChatGrant({ contactId, profileSlug: result.profile, scopeType: "chat", scopeId: chatA }),
    ).not.toBeNull();
    expect(readAgentRuntimePermissionsConfig("grant-agent")?.capabilities).toEqual([
      { permission: "use", objectType: "tool", objectId: "Bash" },
    ]);
  });

  function capabilityKeys(capabilities: readonly { permission: string; objectType: string; objectId: string }[]) {
    return capabilities.map((capability) => `${capability.permission}:${capability.objectType}:${capability.objectId}`);
  }

  it("keeps an exact grant to the denied capability while the derived profile carries others", () => {
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash",
      label: "Use Bash",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Read"] } },
    });

    const result = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:profile-exact:1",
    });

    // The grant attaches a single-capability sibling, never the derived profile.
    expect(result.profile).toBe("permission-use-tool-bash-exact");
    expect(capabilityKeys(result.capabilities)).toEqual(["use:tool:Bash"]);
    expect(dbGetTagDefinition("permission-use-tool-bash-exact")?.metadata).toEqual({
      permissions: { capabilities: ["use:tool:Bash"] },
    });
    expect(
      dbGetContactChatGrant({
        contactId,
        profileSlug: "permission-use-tool-bash-exact",
        scopeType: "chat",
        scopeId: chatA,
      }),
    ).not.toBeNull();
    expect(
      dbGetContactChatGrant({
        contactId,
        profileSlug: "permission-use-tool-bash",
        scopeType: "chat",
        scopeId: chatA,
      }),
    ).toBeNull();
    // The contact receives the denied capability only: no Read leak.
    expect(readProfileCapabilityStrings(result.profile)).toEqual(["use:tool:Bash"]);
    expect(
      resolveContactChatOverlay({ contactId, chatId: chatA }).capabilities.map(
        (capability) => `${capability.permission}:${capability.objectType}:${capability.objectId}`,
      ),
    ).toEqual(["use:tool:Bash"]);
    expect(readAgentRuntimePermissionsConfig("grant-agent")?.capabilities).toEqual([
      { permission: "use", objectType: "tool", objectId: "Bash" },
    ]);

    // Existing holders of the derived profile keep their capabilities.
    expect(dbGetTagDefinition("permission-use-tool-bash")?.metadata).toEqual({
      permissions: { capabilities: ["use:tool:Read"] },
    });
  });

  it("replays the exact grant on the sibling profile without duplicating it or widening it", () => {
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash",
      label: "Use Bash",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Read"] } },
    });

    const first = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:profile-exact-replay:1",
    });
    const second = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:profile-exact-replay:1",
    });
    // A replay without a ledger key is an ensure: nothing changes.
    const third = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
    });

    expect(first.profile).toBe("permission-use-tool-bash-exact");
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.profile).toBe("permission-use-tool-bash-exact");
    expect(third.changed).toBe(false);
    expect(third.operations.every((operation) => operation.status === "unchanged")).toBe(true);
    // One sibling, one grant, and still only the denied capability.
    expect(dbGetTagDefinition("permission-use-tool-bash-exact")?.metadata).toEqual({
      permissions: { capabilities: ["use:tool:Bash"] },
    });
    expect(dbListContactChatGrants({ contactId, profileSlug: "permission-use-tool-bash-exact" })).toMatchObject([
      { scopeType: "chat", scopeId: chatA, profileSlug: "permission-use-tool-bash-exact" },
    ]);
  });

  it("never rewrites a sibling -exact profile another contact already uses", () => {
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash",
      label: "Use Bash",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Read"] } },
    });
    // Another contact was granted exact Write first, so the plain sibling holds Write.
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash-exact",
      label: "Use Bash Exact",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Write"] } },
    });

    const result = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:sibling-occupied:1",
    });

    // Bash lands on a deterministic capability-hashed sibling instead.
    expect(result.profile).toMatch(/^permission-use-tool-bash-exact-[0-9a-f]{8}$/);
    expect(capabilityKeys(result.capabilities)).toEqual(["use:tool:Bash"]);
    expect(readProfileCapabilityStrings(result.profile)).toEqual(["use:tool:Bash"]);
    // The contact receives the denied capability only.
    expect(
      resolveContactChatOverlay({ contactId, chatId: chatA }).capabilities.map(
        (capability) => `${capability.permission}:${capability.objectType}:${capability.objectId}`,
      ),
    ).toEqual(["use:tool:Bash"]);

    // Existing holders keep exactly what they had: no rewrite of either profile.
    expect(dbGetTagDefinition("permission-use-tool-bash-exact")?.metadata).toEqual({
      permissions: { capabilities: ["use:tool:Write"] },
    });
    expect(readProfileCapabilityStrings("permission-use-tool-bash-exact")).toEqual(["use:tool:Write"]);
    expect(dbGetTagDefinition("permission-use-tool-bash")?.metadata).toEqual({
      permissions: { capabilities: ["use:tool:Read"] },
    });

    // Replaying the same exact grant resolves the same slug and creates nothing new.
    const replay = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
    });
    const replayAgain = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
    });

    expect(replay.profile).toBe(result.profile);
    expect(replayAgain.profile).toBe(result.profile);
    expect(replay.changed).toBe(false);
    expect(replayAgain.changed).toBe(false);
    expect(dbGetTagDefinition(result.profile)?.metadata).toEqual({
      permissions: { capabilities: ["use:tool:Bash"] },
    });
  });

  it("fails instead of rewriting when every candidate profile carries other capabilities", () => {
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash",
      label: "Use Bash",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Read"] } },
    });
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash-exact",
      label: "Use Bash Exact",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Write"] } },
    });
    // Pre-occupy the hashed candidate too, so no non-destructive slug is left.
    const capability = { permission: "use", objectType: "tool", objectId: "Bash" };
    const hash = createHash("sha256").update("use:tool:Bash").digest("hex").slice(0, 8);
    dbCreateTagDefinition({
      slug: `permission-use-tool-bash-exact-${hash}`,
      label: "Occupied",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Edit"] } },
    });

    expect(() =>
      applyPermissionGrant({
        intent: "exact",
        scope: { type: "chat", chatId: chatA },
        capability,
        contactId,
        agentId: "grant-agent",
      }),
    ).toThrow(/already carry different capabilities/);

    expect(readProfileCapabilityStrings(`permission-use-tool-bash-exact-${hash}`)).toEqual(["use:tool:Edit"]);
  });

  it("replays the same idempotency key without writing again", () => {
    const first = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:replay:1",
    });
    const second = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:replay:1",
    });

    expect(first.changed).toBe(true);
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.changed).toBe(true); // the stored result of the first apply
    expect(second.operations).toEqual(first.operations);
  });

  it("is idempotent without a key: a second identical apply changes nothing", () => {
    const first = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
    });
    const second = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.operations.every((operation) => operation.status === "unchanged")).toBe(true);
  });

  it("applies a contact scoped grant as a global contact tag", () => {
    const result = applyPermissionGrant({
      intent: "exact",
      scope: { type: "global" },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:contact:1",
    });

    expect(result.operations.map((operation) => operation.kind)).toEqual([
      "profile",
      "contact-profile-global",
      "agent-ceiling",
    ]);
    expect(getContact(contactId)?.tags).toContain("permission-use-tool-bash");
    expect(dbListContactChatGrants({ contactId })).toEqual([]);
  });

  it("applies a chat-tag scoped grant", () => {
    const result = applyPermissionGrant({
      intent: "exact",
      scope: { type: "chat_tag", chatTag: "ops" },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:chat-tag:1",
    });

    expect(
      dbGetContactChatGrant({ contactId, profileSlug: result.profile, scopeType: "chat_tag", scopeId: "ops" }),
    ).not.toBeNull();
    // The tagged scope covers every chat carrying the tag, not just one chat.
    expect(dbListContactChatGrants({ contactId })).toMatchObject([
      { scopeType: "chat_tag", scopeId: "ops", profileSlug: "permission-use-tool-bash" },
    ]);
    expect(dbListContactChatGrants({ contactId, scopeType: "chat", scopeId: chatB })).toEqual([]);
  });

  it("applies an agent-only grant without a contact scope", () => {
    const result = applyPermissionGrant({
      intent: "exact",
      scope: null,
      capability: CAPABILITY,
      agentId: "grant-agent",
      idempotencyKey: "test:agent:1",
    });

    expect(result.operations.map((operation) => operation.kind)).toEqual(["profile", "agent-ceiling"]);
    expect(dbListContactChatGrants()).toEqual([]);
    expect(readAgentRuntimePermissionsConfig("grant-agent")?.capabilities).toEqual([
      { permission: "use", objectType: "tool", objectId: "Bash" },
    ]);
  });

  it("full access grants the built-in admin profile without creating a definition", () => {
    const result = applyPermissionGrant({
      intent: "full-access",
      scope: { type: "chat", chatId: chatA },
      capability: CAPABILITY,
      contactId,
      agentId: "grant-agent",
      idempotencyKey: "test:full:1",
    });

    expect(result.profile).toBe("permission-admin");
    expect(result.capabilities).toEqual([{ permission: "admin", objectType: "system", objectId: "*" }]);
    expect(dbGetTagDefinition("permission-admin")).toBeNull();
    expect(
      dbGetContactChatGrant({ contactId, profileSlug: "permission-admin", scopeType: "chat", scopeId: chatA }),
    ).not.toBeNull();
    // The agent ceiling only gains the denied capability, never admin:*.
    expect(readAgentRuntimePermissionsConfig("grant-agent")?.capabilities).toEqual([
      { permission: "use", objectType: "tool", objectId: "Bash" },
    ]);
  });

  it("refuses to mutate a tag it does not own", () => {
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash",
      label: "Hand made",
      kind: "user",
      source: "operator",
      metadata: {},
    });

    expect(() =>
      applyPermissionGrant({
        intent: "exact",
        scope: { type: "chat", chatId: chatA },
        capability: CAPABILITY,
        contactId,
        agentId: "grant-agent",
      }),
    ).toThrow("not provider-owned");
  });
});
