/**
 * Library agent definitions from the CLI: `ravi agents search|install|update|publish`
 * (`ravi agents show <ref>` lives with `agents show` in agents.ts).
 *
 * spec: skills/library ("Agents"), cli
 */

import "reflect-metadata";
import { nats } from "../../nats.js";
import {
  executeLibraryAgentInstall,
  executeLibraryAgentPublish,
  executeLibraryAgentUpdate,
  LIBRARY_AGENT_CANNOT_INSTALL,
  LIBRARY_AGENT_EDITED_LOCALLY,
  prepareLibraryAgentInstall,
  prepareLibraryAgentPublish,
  prepareLibraryAgentUpdate,
  searchLibraryAgents,
} from "../../library/agent-definitions.js";
import { parseLibraryRef } from "../../library/refs.js";
import { LIBRARY_AGENT_CANNOT_PUBLISH, LibraryCommandError } from "../../library/service.js";
import { CONTRACT_EXIT_USAGE, contractDryRun, contractFail } from "../agent-contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { failLibraryPolicy, runtimeLibraryCaller, withLibraryContract } from "../library-contract.js";
import {
  agentsInstallReturnSchema,
  agentsPublishReturnSchema,
  agentsSearchReturnSchema,
  agentsUpdateReturnSchema,
} from "./operational-return-schemas.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emitConfigChanged(): void {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

/** Agents do not install or update agents: a person adds authority to this machine. */
function refuseInAgentRuntime(op: string, asJson?: boolean): void {
  if (!runtimeLibraryCaller()) return;
  failLibraryPolicy(
    op,
    LIBRARY_AGENT_CANNOT_INSTALL,
    "Agents do not install or update Library agents: a person does it from the operator's terminal.",
    `Ask the operator to run: ravi ${op} ${op === "agents install" ? "<ref>" : "<id>"} --execute`,
    asJson,
  );
}

function requireAgentRef(op: string, value: string, asJson?: boolean) {
  const ref = parseLibraryRef(value ?? "");
  if (ref) return ref;
  const message = `Not a valid Library ref: ${String(value ?? "").slice(0, 120)}. Use org/<slug> or <project>/<slug> (a-z, 0-9 and -).`;
  contractFail(op, "LIBRARY_REF_INVALID", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: { suggestedAction: "Copy the ref from: ravi agents search <words> --json" },
  });
}

const AGENTS_SEARCH_HELP_AFTER = `
READ — searches the Console Library for agent definitions (instructions, an
optional HEARTBEAT.md and suggested provider, model, permission profile and
skills) that your organization and your Console project publish. Install one
as a new local agent with 'ravi agents install <ref>'.

EXAMPLES
  ravi agents search
  ravi agents search triage --json
  ravi agents search support --project clinica

ON ERROR
  library.status=skipped → run 'ravi login' first.
  library.status=stale   → the Console was unreachable; results come from the cache.

SEE ALSO
  ravi agents show <ref> · ravi agents install <ref>
`;

const AGENTS_INSTALL_HELP_AFTER = `
MUTATE (BRAKED WHEN IT ADDS AUTHORITY) — creates a new local agent from a
Library agent definition: writes AGENTS.md (and HEARTBEAT.md) into its cwd
(default ~/ravi/<id>), sets the provider and model the definition suggests and
records where it came from (<ref>@<version> and the hash of each file).

BRAKE
  Without --execute it prints the plan and exits 3 when the definition asks for
  a permission profile above the bootstrap floor (full-access) or for any skill
  grant. A definition with neither applies immediately.
  Grants are stored like 'ravi skills grant'. A required skill this machine
  cannot find is skipped and listed.

RULES
  • Refuses when the local id already exists (AGENT_ALREADY_EXISTS).
  • Agents do not install agents: inside an agent it refuses before any
    request (LIBRARY_AGENT_CANNOT_INSTALL, exit 3).
  • A definition never brings routes, instances, contacts or credentials:
    route the new agent yourself afterwards.

EXAMPLES
  ravi agents install org/triage                       # plan (exit 3 when braked)
  ravi agents install org/triage --execute
  ravi agents install clinica/recepcao --id recepcao --cwd ~/agents/recepcao --execute

ON ERROR
  exit 3 WRITE_REQUIRES_EXECUTE       → review the plan, then re-run with --execute.
  exit 3 LIBRARY_AGENT_CANNOT_INSTALL → ask the operator.
  AGENT_ALREADY_EXISTS                → pass --id <another-id>.
  AGENT_CWD_IN_USE                    → pass --cwd <empty-dir>.

SEE ALSO
  ravi agents update <id> · ravi agents show <ref> · ravi agents permissions <id>
`;

const AGENTS_UPDATE_HELP_AFTER = `
MUTATE (BRAKED WHEN IT ADDS AUTHORITY) — brings an agent installed from the
Library to the latest published version of its definition. Files you did not
touch are overwritten; a file you edited here that also changed in the Library
needs a choice: --keep-local keeps your file, --take-library replaces it (the
error shows the diff).

BRAKE
  A new permission profile above what the agent has, or new skill grants, need
  --execute (exit 3 with the plan otherwise). Only a profile the definition
  changed is applied: a profile you set here is not reverted.

RULES
  • Agents do not update agents (LIBRARY_AGENT_CANNOT_INSTALL, exit 3).

EXAMPLES
  ravi agents update triage
  ravi agents update triage --keep-local
  ravi agents update triage --take-library --execute

ON ERROR
  exit 2 LIBRARY_AGENT_EDITED_LOCALLY → read the diff, then pass --keep-local or --take-library.
  exit 3 WRITE_REQUIRES_EXECUTE       → review the plan, then re-run with --execute.
  LIBRARY_AGENT_NO_ORIGIN             → the agent was not installed from the Library.
`;

const AGENTS_PUBLISH_HELP_AFTER = `
MUTATE (BRAKED) — publishes a local agent as a Library agent definition for the
organization (--scope org) or one Console project, or proposes it for review
(--propose). The package is the agent's AGENTS.md, its HEARTBEAT.md when there
is one, and an agent.json with its provider, model and permission profile as
suggestions and the Library skills it is granted that the scope can see.

NEVER PUBLISHED
  Routes, instances, contacts, sessions, local paths, credentials, and skills
  that are not Library skills (they are listed under leftOut).

RULES
  • Without --execute: prints the plan and exits 3.
  • Agents do not publish or propose agents: inside an agent it refuses before
    any request (LIBRARY_AGENT_CANNOT_PUBLISH, exit 3).
  • The description is --description, else the agent's own description
    ('ravi agents set <id> description "<text>"').

EXAMPLES
  ravi agents publish triage --scope org                        # plan (exit 3)
  ravi agents publish triage --scope org --execute
  ravi agents publish recepcao --scope clinica --description "Front desk" --propose --execute

ON ERROR
  exit 3 WRITE_REQUIRES_EXECUTE        → review the plan, then re-run with --execute.
  exit 3 LIBRARY_AGENT_CANNOT_PUBLISH  → ask the operator.
  CONFLICT reason=stale_base           → someone published meanwhile; re-run without --execute.
  CONFLICT reason=slug_taken_in_*      → pass --slug <another>.
  ORG_ACCESS_DENIED                    → only a publisher of that scope publishes; use --propose.
`;

@Group({
  name: "agents",
  description: "Agent management",
})
export class AgentsLibraryCommands {
  @Command({
    name: "search",
    description: "Search the Console Library for agent definitions to install",
    helpAfter: AGENTS_SEARCH_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "agents", action: "search", risk: "low" })
  @Returns(agentsSearchReturnSchema)
  async search(
    @Arg("query", { description: "Words to search for", required: false }) query?: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--limit <n>", description: "Maximum results (default 20)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withLibraryContract("agents search", asJson, async () => {
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      const payload = await searchLibraryAgents({
        query: query?.trim() ?? "",
        project: project?.trim() || null,
        ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      });
      if (asJson) {
        printJson(payload);
      } else {
        if (payload.library.hint) console.log(payload.library.hint);
        if (payload.library.error)
          console.log(`Library: ${payload.library.error.code} ${payload.library.error.message}`);
        if (payload.items.length === 0) {
          console.log("No Library agents found.");
        } else {
          for (const item of payload.items) {
            console.log(`  ${item.ref.padEnd(32)} v${item.version}  ${item.description ?? item.name}`);
          }
          console.log("\nRead one with: ravi agents show <ref>");
        }
      }
      return payload;
    });
  }

  @Command({
    name: "install",
    description:
      "Create a local agent from a Library agent definition. Requires --execute when it raises the permission profile or grants skills.",
    helpAfter: AGENTS_INSTALL_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "install", risk: "high", requiresConfirmation: true })
  @Returns(agentsInstallReturnSchema)
  async install(
    @Arg("ref", { description: "Library agent ref: org/<slug> or <project>/<slug>" }) ref: string,
    @Option({ flags: "--id <id>", description: "Local agent id (default: the ref's slug)" }) id?: string,
    @Option({ flags: "--cwd <dir>", description: "Agent folder (default: ~/ravi/<id>)" }) cwd?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description:
        "Confirm a profile above the bootstrap floor or skill grants (without it, print the plan and exit 3)",
    })
    execute?: boolean,
  ) {
    refuseInAgentRuntime("agents install", asJson);
    const libraryRef = requireAgentRef("agents install", ref, asJson);
    return withLibraryContract("agents install", asJson, async () => {
      const prepared = await prepareLibraryAgentInstall({
        ref: libraryRef,
        ...(id?.trim() ? { id: id.trim() } : {}),
        ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
      });
      if (prepared.plan.requiresExecute && !execute) {
        contractDryRun("agents install", { ...prepared.plan }, { asJson });
      }
      const result = executeLibraryAgentInstall(prepared);
      emitConfigChanged();
      const payload = { success: true as const, ...result };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(
          `✓ Installed ${result.ref} v${result.version} as agent '${result.agent.id}' in ${result.agent.cwd}`,
        );
        if (result.profile) console.log(`  Permission profile: ${result.profile}`);
        for (const grant of result.granted) console.log(`  Granted: ${grant}`);
        for (const skipped of result.skipped) console.log(`  Skipped: ${skipped.ref} (${skipped.reason})`);
        console.log(`  Next: ${result.next.join(" · ")}`);
      }
      return payload;
    });
  }

  @Command({
    name: "update",
    description:
      "Update an agent installed from the Library to the latest version. Requires --execute when it raises the profile or grants skills.",
    helpAfter: AGENTS_UPDATE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "update", risk: "high", requiresConfirmation: true })
  @Returns(agentsUpdateReturnSchema)
  async update(
    @Arg("id", { description: "Local agent id" }) id: string,
    @Option({ flags: "--keep-local", description: "Keep files edited here that also changed in the Library" })
    keepLocal?: boolean,
    @Option({ flags: "--take-library", description: "Replace files edited here with the Library version" })
    takeLibrary?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Confirm a higher permission profile or new skill grants (without it, print the plan and exit 3)",
    })
    execute?: boolean,
  ) {
    refuseInAgentRuntime("agents update", asJson);
    return withLibraryContract("agents update", asJson, async () => {
      let prepared: Awaited<ReturnType<typeof prepareLibraryAgentUpdate>>;
      try {
        prepared = await prepareLibraryAgentUpdate({
          agentId: id,
          keepLocal: keepLocal === true,
          takeLibrary: takeLibrary === true,
        });
      } catch (error) {
        // The text form shows the diff before the error; JSON carries it in details.diff.
        if (!asJson && error instanceof LibraryCommandError && error.code === LIBRARY_AGENT_EDITED_LOCALLY) {
          const diff = error.details.diff;
          if (typeof diff === "string" && diff) console.log(diff);
        }
        throw error;
      }
      const { plan } = prepared;
      if (plan.requiresExecute && !execute) contractDryRun("agents update", { ...plan }, { asJson });
      const result = executeLibraryAgentUpdate(prepared);
      if (result.profile) emitConfigChanged();
      const payload = {
        success: true as const,
        ...result,
        upToDate: plan.upToDate,
        plan: { files: plan.files, profile: plan.profile, skills: plan.skills },
      };
      if (asJson) {
        printJson(payload);
      } else if (plan.upToDate) {
        console.log(`= ${result.agent} is up to date with ${result.ref} v${result.version}`);
      } else {
        console.log(`✓ Updated ${result.agent} from ${result.ref} v${result.previousVersion} to v${result.version}`);
        for (const file of result.written) console.log(`  Wrote: ${file}`);
        for (const file of result.kept) console.log(`  Kept local: ${file}`);
        if (result.profile) console.log(`  Permission profile: ${result.profile}`);
        for (const grant of result.granted) console.log(`  Granted: ${grant}`);
      }
      return payload;
    });
  }

  @Command({
    name: "publish",
    description:
      "Publish a local agent as a Library agent definition for the organization or one project (or --propose it). Requires --execute.",
    helpAfter: AGENTS_PUBLISH_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "publish", risk: "high", requiresConfirmation: true })
  @Returns(agentsPublishReturnSchema)
  async publish(
    @Arg("id", { description: "Local agent id" }) id: string,
    @Option({ flags: "--scope <scope>", description: "org, or the Console project slug the agent belongs to" })
    scope?: string,
    @Option({ flags: "--slug <slug>", description: "Library slug (default: the agent id)" }) slug?: string,
    @Option({ flags: "--description <text>", description: "What the agent does (default: its own description)" })
    description?: string,
    @Option({ flags: "--note <text>", description: "Version note, at most 500 characters" }) note?: string,
    @Option({ flags: "--propose", description: "Propose it for review instead of publishing" }) propose?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm the publish (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    if (runtimeLibraryCaller()) {
      failLibraryPolicy(
        "agents publish",
        LIBRARY_AGENT_CANNOT_PUBLISH,
        "Agents do not publish or propose Library agents: a person does it from the operator's terminal or the Console.",
        `Ask the operator to run: ravi agents publish ${id} --scope ${scope?.trim() || "org|<project-slug>"} --execute`,
        asJson,
      );
    }
    if (!scope?.trim()) {
      contractFail("agents publish", "USAGE_ERROR", "Pass --scope org or --scope <project-slug>.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          suggestedAction: "Choose who gets the agent: --scope org (every project) or --scope <project-slug>",
        },
      });
    }
    return withLibraryContract("agents publish", asJson, async () => {
      const prepared = await prepareLibraryAgentPublish({
        agentId: id,
        scope,
        ...(slug?.trim() ? { slug: slug.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(note !== undefined ? { note } : {}),
        propose: propose === true,
      });
      if (!execute) contractDryRun("agents publish", { ...prepared.plan }, { asJson });
      const result = await executeLibraryAgentPublish(prepared);
      const { plan } = prepared;
      const payload = result.proposal
        ? {
            success: true as const,
            ref: result.ref,
            agent: plan.agent,
            version: null,
            contentHash: plan.contentHash,
            unchanged: false,
            item: null,
            proposal: result.proposal,
            manifest: plan.manifest,
            leftOut: plan.leftOut,
            next: result.proposal.reviewUrl,
          }
        : {
            success: true as const,
            ref: result.ref,
            agent: plan.agent,
            version: result.version.number,
            contentHash: result.version.contentHash,
            unchanged: result.unchanged,
            item: result.item,
            proposal: null,
            manifest: plan.manifest,
            leftOut: plan.leftOut,
            next: `ravi agents install ${result.ref}`,
          };
      if (asJson) {
        printJson(payload);
      } else if (result.proposal) {
        console.log(`✓ Proposed ${result.ref} (proposal ${result.proposal.number}) for review`);
        if (result.proposal.reviewUrl) console.log(`  Review: ${result.proposal.reviewUrl}`);
      } else if (payload.unchanged) {
        console.log(`= ${result.ref} unchanged (version ${payload.version} already has this content)`);
      } else {
        console.log(`✓ Published ${result.ref} version ${payload.version}`);
        console.log(`  Others install it with: ravi agents install ${result.ref}`);
      }
      for (const left of plan.leftOut) console.log(`  Left out: ${left.skill} (${left.reason})`);
      return payload;
    });
  }
}
