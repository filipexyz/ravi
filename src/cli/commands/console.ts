import "reflect-metadata";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CliOnly, Command, CommandAccess, Group, Option } from "../decorators.js";
import { contractFail } from "../agent-contract.js";
import { connectInstallation, runFleetConnection } from "../../fleet/client.js";
import { fleetDirectory, readFleetIdentity } from "../../fleet/identity.js";
import { executeFleetOperation } from "../../fleet/executor.js";

@Group({ name: "console", description: "Associate this Ravi installation with its Console", scope: "resource" })
export class ConsoleCommands {
  @Command({ name: "connect", description: "Open browser confirmation and associate this installation" })
  @CommandAccess({ kind: "mutate", resource: "fleet", action: "connect", risk: "high", localOperator: true })
  @CliOnly()
  async connect(
    @Option({ flags: "--url <origin>", description: "Trusted HTTPS Console origin" }) url?: string,
    @Option({ flags: "--name <name>", description: "Installation name" }) name?: string,
    @Option({ flags: "--no-open", description: "Print the association link for a headless machine" }) noOpen?: boolean,
    @Option({ flags: "--json", description: "Return association metadata as JSON; browser instructions go to stderr" })
    asJson?: boolean,
  ) {
    if (!url)
      contractFail("console connect", "USAGE_ERROR", "Specify --url with your trusted Console HTTPS origin", {
        asJson,
      });
    const result = await connectInstallation({
      consoleUrl: url,
      name,
      onLink: async (link, fingerprint) => {
        const instructions = `Confirme esta instalação no Console:\n${link}\nIdentidade: ${fingerprint}`;
        if (asJson) console.error(instructions);
        else console.log(instructions);
        if (!noOpen && process.platform !== "win32") {
          const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [link], {
            stdio: "ignore",
            detached: true,
          });
          child.on("error", () => {});
          child.unref();
        }
      },
    });
    if (asJson) console.log(JSON.stringify({ associated: true, ...result }));
    else
      console.log(
        `Instalação associada: ${result.installationId}. O daemon estabelece a conexão automaticamente. Sem daemon, use ravi console run.`,
      );
    return { associated: true, ...result };
  }

  @Command({ name: "run", description: "Run the outbound management connection in the foreground" })
  @CommandAccess({ kind: "mutate", resource: "fleet", action: "run", risk: "high", localOperator: true })
  @CliOnly()
  async run(
    @Option({ flags: "--json", description: "Stream connection state changes as newline-delimited JSON" })
    asJson?: boolean,
  ) {
    if (!(await readFleetIdentity()))
      contractFail("console run", "NOT_ASSOCIATED", "Run ravi console connect first", { asJson });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runFleetConnection({
        signal: controller.signal,
        execute: executeFleetOperation,
        onState: (state) => console.log(asJson ? JSON.stringify({ state }) : `Console: ${state}`),
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }

  @Command({ name: "status", description: "Show safe local association metadata" })
  @CommandAccess({ kind: "read", resource: "fleet", action: "status", risk: "low", localOperator: true })
  @CliOnly()
  async status(
    @Option({ flags: "--json", description: "Return safe association metadata as JSON" }) _asJson?: boolean,
  ) {
    const identity = await readFleetIdentity();
    console.log(
      JSON.stringify(
        identity
          ? {
              associated: true,
              installationId: identity.installationId,
              consoleUrl: identity.consoleUrl,
              certificateExpiresAt: identity.expiresAt,
            }
          : { associated: false },
        null,
        2,
      ),
    );
  }

  @Command({ name: "disconnect", description: "Remove this installation's local Console credentials" })
  @CommandAccess({ kind: "mutate", resource: "fleet", action: "disconnect", risk: "low", localOperator: true })
  @CliOnly()
  async disconnect(
    @Option({ flags: "--json", description: "Return the disconnection result as JSON" }) asJson?: boolean,
  ) {
    for (const file of ["identity.json", "association.json", "rotation.json"])
      await rm(join(fleetDirectory(), file), { force: true });
    if (asJson) console.log(JSON.stringify({ associated: false }));
    else
      console.log(
        "Credenciais locais removidas. Para revogar uma cópia em outra máquina, use Gerenciar instalações no Console.",
      );
    return { associated: false };
  }
}
