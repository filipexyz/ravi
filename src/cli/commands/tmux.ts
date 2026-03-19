import "reflect-metadata";
import { Command, Group, Arg, Option } from "../decorators.js";
import { RaviTmuxManager } from "../../tmux/manager.js";

@Group({
  name: "tmux",
  description: "Orchestrate Ravi TUI sessions inside tmux",
})
export class TmuxCommands {
  @Command({ name: "watch", description: "Listen to NATS prompts and open tmux windows automatically" })
  async watch(
    @Option({ flags: "--sync", description: "Bootstrap windows for existing sessions before watching" }) sync = false,
  ) {
    const manager = new RaviTmuxManager();
    console.log(`Watching NATS prompts and materializing tmux windows${sync ? " (sync enabled)" : ""}...`);
    await manager.watch({ syncExisting: sync });
  }

  @Command({ name: "open", description: "Ensure a tmux session/window exists for an agent or session" })
  async open(
    @Arg("agent", { description: "Agent ID" }) agentId: string,
    @Arg("session", { description: "Optional Ravi session name/key", required: false }) sessionName?: string,
  ) {
    const manager = new RaviTmuxManager();
    const result = await manager.openAgentWindow(agentId, sessionName);
    console.log(`tmux session: ${result.tmuxSessionName}`);
    console.log(`window:       ${result.windowName}`);
    console.log(`pane:         ${result.paneTitle} (${result.paneId})`);
    console.log(
      `state:        ${result.createdSession ? "created-session" : result.createdWindow ? "created-window" : result.createdPane ? "created-pane" : result.respawnedPane ? "respawned-pane" : "already-running"}`,
    );
  }

  @Command({ name: "attach", description: "Attach or switch to an agent/session inside tmux" })
  async attach(
    @Arg("agent", { description: "Agent ID" }) agentId: string,
    @Arg("session", { description: "Optional Ravi session name/key", required: false }) sessionName?: string,
  ) {
    const manager = new RaviTmuxManager();
    await manager.attach(agentId, sessionName);
  }

  @Command({ name: "list", description: "List Ravi-managed tmux sessions and windows" })
  async list() {
    const manager = new RaviTmuxManager();
    const sessions = await manager.listManagedSessions();

    if (sessions.length === 0) {
      console.log("No Ravi tmux sessions found.");
      return;
    }

    for (const session of sessions) {
      console.log(`\n${session.tmuxSessionName}`);
      for (const window of session.windows) {
        console.log(`  - ${window.name}${window.paneDead ? " (dead)" : ""}`);
      }
    }
  }
}
