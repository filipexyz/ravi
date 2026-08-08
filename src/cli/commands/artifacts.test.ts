/**
 * Agent-first contract tests for the `artifacts` and `artifacts.release` CLI
 * domains (Manual v2): write brake (exit 3) on the external-exposure ops
 * (`publish`, `release activate`), not-found envelopes (ARTIFACT_NOT_FOUND /
 * ARTIFACT_VERSION_NOT_FOUND, exit 1) and compact `--fields` mode. Follows the
 * group.test.ts pattern: no-op decorator mocks + store/publish-client mocks
 * with spies + `hasContext: () => true` so the contract helpers throw
 * ContractError instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { CloudAuthError } from "../../cloud-auth/errors.js";

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const publishCalls: Array<{ target: string; options: Record<string, unknown> }> = [];
const activateCalls: Array<{ id: string; options: Record<string, unknown> }> = [];
const archiveCalls: Array<{ id: string }> = [];
const updateCalls: Array<{ id: string; updates: Record<string, unknown> }> = [];
const attachCalls: Array<Record<string, unknown>> = [];
const snapshotCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
const restoreCalls: Array<{ id: string; versionNumber: number }> = [];
const eventCalls: Array<{ id: string; input: Record<string, unknown> }> = [];
const schemaInitializingStoreCalls: string[] = [];
const readOnlyArtifactInspectionCalls: Array<{ id: string; versionNumber?: number }> = [];

const knownArtifacts: Array<Record<string, unknown>> = [
  {
    id: "art_aaa111",
    kind: "report",
    title: "Relatorio Vendas",
    status: "completed",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "art_bbb222",
    kind: "image",
    title: "Dashboard Metricas",
    status: "completed",
    tags: [],
    createdAt: 2,
    updatedAt: 2,
  },
];

const versionFixture = {
  id: "ver_1",
  artifactId: "art_aaa111",
  versionNumber: 1,
  status: "active",
  label: null,
  source: "cli",
  createdBy: null,
  createdAt: 1,
  assets: [],
  manifest: {},
  metadata: null,
};

function requireKnownArtifact(id: string): Record<string, unknown> {
  const artifact = knownArtifacts.find((entry) => entry.id === id);
  if (!artifact) throw new Error(`Artifact not found: ${id}`);
  return artifact;
}

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the modules under test)
// ---------------------------------------------------------------------------

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

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("./operational-return-schemas.js", () => ({
  artifactCreateReturnSchema: {},
  artifactDetailsReturnSchema: {},
  artifactEventReturnSchema: {},
  artifactEventsReturnSchema: {},
  artifactListReturnSchema: {},
  artifactMutationReturnSchema: {},
  artifactPublishReturnSchema: {},
  artifactReleaseActivateReturnSchema: {},
  artifactRestoreReturnSchema: {},
  artifactSnapshotReturnSchema: {},
  artifactVersionShowReturnSchema: {},
  artifactVersionsReturnSchema: {},
  declareCommandReturns: () => {},
}));

mock.module("../../artifacts/store.js", () => ({
  createArtifact: (input: Record<string, unknown>) => ({ id: "art_new", ...input }),
  createArtifactPackage: () => ({
    artifact: { id: "art_new" },
    version: versionFixture,
    package: { fileCount: 1, entrypoint: "index.html" },
  }),
  createArtifactVersion: (id: string, input: Record<string, unknown> = {}) => {
    requireKnownArtifact(id);
    snapshotCalls.push({ id, input });
    return { ...versionFixture, artifactId: id };
  },
  getArtifactVersion: (id: string, versionNumber?: number) => {
    schemaInitializingStoreCalls.push("getArtifactVersion");
    requireKnownArtifact(id);
    return versionNumber === undefined || versionNumber === 1 ? { ...versionFixture, artifactId: id } : null;
  },
  getArtifactDetails: (id: string) => {
    schemaInitializingStoreCalls.push("getArtifactDetails");
    const artifact = knownArtifacts.find((entry) => entry.id === id);
    return artifact ? { artifact, links: [], events: [], versions: [] } : null;
  },
  inspectArtifactPublishStateReadOnly: (id: string, versionNumber?: number) => {
    readOnlyArtifactInspectionCalls.push({ id, ...(versionNumber !== undefined ? { versionNumber } : {}) });
    const artifact = knownArtifacts.find((entry) => entry.id === id);
    return {
      artifactExists: Boolean(artifact),
      versionExists: versionNumber === undefined ? null : Boolean(artifact) && versionNumber === 1,
      artifact: artifact ?? null,
      version: artifact ? { ...versionFixture, artifactId: id } : null,
      publishedEvents: artifact
        ? [
            {
              id: 1,
              artifactId: id,
              eventType: "published",
              payload: {
                local: { versionNumber: 1 },
                remote: { releaseId: "rel_1" },
                site: { ref: "demo" },
              },
              createdAt: 1,
            },
          ]
        : [],
      candidates: knownArtifacts.map((entry) => String(entry.id)),
    };
  },
  listArtifactEvents: (id: string) => {
    schemaInitializingStoreCalls.push("listArtifactEvents");
    requireKnownArtifact(id);
    return [];
  },
  listArtifactVersions: (id: string) => {
    requireKnownArtifact(id);
    return [{ ...versionFixture, artifactId: id }];
  },
  listArtifactsPage: () => ({ items: knownArtifacts, total: knownArtifacts.length }),
  restoreArtifactVersion: (id: string, versionNumber: number) => {
    requireKnownArtifact(id);
    if (versionNumber !== 1) throw new Error(`Artifact version not found: ${id} v${versionNumber}`);
    restoreCalls.push({ id, versionNumber });
    return {
      artifact: knownArtifacts[0],
      restoredFrom: versionFixture,
      restoreVersion: { ...versionFixture, versionNumber: 2 },
    };
  },
  updateArtifact: (id: string, updates: Record<string, unknown>) => {
    const artifact = requireKnownArtifact(id);
    updateCalls.push({ id, updates });
    return artifact;
  },
  archiveArtifact: (id: string) => {
    const artifact = requireKnownArtifact(id);
    archiveCalls.push({ id });
    return artifact;
  },
  appendArtifactEvent: (id: string, input: Record<string, unknown>) => {
    requireKnownArtifact(id);
    eventCalls.push({ id, input });
    return { id: "evt_1", artifactId: id, eventType: input.eventType, createdAt: 1 };
  },
  attachArtifact: (id: string, targetType: string, targetId: string, relation: string) => {
    requireKnownArtifact(id);
    attachCalls.push({ id, targetType, targetId, relation });
    return { id: "link_1", artifactId: id, targetType, targetId, relation };
  },
}));

mock.module("../../whatsapp-overlay/artifacts.js", () => ({
  buildOverlayArtifactsPayload: () => ({ items: [], stats: {} }),
  normalizeLifecycle: (value: string) =>
    ["pending", "running", "completed", "failed", "archived"].includes(value) ? value : null,
  resolveArtifactBlob: async () => ({ ok: false, error: "not found", code: "NOT_FOUND", status: 404 }),
}));

mock.module("../../artifacts/publish-client.js", () => ({
  publishArtifactToConsole: async (target: string, options: Record<string, unknown>) => {
    publishCalls.push({ target, options });
    if (options.project === "auth-error") throw new CloudAuthError("AUTH_REQUIRED", "login required");
    return {
      artifact: { id: "cloud_art_1" },
      artifactVersion: { id: "cloud_ver_1" },
      publish: { id: "pub_1" },
      release: { id: "rel_1" },
      routes: [],
      url: "https://demo.ravi.page/",
      upload: { attempted: 1, skipped: 0 },
    };
  },
  activateArtifactReleaseInConsole: async (id: string, options: Record<string, unknown>) => {
    activateCalls.push({ id, options });
    if (options.release === "rel_auth_error") throw new CloudAuthError("AUTH_REQUIRED", "login required");
    return { release: { id: "rel_1" }, site: { id: "site_1" }, routes: [], url: "https://demo.ravi.page/" };
  },
}));

const { ArtifactsCommands, ArtifactReleaseCommands } = await import("./artifacts.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

beforeEach(() => {
  publishCalls.length = 0;
  activateCalls.length = 0;
  archiveCalls.length = 0;
  updateCalls.length = 0;
  attachCalls.length = 0;
  snapshotCalls.length = 0;
  restoreCalls.length = 0;
  eventCalls.length = 0;
  schemaInitializingStoreCalls.length = 0;
  readOnlyArtifactInspectionCalls.length = 0;
});

// ---------------------------------------------------------------------------
// artifacts — write brake on the external-exposure ops
// ---------------------------------------------------------------------------

describe("artifacts write brake", () => {
  it("publish without --execute is a dry-run: exit 3 and NO Console/upload call", async () => {
    const commands = new ArtifactsCommands();
    const route = "/PRIVATE_ROUTE_8K2R";
    const name = "PRIVATE_NAME_8K2R";
    const entrypoint = "private/PRIVATE_ENTRYPOINT_8K2R.html";
    const error = await expectContractError(
      () =>
        commands.publish(
          "art_aaa111",
          "proj",
          "demo",
          route,
          "public",
          name,
          undefined,
          undefined,
          entrypoint,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      target: { kind: "artifact", artifactId: "art_aaa111" },
      project: "proj",
      site: "demo",
      routePresent: true,
      visibility: "public",
      namePresent: true,
      slug: null,
      entrypointPresent: true,
      artifactVersion: null,
      activate: true,
      replaceRelease: false,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(route);
    expect(serializedPlan).not.toContain(name);
    expect(serializedPlan).not.toContain(entrypoint);
    expect(publishCalls).toHaveLength(0);
  });

  it("publish rejects a missing filesystem target before the dry-run brake", async () => {
    const commands = new ArtifactsCommands();
    await expectContractError(
      () =>
        commands.publish(
          "./missing-local-target",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      "USAGE_ERROR",
      2,
    );
    expect(publishCalls).toHaveLength(0);
  });

  it(
    "publish resolves missing artifact ids and versions before the dry-run brake without schema initialization",
    async () => {
      const commands = new ArtifactsCommands();
      await expectContractError(
        () =>
          commands.publish(
            "art_missing_target",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          ),
        "ARTIFACT_NOT_FOUND",
        1,
      );
      await expectContractError(
        () =>
          commands.publish(
            "art_aaa111",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            "2",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          ),
        "ARTIFACT_VERSION_NOT_FOUND",
        1,
      );
      expect(schemaInitializingStoreCalls).toEqual([]);
      expect(publishCalls).toHaveLength(0);
    },
  );

  it("publish with --execute uploads through the publish client", async () => {
    const commands = new ArtifactsCommands();
    const result = await silenced(() =>
      commands.publish(
        "art_aaa111",
        "proj",
        "demo",
        "/",
        "public",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({ target: "art_aaa111" });
    expect(publishCalls[0]?.options).toMatchObject({
      project: "proj",
      site: "demo",
      route: "/",
      visibility: "public",
      activate: true,
    });
    expect(result).toMatchObject({ url: "https://demo.ravi.page/" });
  });

  it("release activate without --execute is a dry-run: exit 3 and NO Console call", async () => {
    const commands = new ArtifactReleaseCommands();
    const error = await expectContractError(
      () => commands.activate("art_aaa111", "1", "rel_1", "demo", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      artifactId: "art_aaa111",
      artifactVersion: 1,
      release: "rel_1",
      site: "demo",
    });
    expect(activateCalls).toHaveLength(0);
  });

  it("release activate validates required selectors before the dry-run brake", async () => {
    const commands = new ArtifactReleaseCommands();
    await expectContractError(() => commands.activate("", "1", "rel_1", "demo", undefined, true), "USAGE_ERROR", 2);
    await expect(commands.activate("art_aaa111", undefined, undefined, undefined, undefined, true)).rejects.toThrow(
      "Missing release selector",
    );
    expect(activateCalls).toHaveLength(0);
  });

  it("release activate resolves the artifact and recorded release before the brake using read-only state", async () => {
    const commands = new ArtifactReleaseCommands();
    await expectContractError(
      () => commands.activate("art_missing_target", "1", undefined, undefined, undefined, true),
      "ARTIFACT_NOT_FOUND",
      1,
    );
    const dryRun = await expectContractError(
      () => commands.activate("art_aaa111", "1", undefined, undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(dryRun.details.plan).toMatchObject({ artifactId: "art_aaa111", artifactVersion: 1 });
    expect(schemaInitializingStoreCalls).toEqual([]);
    expect(readOnlyArtifactInspectionCalls).toContainEqual({ id: "art_aaa111", versionNumber: 1 });
  });

  it("virgin dry-runs never call artifact ledger helpers that initialize schema", async () => {
    const publish = new ArtifactsCommands();
    const activate = new ArtifactReleaseCommands();

    await expectContractError(
      () =>
        publish.publish(
          "art_aaa111",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    await expectContractError(
      () => activate.activate("art_aaa111", "1", "rel_1", "site_1", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(schemaInitializingStoreCalls).toEqual([]);
    expect(publishCalls).toHaveLength(0);
    expect(activateCalls).toHaveLength(0);
  });

  it("release activate with --execute calls the publish client", async () => {
    const commands = new ArtifactReleaseCommands();
    await silenced(() => commands.activate("art_aaa111", undefined, "rel_1", "demo", undefined, true, true));

    expect(activateCalls).toHaveLength(1);
    expect(activateCalls[0]).toMatchObject({ id: "art_aaa111" });
    expect(activateCalls[0]?.options).toMatchObject({ release: "rel_1", site: "demo" });
  });

  it("never exits the host process when publish fails in a tool or gateway context", async () => {
    await expect(
      silenced(() =>
        new ArtifactsCommands().publish(
          "art_aaa111",
          "auth-error",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("never exits the host process when release activation fails in a tool or gateway context", async () => {
    await expect(
      silenced(() =>
        new ArtifactReleaseCommands().activate(
          "art_aaa111",
          undefined,
          "rel_auth_error",
          "demo",
          undefined,
          true,
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("archive is declared UNBRAKED: the soft-delete happens without --execute", async () => {
    const commands = new ArtifactsCommands();
    const payload = await silenced(() => commands.archive("art_aaa111", true));

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]).toMatchObject({ id: "art_aaa111" });
    expect(payload).toMatchObject({ success: true });
  });

  it("restore is declared UNBRAKED: the reversible restore happens without --execute", async () => {
    const commands = new ArtifactsCommands();
    const payload = await silenced(() => commands.restore("art_aaa111", "1", undefined, true));

    expect(restoreCalls).toHaveLength(1);
    expect(payload).toMatchObject({ success: true });
  });
});

// ---------------------------------------------------------------------------
// artifacts — not-found envelopes and compact mode
// ---------------------------------------------------------------------------

describe("artifacts envelopes and compact mode", () => {
  it("show on an unknown id exits 1 with ARTIFACT_NOT_FOUND and local suggestions", async () => {
    const commands = new ArtifactsCommands();
    const error = await expectContractError(() => commands.show("art_aaa", true), "ARTIFACT_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("art_aaa111");
    expect(error.details.suggestedAction).toContain("ravi artifacts list");
  });

  it("archive on an unknown id maps the store throw to ARTIFACT_NOT_FOUND without mutating anything", async () => {
    const commands = new ArtifactsCommands();
    await expectContractError(() => commands.archive("art_ghost", true), "ARTIFACT_NOT_FOUND", 1);

    expect(archiveCalls).toHaveLength(0);
  });

  it("snapshot on an unknown id maps the store throw to ARTIFACT_NOT_FOUND", async () => {
    const commands = new ArtifactsCommands();
    await expectContractError(
      () => commands.snapshot("art_ghost", undefined, undefined, undefined, undefined, undefined, undefined, true),
      "ARTIFACT_NOT_FOUND",
      1,
    );

    expect(snapshotCalls).toHaveLength(0);
  });

  it("events on an unknown id passes the ContractError through the legacy catch (exit 1)", async () => {
    const commands = new ArtifactsCommands();
    const error = await expectContractError(() => commands.events("art_ghost", true), "ARTIFACT_NOT_FOUND", 1);

    expect(error.details.suggestedAction).toContain("ravi artifacts list");
  });

  it("version with an unknown version number exits 1 with ARTIFACT_VERSION_NOT_FOUND", async () => {
    const commands = new ArtifactsCommands();
    const error = await expectContractError(
      () => commands.version("art_aaa111", "9", true),
      "ARTIFACT_VERSION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi artifacts versions art_aaa111");
  });

  it("restore with an unknown version number maps the store throw to ARTIFACT_VERSION_NOT_FOUND", async () => {
    const commands = new ArtifactsCommands();
    await expectContractError(
      () => commands.restore("art_aaa111", "9", undefined, true),
      "ARTIFACT_VERSION_NOT_FOUND",
      1,
    );

    expect(restoreCalls).toHaveLength(0);
  });

  it("attach on an unknown id maps the store throw to ARTIFACT_NOT_FOUND", async () => {
    const commands = new ArtifactsCommands();
    await expectContractError(
      () => commands.attach("art_ghost", "task", "task-1", undefined, undefined, true),
      "ARTIFACT_NOT_FOUND",
      1,
    );

    expect(attachCalls).toHaveLength(0);
  });

  it("list --fields narrows each item to the requested fields", async () => {
    const commands = new ArtifactsCommands();
    const payload = await silenced(() =>
      commands.list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        "id,kind",
      ),
    );

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "kind"]);
    }
  });
});
