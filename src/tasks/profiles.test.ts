import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import systemProfilesRaw from "./profile-catalog/system-profiles.json" with { type: "json" };

let pluginDescriptors: Array<{ path: string }> = [];

mock.module("../plugins/index.js", () => ({
  discoverPlugins: () => pluginDescriptors,
}));

const {
  createTask,
  dbDeleteTask,
  getTaskDetails,
  initTaskProfileScaffold,
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
    templateTexts?: {
      dispatch?: string;
      resume?: string;
      dispatchSummary?: string;
      dispatchEventMessage?: string;
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
  };

  if (templateMode === "path") {
    writeFileSync(join(profileDir, "dispatch.md"), `${templateTexts.dispatch}\n`, "utf8");
    writeFileSync(join(profileDir, "resume.md"), `${templateTexts.resume}\n`, "utf8");
    writeFileSync(join(profileDir, "dispatch-summary.txt"), `${templateTexts.dispatchSummary}\n`, "utf8");
    writeFileSync(join(profileDir, "dispatch-event.txt"), `${templateTexts.dispatchEventMessage}\n`, "utf8");
  }

  const manifest = {
    id: profileId,
    version: options.version ?? "1",
    label: options.label ?? profileId,
    description: options.description ?? `Profile ${profileId}`,
    sessionNameTemplate: "<task-id>-work",
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
          }
        : templateTexts,
  };

  writeFileSync(join(profileDir, "profile.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return profileDir;
}

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const taskId = createdTaskIds.pop();
    if (taskId) {
      dbDeleteTask(taskId);
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  pluginDescriptors = [];
  delete process.env.RAVI_STATE_DIR;
  process.chdir(originalCwd);
});

describe("task profile catalog", () => {
  it("fails closed for unknown profile ids instead of falling back to default", () => {
    expect(() => resolveTaskProfile("missing-profile")).toThrow(
      "Unknown task profile: missing-profile. Available profiles:",
    );
  });

  it("resolves precedence across system, plugin, workspace, and user sources", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-workspace-");
    const pluginDir = makeTempDir("ravi-task-profiles-plugin-");
    const stateDir = makeTempDir("ravi-task-profiles-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;
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
    expect(profiles.some((profile) => profile.id === "brainstorm")).toBeTrue();
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

      if (manifest.id === "task-doc-optional") {
        expect(sync).toEqual({
          artifactFirst: false,
          taskDocument: { mode: "optional" },
        });
      }

      if (
        manifest.id === "brainstorm" ||
        manifest.id === "content" ||
        manifest.id === "video-rapha" ||
        manifest.id === "task-doc-none"
      ) {
        expect(sync).toEqual({
          artifactFirst: false,
        });
      }
    }
  });

  it("rejects legacy task document aliases in external manifests", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-legacy-");
    const stateDir = makeTempDir("ravi-task-profiles-legacy-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

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

  it("rejects legacy driver fields in external manifests", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-driver-");
    const stateDir = makeTempDir("ravi-task-profiles-driver-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

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

  it("renders external templates with the stable context and flags unknown placeholders early", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-preview-");
    const stateDir = makeTempDir("ravi-task-profiles-preview-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

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
      },
    });
    writeTaskProfile(profilesRoot, "bad-template", {
      templateMode: "path",
      templateTexts: {
        dispatch: "Bad {{mystery.value}}",
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

    const validation = validateTaskProfiles("bad-template");
    expect(validation).toHaveLength(1);
    expect(validation[0]?.valid).toBeFalse();
    expect(validation[0]?.error).toContain('Unknown placeholder root "mystery"');
  });

  it("pins profile version, source, and snapshot when creating a task", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-snapshot-");
    const stateDir = makeTempDir("ravi-task-profiles-snapshot-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

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

  it("scaffolds a valid external profile manifest bundle", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-init-");
    const stateDir = makeTempDir("ravi-task-profiles-init-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

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

  it("scaffolds content profiles rooted in task_dir with content artifacts", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-content-init-");
    const stateDir = makeTempDir("ravi-task-profiles-content-init-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

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

  it("previews the built-in video-rapha profile against the videomaker workspace", () => {
    const preview = previewTaskProfile("video-rapha", {
      title: "Video Rapha preview",
      input: {
        video_id: "silveira-nuclear",
        titulo: "Silveira Nuclear",
        brief: "Explicar a tese central, mostrar contraste e fechar com CTA.",
        tese: "nuclear e a virada silenciosa da matriz",
        publico: "fundadores e operadores curiosos sobre energia",
        acao: "me chama no whatsapp",
      },
    });

    const videoWorkspace = join(homedir(), "ravi", "videomaker");
    expect(preview.profile.workspaceBootstrap.mode).toBe("path");
    expect(preview.primaryArtifact?.kind).toBe("video-runner-state");
    expect(preview.primaryArtifact?.path).toBe(`${videoWorkspace}/out/silveira-nuclear/.wf-eb-state.json`);
    expect(preview.rendered.dispatch).toContain(`project root: ${videoWorkspace}/out/silveira-nuclear`);
    expect(preview.rendered.dispatch).toContain("CLI canônica: `video`");
    expect(preview.rendered.dispatchSummary).toContain("videomaker worktree");
  });
});
