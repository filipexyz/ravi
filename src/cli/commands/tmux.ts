import "reflect-metadata";
import { Command, Group, Arg, Option } from "../decorators.js";
import { subscribe } from "../../nats.js";
import { RaviTmuxManager, parseSessionNameFromPromptTopic } from "../../tmux/manager.js";

function printJsonLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

@Group({
  name: "tmux",
  description: "Orchestrate Ravi TUI sessions inside tmux",
})
export class TmuxCommands {
  @Command({ name: "watch", description: "Listen to NATS prompts and open tmux windows automatically" })
  async watch(
    @Option({ flags: "--sync", description: "Bootstrap windows for existing sessions before watching" }) sync = false,
    @Option({ flags: "--json", description: "Print raw JSONL events" }) asJson?: boolean,
  ) {
    const manager = new RaviTmuxManager();
    if (!asJson) {
      console.log(`Watching NATS prompts and materializing tmux windows${sync ? " (sync enabled)" : ""}...`);
      await manager.watch({ syncExisting: sync });
      return;
    }

    printJsonLine({
      type: "watch.started",
      topicPattern: "ravi.session.*.prompt",
      syncExisting: sync,
      timestamp: new Date().toISOString(),
    });

    if (sync) {
      await manager.syncExistingSessions();
      printJsonLine({
        type: "watch.sync_completed",
        timestamp: new Date().toISOString(),
      });
    }

    let count = 0;
    for await (const event of subscribe("ravi.session.*.prompt")) {
      count++;
      const sessionName = parseSessionNameFromPromptTopic(event.topic);
      if (!sessionName) {
        printJsonLine({
          type: "watch.event_skipped",
          count,
          topic: event.topic,
          reason: "unrecognized-prompt-topic",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      try {
        const result = await manager.ensureWindowForSessionName(sessionName);
        printJsonLine({
          type: result ? "watch.window_ensured" : "watch.session_not_found",
          count,
          topic: event.topic,
          sessionName,
          result,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        printJsonLine({
          type: "watch.error",
          count,
          topic: event.topic,
          sessionName,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    }

    printJsonLine({
      type: "watch.ended",
      count,
      timestamp: new Date().toISOString(),
    });
  }

  @Command({ name: "open", description: "Ensure a tmux session/window exists for an agent or session" })
  async open(
    @Arg("agent", { description: "Agent ID" }) agentId: string,
    @Arg("session", { description: "Optional Ravi session name/key", required: false }) sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const manager = new RaviTmuxManager();
    const result = await manager.openAgentWindow(agentId, sessionName);
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            success: true,
            target: {
              agentId,
              ...(sessionName ? { sessionName } : {}),
            },
            tmux: result,
          },
          null,
          2,
        ),
      );
      return result;
    }
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
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const manager = new RaviTmuxManager();
    if (asJson) {
      const result = await manager.openAgentWindow(agentId, sessionName);
      console.log(
        JSON.stringify(
          {
            success: true,
            attached: false,
            reason: "JSON mode ensures the tmux target without attaching an interactive client.",
            target: {
              agentId,
              ...(sessionName ? { sessionName } : {}),
            },
            tmux: result,
          },
          null,
          2,
        ),
      );
      return;
    }
    await manager.attach(agentId, sessionName);
  }

  @Command({ name: "list", description: "List Ravi-managed tmux sessions and windows" })
  async list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const manager = new RaviTmuxManager();
    const sessions = await manager.listManagedSessions();

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            total: sessions.length,
            sessions,
          },
          null,
          2,
        ),
      );
      return sessions;
    }

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
