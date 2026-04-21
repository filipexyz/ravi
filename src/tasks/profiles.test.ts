import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import systemProfilesRaw from "./profile-catalog/system-profiles.json" with { type: "json" };

let pluginDescriptors: Array<{ path: string }> = [];
let discoverPluginsCalls = 0;

mock.module("../plugins/index.js", () => ({
  discoverPlugins: () => {
    discoverPluginsCalls += 1;
    return pluginDescriptors;
  },
}));

const {
  createTask,
  dbDeleteTask,
  getTaskDetails,
  initTaskProfileScaffold,
  invalidateTaskProfileCatalogCache,
  listTaskProfiles,
  previewTaskProfile,
  requireTaskProfileDefinition,
  resolveTaskProfile,
  validateTaskProfiles,
} = await import("./index.js");

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const createdTaskIds: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type TestProfileVariant = "task-doc" | "brainstorm" | "runtime-only";

function writeTaskProfile(
  profilesRoot: string,
  profileId: string,
  options: {
    version?: string;
    label?: string;
    description?: string;
    variant?: TestProfileVariant;
    taskDocumentUsage?: "required" | "optional" | "none";
    templateMode?: "inline" | "path";
    inputs?: Array<{ key: string; defaultValue?: string }>;
    runtimeDefaults?: {
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      thinking?: "off" | "normal" | "verbose";
    };
    templateTexts?: {
      dispatch?: string;
      resume?: string;
      dispatchSummary?: string;
      dispatchEventMessage?: string;
      reportDoneMessage?: string;
      reportBlockedMessage?: string;
      reportFailedMessage?: string;
    };
  } = {},
): string {
  const variant = options.variant ?? "task-doc";
  const taskDocumentUsage =
    options.taskDocumentUsage ?? (variant === "runtime-only" || variant === "brainstorm" ? "none" : "required");
  const templateMode = options.templateMode ?? "inline";
  const profileDir = join(profilesRoot, profileId);
  mkdirSync(profileDir, { recursive: true });

  const templateTexts = {
    dispatch: options.templateTexts?.dispatch ?? `Dispatch {{task.title}} with ${profileId}`,
    resume: options.templateTexts?.resume ?? `Resume {{task.id}} with ${profileId}`,
    dispatchSummary: options.templateTexts?.dispatchSummary ?? `Summary {{task.id}}`,
    dispatchEventMessage: options.templateTexts?.dispatchEventMessage ?? `Event {{task.id}}`,
    reportDoneMessage: options.templateTexts?.reportDoneMessage ?? "{{report.text}}",
    reportBlockedMessage: options.templateTexts?.reportBlockedMessage ?? "{{report.text}}",
    reportFailedMessage: options.templateTexts?.reportFailedMessage ?? "{{report.text}}",
  };

  if (templateMode === "path") {
    writeFileSync(join(profileDir, "dispatch.md"), `${templateTexts.dispatch}\n`, "utf8");
    writeFileSync(join(profileDir, "resume.md"), `${templateTexts.resume}\n`, "utf8");
    writeFileSync(join(profileDir, "dispatch-summary.txt"), `${templateTexts.dispatchSummary}\n`, "utf8");
    writeFileSync(join(profileDir, "dispatch-event.txt"), `${templateTexts.dispatchEventMessage}\n`, "utf8");
    writeFileSync(join(profileDir, "report-done.txt"), `${templateTexts.reportDoneMessage}\n`, "utf8");
    writeFileSync(join(profileDir, "report-blocked.txt"), `${templateTexts.reportBlockedMessage}\n`, "utf8");
    writeFileSync(join(profileDir, "report-failed.txt"), `${templateTexts.reportFailedMessage}\n`, "utf8");
  }

  const manifest = {
    id: profileId,
    version: options.version ?? "1",
    label: options.label ?? profileId,
    description: options.description ?? `Profile ${profileId}`,
    sessionNameTemplate: "<task-id>-work",
    ...(options.runtimeDefaults ? { runtimeDefaults: options.runtimeDefaults } : {}),
    workspaceBootstrap: {
      mode: "inherit",
      ensureTaskDir: taskDocumentUsage !== "none",
    },
    sync: {
      artifactFirst: taskDocumentUsage === "required",
      ...(taskDocumentUsage !== "none" ? { taskDocument: { mode: taskDocumentUsage } } : {}),
    },
    rendererHints: {
      label: options.label ?? profileId,
      showTaskDoc: taskDocumentUsage !== "none",
      showWorkspace: true,
    },
    defaultTags: [`task.profile.${profileId}`],
    inputs: (options.inputs ?? []).map((input) => ({
      key: input.key,
      defaultValue: input.defaultValue,
    })),
    completion: {
      summaryRequired: true,
      summaryLabel: "Resumo",
    },
    progress: {
      requireMessage: true,
    },
    artifacts:
      variant === "brainstorm"
        ? [
            {
              kind: "brainstorm-draft",
              label: "Brainstorm draft",
              pathTemplate: "{{session.cwd}}/.genie/brainstorms/{{profileState.brainstorm.slug}}/DRAFT.md",
              primary: true,
            },
            {
              kind: "brainstorm-design",
              label: "Brainstorm design",
              pathTemplate: "{{session.cwd}}/.genie/brainstorms/{{profileState.brainstorm.slug}}/DESIGN.md",
              primaryWhenStatuses: ["done"],
            },
            {
              kind: "brainstorm-jar",
              label: "Brainstorm jar",
              pathTemplate: "{{session.cwd}}/.genie/brainstorm.md",
            },
          ]
        : taskDocumentUsage !== "none"
          ? [
              {
                kind: "task-doc",
                label: "TASK.md",
                pathTemplate: "{{task.taskDocPath}}",
                primary: true,
              },
            ]
          : [],
    state:
      variant === "brainstorm"
        ? [
            {
              path: "brainstorm.slug",
              valueTemplate: "{{task.title}}",
              transform: "slug",
            },
          ]
        : [],
    templates:
      templateMode === "path"
        ? {
            dispatch: { path: "./dispatch.md" },
            resume: { path: "./resume.md" },
            dispatchSummary: { path: "./dispatch-summary.txt" },
            dispatchEventMessage: { path: "./dispatch-event.txt" },
            reportDoneMessage: { path: "./report-done.txt" },
            reportBlockedMessage: { path: "./report-blocked.txt" },
            reportFailedMessage: { path: "./report-failed.txt" },
          }
        : templateTexts,
  };

  writeFileSync(join(profileDir, "profile.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return profileDir;
}

afterEach(async () => {
  invalidateTaskProfileCatalogCache();

  while (createdTaskIds.length > 0) {
    const taskId = createdTaskIds.pop();
    if (taskId) {
      dbDeleteTask(taskId);
    }
  }

  await cleanupIsolatedRaviState(process.env.RAVI_STATE_DIR ?? null);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  pluginDescriptors = [];
  discoverPluginsCalls = 0;
  process.chdir(originalCwd);
});

describe("task profile catalog", () => {
  it("fails closed for unknown profile ids instead of falling back to default", () => {
    expect(() => resolveTaskProfile("missing-profile")).toThrow(
      "Unknown task profile: missing-profile. Available profiles:",
    );
  });

  it("caches task profile catalog lookups within the process", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-cache-");
    await createIsolatedRaviState("ravi-task-profiles-cache-state-");
    process.chdir(workspaceDir);

    expect(discoverPluginsCalls).toBe(0);

    resolveTaskProfile("default");
    resolveTaskProfile("default");

    expect(discoverPluginsCalls).toBe(1);
  });

  it("invalidates the cached catalog after scaffolding a profile", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-cache-init-");
    await createIsolatedRaviState("ravi-task-profiles-cache-init-state-");
    process.chdir(workspaceDir);

    expect(listTaskProfiles().some((profile) => profile.id === "cache-scaffold")).toBeFalse();

    initTaskProfileScaffold("cache-scaffold", "runtime-only", {
      sourceKind: "workspace",
      cwd: workspaceDir,
    });

    expect(requireTaskProfileDefinition("cache-scaffold").sourceKind).toBe("workspace");
  });

  it("resolves precedence across system, plugin, workspace, and user sources", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-workspace-");
    const pluginDir = makeTempDir("ravi-task-profiles-plugin-");
    const stateDir = await createIsolatedRaviState("ravi-task-profiles-state-");
    process.chdir(workspaceDir);
    pluginDescriptors = [{ path: pluginDir }];

    writeTaskProfile(join(pluginDir, "task-profiles"), "cascade-profile", {
      version: "plugin-1",
      label: "Plugin Cascade",
    });
    writeTaskProfile(join(workspaceDir, ".ravi", "task-profiles"), "cascade-profile", {
      version: "workspace-1",
      label: "Workspace Cascade",
    });
    writeTaskProfile(join(stateDir, "task-profiles"), "cascade-profile", {
      version: "user-1",
      label: "User Cascade",
    });
    writeTaskProfile(join(workspaceDir, ".ravi", "task-profiles"), "default", {
      version: "workspace-default-1",
      label: "Workspace Default",
    });

    const cascade = requireTaskProfileDefinition("cascade-profile");
    expect(cascade.sourceKind).toBe("user");
    expect(cascade.version).toBe("user-1");
    expect(cascade.label).toBe("User Cascade");

    const defaultProfile = requireTaskProfileDefinition("default");
    expect(defaultProfile.sourceKind).toBe("workspace");
    expect(defaultProfile.version).toBe("workspace-default-1");
    expect(defaultProfile.label).toBe("Workspace Default");

    const profiles = listTaskProfiles();
    expect(profiles.some((profile) => profile.id === "default")).toBeTrue();
    expect(profiles.some((profile) => profile.id === "brainstorm")).toBeFalse();
    expect(profiles.find((profile) => profile.id === "cascade-profile")?.sourceKind).toBe("user");
  });

  it("keeps the built-in catalog free of legacy task document fields", () => {
    const manifests = systemProfilesRaw as Array<Record<string, unknown>>;
    const legacyDriverKey = "driver";
    const legacyTopLevelKey = ["taskDoc", "Mode"].join("");
    const legacySyncKey = ["taskDoc", "First"].join("");

    for (const manifest of manifests) {
      expect(manifest).not.toHaveProperty(legacyDriverKey);
      expect(manifest).not.toHaveProperty(legacyTopLevelKey);
      const sync = (manifest.sync ?? {}) as Record<string, unknown>;
      expect(sync).not.toHaveProperty(legacySyncKey);

      if (manifest.id === "default") {
        expect(sync).toEqual({
          artifactFirst: true,
          taskDocument: { mode: "required" },
        });
      }
    }
  });

  it("rejects legacy task document aliases in external manifests", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-legacy-");
    await createIsolatedRaviState("ravi-task-profiles-legacy-state-");
    process.chdir(workspaceDir);

    const profilesRoot = join(workspaceDir, ".ravi", "task-profiles");
    const profileDir = join(profilesRoot, "legacy-alias");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "profile.json"),
      `${JSON.stringify(
        {
          id: "legacy-alias",
          version: "1",
          label: "legacy-alias",
          description: "legacy alias should fail",
          sessionNameTemplate: "<task-id>-work",
          workspaceBootstrap: {
            mode: "inherit",
            ensureTaskDir: true,
          },
          ["taskDoc" + "Mode"]: "required",
          sync: {
            ["taskDoc" + "First"]: true,
          },
          rendererHints: {
            label: "legacy",
            showTaskDoc: true,
            showWorkspace: true,
          },
          defaultTags: [],
          inputs: [],
          completion: {},
          progress: {},
          artifacts: [],
          state: [],
          templates: {
            dispatch: "dispatch",
            resume: "resume",
            dispatchSummary: "summary",
            dispatchEventMessage: "event",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(() => validateTaskProfiles("legacy-alias")).toThrow("removed top-level task document field");
  });

  it("rejects legacy driver fields in external manifests", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-driver-");
    await createIsolatedRaviState("ravi-task-profiles-driver-state-");
    process.chdir(workspaceDir);

    const profilesRoot = join(workspaceDir, ".ravi", "task-profiles");
    const profileDir = join(profilesRoot, "legacy-driver");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "profile.json"),
      `${JSON.stringify(
        {
          id: "legacy-driver",
          version: "1",
          label: "legacy-driver",
          description: "legacy driver should fail",
          driver: "doc-first",
          sessionNameTemplate: "<task-id>-work",
          workspaceBootstrap: {
            mode: "inherit",
            ensureTaskDir: true,
          },
          sync: {
            artifactFirst: true,
            taskDocument: { mode: "required" },
          },
          rendererHints: {
            label: "legacy-driver",
            showTaskDoc: true,
            showWorkspace: true,
          },
          defaultTags: [],
          inputs: [],
          completion: {},
          progress: {},
          artifacts: [],
          state: [],
          templates: {
            dispatch: "dispatch",
            resume: "resume",
            dispatchSummary: "summary",
            dispatchEventMessage: "event",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(() => validateTaskProfiles("legacy-driver")).toThrow('uses removed field "driver"');
  });

  it("renders external templates with the stable context and flags unknown placeholders early", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-preview-");
    await createIsolatedRaviState("ravi-task-profiles-preview-state-");
    process.chdir(workspaceDir);

    const profilesRoot = join(workspaceDir, ".ravi", "task-profiles");
    writeTaskProfile(profilesRoot, "previewable", {
      version: "7",
      label: "Previewable",
      templateMode: "path",
      inputs: [{ key: "flavor", defaultValue: "vanilla" }],
      templateTexts: {
        dispatch: "Dispatch {{task.title}} @ {{profile.version}} for {{input.flavor}} using {{task.taskDocPath}}",
        resume: "Resume {{task.id}} in {{session.cwd}}",
        dispatchSummary: "Primary {{artifacts.primary.path}}",
        dispatchEventMessage: "Send {{session.name}}",
        reportDoneMessage: "Done {{report.header}} | {{session.name}} | {{artifacts.primary.path}}",
      },
    });
    writeTaskProfile(profilesRoot, "bad-template", {
      templateMode: "path",
      templateTexts: {
        reportFailedMessage: "Bad {{mystery.value}}",
      },
    });

    const preview = previewTaskProfile("previewable", {
      title: "Catalog Preview",
      input: { flavor: "mint" },
    });

    expect(preview.rendered.dispatch).toContain("Catalog Preview");
    expect(preview.rendered.dispatch).toContain("7");
    expect(preview.rendered.dispatch).toContain("mint");
    expect(preview.rendered.dispatch).toContain("TASK.md");
    expect(preview.rendered.dispatchSummary).toContain("TASK.md");
    expect(preview.rendered.dispatchEventMessage).toContain("task-preview-previewable-work");
    expect(preview.rendered.reportDoneMessage).toContain("Done Task concluída:");
    expect(preview.rendered.reportDoneMessage).toContain("task-preview-previewable-work");
    expect(preview.rendered.reportBlockedMessage).toContain("Task bloqueada:");
    expect(preview.rendered.reportFailedMessage).toContain("Task falhou:");

    const validation = validateTaskProfiles("bad-template");
    expect(validation).toHaveLength(1);
    expect(validation[0]?.valid).toBeFalse();
    expect(validation[0]?.error).toContain('Unknown placeholder root "mystery"');
  });

  it("validates and snapshots profile runtime defaults on task creation", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-runtime-defaults-");
    await createIsolatedRaviState("ravi-task-profiles-runtime-defaults-state-");
    process.chdir(workspaceDir);

    const profilesRoot = join(workspaceDir, ".ravi", "task-profiles");
    writeTaskProfile(profilesRoot, "runtime-defaulted", {
      taskDocumentUsage: "none",
      runtimeDefaults: {
        model: "gpt-5.4-mini",
        effort: "high",
        thinking: "verbose",
      },
    });

    const profile = requireTaskProfileDefinition("runtime-defaulted");
    expect(profile.runtimeDefaults).toEqual({
      model: "gpt-5.4-mini",
      effort: "high",
      thinking: "verbose",
    });

    const created = createTask({
      title: "Runtime defaulted task",
      instructions: "Pin runtime defaults in the task snapshot.",
      createdBy: "test",
      profileId: "runtime-defaulted",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.profileSnapshot?.runtimeDefaults).toEqual(profile.runtimeDefaults);
    expect(getTaskDetails(created.task.id).taskProfile?.runtimeDefaults).toEqual(profile.runtimeDefaults);
  });

  it.skip("pins profile version, source, and snapshot when creating a task", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-snapshot-");
    await createIsolatedRaviState("ravi-task-profiles-snapshot-state-");
    process.chdir(workspaceDir);

    const profilesRoot = join(workspaceDir, ".ravi", "task-profiles");
    writeTaskProfile(profilesRoot, "default", {
      version: "workspace-v1",
      label: "Workspace Default V1",
    });

    const created = createTask({
      title: "Frozen profile task",
      instructions: "Snapshot the profile on creation.",
      createdBy: "test",
      profileId: "default",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.profileVersion).toBe("workspace-v1");
    expect(created.task.profileSource).toContain("workspace");
    expect(created.task.profileSnapshot?.version).toBe("workspace-v1");
    expect(created.task.profileSnapshot?.label).toBe("Workspace Default V1");

    writeTaskProfile(profilesRoot, "default", {
      version: "workspace-v2",
      label: "Workspace Default V2",
    });

    expect(requireTaskProfileDefinition("default").version).toBe("workspace-v2");

    const details = getTaskDetails(created.task.id);
    expect(details.task?.profileVersion).toBe("workspace-v1");
    expect(details.task?.profileSnapshot?.label).toBe("Workspace Default V1");
    expect(details.taskProfile?.version).toBe("workspace-v1");
    expect(details.taskProfile?.label).toBe("Workspace Default V1");
  });

  it("scaffolds a valid external profile manifest bundle", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-init-");
    await createIsolatedRaviState("ravi-task-profiles-init-state-");
    process.chdir(workspaceDir);

    const result = initTaskProfileScaffold("scaffolded-profile", "doc-first", {
      sourceKind: "workspace",
      cwd: workspaceDir,
    });

    expect(result.sourceKind).toBe("workspace");
    expect(existsSync(result.manifestPath)).toBeTrue();
    expect(existsSync(join(result.profileDir, "dispatch.md"))).toBeTrue();

    const validation = validateTaskProfiles("scaffolded-profile");
    expect(validation[0]?.valid).toBeTrue();
  });

  it("scaffolds content profiles rooted in task_dir with content artifacts", async () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-content-init-");
    await createIsolatedRaviState("ravi-task-profiles-content-init-state-");
    process.chdir(workspaceDir);

    const result = initTaskProfileScaffold("content-scaffold", "content", {
      sourceKind: "workspace",
      cwd: workspaceDir,
    });

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      workspaceBootstrap: { mode: string; ensureTaskDir: boolean };
      sync: { artifactFirst?: boolean; taskDocument?: { mode: string } };
      artifacts: Array<{ kind: string }>;
      rendererHints: { label: string };
    };

    expect(manifest.workspaceBootstrap).toEqual({
      mode: "task_dir",
      ensureTaskDir: true,
    });
    expect(manifest.sync.artifactFirst).toBe(false);
    expect(manifest.sync.taskDocument).toBeUndefined();
    expect(manifest.rendererHints.label).toBe("Content workspace");
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual([
      "content-draft",
      "content-notes",
      "content-sources",
      "content-assets",
      "content-exports",
    ]);

    const validation = validateTaskProfiles("content-scaffold");
    expect(validation[0]?.valid).toBeTrue();
  });

  it("keeps the system catalog limited to the default profile", () => {
    const profiles = listTaskProfiles().filter((profile) => profile.sourceKind === "system");

    expect(profiles.map((profile) => profile.id)).toEqual(["default"]);

    const preview = previewTaskProfile("default", {
      title: "Default profile preview",
    });

    expect(preview.profile.workspaceBootstrap.mode).toBe("inherit");
    expect(preview.primaryArtifact?.kind).toBe("task-doc");
    expect(preview.primaryArtifact?.path).toContain("TASK.md");
  });
});
afterAll(() => mock.restore());
