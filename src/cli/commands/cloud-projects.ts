import "reflect-metadata";
import { Arg, CliOnly, Command, Group, Option } from "../decorators.js";
import { cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  createCloudProject,
  listCloudProjects,
  normalizeCloudProjectVisibility,
  type CloudProjectCreateResult,
  type CloudProjectListResult,
  type CloudProjectPayload,
  type CloudProjectsClientDeps,
} from "../../cloud-projects/client.js";

export interface CloudProjectsCommandDeps extends CloudProjectsClientDeps {
  client?: ConsoleApiClient;
}

@Group({
  name: "cloud.projects",
  description: "Manage Ravi Cloud projects through Console",
  scope: "open",
})
export class CloudProjectsCommands {
  constructor(private readonly deps: CloudProjectsCommandDeps = defaultCloudProjectsDeps()) {}

  @Command({ name: "list", description: "List Ravi Cloud projects from Console" })
  @CliOnly()
  async list(
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCloudProjectsCommand(asJson, async () => {
      const result = await listCloudProjects({ console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printProjectList(result));
      return result;
    });
  }

  @Command({ name: "create", description: "Create a Ravi Cloud project in Console" })
  @CliOnly()
  async create(
    @Arg("slug", { description: "Console project slug" }) slug: string,
    @Option({ flags: "--name <name>", description: "Project display name; defaults to the slug" }) name?: string,
    @Option({ flags: "--description <text>", description: "Project description" }) description?: string,
    @Option({ flags: "--visibility <visibility>", description: "Default visibility: private|protected_link|public" })
    visibility?: string,
    @Option({
      flags: "--default-page-site [slug]",
      description: "Also create a default Ravi Pages site; uses the project slug when omitted",
    })
    defaultPageSite?: boolean | string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCloudProjectsCommand(asJson, async () => {
      const result = await createCloudProject(
        {
          slug,
          name,
          description,
          defaultVisibility: normalizeCloudProjectVisibility(visibility),
          defaultPageSite,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printCreatedProject(result));
      return result;
    });
  }
}

function defaultCloudProjectsDeps(): CloudProjectsCommandDeps {
  return {};
}

async function runCloudProjectsCommand<T>(asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      printJson(formatCloudAuthError(cloudError));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    process.exit(cloudError.exitCode);
  }
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printProjectList(result: CloudProjectListResult): void {
  if (result.projects.length === 0) {
    console.log("No Ravi Cloud projects found.");
    return;
  }

  console.log(`Ravi Cloud projects (${result.total})`);
  for (const project of result.projects) {
    console.log(`  - ${projectLabel(project)}`);
  }
}

function printCreatedProject(result: CloudProjectCreateResult): void {
  console.log("✓ Ravi Cloud project created");
  printProjectFields(result.project);
  if (result.redirectTo) console.log(`  Console:    ${result.consoleUrl}${result.redirectTo}`);
}

function projectLabel(project: CloudProjectPayload): string {
  const slug = stringValue(project.slug) ?? stringValue(project.id) ?? "project";
  const name = stringValue(project.name);
  const visibility = stringValue(project.defaultVisibility);
  const artifacts = numberValue(project.artifactCount);
  return [
    slug,
    name && name !== slug ? name : null,
    visibility ? `visibility=${visibility}` : null,
    artifacts !== null ? `artifacts=${artifacts}` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

function printProjectFields(project: CloudProjectPayload): void {
  const fields = [
    ["Project", stringValue(project.id)],
    ["Slug", stringValue(project.slug)],
    ["Name", stringValue(project.name)],
    ["Visibility", stringValue(project.defaultVisibility)],
  ] as const;

  for (const [label, value] of fields) {
    if (value) console.log(`  ${label.padEnd(10)} ${value}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
