/**
 * `ravi cloud catalog list|install` and `ravi cloud catalog packs install`:
 * the curated catalog of cloud agents (and agency packs) Ravi lists. Installing
 * copies the agent and its skills into the organization's Library, deploys it
 * in a project and leaves it awaiting an owner's or admin's approval of its
 * capability manifest, unless an owner or admin installed it.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import {
  installCloudCatalogEntry,
  installCloudCatalogPack,
  listCloudCatalog,
} from "../../cloud-agents/client-product.js";
import type { CloudAgent, CloudCatalogEntry, CloudCatalogPack, CloudManifest } from "../../cloud-agents/types.js";
import { contractDryRun, contractFail, suggestSimilar } from "../agent-contract.js";
import {
  cloudPaginationReturnSchema,
  pageCloudList,
  requireCloudProject,
  withCloudAgentsContract,
} from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudCatalogEntryReturnSchema,
  cloudCatalogPackReturnSchema,
  cloudProductAgentReturnSchema,
  printJson,
  productSession,
  requireArg,
} from "../cloud-product-contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const INSTALL_HELP_AFTER = `
MUTATE (BRAKED) — copies a catalog agent (or every agent of a pack) and its
skills into the organization's Library with its provenance, and deploys it in
a project. Unless you are an owner or admin, it waits in awaiting_approval
until one approves its capability manifest (ravi cloud agents approve <agent> --execute).

EXAMPLES
  ravi cloud catalog list
  ravi cloud catalog install clinic-triage --project clinica --execute
  ravi cloud catalog packs install clinic --project clinica --execute
`;

const installPayloadSchema = z
  .object({
    success: z.literal(true),
    project: z.string(),
    installed: z.object({ kind: z.enum(["entry", "pack"]), id: z.string(), name: z.string() }).strict(),
    agents: z.array(cloudProductAgentReturnSchema),
  })
  .strict();

function findByRef<T extends { id: string; slug: string; name: string }>(items: readonly T[], ref: string): T | null {
  const key = ref.trim().toLowerCase();
  return (
    items.find((item) => item.id === ref.trim()) ??
    items.find((item) => item.slug.toLowerCase() === key) ??
    items.find((item) => item.name.toLowerCase() === key) ??
    null
  );
}

function manifestSummary(manifest: CloudManifest | null) {
  if (!manifest) return null;
  const { writes, networking, allowedHosts, mcpServers, raviOps, secrets, memory, office } = manifest;
  return { writes, networking, allowedHosts, mcpServers, raviOps, secrets, memory, office };
}

function printInstalled(agents: readonly CloudAgent[]): void {
  for (const agent of agents) {
    console.log(`✓ ${agent.name} (${agent.id}): ${agent.status}`);
    if (agent.status === "awaiting_approval") {
      console.log(`  An owner or admin approves it with: ravi cloud agents approve ${agent.id} --execute`);
    }
  }
}

@Group({
  name: "cloud.catalog",
  description: "The curated catalog of cloud agents Ravi lists",
  scope: "open",
})
export class CloudCatalogCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({ name: "list", description: "List the catalog's agents and packs" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "catalog.list", risk: "low" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        entries: z.array(cloudCatalogEntryReturnSchema),
        packs: z.array(cloudCatalogPackReturnSchema),
        /** Pages the agents; packs are listed whole. */
        pagination: cloudPaginationReturnSchema,
      })
      .strict(),
  )
  async list(
    @Option({ flags: "--sector <sector>", description: "Only this sector" }) sector?: string,
    @Option({ flags: "--limit <n>", description: "Page size (1-200, default 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Skip this many (default 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withCloudAgentsContract("cloud catalog list", asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const catalog = await listCloudCatalog(session.client);
      const wanted = sector?.trim().toLowerCase();
      const bySector = <T extends { sector: string | null }>(items: T[]) =>
        wanted ? items.filter((item) => item.sector?.toLowerCase() === wanted) : items;
      const page = pageCloudList(
        "cloud catalog list",
        bySector(catalog.entries),
        { limit, offset, command: `ravi cloud catalog list${wanted ? ` --sector ${wanted}` : ""}` },
        asJson,
      );
      const payload = {
        success: true as const,
        entries: page.items,
        packs: bySector(catalog.packs),
        pagination: page.pagination,
      };
      if (asJson) {
        printJson(payload);
      } else if (payload.entries.length === 0 && payload.packs.length === 0) {
        console.log("The catalog has no agents yet.");
      } else {
        for (const entry of payload.entries) {
          console.log(
            `  ${entry.slug.padEnd(24)} ${(entry.sector ?? "-").padEnd(12)} ${entry.name} — ${entry.summary}${entry.installed ? "  (installed)" : ""}  by ${entry.publisher.name ?? entry.publisher.id}`,
          );
        }
        for (const pack of payload.packs) {
          console.log(
            `  pack ${pack.slug.padEnd(19)} ${(pack.sector ?? "-").padEnd(12)} ${pack.name} — ${pack.entries.map((entry) => entry.slug).join(", ")}`,
          );
        }
      }
      return payload;
    });
  }

  @Command({
    name: "install",
    description: "Install a catalog agent in a project. Requires --execute.",
    helpAfter: INSTALL_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "catalog.install",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(installPayloadSchema)
  async install(
    @Arg("entry", { description: "Catalog entry slug or id" }) entryRef: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Install (without it, print the plan and exit 3)" }) execute?: boolean,
  ) {
    const op = "cloud catalog install";
    const ref = requireArg(op, "<entry>", entryRef, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const { entries } = await listCloudCatalog(session.client);
        const entry = requireCatalogItem<CloudCatalogEntry>(op, entries, ref, "entry", asJson);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              entry: { id: entry.id, slug: entry.slug, name: entry.name },
              publisher: entry.publisher,
              project: projectRef,
              alreadyInstalled: entry.installed,
              manifest: manifestSummary(entry.manifest),
              effect:
                "copies the agent into the organization's Library and deploys it; it waits for an owner's or admin's approval unless you are one",
            },
            { asJson },
          );
        }
        const result = await installCloudCatalogEntry(session.client, entry.id, projectRef);
        const payload = {
          success: true as const,
          project: projectRef,
          installed: { kind: "entry" as const, id: entry.id, name: entry.name },
          agents: result.agents,
        };
        if (asJson) printJson(payload);
        else printInstalled(result.agents);
        return payload;
      },
      { notFoundCode: "CLOUD_CATALOG_NOT_FOUND" },
    );
  }
}

@Group({
  name: "cloud.catalog.packs",
  description: "Agency packs of catalog agents",
  scope: "open",
})
export class CloudCatalogPacksCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({
    name: "install",
    description: "Install every agent of a catalog pack in a project. Requires --execute.",
    helpAfter: INSTALL_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "catalog.packs.install",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(installPayloadSchema)
  async install(
    @Arg("pack", { description: "Pack slug or id" }) packRef: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Install (without it, print the plan and exit 3)" }) execute?: boolean,
  ) {
    const op = "cloud catalog packs install";
    const ref = requireArg(op, "<pack>", packRef, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const { packs } = await listCloudCatalog(session.client);
        const pack = requireCatalogItem<CloudCatalogPack>(op, packs, ref, "pack", asJson);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              pack: { id: pack.id, slug: pack.slug, name: pack.name },
              publisher: pack.publisher,
              project: projectRef,
              agents: pack.entries.map((entry) => entry.slug),
              effect:
                "copies every agent of the pack into the organization's Library and deploys them; each waits for an owner's or admin's approval unless you are one",
            },
            { asJson },
          );
        }
        const result = await installCloudCatalogPack(session.client, pack.id, projectRef);
        const payload = {
          success: true as const,
          project: projectRef,
          installed: { kind: "pack" as const, id: pack.id, name: pack.name },
          agents: result.agents,
        };
        if (asJson) printJson(payload);
        else printInstalled(result.agents);
        return payload;
      },
      { notFoundCode: "CLOUD_CATALOG_NOT_FOUND" },
    );
  }
}

function requireCatalogItem<T extends { id: string; slug: string; name: string }>(
  op: string,
  items: readonly T[],
  ref: string,
  what: "entry" | "pack",
  asJson?: boolean,
): T {
  const found = findByRef(items, ref);
  if (found) return found;
  contractFail(op, "CLOUD_CATALOG_NOT_FOUND", `No catalog ${what} '${ref.slice(0, 80)}'.`, {
    asJson,
    details: {
      suggestedAction: "List the catalog with: ravi cloud catalog list",
      suggestions: suggestSimilar(
        ref,
        items.map((item) => item.slug),
      ),
    },
  });
}
