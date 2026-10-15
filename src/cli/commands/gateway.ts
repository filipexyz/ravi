/**
 * Gateway Commands - expose this host's sandbox listener through a locally
 * managed Cloudflare tunnel. 05a ships only the PM2 entry point
 * (`tunnel-run`); `expose`, `status` and `unexpose` arrive in 05b.
 */

import "reflect-metadata";
import { spawn } from "node:child_process";
import { runTunnel, type TunnelSpawn } from "../../gateway-expose/tunnel-runner.js";
import { CliOnly, Command, CommandAccess, Group } from "../decorators.js";

@Group({
  name: "gateway",
  description: "Expose this host's sandbox listener to connected sandbox runs through a Cloudflare tunnel",
  scope: "admin",
})
export class GatewayCommands {
  @Command({
    name: "tunnel-run",
    description: "Run cloudflared and its drift poller in the foreground (used by PM2 ravi-gateway)",
    hidden: true,
  })
  @CommandAccess({ kind: "mutate", resource: "gateway", action: "tunnel-run", risk: "high" })
  @CliOnly()
  async tunnelRun() {
    const result = await runTunnel({ spawn: spawn as unknown as TunnelSpawn });
    if (result.outcome === "refused" && result.reason.startsWith("platform_unsupported:")) {
      console.error(
        `ravi gateway tunnel-run: the gateway tunnel runs only on macOS until cloudflared's confinement on ${process.platform} is verified; not starting cloudflared (${result.reason}).`,
      );
    } else if (result.outcome === "refused" && result.reason.startsWith("runner_already_running:")) {
      console.error(
        `ravi gateway tunnel-run: another tunnel runner owns cloudflared (${result.reason}); stop it (pm2 stop ravi-gateway) before running one by hand.`,
      );
    } else if (result.outcome === "refused") {
      console.error(`ravi gateway tunnel-run: not starting cloudflared (${result.reason}).`);
    } else if (result.outcome === "restart") {
      console.error(`ravi gateway tunnel-run: exiting for a restart (${result.reason}).`);
    } else if (result.outcome === "drift") {
      console.error(
        `ravi gateway tunnel-run: tunnel drift (${result.reason}); cloudflared stopped and the drift latch is set until a rotate.`,
      );
    }
    process.exit(result.exitCode);
  }
}
