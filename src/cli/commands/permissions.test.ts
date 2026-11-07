import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { addContactTag, createContact, getContact } from "../../contacts.js";
import { authorizeContextCapabilities } from "../../permissions/context-capabilities-provider.js";
import { dbEnsureContactChatGrant, dbListContactChatGrants } from "../../permissions/contact-chat-grants.js";
import { recordPermissionDenial } from "../../permissions/denials.js";
import {
  AGENT_RUNTIME_PERMISSION_PROFILES,
  materializeAgentDefaultCapabilities,
  readAgentRuntimePermissionsConfig,
} from "../../permissions/agent-default-capabilities-provider.js";
import { bootstrapCapabilitiesFor } from "../../permissions/runtime-bootstrap-provider.js";
import { resolveContactChatOverlay } from "../../permissions/contact-policy-permissions-provider.js";
import { dbCreateAgent, dbUpdateAgent, dbUpsertChat, getDb } from "../../router/router-db.js";
import { createRuntimeContext, resolveRuntimeContext } from "../../runtime/context-registry.js";
import { attachTagSlugsToAsset, dbCreateTagDefinition, dbGetTagDefinition } from "../../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";

afterAll(() => mock.restore());

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../../permissions/provider-registry.js", () => ({
  getConfiguredPermissionProviders: () => [
    { id: "operator-control", version: "operator-control/local-v1", required: true },
    { id: "context-capabilities", version: "snapshot/v1", required: true },
  ],
  getConfiguredCapabilityMaterializers: () => [
    { id: "runtime-bootstrap", version: "bootstrap/v1", required: true },
    { id: "agent-default-capabilities", version: "agent-defaults/v1", required: true },
    { id: "agent-identity-permissions", version: "agent-identity/v1", required: true },
    { id: "contact-policy-permissions", version: "contact-tags/v1", required: true },
  ],
}));

mock.module("../../permissions/provider-runtime.js", () => ({
  authorizePermission: (request: {
    localOperator?: boolean;
    permission: string;
    objectType: string;
    objectId: string;
  }) => ({
    decision: request.localOperator ? "allow" : "deny",
    allowed: request.localOperator === true,
    providerId: request.localOperator ? "operator-control" : "provider-runtime",
    providerVersion: request.localOperator ? "operator-control/local-v1" : "runtime",
    reasonCode: request.localOperator ? "operator_control_local_allow" : "no_permission_provider_configured",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
  }),
  materializeSubjectCapabilities: (subjectType: string, subjectId: string) =>
    subjectType === "agent" && subjectId === "main"
      ? [{ permission: "view", objectType: "agent", objectId: "*", source: "agent-default-capabilities:agent:main" }]
      : [],
}));

const { PermissionsCommands } = await import("./permissions.js");

function captureContractError(fn: () => unknown): ContractError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("Expected a ContractError");
}

function groupChat(platformChatId: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "main",
    platformChatId,
    chatType: "group",
    title: platformChatId,
  });
}

describe("PermissionsCommands provider-runtime surface", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permissions-commands-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("reports provider-owned permission orchestration enabled", () => {
    const commands = new PermissionsCommands();
    const payload = commands.status(true);

    expect(payload).toMatchObject({
      status: "provider-runtime",
      mutationCommands: { enabled: true },
      authorizationProviders: [{ id: "operator-control" }, { id: "context-capabilities" }],
      capabilityMaterializers: [
        { id: "runtime-bootstrap" },
        { id: "agent-default-capabilities" },
        { id: "agent-identity-permissions" },
        { id: "contact-policy-permissions" },
      ],
    });
  });

  it("checks permissions through provider-runtime only", () => {
    const commands = new PermissionsCommands();
    const denied = commands.check("execute", "group", "agents", undefined, true);
    const allowed = commands.check("execute", "group", "agents", true, true);

    expect(denied.allowed).toBe(false);
    expect(denied.decision.providerId).toBe("provider-runtime");
    expect(denied.decision.reasonCode).toBe("no_permission_provider_configured");
    expect(denied.diagnosticNote).toContain("agent-default-capabilities");
    expect(denied.diagnosticNote).toContain("ravi permissions allow <profile> --to agent:<id> --apply");
    expect(denied.guidance?.preferredPath.allowCommand).toBe(
      "ravi permissions allow permission-execute-group-agents --capabilities execute:group:agents --apply",
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.decision.providerId).toBe("operator-control");
  });

  it("suggests matching provider-owned permission tags for denied checks", () => {
    dbCreateTagDefinition({
      slug: "permission-family",
      label: "Family Image",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: ["mutate:image:generate"],
        },
      },
    });

    const commands = new PermissionsCommands();
    const denied = commands.check("mutate", "image", "generate", undefined, true);

    expect(denied.allowed).toBe(false);
    expect(denied.guidance).toMatchObject({
      canonicalCapability: "mutate:image:generate",
      preferredPath: {
        suggestedTags: [
          {
            slug: "permission-family",
            label: "Family Image",
            capabilities: ["mutate:image:generate"],
          },
        ],
      },
      requestShape: {
        profileOrTag: "permission tag permission-family",
      },
    });
  });

  it("materializes provider-owned subject capabilities", () => {
    const commands = new PermissionsCommands();
    const payload = commands.materialize("agent", "main", true);

    expect(payload).toEqual({
      subject: { type: "agent", id: "main" },
      capabilities: [
        {
          permission: "view",
          objectType: "agent",
          objectId: "*",
          source: "agent-default-capabilities:agent:main",
        },
      ],
      guidance: {
        recurringAccess:
          "Recurring access should come from provider-owned agent identity profiles/tags, not ad-hoc capability lists.",
        breakGlass: "full-access is break-glass and should be explicit.",
      },
    });
  });

  it("refuses contact grants, revokes and listings without a chat scope", () => {
    const contact = createContact({ phone: "+15550000010", name: "Scope Required User" });
    const commands = new PermissionsCommands();

    const allowError = captureContractError(() =>
      commands.allow(
        "image workflow",
        `contact:${contact.id}`,
        undefined,
        "mutate:image:generate",
        undefined,
        undefined,
        true,
        true,
      ),
    );
    const denyError = captureContractError(() =>
      commands.deny("image workflow", `contact:${contact.id}`, undefined, undefined, undefined, true, true),
    );
    const listError = captureContractError(() =>
      commands.list(`contact:${contact.id}`, undefined, undefined, undefined, undefined, undefined, undefined, true),
    );

    for (const error of [allowError, denyError, listError]) {
      expect(error.code).toBe("CHAT_SCOPE_REQUIRED");
      expect(error.exitCode).toBe(2);
      expect(error.details.acceptedFlags).toEqual(["--chat <chat-id|current>", "--chat-tag <tag>", "--force"]);
    }
    expect(allowError.details.suggestions).toContain(
      `ravi permissions allow image workflow --to contact:${contact.id} --capabilities mutate:image:generate --chat <chat-id>`.replace(
        "image workflow",
        '"image workflow"',
      ),
    );
    // Refused before any write, even with --apply.
    expect(dbGetTagDefinition("permission-image-workflow")).toBeNull();
    expect(getContact(contact.id)?.tags).not.toContain("permission-image-workflow");
  });

  it("suggests the current chat when a contact grant has no scope", () => {
    const contact = createContact({ phone: "+15550000011", name: "Current Chat User" });
    const chat = groupChat("120363400000000011@g.us");
    const commands = new PermissionsCommands();

    const error = captureContractError(() =>
      runWithContext(
        {
          agentId: "main",
          source: { channel: "whatsapp", accountId: "main", instanceId: "main", chatId: chat.platformChatId },
        },
        () => commands.allow("image workflow", `contact:${contact.id}`, undefined, "mutate:image:generate", undefined),
      ),
    );

    expect(error.code).toBe("CHAT_SCOPE_REQUIRED");
    expect(error.details.currentChat).toBe(chat.id);
    expect(String(error.details.suggestedAction)).toContain(`only in this chat (--chat ${chat.id})`);
    expect(error.details.suggestions?.[0]).toEndWith(`--chat ${chat.id}`);
  });

  it("checks contact scope before resolving a new profile without capabilities", () => {
    const contact = createContact({ phone: "+15550000013", name: "New Profile User" });
    const chat = groupChat("120363400000000013@g.us");
    const commands = new PermissionsCommands();
    const allowNewProfile = (chatId?: string, force?: boolean) =>
      captureContractError(() =>
        commands.allow(
          "brand new",
          `contact:${contact.id}`,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          chatId,
          undefined,
          force,
        ),
      );

    expect(allowNewProfile().code).toBe("CHAT_SCOPE_REQUIRED");
    const conflict = allowNewProfile(chat.id, true);
    expect(conflict.code).toBe("USAGE_ERROR");
    expect(conflict.message).toContain("cannot be combined with --chat/--chat-tag");
    const missingCapabilities = allowNewProfile(chat.id);
    expect(missingCapabilities.code).toBe("USAGE_ERROR");
    expect(missingCapabilities.exitCode).toBe(2);
    expect(missingCapabilities.message).toContain("Unknown or empty permission profile: permission-brand-new");
    for (const profile of AGENT_RUNTIME_PERMISSION_PROFILES) {
      expect(missingCapabilities.message).toContain(profile);
    }
    expect(missingCapabilities.message).toContain("ravi skills show permissions");
    expect(missingCapabilities.message).toContain("ravi tags list --kind system --source permissions --json");
    expect(dbGetTagDefinition("permission-brand-new")).toBeNull();
    expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
  });

  for (const profile of AGENT_RUNTIME_PERMISSION_PROFILES) {
    const behavior =
      profile === "full-access" ? "previews and blocks unapproved apply of" : "plans, grants, reads and revokes";
    it(`${behavior} built-in ${profile} for a human in a governed Slack chat`, () => {
      const contact = createContact({ phone: "+15550000031", name: "Profile Grant User" });
      const other = createContact({ phone: "+15550000032", name: "Other Chat Member" });
      const chat = dbUpsertChat({
        channel: "slack",
        instanceId: "test-slack",
        platformChatId: "C_PROFILE_TEST",
        chatType: "group",
      });
      const commands = new PermissionsCommands();
      const subject = `contact:${contact.id}`;
      const slug = `permission-${profile}`;
      dbCreateAgent({ id: "profile-reference", cwd: "/tmp" });
      dbUpdateAgent("profile-reference", { defaults: { runtimePermissions: { profile } } });
      const runtimeCapabilities =
        profile === "bootstrap"
          ? bootstrapCapabilitiesFor("agent")
          : materializeAgentDefaultCapabilities("profile-reference");
      const expected = runtimeCapabilities.map(({ permission, objectType, objectId }) => ({
        permission,
        objectType,
        objectId,
      }));
      const capabilityStrings = expected.map((cap) => `${cap.permission}:${cap.objectType}:${cap.objectId}`);

      expect(dbGetTagDefinition(slug)).toBeNull();
      const preview = commands.allow(
        profile,
        subject,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        true,
        chat.id,
      );
      const revokePreview = commands.deny(slug, subject, chat.id, undefined, undefined, false, true);
      expect(preview.capabilities).toEqual(expected);
      expect(preview.confirmation.capabilities).toEqual(capabilityStrings);
      expect(revokePreview.capabilities).toEqual(expected);
      expect(revokePreview.tagSlug).toBe(preview.tagSlug);
      expect(preview.dryRun).toBe(true);
      expect(dbGetTagDefinition(slug)).toBeNull();
      expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
      if (profile === "full-access") {
        expect(capabilityStrings).toContain("admin:system:*");
        expect(capabilityStrings).toContain("execute:executable:*");
        expect(capabilityStrings).toContain("use:skill:*");
        expect(preview.hints).toContain(
          "full-access requires verified operator approval. This command cannot consume an operator approval; --apply is blocked.",
        );
        expect(preview.nextCommand).toBeUndefined();
        const denied = captureContractError(() =>
          commands.allow(slug, subject, undefined, undefined, undefined, undefined, true, true, chat.id),
        );
        expect(denied.code).toBe("FULL_ACCESS_APPROVAL_REQUIRED");
        expect(denied.exitCode).toBe(3);
        expect(dbGetTagDefinition(slug)).toBeNull();
        expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
        dbEnsureContactChatGrant({ contactId: contact.id, profileSlug: slug, scopeType: "chat", scopeId: chat.id });
        expect(commands.deny(profile, subject, chat.id, undefined, undefined, true, true).changedCount).toBe(1);
        expect(
          commands.list(subject, chat.id, undefined, undefined, profile, undefined, undefined, true).grants,
        ).toEqual([]);
        return;
      } else if (profile === "bootstrap") {
        expect(capabilityStrings).toContain("read:bases.views:query");
        expect(capabilityStrings).not.toContain("admin:system:*");
        expect(capabilityStrings).not.toContain("execute:group:*");
      } else {
        expect(expected).toEqual([]);
      }

      const applied = commands.allow(slug, subject, undefined, undefined, undefined, undefined, true, true, chat.id);
      expect(applied.confirmation).toMatchObject({ dryRun: false, global: false, scopes: [`chat:${chat.id}`] });
      expect(dbGetTagDefinition(slug)).toMatchObject({ kind: "system", source: "permissions" });
      expect(dbListContactChatGrants({ contactId: contact.id })).toHaveLength(1);
      const listed = commands.list(subject, chat.id, undefined, undefined, profile, undefined, undefined, true);
      expect(listed.grants).toEqual([
        expect.objectContaining({
          contact: subject,
          profile: slug,
          scope: `chat:${chat.id}`,
          capabilities: capabilityStrings,
        }),
      ]);
      expect(resolveContactChatOverlay({ contactId: contact.id, chatId: chat.id })).toMatchObject({
        active: true,
        eligible: true,
        capabilities: expected.map((cap) => expect.objectContaining(cap)),
      });
      expect(resolveContactChatOverlay({ contactId: other.id, chatId: chat.id })).toMatchObject({
        active: true,
        capabilities: [],
      });
      const replay = commands.allow(profile, subject, undefined, undefined, undefined, undefined, true, true, chat.id);
      expect(replay.changedCount).toBe(0);
      commands.deny(profile, subject, chat.id, undefined, undefined, true, true);
      expect(
        commands.list(subject, chat.id, undefined, undefined, undefined, undefined, undefined, true).grants,
      ).toEqual([]);
    });
  }

  for (const profile of ["full-access", "permission-full-access", "FULL ACCESS"]) {
    it(`blocks ${profile} apply before profile, scoped grant or executor ceiling writes`, () => {
      const contact = createContact({ phone: "+15550000038", name: "Unapproved Grant User" });
      const chat = groupChat("unapproved-full-access");
      dbCreateAgent({ id: "grant-target", cwd: "/tmp" });
      dbCreateAgent({ id: "grant-executor", cwd: "/tmp" });
      dbCreateTagDefinition({
        slug: "permission-full-access",
        label: "Existing profile",
        kind: "system",
        source: "permissions",
        metadata: { permissions: { capabilities: ["read:skills:show"] } },
      });
      const before = dbGetTagDefinition("permission-full-access");
      const error = captureContractError(() =>
        runWithContext({ agentId: "grant-executor" }, () =>
          new PermissionsCommands().allow(
            profile,
            `contact:${contact.id},agent:grant-target`,
            "grant-executor",
            undefined,
            "Changed label",
            undefined,
            true,
            true,
            chat.id,
          ),
        ),
      );
      expect(error.code).toBe("FULL_ACCESS_APPROVAL_REQUIRED");
      expect(error.exitCode).toBe(3);
      expect(dbGetTagDefinition("permission-full-access")).toEqual(before);
      expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
      expect(getContact(contact.id)?.tags).not.toContain("permission-full-access");
      expect(readAgentRuntimePermissionsConfig("grant-target")).toBeNull();
      expect(readAgentRuntimePermissionsConfig("grant-executor")).toBeNull();
    });
  }

  it("keeps unknown-profile diagnostics within the remote message budget with many stored profiles", () => {
    for (let index = 0; index < 30; index++) {
      dbCreateTagDefinition({
        slug: `permission-workflow-${index}-${"long-name-".repeat(6)}`,
        label: `Workflow ${index}`,
        kind: "system",
        source: "permissions",
      });
    }
    const error = captureContractError(() => new PermissionsCommands().allow("unknown", "agent:main"));
    expect(error.message.length).toBeLessThanOrEqual(1200);
    expect(error.message).toContain("ravi skills show permissions");
    expect(error.message).toContain("ravi tags list --kind system --source permissions --json");
    expect(error.details.acceptedValues).toHaveLength(34);
  });

  it("discovers every stored profile across pages of newer non-profile permission tags", () => {
    const profileSlugs = Array.from({ length: 505 }, (_, index) => `permission-archived-workflow-${index}`);
    for (const slug of profileSlugs) {
      dbCreateTagDefinition({ slug, label: slug, kind: "system", source: "permissions" });
    }
    for (let index = 0; index < 505; index++) {
      const slug = `unrelated-permission-metadata-${index}`;
      dbCreateTagDefinition({ slug, label: slug, kind: "system", source: "permissions" });
    }

    const error = captureContractError(() => new PermissionsCommands().allow("unknown", "agent:main"));
    const acceptedValues = error.details.acceptedValues as string[];
    expect(acceptedValues).toHaveLength(AGENT_RUNTIME_PERMISSION_PROFILES.length + profileSlugs.length);
    expect(new Set(acceptedValues)).toEqual(new Set([...AGENT_RUNTIME_PERMISSION_PROFILES, ...profileSlugs]));
    expect(error.message.length).toBeLessThanOrEqual(1200);
    expect(error.message).toContain("ravi tags list --kind system --source permissions --json");
  });

  it("keeps explicit-only capabilities and discards chat-only leftovers like the runtime", () => {
    const contact = createContact({ phone: "+15550000033", name: "Explicit Profile User" });
    const chat = groupChat("profile-explicit-test");
    const commands = new PermissionsCommands();
    const subject = `contact:${contact.id}`;
    commands.allow("explicit-only", subject, undefined, "read:skills:show", undefined, undefined, true, true, chat.id);
    expect(
      commands.list(subject, chat.id, undefined, undefined, undefined, undefined, undefined, true).grants[0]
        ?.capabilities,
    ).toEqual(["read:skills:show"]);
    commands.allow("chat-only", subject, undefined, "admin:system:*", undefined, undefined, true, true, chat.id);
    expect(
      commands.list(subject, chat.id, undefined, undefined, "chat-only", undefined, undefined, true).grants[0]
        ?.capabilities,
    ).toEqual([]);
  });

  for (const definition of ["missing", "empty"]) {
    it(`revokes a grant and its live context when the profile definition is ${definition}`, () => {
      const contact = createContact({ phone: "+15550000034", name: "Revoked Profile User" });
      const chat = groupChat("orphan-profile-test");
      const profile = "permission-orphan";
      if (definition === "empty") {
        dbCreateTagDefinition({ slug: profile, label: "Orphan", kind: "system", source: "permissions" });
      }
      dbEnsureContactChatGrant({ contactId: contact.id, profileSlug: profile, scopeType: "chat", scopeId: chat.id });
      const live = createRuntimeContext({
        kind: "turn-runtime",
        capabilities: [{ permission: "read", objectType: "skills", objectId: "show" }],
        metadata: {
          actorPrincipal: `contact:${contact.id}`,
          actorAuthorizationMode: "user-overlay",
          userOverlay: "active",
          userOverlayGrants: [`${profile}@chat:${chat.id}`],
        },
      });
      const result = new PermissionsCommands().deny(
        profile,
        `contact:${contact.id}`,
        chat.id,
        undefined,
        undefined,
        true,
        true,
      );
      expect(result.changedCount).toBe(1);
      expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
      expect(resolveRuntimeContext(live.contextKey, { touch: false })).toBeNull();
    });
  }

  it("plans a chat-scoped contact grant without mutating provider-owned state", () => {
    const contact = createContact({ phone: "+15550000001", name: "Permission Test User" });
    const chat = groupChat("120363400000000012@g.us");
    dbCreateAgent({ id: "workflow-agent", cwd: "/tmp" });

    const commands = new PermissionsCommands();
    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      "workflow-agent",
      "mutate:image:generate",
      undefined,
      undefined,
      undefined,
      true,
      chat.id,
    );

    expect(payload).toMatchObject({
      dryRun: true,
      tagSlug: "permission-image-workflow",
      capabilities: [{ permission: "mutate", objectType: "image", objectId: "generate" }],
      targets: [{ type: "contact", id: contact.id }],
      agentCeilings: ["workflow-agent"],
      scopes: [{ type: "chat", label: `chat:${chat.id}`, chatId: chat.id, known: true }],
      force: false,
      confirmation: { action: "allow", dryRun: true, global: false, force: false },
    });
    expect(payload.operations.every((operation) => operation.status === "planned")).toBe(true);
    expect(payload.nextCommand).toBe(
      `ravi permissions allow "image workflow" --to contact:${contact.id} --agent workflow-agent --capabilities mutate:image:generate --chat ${chat.id} --apply`,
    );
    expect(dbGetTagDefinition("permission-image-workflow")).toBeNull();
    expect(dbListContactChatGrants()).toEqual([]);
    expect(readAgentRuntimePermissionsConfig("workflow-agent")).toBeNull();
  });

  it("applies a chat-scoped contact grant with a structured confirmation", () => {
    const contact = createContact({ phone: "+15550000002", name: "Permission Apply User" });
    const chat = groupChat("120363400000000013@g.us");
    dbCreateAgent({ id: "apply-agent", cwd: "/tmp" });

    const commands = new PermissionsCommands();
    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      "apply-agent",
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      chat.platformChatId,
    );

    expect(payload.dryRun).toBe(false);
    expect(payload.changedCount).toBe(3);
    expect(payload.operations).toContainEqual({
      kind: "contact-chat-grant",
      status: "applied",
      target: `contact:${contact.id}@chat:${chat.id}`,
      message: `Granted the permission profile to the contact only in chat:${chat.id}.`,
    });
    expect(payload.confirmation).toEqual({
      action: "allow",
      dryRun: false,
      contacts: [`contact:${contact.id}`],
      agents: ["agent:apply-agent"],
      scopes: [`chat:${chat.id}`],
      global: false,
      force: false,
      profile: "permission-image-workflow",
      capabilities: ["mutate:image:generate"],
      message:
        `Granted permission-image-workflow to contact:${contact.id} only in chat:${chat.id} (not global). ` +
        "Ensured agent:apply-agent ceiling includes permission-image-workflow.",
    });
    expect(payload.hints.some((hint) => hint.startsWith(`chat:${chat.id} is now governed by contact grants`))).toBe(
      true,
    );
    expect(dbListContactChatGrants({ contactId: contact.id })).toMatchObject([
      { profileSlug: "permission-image-workflow", scopeType: "chat", scopeId: chat.id },
    ]);
    // Not global: the contact policy tag stays untouched.
    expect(getContact(contact.id)?.tags).not.toContain("permission-image-workflow");
    expect(readAgentRuntimePermissionsConfig("apply-agent")?.capabilities).toEqual([
      { permission: "mutate", objectType: "image", objectId: "generate" },
    ]);

    const again = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      chat.id,
    );
    expect(again.changedCount).toBe(0);
    expect(again.hints.some((hint) => hint.includes("is now governed"))).toBe(false);
    expect(again.hints.some((hint) => hint.includes("Pass --agent <id>"))).toBe(true);
  });

  it("stores thread grants on the container chat", () => {
    const contact = createContact({ phone: "+15550000014", name: "Thread User" });
    const channel = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "C0PERMS1",
      chatType: "group",
      title: "perms",
    });
    const thread = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "C0PERMS1#1781574894.010449",
      chatType: "thread",
      title: "perms thread",
    });

    const commands = new PermissionsCommands();
    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      thread.id,
    );

    expect(payload.scopes).toEqual([
      {
        type: "chat",
        label: `chat:${channel.id}`,
        chatId: channel.id,
        requestedChatId: thread.id,
        threadChatId: thread.id,
        channel: "slack",
        title: "perms",
        known: true,
      },
    ]);
    expect(payload.confirmation.scopes).toEqual([`chat:${channel.id}`]);
    expect(payload.hints).toContain(
      `chat:${thread.id} is a thread; the grant is stored on its chat chat:${channel.id} and inherited.`,
    );
    expect(dbListContactChatGrants({ contactId: contact.id })).toMatchObject([
      { scopeType: "chat", scopeId: channel.id },
    ]);
  });

  it("applies chat-tag scoped contact grants", () => {
    const contact = createContact({ phone: "+15550000015", name: "Tag User" });
    const first = groupChat("120363400000000015@g.us");
    const second = groupChat("120363400000000016@g.us");
    attachTagSlugsToAsset({ assetType: "chat", assetId: first.id, tags: ["vip"], source: "test" });
    attachTagSlugsToAsset({ assetType: "chat", assetId: second.id, tags: ["vip"], source: "test" });

    const commands = new PermissionsCommands();
    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      undefined,
      "VIP",
    );

    expect(payload.scopes).toEqual([{ type: "chat_tag", label: "chat-tag:vip", chatTag: "vip", taggedChatCount: 2 }]);
    expect(payload.confirmation).toMatchObject({ scopes: ["chat-tag:vip"], global: false, force: false });
    expect(payload.confirmation.message).toContain("only in chat-tag:vip (not global)");
    expect(dbListContactChatGrants({ contactId: contact.id })).toMatchObject([
      { scopeType: "chat_tag", scopeId: "vip" },
    ]);
    expect(getContact(contact.id)?.tags).not.toContain("permission-image-workflow");
  });

  it("grants globally only with --force and hints at the safer chat scope", () => {
    const contact = createContact({ phone: "+15550000016", name: "Global User" });
    const commands = new PermissionsCommands();

    const conflict = captureContractError(() =>
      commands.allow(
        "image workflow",
        `contact:${contact.id}`,
        undefined,
        "mutate:image:generate",
        undefined,
        undefined,
        true,
        true,
        "chat_any",
        undefined,
        true,
      ),
    );
    expect(conflict.code).toBe("USAGE_ERROR");
    expect(conflict.exitCode).toBe(2);

    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      undefined,
      undefined,
      true,
    );

    expect(payload.scopes).toEqual([{ type: "global", label: "global" }]);
    expect(payload.confirmation).toMatchObject({
      contacts: [`contact:${contact.id}`],
      scopes: ["global"],
      global: true,
      force: true,
      profile: "permission-image-workflow",
    });
    expect(payload.confirmation.message).toContain("globally (all chats, --force)");
    expect(payload.hints[0]).toContain("Global contact grant (--force)");
    expect(payload.hints[0]).toContain("Safer default: confirm with the human");
    expect(payload.operations).toContainEqual(
      expect.objectContaining({ kind: "contact-profile-global", status: "applied" }),
    );
    expect(getContact(contact.id)?.tags).toContain("permission-image-workflow");
    expect(dbListContactChatGrants()).toEqual([]);
  });

  it("revokes contact grants with the same scope rules", () => {
    const contact = createContact({ phone: "+15550000017", name: "Revoke User" });
    const chat = groupChat("120363400000000017@g.us");
    const commands = new PermissionsCommands();
    commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      chat.id,
    );
    commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      undefined,
      true,
    );

    const plan = commands.deny(
      "image workflow",
      `contact:${contact.id}`,
      chat.id,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(plan).toMatchObject({
      dryRun: true,
      operations: [{ kind: "contact-chat-grant", status: "planned" }],
      confirmation: { action: "deny", dryRun: true, scopes: [`chat:${chat.id}`], global: false, force: false },
      nextCommand: `ravi permissions deny "image workflow" --to contact:${contact.id} --chat ${chat.id} --apply`,
    });
    expect(plan.hints).toContain(
      `chat:${chat.id} would no longer be governed by contact grants; turns there would use the agent identity again.`,
    );
    expect(dbListContactChatGrants({ contactId: contact.id })).toHaveLength(1);

    const applied = commands.deny("image workflow", `contact:${contact.id}`, chat.id, undefined, undefined, true, true);
    expect(applied.changedCount).toBe(1);
    expect(applied.confirmation.message).toBe(
      `Revoked permission-image-workflow from contact:${contact.id} only in chat:${chat.id} (not global).`,
    );
    expect(applied.hints).toContain(
      `contact:${contact.id} keeps a global permission-image-workflow grant; it only applies in chats governed by a chat or chat-tag grant.`,
    );
    expect(applied.hints).toContain(
      `chat:${chat.id} is no longer governed by contact grants; turns there use the agent identity again.`,
    );
    expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
    expect(getContact(contact.id)?.tags).toContain("permission-image-workflow");

    const global = commands.deny("image workflow", `contact:${contact.id}`, undefined, undefined, true, true, true);
    expect(global.confirmation).toMatchObject({ scopes: ["global"], global: true, force: true });
    expect(getContact(contact.id)?.tags).not.toContain("permission-image-workflow");

    const agentTarget = captureContractError(() =>
      commands.deny("image workflow", "agent:main", chat.id, undefined, undefined, true, true),
    );
    expect(agentTarget.code).toBe("USAGE_ERROR");
  });

  it("reports remaining coverage when a revoked chat stays governed", () => {
    const contact = createContact({ phone: "+15550000020", name: "Covered User" });
    const chat = groupChat("120363400000000020@g.us");
    attachTagSlugsToAsset({ assetType: "chat", assetId: chat.id, tags: ["vip"], source: "test" });
    const commands = new PermissionsCommands();
    const subject = `contact:${contact.id}`;
    commands.allow(
      "image workflow",
      subject,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      chat.id,
    );
    commands.allow("image workflow", subject, undefined, undefined, undefined, undefined, true, true, undefined, "vip");
    commands.allow(
      "image workflow",
      subject,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      undefined,
      true,
    );

    const applied = commands.deny("image workflow", subject, chat.id, undefined, undefined, true, true);

    expect(applied.hints).toEqual([
      `${subject} still receives permission-image-workflow in chat:${chat.id} through chat-tag:vip.`,
      `${subject} still receives permission-image-workflow in chat:${chat.id} through global.`,
    ]);
  });

  it("revokes live turn contexts that used a revoked contact grant", () => {
    const contact = createContact({ phone: "+15550000019", name: "Live User" });
    const chat = groupChat("120363400000000019@g.us");
    const commands = new PermissionsCommands();
    commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      chat.id,
    );
    const live = createRuntimeContext({
      kind: "turn-runtime",
      capabilities: [{ permission: "mutate", objectType: "image", objectId: "generate" }],
      metadata: {
        actorPrincipal: `contact:${contact.id}`,
        actorAuthorizationMode: "user-overlay",
        userOverlay: "active",
        userOverlayGrants: [`permission-image-workflow@chat:${chat.id}`],
      },
    });

    const applied = commands.deny("image workflow", `contact:${contact.id}`, chat.id, undefined, undefined, true, true);

    expect(applied.operations).toContainEqual(
      expect.objectContaining({
        kind: "contact-chat-grant",
        status: "applied",
        message: expect.stringContaining("Revoked 1 live turn context(s) that used this grant."),
      }),
    );
    expect(resolveRuntimeContext(live.contextKey, { touch: false })).toBeNull();
  });

  it("reduces a shared chat-only definition across every live scope and derived context", () => {
    const first = createContact({ phone: "+15550000791", name: "First profile holder" });
    const second = createContact({ phone: "+15550000792", name: "Other profile holder" });
    const chatA = groupChat("profile-reduction-a");
    const chatB = groupChat("profile-reduction-b");
    const profile = "permission-chat-only";
    const capability = { permission: "read", objectType: "skills", objectId: "show" };
    dbCreateTagDefinition({
      slug: profile,
      label: "Chat only",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["read:skills:show"] } },
    });
    dbEnsureContactChatGrant({ contactId: first.id, profileSlug: profile, scopeType: "chat", scopeId: chatA.id });
    dbEnsureContactChatGrant({ contactId: first.id, profileSlug: profile, scopeType: "chat", scopeId: chatB.id });
    dbEnsureContactChatGrant({ contactId: second.id, profileSlug: profile, scopeType: "chat_tag", scopeId: "ops" });
    addContactTag(second.id, profile);
    const snapshot = (contactId: string, grant: string) =>
      createRuntimeContext({
        kind: "turn-runtime",
        capabilities: [capability],
        metadata: { actorPrincipal: `contact:${contactId}`, userOverlayGrants: [grant] },
      });
    const affected = [
      snapshot(first.id, `${profile}@chat:${chatA.id}`),
      snapshot(first.id, `${profile}@chat:${chatB.id}`),
      snapshot(second.id, `${profile}@chat-tag:ops`),
      snapshot(second.id, `${profile}@global`),
    ];
    const child = createRuntimeContext({
      capabilities: [capability],
      metadata: { parentContextId: affected[1]!.contextId },
    });
    const projected = createRuntimeContext({
      capabilities: [capability],
      metadata: { actorProjection: { sourceContextId: affected[2]!.contextId } },
    });
    const unaffected = snapshot(second.id, "permission-chat-only-extra@global");
    const commands = new PermissionsCommands();

    commands.allow(
      "chat-only",
      `contact:${first.id}`,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      true,
      chatA.id,
    );
    for (const context of affected) expect(resolveRuntimeContext(context.contextKey, { touch: false })).not.toBeNull();
    expect(dbGetTagDefinition(profile)?.metadata?.permissions).toEqual({ capabilities: ["read:skills:show"] });

    commands.allow(
      "chat-only",
      `contact:${first.id}`,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      chatA.id,
    );
    expect(dbGetTagDefinition(profile)?.metadata?.permissions).toEqual({ capabilities: [] });
    expect(resolveContactChatOverlay({ contactId: first.id, chatId: chatB.id }).capabilities).toEqual([]);
    for (const context of [...affected, child, projected]) {
      const live = resolveRuntimeContext(context.contextKey, { touch: false });
      expect({
        live: Boolean(live),
        allowed: live ? authorizeContextCapabilities({ ...capability, context: live }).allowed : false,
      }).toEqual({ live: false, allowed: false });
    }
    expect(resolveRuntimeContext(unaffected.contextKey, { touch: false })).not.toBeNull();
  });

  it("rolls back the profile reduction and every revocation when a context write fails", () => {
    const contact = createContact({ phone: "+15550000793", name: "Atomic profile holder" });
    const chat = groupChat("profile-reduction-rollback");
    dbCreateTagDefinition({
      slug: "permission-chat-only",
      label: "Chat only",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["read:skills:show"] } },
    });
    const root = createRuntimeContext({
      capabilities: [{ permission: "read", objectType: "skills", objectId: "show" }],
      metadata: {
        actorPrincipal: `contact:${contact.id}`,
        userOverlayGrants: [`permission-chat-only@chat:${chat.id}`],
      },
    });
    const child = createRuntimeContext({
      contextId: "ctx_profile_reduction_rollback",
      metadata: { parentContextId: root.contextId },
    });
    getDb().exec(
      "CREATE TEMP TRIGGER refuse_profile_context_revoke BEFORE UPDATE OF revoked_at ON contexts WHEN OLD.context_id = 'ctx_profile_reduction_rollback' BEGIN SELECT RAISE(ABORT, 'profile revocation write refused'); END",
    );
    expect(() =>
      new PermissionsCommands().allow(
        "chat-only",
        `contact:${contact.id}`,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
        chat.id,
      ),
    ).toThrow("profile revocation write refused");
    expect(dbGetTagDefinition("permission-chat-only")?.metadata?.permissions).toEqual({
      capabilities: ["read:skills:show"],
    });
    expect(resolveRuntimeContext(root.contextKey, { touch: false })).not.toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).not.toBeNull();
    expect(dbListContactChatGrants({ contactId: contact.id })).toEqual([]);
  });

  it("lists contact grants for a chat with the effective contact caps", () => {
    const ana = createContact({ phone: "+15550000018", name: "List Ana" });
    const bruno = createContact({ phone: "+15550000019", name: "List Bruno" });
    const chat = groupChat("120363400000000018@g.us");
    attachTagSlugsToAsset({ assetType: "chat", assetId: chat.id, tags: ["vip"], source: "test" });
    const commands = new PermissionsCommands();
    commands.allow(
      "image workflow",
      `contact:${ana.id}`,
      undefined,
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
      chat.id,
    );
    commands.allow(
      "mail workflow",
      `contact:${bruno.id}`,
      undefined,
      "mutate:mail:send",
      undefined,
      undefined,
      true,
      true,
      undefined,
      "vip",
    );
    commands.allow(
      "image workflow",
      `contact:${bruno.id}`,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      undefined,
      true,
    );

    const forChat = commands.list(undefined, chat.id, undefined, undefined, undefined, undefined, undefined, true);
    expect(forChat.total).toBe(2);
    expect(forChat.grants).toHaveLength(2);
    expect(forChat.grants).toContainEqual({
      contact: `contact:${ana.id}`,
      profile: "permission-image-workflow",
      scope: `chat:${chat.id}`,
      scopeType: "chat",
      source: "contact-chat-grant",
      capabilities: ["mutate:image:generate"],
    });
    expect(forChat.grants).toContainEqual({
      contact: `contact:${bruno.id}`,
      profile: "permission-mail-workflow",
      scope: "chat-tag:vip",
      scopeType: "chat_tag",
      source: "contact-chat-grant",
      capabilities: ["mutate:mail:send"],
    });
    expect(forChat.confirmation).toMatchObject({ action: "list", scopes: [`chat:${chat.id}`], global: false });
    expect(forChat.hints).toContain(
      "Global contact grants also apply in governed chats; list them with `ravi permissions list --force`.",
    );

    const firstPage = commands.list(undefined, chat.id, undefined, undefined, undefined, "1", undefined, true);
    expect(firstPage.grants).toHaveLength(1);
    expect(firstPage.pagination).toMatchObject({ limit: 1, offset: 0, returned: 1, total: 2, hasMore: true });
    expect(firstPage.pagination.nextCommand).toBe(
      `ravi permissions list --json --limit 1 --offset 1 --chat ${chat.id}`,
    );
    expect(firstPage.confirmation.message).toBe(`Listed 1 of 2 contact grant(s) covering chat:${chat.id}.`);
    const secondPage = commands.list(undefined, chat.id, undefined, undefined, undefined, "1", "1", true);
    expect(secondPage.pagination).toMatchObject({ offset: 1, returned: 1, hasMore: false, nextCommand: null });
    expect([...firstPage.grants, ...secondPage.grants]).toEqual(expect.arrayContaining(forChat.grants));

    const forBruno = commands.list(
      `contact:${bruno.id}`,
      chat.id,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(forBruno.grants.map((grant) => `${grant.profile}@${grant.scope}`).sort()).toEqual([
      "permission-image-workflow@global",
      "permission-mail-workflow@chat-tag:vip",
    ]);
    expect(forBruno.overlays).toEqual([
      {
        contact: `contact:${bruno.id}`,
        chat: `chat:${chat.id}`,
        governed: true,
        eligible: true,
        capabilities: ["mutate:mail:send", "mutate:image:generate"],
      },
    ]);
    expect(forBruno.confirmation.message).toBe(
      `Listed 2 contact grant(s) for contact:${bruno.id} covering chat:${chat.id}.`,
    );

    const global = commands.list(undefined, undefined, undefined, true, undefined, undefined, undefined, true);
    expect(global.grants).toEqual([
      expect.objectContaining({ contact: `contact:${bruno.id}`, scope: "global", source: "contact-tag" }),
    ]);
    expect(global.confirmation).toMatchObject({ scopes: ["global"], global: true, force: true });
  });

  it("resolves a user-overlay denial into a chat-scoped contact grant", () => {
    const contact = createContact({ phone: "+15550000020", name: "Overlay Resolve User" });
    const chat = groupChat("120363400000000020@g.us");
    dbCreateAgent({ id: "overlay-agent", cwd: "/tmp" });
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "overlay-agent",
      relation: "mutate",
      objectType: "image",
      objectId: "generate",
      agentId: "overlay-agent",
      sessionName: "overlay-session",
      contextId: "ctx_permission_overlay_resolve",
      detail: {
        context: {
          authorityMode: "agent-identity",
          actorPrincipal: `contact:${contact.id}`,
          actorAuthorizationMode: "user-overlay",
          userOverlayChat: `chat:${chat.id}`,
          executorAgentId: "overlay-agent",
          agentIdentityPrincipal: `agent_identity:overlay-agent:chat:${chat.id}`,
        },
      },
    });

    const commands = new PermissionsCommands();
    const payload = commands.resolve(String(denial!.id), "image workflow", undefined, true, true);

    expect(payload).toMatchObject({
      targets: [{ type: "contact", id: contact.id }],
      agentCeilings: ["overlay-agent"],
      scopes: [{ type: "chat", chatId: chat.id }],
      confirmation: { scopes: [`chat:${chat.id}`], global: false, force: false },
    });
    expect(dbListContactChatGrants({ contactId: contact.id })).toMatchObject([
      { profileSlug: "permission-image-workflow", scopeType: "chat", scopeId: chat.id },
    ]);
    expect(readAgentRuntimePermissionsConfig("overlay-agent")?.capabilities).toEqual([
      { permission: "mutate", objectType: "image", objectId: "generate" },
    ]);
  });

  it("blocks resolve --profile full-access before any provider write", () => {
    dbCreateAgent({ id: "blocked-resolve-agent", cwd: "/tmp" });
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "blocked-resolve-agent",
      relation: "execute",
      objectType: "executable",
      objectId: "curl",
      agentId: "blocked-resolve-agent",
    });
    const commands = new PermissionsCommands();
    const preview = commands.resolve(String(denial!.id), "full-access", undefined, false, true);
    expect(preview.nextCommand).toBeUndefined();
    const error = captureContractError(() =>
      commands.resolve(String(denial!.id), "full-access", undefined, true, true),
    );
    expect(error).toMatchObject({ op: "permissions resolve", code: "FULL_ACCESS_APPROVAL_REQUIRED", exitCode: 3 });
    expect(dbGetTagDefinition("permission-full-access")).toBeNull();
    expect(readAgentRuntimePermissionsConfig("blocked-resolve-agent")).toBeNull();
  });

  it("resolves an agent-identity denial into an agent-owned recurring profile workflow", () => {
    const contact = createContact({ phone: "+15550000003", name: "Permission Resolve User" });
    dbCreateAgent({ id: "resolve-agent", cwd: "/tmp" });
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "resolve-agent",
      relation: "execute",
      objectType: "executable",
      objectId: "curl",
      agentId: "resolve-agent",
      sessionName: "workflow-session",
      contextId: "ctx_permission_resolve_test",
      detail: {
        context: {
          authorityMode: "agent-identity",
          actorPrincipal: `contact:${contact.id}`,
          executorAgentId: "resolve-agent",
          agentIdentityPrincipal: "agent_identity:resolve-agent:chat:chat_alpha",
        },
      },
    });
    expect(denial).not.toBeNull();

    const commands = new PermissionsCommands();
    const payload = commands.resolve(String(denial!.id), "publishing workflow", undefined, true, true);

    expect(payload).toMatchObject({
      dryRun: false,
      tagSlug: "permission-publishing-workflow",
      denial: {
        id: denial!.id,
        missingCapability: "execute:executable:curl",
        subject: "agent:resolve-agent",
      },
      capabilities: [{ permission: "execute", objectType: "executable", objectId: "curl" }],
      targets: [{ type: "agent", id: "resolve-agent" }],
      agentCeilings: [],
    });
    expect(getContact(contact.id)?.tags).not.toContain("permission-publishing-workflow");
    expect(readAgentRuntimePermissionsConfig("resolve-agent")?.capabilities).toEqual([
      { permission: "execute", objectType: "executable", objectId: "curl" },
    ]);
  });
});
