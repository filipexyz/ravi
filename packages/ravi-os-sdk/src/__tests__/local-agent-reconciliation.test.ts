import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  LOCAL_AGENT_RECONCILIATION_PROTOCOL,
  LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION,
  LocalAgentReconciliationRequestSchema,
  LocalAgentReconciliationResultSchema,
  LocalAgentReconciler,
  createRaviClientLocalAgentRuntimeAdapter,
  type LocalAgentRuntimeAdapter,
  type LocalAgentRuntimePreference,
  type LocalAgentRuntimeRecord,
} from "../local-agent-reconciliation.js";

const fixtureDirectory = new URL(
  "./fixtures/local-agent-reconciliation/",
  import.meta.url,
);

async function fixture<T>(name: string): Promise<T> {
  return Bun.file(new URL(name, fixtureDirectory)).json() as Promise<T>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FakeRuntime implements LocalAgentRuntimeAdapter {
  readonly agents = new Map<string, LocalAgentRuntimeRecord>();
  readonly permissions = new Map<
    string,
    { profile: string; capabilities: readonly string[] }
  >();
  createCount = 0;

  async inspect(agentId: string) {
    return this.agents.get(agentId) ?? null;
  }

  async create(input: {
    agentId: string;
    cwd: string;
    runtime: LocalAgentRuntimePreference;
  }) {
    this.createCount += 1;
    this.agents.set(input.agentId, {
      agentId: input.agentId,
      cwd: input.cwd,
      ...input.runtime,
    });
  }

  async configureRuntime(
    agent: LocalAgentRuntimeRecord,
    desired: LocalAgentRuntimePreference,
  ) {
    const changed =
      agent.provider !== desired.provider ||
      agent.model !== desired.model ||
      agent.modelPreset !== desired.modelPreset;
    if (changed) {
      this.agents.set(agent.agentId, {
        agentId: agent.agentId,
        cwd: agent.cwd,
        ...desired,
      });
    }
    return changed;
  }

  async configurePermissions(input: {
    agentId: string;
    profile: "bootstrap" | "full-access";
    capabilities: readonly string[];
  }) {
    const prior = this.permissions.get(input.agentId);
    const next = {
      profile: input.profile,
      capabilities: [...input.capabilities],
    };
    const changed = JSON.stringify(prior) !== JSON.stringify(next);
    this.permissions.set(input.agentId, next);
    return changed;
  }
}

async function createHarness() {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "ravi-local-agent-reconciliation-"),
  );
  const runtime = new FakeRuntime();
  const reconciler = new LocalAgentReconciler({
    runtime,
    templates: [
      {
        templateId: "standard",
        workspaceRoot,
        agentIdPrefix: "channel",
        allowAdoption: false,
        manageInstructions: true,
        baseInstructions: "Respect local policy.",
        permissionProfile: "bootstrap",
        capabilityMap: {
          "read.messages": ["view:chat:*"],
          "write.replies": ["send:chat:*"],
        },
        runtime: {
          provider: "codex",
          modelPreset: "balanced",
          allowedProviders: ["codex"],
          allowedModelPresets: ["balanced"],
        },
      },
    ],
    now: () => "2026-07-24T18:00:01.000Z",
  });
  return { workspaceRoot, runtime, reconciler };
}

describe("local agent reconciliation", () => {
  it("parses the projected desired and observed fixtures", async () => {
    const request = await fixture("reconciliation-request.json");
    const result = await fixture("reconciliation-result.json");
    expect(LocalAgentReconciliationRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(LocalAgentReconciliationResultSchema.parse(result)).toEqual(
      result,
    );
  });

  it("materializes once from a trusted local template and converges on retry", async () => {
    const harness = await createHarness();
    const request = LocalAgentReconciliationRequestSchema.parse({
      protocol: LOCAL_AGENT_RECONCILIATION_PROTOCOL,
      schemaVersion: LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION,
      requestId: "request-a",
      idempotencyKey: "idempotency-a",
      sourceId: "channel-example",
      agentKey: "external-agent-a",
      templateId: "standard",
      revision: digest("revision-a"),
      instructions: "Answer only within the configured scope.",
      runtime: {
        provider: "codex",
        modelPreset: "balanced",
      },
      requestedCapabilities: ["read.messages", "write.replies"],
    });

    const created = await harness.reconciler.reconcile(request);
    const duplicate = await harness.reconciler.reconcile({
      ...request,
      requestId: "request-b",
    });

    expect(created).toMatchObject({
      disposition: "created",
      state: "ready",
      appliedRevision: request.revision,
      grantedCapabilities: ["read.messages", "write.replies"],
    });
    expect(duplicate).toMatchObject({
      disposition: "unchanged",
      state: "ready",
      agentId: created.agentId,
    });
    expect(harness.runtime.createCount).toBe(1);
    expect(
      harness.runtime.permissions.get(created.agentId ?? ""),
    ).toEqual({
      profile: "bootstrap",
      capabilities: ["send:chat:*", "view:chat:*"],
    });
    expect(
      await readFile(
        path.join(
          harness.workspaceRoot,
          created.agentId ?? "",
          "AGENTS.md",
        ),
        "utf8",
      ),
    ).toContain("Answer only within the configured scope.");
  });

  it("fails closed for capability, runtime, ownership, and idempotency conflicts", async () => {
    const harness = await createHarness();
    const base = LocalAgentReconciliationRequestSchema.parse({
      protocol: LOCAL_AGENT_RECONCILIATION_PROTOCOL,
      schemaVersion: LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION,
      requestId: "request-a",
      idempotencyKey: "idempotency-a",
      sourceId: "channel-example",
      agentKey: "external-agent-a",
      templateId: "standard",
      revision: digest("revision-a"),
      instructions: "Use the managed workspace.",
      requestedCapabilities: ["read.messages"],
    });
    const created = await harness.reconciler.reconcile(base);
    expect(created.state).toBe("ready");

    await expect(
      harness.reconciler.reconcile({
        ...base,
        requestId: "request-capability",
        idempotencyKey: "idempotency-capability",
        requestedCapabilities: ["admin.system"],
      }),
    ).resolves.toMatchObject({
      state: "blocked",
      error: { code: "LOCAL_PERMISSION_DENIED" },
    });
    await expect(
      harness.reconciler.reconcile({
        ...base,
        requestId: "request-runtime",
        idempotencyKey: "idempotency-runtime",
        runtime: { provider: "other" },
      }),
    ).resolves.toMatchObject({
      state: "blocked",
      error: { code: "LOCAL_PERMISSION_DENIED" },
    });
    await expect(
      harness.reconciler.reconcile({
        ...base,
        requestId: "request-conflict",
        instructions: "Different payload under the same key.",
      }),
    ).resolves.toMatchObject({
      state: "blocked",
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const adoptionHarness = await createHarness();
    const occupiedAgentId = `channel-${digest(
      "channel-example\u001fexternal-agent-a",
    ).slice(0, 24)}`;
    adoptionHarness.runtime.agents.set(occupiedAgentId, {
      agentId: occupiedAgentId,
      cwd: path.join(
        adoptionHarness.workspaceRoot,
        occupiedAgentId,
      ),
    });
    await expect(
      adoptionHarness.reconciler.reconcile({
        ...base,
        requestId: "request-adoption",
        idempotencyKey: "idempotency-adoption",
      }),
    ).resolves.toMatchObject({
      state: "blocked",
      error: { code: "LOCAL_PERMISSION_DENIED" },
    });
  });

  it("rejects wire requests that attempt to carry local workspace configuration", async () => {
    const request = await fixture<Record<string, unknown>>(
      "reconciliation-request.json",
    );
    expect(
      LocalAgentReconciliationRequestSchema.parse({
        ...request,
        cwd: "/untrusted/path",
      }),
    ).not.toHaveProperty("cwd");
    expect(
      LocalAgentReconciliationRequestSchema.safeParse({
        ...request,
        schemaVersion:
          LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION + 1,
      }).success,
    ).toBe(false);
  });

  it("adapts the generated Ravi client without repeating an equal permission write", async () => {
    let permissions:
      | {
          profile: string;
          capabilities: string[];
        }
      | undefined;
    const adapter = createRaviClientLocalAgentRuntimeAdapter({
      agents: {
        async list() {
          return {
            agents: [
              {
                id: "agent-a",
                cwd: "/srv/ravi/agent-a",
                provider: "codex",
                modelPresetId: "balanced",
              },
            ],
            pagination: { nextOffset: null },
          };
        },
        async create() {},
        async set() {},
        async permissions(_id, profile, options) {
          if (profile === undefined) {
            return {
              changed: false,
              runtimePermissions:
                permissions === undefined
                  ? null
                  : {
                      profile: permissions.profile,
                      capabilities: permissions.capabilities,
                    },
            };
          }
          permissions = {
            profile,
            capabilities:
              options?.capabilities?.split(",").filter(Boolean) ?? [],
          };
          return { changed: true };
        },
      },
    });

    await expect(adapter.inspect("agent-a")).resolves.toMatchObject({
      agentId: "agent-a",
      provider: "codex",
      modelPreset: "balanced",
    });
    await expect(
      adapter.configurePermissions({
        agentId: "agent-a",
        profile: "bootstrap",
        capabilities: ["send:chat:*"],
      }),
    ).resolves.toBe(true);
    await expect(
      adapter.configurePermissions({
        agentId: "agent-a",
        profile: "bootstrap",
        capabilities: ["send:chat:*"],
      }),
    ).resolves.toBe(false);
  });
});
