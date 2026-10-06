/**
 * Runtime model catalog commands
 *
 * Read-only view of the valid models per registered runtime provider, with
 * the context window when it is known locally.
 */

import "reflect-metadata";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { CONTRACT_EXIT_USAGE, contractFail, suggestSimilar } from "../agent-contract.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { listRuntimeModelCatalog } from "../../runtime/model-catalog.js";
import { listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import { runtimeModelCatalogListReturnSchema } from "./operational-return-schemas.js";

@Group({
  name: "runtime.models",
  description: "Runtime model catalog (valid models per provider)",
  scope: "open",
})
export class RuntimeModelCatalogCommands {
  @Command({
    name: "list",
    description: "List valid models per runtime provider",
    helpAfter: [
      "",
      "contextWindow comes from the provider-reported window or the locally cached pricing catalog;",
      "null means unknown. Providers with freeText=true accept any model selector.",
      "",
      "Examples:",
      "  ravi runtime models list",
      "  ravi runtime models list --provider codex --json",
      "  ravi runtime models list --limit 2 --offset 2 --json",
    ].join("\n"),
  })
  @CommandAccess({ kind: "read", resource: "runtime.models", action: "list", risk: "low" })
  @Returns(runtimeModelCatalogListReturnSchema)
  list(
    @Option({ flags: "--provider <id>", description: "Only this runtime provider" }) provider?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
    @Option({ flags: "--limit <n>", description: "Providers per page (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of providers to skip (default: 0)" }) offset?: string,
  ) {
    const registered = listRegisteredRuntimeProviderIds();
    const filter = provider?.trim();
    if (filter && !registered.includes(filter)) {
      contractFail("runtime models list", "PROVIDER_NOT_FOUND", `Runtime provider not registered: ${filter}`, {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          suggestedAction: "Use one of the registered providers (see suggestions)",
          suggestions: suggestSimilar(filter, registered),
        },
      });
    }

    const page = paginateCliItems(filter ? [filter] : registered, { limit, offset });
    const providers = listRuntimeModelCatalog(page.items);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "runtime", "models", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: providers.length,
      total: page.total,
      options: ["--provider", filter],
    });
    const payload = { total: page.total, pagination, providers };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }

    for (const entry of providers) {
      console.log(`\n${entry.name} (${entry.id})${entry.freeText ? "  free-form model selector" : ""}`);
      if (entry.models.length === 0) {
        console.log("  (no fixed model list)");
        continue;
      }
      for (const model of entry.models) {
        const window = model.contextWindow !== null ? `  ${model.contextWindow.toLocaleString("en-US")} tokens` : "";
        const marker = model.id === entry.defaultModel ? " (default)" : "";
        console.log(`  ${model.id}${marker}${window}`);
      }
    }
    if (pagination.nextCommand) {
      console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    }
    return payload;
  }
}
