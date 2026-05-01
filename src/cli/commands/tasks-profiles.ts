import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import {
  createTaskWorktreeConfig,
  initTaskProfileScaffold,
  listTaskProfiles,
  previewTaskProfile,
  requireTaskRuntimeAgent,
  requireTaskProfileDefinition,
  validateTaskProfiles,
} from "../../tasks/index.js";
import type { TaskProfileScaffoldPreset } from "../../tasks/types.js";

function parseProfileInputs(raw?: string[] | string): Record<string, string> {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const resolved: Record<string, string> = {};

  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) {
      fail(`Invalid --input value: ${value}. Use key=value.`);
    }
    const key = value.slice(0, index).trim();
    const entryValue = value.slice(index + 1).trim();
    if (!key) {
      fail(`Invalid --input value: ${value}. Use key=value.`);
    }
    resolved[key] = entryValue;
  }

  return resolved;
}

function requireProfileScaffoldPreset(value?: string): TaskProfileScaffoldPreset {
  const normalized = value?.trim() as TaskProfileScaffoldPreset | undefined;
  if (!normalized || !["doc-first", "brainstorm", "runtime-only", "content"].includes(normalized)) {
    fail("Invalid preset. Use doc-first|brainstorm|runtime-only|content.");
  }
  return normalized;
}

function formatWorkspaceBootstrap(profile: {
  workspaceBootstrap: { mode: string; path?: string; ensureTaskDir: boolean };
}): string {
  switch (profile.workspaceBootstrap.mode) {
    case "task_dir":
      return "task workspace";
    case "path":
      return profile.workspaceBootstrap.path?.trim() ? `path :: ${profile.workspaceBootstrap.path}` : "path";
    case "inherit":
    default:
      return profile.workspaceBootstrap.ensureTaskDir ? "agent cwd + task workspace" : "agent cwd";
  }
}

function summarizePrimaryArtifacts(profile: {
  artifacts: Array<{ label: string; primary?: boolean; primaryWhenStatuses?: string[] }>;
}): string {
  const primary = profile.artifacts.filter(
    (artifact) => artifact.primary || (artifact.primaryWhenStatuses?.length ?? 0) > 0,
  );
  if (primary.length === 0) {
    return "-";
  }
  return primary.map((artifact) => artifact.label).join(", ");
}

@Group({
  name: "tasks.profiles",
  description: "Inspect and scaffold the task profile catalog",
  scope: "open",
  skillGate: "ravi-system-tasks",
})
export class TaskProfileCommands {
  @Command({ name: "list", description: "List resolved task profiles from all catalog sources" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const profiles = listTaskProfiles();
    const payload = { total: profiles.length, profiles };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (profiles.length === 0) {
      console.log("\nNo task profiles found.\n");
    } else {
      console.log(`\nTask profiles (${profiles.length})\n`);
      console.log("  ID                  VERSION  SOURCE     WORKSPACE                SURFACE");
      console.log("  ------------------  -------  ---------  -----------------------  ------------------------------");
      for (const profile of profiles) {
        console.log(
          `  ${profile.id.padEnd(18)}  ${profile.version.padEnd(7)}  ${profile.sourceKind.padEnd(9)}  ${formatWorkspaceBootstrap(profile).slice(0, 23).padEnd(23)}  ${profile.rendererHints.label.slice(0, 30)}`,
        );
      }
      console.log("");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show the resolved manifest for one task profile" })
  show(
    @Arg("profileId", { description: "Task profile id" }) profileId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const profile = requireTaskProfileDefinition(profileId);

    if (asJson) {
      console.log(JSON.stringify(profile, null, 2));
      return profile;
    }

    console.log(`\nProfile:     ${profile.id}`);
    console.log(`Version:     ${profile.version}`);
    console.log(`Label:       ${profile.label}`);
    console.log(`Source:      ${profile.sourceKind} :: ${profile.source}`);
    console.log(`Manifest:    ${profile.manifestPath ?? "-"}`);
    console.log(`Surface:     ${profile.rendererHints.label}`);
    console.log(`Workspace:   ${formatWorkspaceBootstrap(profile)}`);
    console.log(`Session:     ${profile.sessionNameTemplate}`);
    console.log(`Description: ${profile.description}`);
    console.log(`Tags:        ${profile.defaultTags.join(", ") || "-"}`);
    console.log(`Inputs:      ${profile.inputs.map((item) => item.key).join(", ") || "-"}`);
    console.log(`State:       ${profile.state.map((item) => item.path).join(", ") || "-"}`);
    console.log(`Artifacts:   ${profile.artifacts.map((item) => item.kind).join(", ") || "-"}`);
    console.log(`Primary:     ${summarizePrimaryArtifacts(profile)}`);
    if (profile.artifacts.length > 0) {
      console.log("\nArtifact definitions:");
      for (const artifact of profile.artifacts) {
        const flags = [
          artifact.primary ? "primary" : null,
          (artifact.primaryWhenStatuses?.length ?? 0) > 0
            ? `primaryWhen=${artifact.primaryWhenStatuses?.join("|")}`
            : null,
          (artifact.showWhenStatuses?.length ?? 0) > 0 ? `showWhen=${artifact.showWhenStatuses?.join("|")}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        console.log(`  - ${artifact.kind} :: ${artifact.pathTemplate}${flags ? ` :: ${flags}` : ""}`);
      }
    }
    if (profile.state.length > 0) {
      console.log("\nState definitions:");
      for (const field of profile.state) {
        console.log(`  - ${field.path} <- ${field.valueTemplate}${field.transform ? ` :: ${field.transform}` : ""}`);
      }
    }
    console.log("\nTemplates:");
    console.log(`  create:              ${profile.templates.create.split("\n")[0]}`);
    console.log(`  dispatch:            ${profile.templates.dispatch.split("\n")[0]}`);
    console.log(`  resume:              ${profile.templates.resume.split("\n")[0]}`);
    console.log(`  dispatchSummary:     ${profile.templates.dispatchSummary}`);
    console.log(`  dispatchEventMessage ${profile.templates.dispatchEventMessage}`);
    console.log(`  reportDoneMessage:   ${profile.templates.reportDoneMessage}`);
    console.log(`  reportBlockedMessage: ${profile.templates.reportBlockedMessage}`);
    console.log(`  reportFailedMessage: ${profile.templates.reportFailedMessage}`);
    return profile;
  }

  @Command({ name: "preview", description: "Render a profile preview with the resolved template context" })
  preview(
    @Arg("profileId", { description: "Task profile id" }) profileId: string,
    @Option({ flags: "--title <text>", description: "Preview task title" }) title?: string,
    @Option({ flags: "--instructions <text>", description: "Preview task instructions" }) instructions?: string,
    @Option({ flags: "--input <key=value...>", description: "Profile input values" }) input?: string[] | string,
    @Option({ flags: "--agent <id>", description: "Agent id for session context" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Session name for preview" }) sessionName?: string,
    @Option({ flags: "--worktree-mode <mode>", description: "inherit|path" }) worktreeMode?: string,
    @Option({ flags: "--worktree-path <path>", description: "Contextual worktree path" }) worktreePath?: string,
    @Option({ flags: "--worktree-branch <name>", description: "Optional contextual worktree branch" })
    worktreeBranch?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const finalTitle = title?.trim();
    if (!finalTitle) {
      fail("--title is required");
    }

    if (agentId?.trim()) {
      try {
        requireTaskRuntimeAgent(agentId.trim());
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }

    const worktree = createTaskWorktreeConfig({
      mode: worktreeMode,
      path: worktreePath,
      branch: worktreeBranch,
    });
    const preview = previewTaskProfile(profileId, {
      title: finalTitle,
      ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
      ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
      ...(worktree ? { worktree } : {}),
      input: parseProfileInputs(input),
    });

    if (asJson) {
      console.log(JSON.stringify(preview, null, 2));
    } else {
      console.log(`\nProfile preview: ${preview.profile.id}@${preview.profile.version}`);
      console.log(`Source: ${preview.profile.sourceKind} :: ${preview.profile.source}`);
      if (preview.primaryArtifact) {
        console.log(`Primary artifact: ${preview.primaryArtifact.label} -> ${preview.primaryArtifact.path}`);
      }
      console.log("\nCreate output:\n");
      console.log(preview.rendered.create);
      console.log("\nDispatch prompt:\n");
      console.log(preview.rendered.dispatch);
      console.log("\nResume prompt:\n");
      console.log(preview.rendered.resume);
      console.log("\nDispatch summary:\n");
      console.log(preview.rendered.dispatchSummary);
      console.log("\nDispatch event message:\n");
      console.log(preview.rendered.dispatchEventMessage);
      console.log("\nDone report message:\n");
      console.log(preview.rendered.reportDoneMessage);
      console.log("\nBlocked report message:\n");
      console.log(preview.rendered.reportBlockedMessage);
      console.log("\nFailed report message:\n");
      console.log(preview.rendered.reportFailedMessage);
    }
    return preview;
  }

  @Command({ name: "validate", description: "Validate one profile or the whole resolved catalog" })
  validate(
    @Arg("profileId", { required: false, description: "Optional task profile id" }) profileId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const results = validateTaskProfiles(profileId?.trim() || undefined);
    const invalid = results.filter((item) => !item.valid);
    const payload = { valid: invalid.length === 0, results };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      for (const result of results) {
        if (result.valid) {
          console.log(`✓ ${result.id}@${result.version} (${result.sourceKind})`);
        } else {
          console.log(`✗ ${result.id}@${result.version} (${result.sourceKind})`);
          console.log(`  ${result.error}`);
        }
      }
    }

    if (invalid.length > 0 && !asJson) {
      fail(`Task profile validation failed for ${invalid.length} profile(s).`);
    }
    return payload;
  }

  @Command({ name: "init", description: "Create a profile scaffold in the workspace or user catalog" })
  init(
    @Arg("profileId", { description: "Task profile id" }) profileId: string,
    @Option({ flags: "--preset <preset>", description: "doc-first|brainstorm|runtime-only|content" }) preset?: string,
    @Option({ flags: "--source <kind>", description: "workspace|user", defaultValue: "workspace" }) sourceKind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const resolvedSourceKind = sourceKind?.trim();
    if (resolvedSourceKind && !["workspace", "user"].includes(resolvedSourceKind)) {
      fail("Invalid source. Use workspace|user.");
    }

    const result = initTaskProfileScaffold(profileId, requireProfileScaffoldPreset(preset), {
      sourceKind: (resolvedSourceKind as "workspace" | "user" | undefined) ?? "workspace",
    });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✓ Task profile scaffold created`);
      console.log(`  Source:   ${result.sourceKind}`);
      console.log(`  Dir:      ${result.profileDir}`);
      console.log(`  Manifest: ${result.manifestPath}`);
    }
    return result;
  }
}
