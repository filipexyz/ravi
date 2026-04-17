import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const actualCliContextModule = await import("../context.js");

let pluginDescriptors: Array<{ path: string }> = [];

mock.module("../../plugins/index.js", () => ({
  discoverPlugins: () => pluginDescriptors,
}));

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { TaskProfileCommands } = await import("./tasks-profiles.js");

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTaskProfile(
  profilesRoot: string,
  profileId: string,
  options: {
    version?: string;
    templateMode?: "inline" | "path";
    taskDocumentUsage?: "required" | "optional" | "none";
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
): void {
  const taskDocumentUsage = options.taskDocumentUsage ?? "required";
  const templateMode = options.templateMode ?? "inline";
  const profileDir = join(profilesRoot, profileId);
  mkdirSync(profileDir, { recursive: true });

  const templateTexts = {
    dispatch: options.templateTexts?.dispatch ?? "Dispatch {{task.title}}",
    resume: options.templateTexts?.resume ?? "Resume {{task.id}}",
    dispatchSummary: options.templateTexts?.dispatchSummary ?? "Summary {{task.id}}",
    dispatchEventMessage: options.templateTexts?.dispatchEventMessage ?? "Event {{task.id}}",
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
    label: profileId,
    description: `CLI profile ${profileId}`,
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
      label: profileId,
      showTaskDoc: taskDocumentUsage !== "none",
      showWorkspace: true,
    },
    defaultTags: [`task.profile.${profileId}`],
    inputs: [{ key: "flavor", defaultValue: "vanilla" }],
    completion: {
      summaryRequired: true,
      summaryLabel: "Resumo",
    },
    progress: {
      requireMessage: true,
    },
    artifacts: [
      {
        kind: `${profileId}-artifact`,
        label: `${profileId} artifact`,
        pathTemplate: "{{session.cwd}}/.ravi/artifacts/{{profile.id}}.md",
        primary: true,
      },
    ],
    state: [
      {
        path: "meta.slug",
        valueTemplate: "{{task.title}}",
        transform: "slug",
      },
    ],
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
}

function captureConsole<T>(run: () => T): { output: string; result: T } {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (value?: unknown) => {
    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  };

  try {
    const result = run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

afterEach(() => {
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

describe("TaskProfileCommands", () => {
  it("lists, shows, and previews resolved profiles through the CLI", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-cli-");
    const stateDir = makeTempDir("ravi-task-profiles-cli-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

    writeTaskProfile(join(workspaceDir, ".ravi", "task-profiles"), "preview-cli", {
      version: "3",
      templateMode: "path",
      templateTexts: {
        dispatch: "CLI {{task.title}} / {{input.flavor}} / {{task.taskDocPath}}",
        resume: "Resume {{task.id}}",
        dispatchSummary: "Summary {{artifacts.primary.path}}",
        dispatchEventMessage: "Event {{session.name}}",
        reportDoneMessage: "Done {{report.header}} / {{session.name}}",
      },
    });

    const commands = new TaskProfileCommands();

    const listOutput = captureConsole(() => commands.list(true));
    const listPayload = JSON.parse(listOutput.output);
    expect(listPayload.profiles.some((profile: { id: string }) => profile.id === "preview-cli")).toBeTrue();

    const showOutput = captureConsole(() => commands.show("preview-cli", true));
    const showPayload = JSON.parse(showOutput.output);
    expect(showPayload.id).toBe("preview-cli");
    expect(showPayload.version).toBe("3");
    expect(showPayload.sourceKind).toBe("workspace");

    const previewOutput = captureConsole(() =>
      commands.preview(
        "preview-cli",
        "CLI Preview Title",
        undefined,
        "flavor=matcha",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    const previewPayload = JSON.parse(previewOutput.output);
    expect(previewPayload.profile.id).toBe("preview-cli");
    expect(previewPayload.rendered.dispatch).toContain("CLI Preview Title");
    expect(previewPayload.rendered.dispatch).toContain("matcha");
    expect(previewPayload.rendered.dispatch).toContain("TASK.md");
    expect(previewPayload.rendered.dispatchSummary).toContain(".ravi/artifacts/preview-cli.md");
    expect(previewPayload.rendered.reportDoneMessage).toContain("Done Task concluída:");
  });

  it("prints state and artifact definitions in textual show output", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-cli-text-");
    const stateDir = makeTempDir("ravi-task-profiles-cli-text-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

    writeTaskProfile(join(workspaceDir, ".ravi", "task-profiles"), "text-cli", {
      version: "7",
      taskDocumentUsage: "none",
    });

    const commands = new TaskProfileCommands();
    const showOutput = captureConsole(() => commands.show("text-cli"));

    expect(showOutput.output).toContain("Profile:     text-cli");
    expect(showOutput.output).toContain("Version:     7");
    expect(showOutput.output).toContain("Source:      workspace ::");
    expect(showOutput.output).toContain("State:");
    expect(showOutput.output).toContain("Artifacts:");
    expect(showOutput.output).toContain("Artifact definitions:");
  });

  it("validates bad templates and initializes a scaffolded profile through the CLI", () => {
    const workspaceDir = makeTempDir("ravi-task-profiles-cli-validate-");
    const stateDir = makeTempDir("ravi-task-profiles-cli-validate-state-");
    process.chdir(workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;

    writeTaskProfile(join(workspaceDir, ".ravi", "task-profiles"), "bad-cli", {
      templateMode: "path",
      templateTexts: {
        reportFailedMessage: "Bad {{unknown.root}}",
      },
    });

    const commands = new TaskProfileCommands();

    const validateBadOutput = captureConsole(() => commands.validate("bad-cli", true));
    const validateBadPayload = JSON.parse(validateBadOutput.output);
    expect(validateBadPayload.valid).toBeFalse();
    expect(validateBadPayload.results[0]?.error).toContain('Unknown placeholder root "unknown"');

    const initOutput = captureConsole(() => commands.init("cli-scaffold", "doc-first", "workspace", true));
    const initPayload = JSON.parse(initOutput.output);
    expect(initPayload.sourceKind).toBe("workspace");
    expect(existsSync(initPayload.manifestPath)).toBeTrue();

    const validateScaffoldOutput = captureConsole(() => commands.validate("cli-scaffold", true));
    const validateScaffoldPayload = JSON.parse(validateScaffoldOutput.output);
    expect(validateScaffoldPayload.valid).toBeTrue();
  });
});
afterAll(() => mock.restore());
