import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRegistry } from "../cli/registry-snapshot.js";
import {
  dbCreateAgent,
  dbDeleteSkillGrant,
  dbTouchContext,
  dbUpdateAgent,
  dbUpdateContextRuntimeState,
  dbUpsertSkillGrant,
} from "../router/router-db.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import {
  getConfiguredCapabilityMaterializers,
  getConfiguredPermissionProviders,
} from "../permissions/provider-registry.js";
import type { PermissionProvider } from "../permissions/provider-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext, revokeRuntimeContext } from "./context-registry.js";
import {
  buildSkillPolicyContextBinding,
  resolveManagedSkillPolicyForContext,
  resolveRuntimeSkillPolicy,
} from "./skill-policy-runtime.js";
import type { RuntimeCapabilities } from "./types.js";

const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "none" },
  usage: { semantics: "unavailable" },
  tools: {
    availableCapabilities: ["fs.read", "exec.shell"],
    permissionMode: "ravi-host",
    accessRequirement: "tool_and_executable",
    supportsParallelCalls: false,
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: false,
  supportsSessionFork: false,
  supportsPartialText: false,
  supportsToolHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

let stateDir: string;
let pluginPath: string;

function context(grants: ContextCapability[] = []): ContextRecord {
  return {
    agentId: "restricted",
    contextId: "ctx-policy",
    contextKey: "rctx-policy",
    kind: "turn-runtime",
    capabilities: grants,
    createdAt: 0,
  };
}

function writeSkill(name: string, requirement?: object): string {
  const directory = join(pluginPath, "skills", name);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${name} guide\n${requirement ? `ravi.requires: ${JSON.stringify(requirement)}\n` : ""}---\nPRIVATE-SKILL-BODY\n`,
  );
  return path;
}

function resolve(ctx = context(), runtimeCapabilities = capabilities) {
  return resolveRuntimeSkillPolicy({
    agentId: "restricted",
    executionId: "execution-1",
    contextKey: ctx.contextKey,
    cwd: stateDir,
    context: ctx,
    plugins: [{ type: "local", path: pluginPath }],
    runtimeCapabilities,
  });
}

describe("runtime skill policy with real catalog and permission providers", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-skill-policy-runtime-");
    pluginPath = join(stateDir, "example-plugin");
    mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), '{"name":"example"}');
    dbCreateAgent({ id: "restricted", cwd: stateDir });
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
  });

  test("a real grant cannot bypass the contextual tool permission", () => {
    writeSkill("reader", { kind: "any-of", alternatives: [["fs.read"]] });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reader" });
    dbUpdateAgent("restricted", { defaults: { runtimePermissions: { profile: "full-access" } } });
    expect(resolve().skills.map((skill) => skill.id)).not.toContain("example:reader");
    const authorized = resolve(context([{ permission: "use", objectType: "tool", objectId: "Read" }]));
    expect(authorized.skills.map((skill) => skill.id)).toContain("example:reader");
  }, 15000);

  test("admin permissions do not invent an unavailable tool", () => {
    writeSkill("reader", { kind: "any-of", alternatives: [["fs.read"]] });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reader" });
    const admin = context([{ permission: "admin", objectType: "system", objectId: "*" }]);
    expect(
      resolve(admin, { ...capabilities, tools: { ...capabilities.tools, availableCapabilities: [] } }).skills.map(
        (skill) => skill.id,
      ),
    ).not.toContain("example:reader");
    expect(resolve(admin).skills.map((skill) => skill.id)).toContain("example:reader");
  });

  test("a missing tool-surface declaration never becomes all builtins", () => {
    writeSkill("reader", { kind: "any-of", alternatives: [["fs.read"]] });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reader" });
    const { availableCapabilities: _declared, ...tools } = capabilities.tools;
    expect(
      resolve(context([{ permission: "admin", objectType: "system", objectId: "*" }]), {
        ...capabilities,
        tools,
      }).skills.map((skill) => skill.id),
    ).not.toContain("example:reader");
  });

  test("admin does not auto-grant a custom tool-independent skill", () => {
    writeSkill("reasoning", { kind: "none" });
    const admin = context([{ permission: "admin", objectType: "system", objectId: "*" }]);
    expect(resolve(admin).skills.map((skill) => skill.id)).not.toContain("example:reasoning");
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reasoning" });
    expect(resolve().skills.map((skill) => skill.id)).toContain("example:reasoning");
  });

  test("an operation-semantic permission selects the mapped system skill without a legacy group grant", () => {
    const semantic = context([
      { permission: "use", objectType: "tool", objectId: "Bash" },
      { permission: "execute", objectType: "executable", objectId: "ravi" },
      { permission: "read", objectType: "cron", objectId: "list" },
    ]);
    expect(resolve(semantic).skills.map((skill) => skill.id)).toContain("ravi-system:cron-manager");
    expect(
      resolve(context(semantic.capabilities.filter((item) => item.objectType !== "executable"))).skills.map(
        (skill) => skill.id,
      ),
    ).not.toContain("ravi-system:cron-manager");
  });

  test("multiple real internal skills survive catalog assembly independently", () => {
    const ctx = context([
      { permission: "use", objectType: "tool", objectId: "Bash" },
      { permission: "execute", objectType: "executable", objectId: "ravi" },
      { permission: "execute", objectType: "group", objectId: "sessions" },
      { permission: "execute", objectType: "group", objectId: "specs" },
    ]);
    const ids = resolve(ctx).skills.map((skill) => skill.id);
    expect(ids).toContain("ravi-system:sessions");
    expect(ids).toContain("ravi-system:specs");
    expect(ids).not.toContain("ravi-system:cron-manager");
  });

  for (const group of ["whatsapp.dm", "whatsapp.group"]) {
    test(`WhatsApp migration uses the registered ${group} child without inventing a root command group`, () => {
      const groups = new Set(getRegistry().commands.map((command) => command.groupPath));
      expect(groups.has(group)).toBe(true);
      expect(groups.has("whatsapp")).toBe(false);
      const ctx = context([
        { permission: "use", objectType: "tool", objectId: "Bash" },
        { permission: "execute", objectType: "executable", objectId: "ravi" },
        { permission: "execute", objectType: "group", objectId: group.replaceAll(".", "_") },
      ]);
      expect(resolve(ctx).skills.map((skill) => skill.id)).toContain("ravi-system:whatsapp-manager");
      expect(
        resolve(context(ctx.capabilities.filter((capability) => capability.objectType !== "group"))).skills.map(
          (skill) => skill.id,
        ),
      ).not.toContain("ravi-system:whatsapp-manager");
      expect(
        resolve(ctx, { ...capabilities, tools: { ...capabilities.tools, availableCapabilities: [] } }).skills.map(
          (skill) => skill.id,
        ),
      ).not.toContain("ravi-system:whatsapp-manager");
    }, 15000);
  }

  test("a CLI dependency needs a real registered operation and usable transport", () => {
    writeSkill("scheduler", { kind: "any-of", alternatives: [["ravi.cli.cron.list"]] });
    writeSkill("imaginary", { kind: "any-of", alternatives: [["ravi.cli.nonexistent"]] });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:scheduler" });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:imaginary" });
    const admin = context([{ permission: "admin", objectType: "system", objectId: "*" }]);
    const noTools = { ...capabilities, tools: { ...capabilities.tools, availableCapabilities: [] } };
    expect(resolve(admin, noTools).skills.map((skill) => skill.id)).not.toContain("example:scheduler");
    expect(resolve(admin).skills.map((skill) => skill.id)).toContain("example:scheduler");
    expect(resolve(admin).skills.map((skill) => skill.id)).not.toContain("example:imaginary");
  });

  test("host dynamic tools can satisfy a CLI operation without shell access", () => {
    writeSkill("scheduler", { kind: "any-of", alternatives: [["ravi.cli.cron.list"]] });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:scheduler" });
    const ctx = context([
      { permission: "use", objectType: "tool", objectId: "cron_list" },
      { permission: "execute", objectType: "group", objectId: "cron" },
    ]);
    const host = {
      ...capabilities,
      dynamicTools: { mode: "host" },
      tools: { ...capabilities.tools, availableCapabilities: [] },
    } satisfies RuntimeCapabilities;
    expect(resolve(ctx, host).skills.map((skill) => skill.id)).toContain("example:scheduler");
    expect(
      resolve(context(ctx.capabilities.filter((item) => item.permission !== "use")), host).skills.map(
        (skill) => skill.id,
      ),
    ).not.toContain("example:scheduler");
  });

  test("missing candidate metadata is diagnostic, not implicit tool independence", () => {
    writeSkill("unclassified");
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:unclassified" });
    const result = resolve();
    expect(result.skills.map((skill) => skill.id)).not.toContain("example:unclassified");
    expect(result.diagnostics).toContainEqual({ skillId: "example:unclassified", code: "missing-requirements" });
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE-SKILL-BODY");
  });

  test("grant changes alter the revision even when the current context cannot use the skill", () => {
    writeSkill("reader", { kind: "any-of", alternatives: [["fs.read"]] });
    const before = resolve();
    expect(resolve().id).toBe(before.id);
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reader" });
    const granted = resolve();
    expect(granted.revisions.permissions).not.toBe(before.revisions.permissions);
    dbDeleteSkillGrant("restricted", "example:reader");
    expect(resolve().revisions.permissions).not.toBe(granted.revisions.permissions);
  });

  test("effective context, native tool surface and skill content each invalidate the snapshot", () => {
    const path = writeSkill("reader", { kind: "any-of", alternatives: [["fs.read"]] });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reader" });
    const before = resolve();
    expect(
      resolve(context([{ permission: "use", objectType: "tool", objectId: "Read" }])).revisions.permissions,
    ).not.toBe(before.revisions.permissions);
    expect(
      resolve(context(), { ...capabilities, tools: { ...capabilities.tools, availableCapabilities: [] } }).revisions
        .toolSurface,
    ).not.toBe(before.revisions.toolSurface);
    writeFileSync(path, '---\nname: reader\nravi.requires: {"kind":"none"}\n---\nChanged instructions\n');
    expect(resolve().revisions.catalog).not.toBe(before.revisions.catalog);
  });

  test("unknown, mismatched and expired identities fail before exposure", () => {
    expect(() =>
      resolveRuntimeSkillPolicy({
        agentId: "missing",
        executionId: "e",
        contextKey: "c",
        cwd: stateDir,
        plugins: [],
        runtimeCapabilities: capabilities,
      }),
    ).toThrow();
    expect(() => resolve({ ...context(), agentId: "different" })).toThrow();
    expect(() => resolve({ ...context(), expiresAt: Date.now() - 1 })).toThrow();
    expect(() => resolve({ ...context(), revokedAt: 1 })).toThrow();
  });

  test("managed reads recheck grants using the persisted secretless binding", () => {
    writeSkill("reasoning", { kind: "none" });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reasoning" });
    const ctx = createRuntimeContext({ agentId: "restricted", capabilities: [] });
    const binding = buildSkillPolicyContextBinding({
      scope: { agentId: "restricted", executionId: "run-1", contextKey: ctx.contextKey },
      cwd: stateDir,
      runtimeCapabilities: capabilities,
      plugins: [{ type: "local", path: pluginPath }],
    });
    const stored = dbUpdateContextRuntimeState(ctx.contextId, { metadata: { skillPolicyBinding: binding } });
    expect(resolveManagedSkillPolicyForContext(stored).skills.map((skill) => skill.id)).toContain("example:reasoning");
    dbDeleteSkillGrant("restricted", "example:reasoning");
    expect(resolveManagedSkillPolicyForContext(stored).skills.map((skill) => skill.id)).not.toContain(
      "example:reasoning",
    );
  });

  test("managed reads reject revoked or stale authority even with an old in-memory context", () => {
    const ctx = createRuntimeContext({ agentId: "restricted", capabilities: [] });
    const binding = buildSkillPolicyContextBinding({
      scope: { agentId: "restricted", executionId: "run-1", contextKey: ctx.contextKey },
      cwd: stateDir,
      runtimeCapabilities: capabilities,
    });
    const stored = dbUpdateContextRuntimeState(ctx.contextId, { metadata: { skillPolicyBinding: binding } });
    dbUpdateAgent("restricted", { defaults: { runtimePermissions: { profile: "full-access" } } });
    expect(() => resolveManagedSkillPolicyForContext(stored)).toThrow();
    revokeRuntimeContext(ctx.contextId);
    expect(() => resolveManagedSkillPolicyForContext(stored)).toThrow();
  });

  test("managed reads reject missing or tampered bindings instead of inferring a tool surface", () => {
    const ctx = createRuntimeContext({ agentId: "restricted", capabilities: [] });
    expect(() => resolveManagedSkillPolicyForContext(ctx)).toThrow();
    const invalid = dbUpdateContextRuntimeState(ctx.contextId, {
      metadata: {
        skillPolicyBinding: {
          contractVersion: 1,
          toolSurface: { availableCapabilities: ["*"], dynamicToolsMode: "host" },
        },
      },
    });
    expect(() => resolveManagedSkillPolicyForContext(invalid)).toThrow();
  });

  test("a broken permission provider blocks even a tool-independent catalog", () => {
    writeSkill("reasoning", { kind: "none" });
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:reasoning" });
    const broken: PermissionProvider = {
      id: "failing-provider",
      version: "v1",
      required: true,
      supports: () => true,
      authorize: () => {
        throw new Error("PRIVATE-PROVIDER-SECRET");
      },
    };
    const chain = getConfiguredPermissionProviders();
    chain.unshift(broken);
    try {
      expect(() =>
        resolve(context(), { ...capabilities, tools: { ...capabilities.tools, availableCapabilities: [] } }),
      ).toThrow("RAVI_SKILL_POLICY_RESOLUTION_ERROR");
    } finally {
      chain.splice(chain.indexOf(broken), 1);
    }
  });

  test("changing an auxiliary skill resource invalidates its catalog revision", () => {
    writeSkill("reasoning", { kind: "none" });
    const resource = join(pluginPath, "skills", "reasoning", "notes.bin");
    writeFileSync(resource, Buffer.from([0, 1, 2]));
    const before = resolve().revisions.catalog;
    writeFileSync(resource, Buffer.from([0, 1, 3]));
    expect(resolve().revisions.catalog).not.toBe(before);
  });

  test("a local skill is admitted only by an explicit grant and still requires tool access", () => {
    const localPath = join(stateDir, ".agents", "skills", "local-reader");
    mkdirSync(localPath, { recursive: true });
    writeFileSync(
      join(localPath, "SKILL.md"),
      '---\nname: local-reader\nravi.requires: {"kind":"any-of","alternatives":[["fs.read"]]}\n---\nLocal instructions\n',
    );
    const read = context([{ permission: "use", objectType: "tool", objectId: "Read" }]);
    expect(resolve(read).skills.map((skill) => skill.id)).not.toContain("local:workspace:agents:local-reader");
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "local:workspace:agents:local-reader" });
    const admitted = resolve(read);
    expect(admitted.skills.map((skill) => skill.id)).toContain("local:workspace:agents:local-reader");
    expect(admitted.provenance["local:workspace:agents:local-reader"]).toContain("local");
    expect(resolve().skills.map((skill) => skill.id)).not.toContain("local:workspace:agents:local-reader");
  });

  test("binding persistence does not include provider secrets or mutate visibility revisions", () => {
    const ctx = createRuntimeContext({ agentId: "restricted", capabilities: [] });
    const secretCapabilityObject = { ...capabilities, credential: "PRIVATE-ADAPTER-SECRET" };
    const binding = buildSkillPolicyContextBinding({
      scope: { agentId: "restricted", executionId: "execution-1", contextKey: ctx.contextKey },
      cwd: stateDir,
      runtimeCapabilities: secretCapabilityObject,
      plugins: [{ type: "local", path: pluginPath }],
    });
    const before = resolve(ctx);
    const stored = dbUpdateContextRuntimeState(ctx.contextId, { metadata: { skillPolicyBinding: binding } });
    expect(resolveManagedSkillPolicyForContext(stored).revisions.permissions).toBe(before.revisions.permissions);
    expect(JSON.stringify(binding)).not.toContain("PRIVATE-ADAPTER-SECRET");
    expect(Object.keys(binding).sort()).toEqual([
      "contractVersion",
      "cwd",
      "plugins",
      "scope",
      "subjectRevision",
      "toolSurface",
    ]);
    dbTouchContext(ctx.contextId, Date.now() + 2000);
    expect(resolveManagedSkillPolicyForContext(stored).id).toBe(before.id);
    dbUpdateContextRuntimeState(ctx.contextId, {
      metadata: { skillPolicyBinding: binding, progress: "new display state" },
    });
    expect(resolveManagedSkillPolicyForContext(stored).id).toBe(before.id);
  });

  test("materializer failures are redacted at binding and managed-read boundaries", () => {
    const ctx = createRuntimeContext({ agentId: "restricted", capabilities: [] });
    const options = {
      scope: { agentId: "restricted", executionId: "run-1", contextKey: ctx.contextKey },
      cwd: stateDir,
      runtimeCapabilities: capabilities,
    };
    const binding = buildSkillPolicyContextBinding(options);
    const stored = dbUpdateContextRuntimeState(ctx.contextId, { metadata: { skillPolicyBinding: binding } });
    const broken: PermissionProvider = {
      id: "broken-materializer",
      version: "v1",
      required: true,
      supports: () => false,
      authorize: () => {
        throw new Error("unused");
      },
      materializeCapabilities: () => {
        throw new Error("PRIVATE-MATERIALIZER-SECRET");
      },
    };
    const materializers = getConfiguredCapabilityMaterializers();
    materializers.unshift(broken);
    try {
      expect(() => buildSkillPolicyContextBinding(options)).toThrow("RAVI_SKILL_POLICY_RESOLUTION_ERROR");
      expect(() => resolveManagedSkillPolicyForContext(stored)).toThrow("RAVI_SKILL_POLICY_RESOLUTION_ERROR");
    } finally {
      materializers.splice(materializers.indexOf(broken), 1);
    }
  });

  test("new physical context nonces preserve the same logical snapshot for unchanged authority", () => {
    const original = resolve({ ...context(), contextId: "ctx-a", contextKey: "key-a", expiresAt: Date.now() + 60000 });
    const rotated = resolve({ ...context(), contextId: "ctx-b", contextKey: "key-b", expiresAt: Date.now() + 120000 });
    expect(rotated.revisions.permissions).toBe(original.revisions.permissions);
    expect(rotated.id).toBe(original.id);
    expect(original.scope.contextKey).toMatch(/^context:[a-f0-9]{64}$/);
    expect(JSON.stringify(original.scope)).not.toContain("key-a");
    const otherIdentityScope = resolve({ ...context(), metadata: { agentIdentityCompartment: "chat:other" } });
    expect(otherIdentityScope.revisions.permissions).not.toBe(original.revisions.permissions);
    expect(otherIdentityScope.scope.contextKey).not.toBe(original.scope.contextKey);
  });

  test("logical snapshot reuse still rejects the revoked bearer and binds each live context privately", () => {
    const createBound = () => {
      const ctx = createRuntimeContext({
        agentId: "restricted",
        kind: "turn-runtime",
        capabilities: [],
        sessionName: "restricted",
      });
      const binding = buildSkillPolicyContextBinding({
        scope: { agentId: "restricted", executionId: "run-stable", contextKey: ctx.contextKey },
        cwd: stateDir,
        runtimeCapabilities: capabilities,
      });
      return {
        ctx: dbUpdateContextRuntimeState(ctx.contextId, { metadata: { skillPolicyBinding: binding } }),
        binding,
      };
    };
    const original = createBound();
    const first = resolveManagedSkillPolicyForContext(original.ctx);
    revokeRuntimeContext(original.ctx.contextId);
    const next = createBound();
    const second = resolveManagedSkillPolicyForContext(next.ctx);
    expect(second.id).toBe(first.id);
    expect(second.scope.contextKey).toBe(first.scope.contextKey);
    expect(original.binding.scope.contextKey).toBe(original.ctx.contextKey);
    expect(next.binding.scope.contextKey).toBe(next.ctx.contextKey);
    expect(next.binding.scope.contextKey).not.toBe(original.binding.scope.contextKey);
    expect(() => resolveManagedSkillPolicyForContext(original.ctx)).toThrow("live registered execution context");
    expect(JSON.stringify(second.scope)).not.toContain(next.ctx.contextKey);
    const mismatched = dbUpdateContextRuntimeState(next.ctx.contextId, {
      metadata: { skillPolicyBinding: original.binding },
    });
    expect(() => resolveManagedSkillPolicyForContext(mismatched)).toThrow("binding authority is stale");
  });

  test("message provenance changes do not erase the stable source authorization scope", () => {
    const source = {
      channel: "whatsapp",
      accountId: "account-a",
      chatId: "chat-a",
      threadId: "thread-a",
      sourceMessageId: "message-a",
    };
    const original = resolve({ ...context(), source });
    const nextMessage = { ...source, sourceMessageId: "message-b" };
    expect(resolve({ ...context(), source: nextMessage }).revisions.permissions).toBe(original.revisions.permissions);
    expect(resolve({ ...context(), source: { ...source, chatId: "chat-b" } }).revisions.permissions).not.toBe(
      original.revisions.permissions,
    );
  });
});
