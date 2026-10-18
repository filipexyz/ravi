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
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import {
  failLibraryPolicy,
  runtimeLibraryCaller,
  runtimeLibrarySession,
  withLibraryContract,
} from "../library-contract.js";
import {
  cancelLibraryRequest,
  executeLibraryAsk,
  LIBRARY_AGENT_CANNOT_LIST,
  LIBRARY_AGENT_CANNOT_OPEN_REQUESTS,
  listLibraryDirectory,
  listLibraryRequests,
  prepareLibraryAsk,
  readAcceptsRequests,
  readListed,
  requireLocalAgent,
  setAcceptsRequests,
  setListed,
} from "../../library/requests.js";
import {
  agentsAskReturnSchema,
  agentsDirectoryReturnSchema,
  agentsInstallReturnSchema,
  agentsListingReturnSchema,
  agentsPublishReturnSchema,
  agentsRequestsCancelReturnSchema,
  agentsRequestsListReturnSchema,
  agentsRequestsToggleReturnSchema,
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

const AGENTS_DIRECTORY_HELP_AFTER = `
READ — lists the agents that the organization's linked Ravi machines report
(name, description, provider, model, project, online, and whether they take
requests). A machine reports only the agents its operator listed
('ravi agents listing <agent> on --execute'). Only org-wide agents and those
of projects you can read appear. Never instructions, paths or credentials.

EXAMPLES
  ravi agents directory
  ravi agents directory finance --json
  ravi agents directory --project clinica

SEE ALSO
  ravi agents ask <machine>/<agent> "<message>" --execute
`;

const AGENTS_ASK_HELP_AFTER = `
MUTATE (BRAKED) — sends a message to an agent on another machine of the
organization. That machine runs one turn of its agent as you (not as its
operator) and sends the answer back. Inside an agent, the answer arrives in the
asking session as a [System] Inform; from the terminal, read it with
'ravi agents requests list --all'.

RULES
  • <machine> is the installation name from 'ravi agents directory', or its id
    when two machines share a name (LIBRARY_TARGET_AMBIGUOUS, exit 2).
  • The asked agent must be open to requests (its operator ran
    'ravi agents requests <agent> on --execute').
  • Inside an agent, only the operator's own turns may ask
    (LIBRARY_REQUEST_EXTERNAL_DENIED, exit 3).
  • Requests expire after 24 hours; a machine has at most 20 open.

EXAMPLES
  ravi agents ask macbook-ana/finance "What was the October close date?"            # plan (exit 3)
  ravi agents ask macbook-ana/finance "What was the October close date?" --execute

ON ERROR
  exit 3 WRITE_REQUIRES_EXECUTE       → review the plan, then re-run with --execute.
  CONFLICT reason=not_accepting       → the agent is not open to requests.
  CONFLICT reason=same_installation   → it runs here: use ravi sessions send.
  CONFLICT reason=too_many_open       → wait, or cancel one (ravi agents requests cancel <id>).
  CONFLICT reason=no_installation     → run ravi login on this daemon.
  NOT_FOUND                           → check the target with ravi agents directory.
`;

const AGENTS_REQUESTS_HELP_AFTER = `
Shows or changes whether an agent of this machine answers requests from agents
on other machines of the organization (default: off). An open agent answers
each request in a session of its own, as the person who asked, without the
operator's authority.

RULES
  • on adds exposure: braked (exit 3 without --execute). It also lists the
    agent in the directory, so other machines can find it.
  • off only takes it away: applies at once (the agent stays listed).
  • Agents do not open or close themselves (LIBRARY_AGENT_CANNOT_OPEN_REQUESTS, exit 3).
  • The directory learns of it right away when 'ravi login' is linked,
    otherwise at the daemon's next pin sync.

EXAMPLES
  ravi agents requests finance                 # current state
  ravi agents requests finance on              # plan (exit 3)
  ravi agents requests finance on --execute
  ravi agents requests finance off
  ravi agents requests list --received --all
`;

const AGENTS_LISTING_HELP_AFTER = `
Shows or changes whether an agent of this machine appears in the
organization's directory ("Running agents" in the Console). Default: off.
This machine reports only listed agents (id, name, provider, model, Console
project, description), and the Console drops the ones it stops reporting.
Never instructions, paths or credentials.

RULES
  • on adds exposure: braked (exit 3 without --execute).
  • off only takes it away: applies at once, and also closes the agent to
    requests ('ravi agents requests <agent> off').
  • Pinning a Library skill to an agent from the Console needs it listed.
  • Agents do not list or unlist themselves (LIBRARY_AGENT_CANNOT_LIST, exit 3).
  • The directory learns of it right away when 'ravi login' is linked,
    otherwise at the daemon's next pin sync.

EXAMPLES
  ravi agents listing finance                  # current state
  ravi agents listing finance on               # plan (exit 3)
  ravi agents listing finance on --execute
  ravi agents listing finance off
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
  @Command({
    name: "directory",
    description: "List agents on the organization's other Ravi machines that you can ask",
    helpAfter: AGENTS_DIRECTORY_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "agents", action: "directory", risk: "low" })
  @Returns(agentsDirectoryReturnSchema)
  async directory(
    @Arg("query", { description: "Words to search for", required: false }) query?: string,
    @Option({ flags: "--project <project>", description: "Only org-wide agents and this project's" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withLibraryContract("agents directory", asJson, async () => {
      const payload = await listLibraryDirectory({
        ...(query?.trim() ? { query: query.trim() } : {}),
        project: project?.trim() || null,
      });
      if (asJson) {
        printJson(payload);
      } else if (payload.agents.length === 0) {
        console.log("No agents in the directory.");
      } else {
        for (const entry of payload.agents) {
          const marks = [
            entry.self ? "this machine" : "",
            entry.online ? "online" : "offline",
            entry.acceptsRequests ? "takes requests" : "",
          ]
            .filter(Boolean)
            .join(", ");
          console.log(
            `  ${entry.target.padEnd(36)} ${marks}${entry.agent.description ? `  ${entry.agent.description}` : ""}`,
          );
        }
        if (payload.can.ask) console.log('\nAsk one with: ravi agents ask <machine>/<agent> "<message>" --execute');
      }
      return payload;
    });
  }

  @Command({
    name: "ask",
    description: "Ask an agent on another Ravi machine of the organization. Requires --execute.",
    helpAfter: AGENTS_ASK_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "ask", risk: "medium", requiresConfirmation: true })
  @Returns(agentsAskReturnSchema)
  async ask(
    @Arg("target", { description: "<machine>/<agent>, as 'ravi agents directory' lists it" }) target: string,
    @Arg("message", { description: "The message (at most 8000 characters)" }) message: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the request (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    return withLibraryContract("agents ask", asJson, async () => {
      const caller = runtimeLibraryCaller();
      const session = caller ? runtimeLibrarySession() : null;
      const prepared = await prepareLibraryAsk({
        target,
        message: message ?? "",
        caller: caller
          ? { agentId: caller.agentId, sessionKey: session?.key ?? null, sessionName: session?.name ?? null }
          : null,
      });
      if (!execute) contractDryRun("agents ask", { ...prepared.plan }, { asJson });
      const result = await executeLibraryAsk(prepared);
      const payload = {
        success: true as const,
        target: result.target,
        request: result.request,
        session: prepared.caller?.sessionName ?? null,
        next: result.next,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Asked ${result.target} (request ${result.request.id})`);
        console.log(
          payload.session
            ? `  The answer arrives in this session as a [System] Inform.`
            : "  Read the answer with: ravi agents requests list --all",
        );
      }
      return payload;
    });
  }

  @Command({
    name: "requests",
    description: "Show or set whether an agent answers requests from other machines (on requires --execute)",
    helpAfter: AGENTS_REQUESTS_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "requests", risk: "medium", requiresConfirmation: true })
  @Returns(agentsRequestsToggleReturnSchema)
  async requests(
    @Arg("id", { description: "Local agent id" }) id: string,
    @Arg("state", { description: "on or off (omit to show)", required: false }) state?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm opening the agent (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const wanted = state?.trim().toLowerCase();
    if (wanted !== undefined && wanted !== "" && wanted !== "on" && wanted !== "off") {
      contractFail("agents requests", "USAGE_ERROR", "The state is on or off.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: `ravi agents requests ${id} on --execute, or ravi agents requests ${id} off` },
      });
    }
    if (wanted && runtimeLibraryCaller()) {
      failLibraryPolicy(
        "agents requests",
        LIBRARY_AGENT_CANNOT_OPEN_REQUESTS,
        "Agents do not open or close agents to requests: the operator decides what other machines may ask.",
        `Ask the operator to run: ravi agents requests ${id} ${wanted}${wanted === "on" ? " --execute" : ""}`,
        asJson,
      );
    }
    return withLibraryContract("agents requests", asJson, async () => {
      requireLocalAgent(id);
      const current = readAcceptsRequests(id);
      if (!wanted) {
        const payload = {
          agent: id,
          listed: readListed(id),
          acceptsRequests: current,
          changed: false,
          reported: false,
        };
        if (asJson) printJson(payload);
        else
          console.log(
            `${id}: ${current ? "answers requests from other machines" : "closed to requests from other machines"}`,
          );
        return payload;
      }
      const accepts = wanted === "on";
      if (accepts && !current && !execute) {
        contractDryRun(
          "agents requests",
          {
            agent: id,
            listed: true,
            acceptsRequests: true,
            effect: `${id} is listed in the organization's directory, and its members may ask it from other machines; it answers as them, without operator authority`,
          },
          { asJson },
        );
      }
      const payload = await setAcceptsRequests({ agentId: id, accepts });
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ ${id} ${accepts ? "answers" : "no longer answers"} requests from other machines`);
        if (payload.hint) console.log(`  ${payload.hint}`);
      }
      return payload;
    });
  }

  @Command({
    name: "listing",
    description: "Show or set whether an agent appears in the organization's directory (on requires --execute)",
    helpAfter: AGENTS_LISTING_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "listing", risk: "medium", requiresConfirmation: true })
  @Returns(agentsListingReturnSchema)
  async listing(
    @Arg("id", { description: "Local agent id" }) id: string,
    @Arg("state", { description: "on or off (omit to show)", required: false }) state?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm listing the agent (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const wanted = state?.trim().toLowerCase();
    if (wanted !== undefined && wanted !== "" && wanted !== "on" && wanted !== "off") {
      contractFail("agents listing", "USAGE_ERROR", "The state is on or off.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: `ravi agents listing ${id} on --execute, or ravi agents listing ${id} off` },
      });
    }
    if (wanted && runtimeLibraryCaller()) {
      failLibraryPolicy(
        "agents listing",
        LIBRARY_AGENT_CANNOT_LIST,
        "Agents do not list or unlist agents: the operator decides what the organization's directory shows.",
        `Ask the operator to run: ravi agents listing ${id} ${wanted}${wanted === "on" ? " --execute" : ""}`,
        asJson,
      );
    }
    return withLibraryContract("agents listing", asJson, async () => {
      requireLocalAgent(id);
      const current = readListed(id);
      if (!wanted) {
        const payload = {
          agent: id,
          listed: current,
          acceptsRequests: readAcceptsRequests(id),
          changed: false,
          reported: false,
        };
        if (asJson) printJson(payload);
        else
          console.log(
            `${id}: ${current ? "listed in the organization's directory" : "not listed in the organization's directory"}`,
          );
        return payload;
      }
      const listed = wanted === "on";
      if (listed && !current && !execute) {
        contractDryRun(
          "agents listing",
          {
            agent: id,
            listed: true,
            effect: `members of the organization see ${id} in the directory (id, name, provider, model, Console project, description); it stays closed to requests`,
          },
          { asJson },
        );
      }
      const payload = await setListed({ agentId: id, listed });
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ ${id} ${listed ? "is listed in" : "is no longer listed in"} the organization's directory`);
        if (payload.hint) console.log(`  ${payload.hint}`);
      }
      return payload;
    });
  }
}

@Group({
  name: "agents.requests",
  description: "Requests between agents on the organization's Ravi machines",
})
export class AgentsRequestsCommands {
  @Command({ name: "list", description: "List this machine's requests (sent by default)" })
  @CommandAccess({ kind: "read", resource: "agents", action: "requests-list", risk: "low" })
  @Returns(agentsRequestsListReturnSchema)
  async list(
    @Option({ flags: "--received", description: "Requests to this machine's agents" }) received?: boolean,
    @Option({ flags: "--all", description: "Include answered, failed, expired and cancelled ones" }) all?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of requests to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withLibraryContract("agents requests list", asJson, async () => {
      const listed = await listLibraryRequests({ received: received === true, all: all === true });
      const page = paginateCliItems(listed.requests, { limit, offset });
      const localPage = listed.local ? paginateCliItems(listed.local, { limit, offset }) : null;
      const total = localPage ? localPage.total : page.total;
      const returned = localPage ? localPage.items.length : page.items.length;
      const payload = {
        ...listed,
        total,
        requests: page.items,
        ...(localPage ? { local: localPage.items } : {}),
        pagination: buildCliOffsetPagination({
          baseCommand: ["ravi", "agents", "requests", "list"],
          limit: page.limit,
          offset: page.offset,
          returned,
          total,
          options: [received ? "--received" : null, all ? "--all" : null],
        }),
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      if (payload.hint) console.log(payload.hint);
      if (payload.stale) {
        for (const row of payload.local ?? []) {
          console.log(
            `  ${row.requestId}  ${row.status.padEnd(9)} ${row.peer ?? "-"}${row.reply ? `\n    ${row.reply}` : ""}`,
          );
        }
        return payload;
      }
      if (payload.requests.length === 0)
        console.log(`No ${payload.state === "open" ? "open " : ""}${payload.box} requests.`);
      for (const request of payload.requests) {
        const other =
          payload.box === "sent"
            ? `to ${request.to.installation.name || request.to.installation.id}/${request.to.agentId}`
            : `from ${request.from.user?.name ?? "?"} on ${request.from.installation?.name ?? "?"}${request.from.agentId ? ` via ${request.from.agentId}` : ""} to ${request.to.agentId}`;
        console.log(`  ${request.id}  ${request.status.padEnd(9)} ${other}`);
        console.log(`    > ${request.message.replace(/\s+/g, " ").slice(0, 160)}`);
        if (request.reply) console.log(`    < ${request.reply}`);
        if (request.failureReason) console.log(`    ! ${request.failureReason}`);
      }
      return payload;
    });
  }

  @Command({ name: "cancel", description: "Cancel a request the asked agent has not taken yet" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "requests-cancel", risk: "low" })
  @Returns(agentsRequestsCancelReturnSchema)
  async cancel(
    @Arg("id", { description: "Request id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withLibraryContract("agents requests cancel", asJson, async () => {
      const request = await cancelLibraryRequest({ id });
      const payload = { success: true as const, request };
      if (asJson) printJson(payload);
      else console.log(`✓ Cancelled request ${request.id}`);
      return payload;
    });
  }
}
