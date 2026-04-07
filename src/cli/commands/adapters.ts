import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import {
  getSessionAdapterDebugSnapshot,
  listSessionAdapters,
  type SessionAdapterDebugSnapshot,
  type SessionAdapterRecord,
  type SessionAdapterStatus,
} from "../../adapters/index.js";

type AdapterDiagnosticState = "live" | "dead" | "unbound" | "protocol-invalid" | "stopped" | "configured";

@Group({
  name: "adapters",
  description: "Inspect session adapters and their debug snapshots",
  scope: "admin",
})
export class AdapterCommands {
  @Command({ name: "list", description: "List session adapters with health and bind state" })
  list(
    @Option({ flags: "--session <sessionKey>", description: "Filter by session key" }) sessionKey?: string,
    @Option({ flags: "--status <status>", description: "Filter by adapter status" }) status?: SessionAdapterStatus,
  ) {
    const adapters = listSessionAdapters({ sessionKey, status });
    this.printJson({
      count: adapters.length,
      adapters: adapters.map((adapter) => this.serializeAdapter(adapter)),
    });
  }

  @Command({ name: "show", description: "Show a session adapter debug snapshot" })
  show(@Arg("adapterId", { description: "Adapter ID to inspect" }) adapterId: string) {
    const adapter = listSessionAdapters({}).find((entry) => entry.adapterId === adapterId);
    if (!adapter) {
      throw new Error(`Adapter not found: ${adapterId}`);
    }

    this.printJson(this.serializeAdapter(adapter));
  }

  private serializeAdapter(adapter: SessionAdapterRecord) {
    const snapshot = getSessionAdapterDebugSnapshot(adapter.adapterId);
    const diagnosticState = this.resolveDiagnosticState(adapter, snapshot);
    const bound = Boolean(snapshot?.bind.contextId);
    return {
      adapterId: adapter.adapterId,
      adapterName: adapter.name,
      transport: adapter.transport,
      sessionKey: adapter.sessionKey,
      sessionName: adapter.sessionName ?? null,
      status: adapter.status,
      diagnosticState,
      bind: {
        bound,
        ...(snapshot?.bind ?? {
          sessionKey: adapter.sessionKey,
          sessionName: adapter.sessionName ?? null,
          agentId: adapter.agentId ?? null,
          contextId: null,
          cliName: null,
        }),
        contextKey: undefined,
      },
      health: snapshot?.health ?? {
        state: adapter.status,
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastEventAt: null,
        lastExitCode: null,
        lastSignal: null,
        lastError: adapter.lastError ?? null,
        lastProtocolError: null,
        pendingCommands: 0,
        stderrTail: "",
      },
      lastEvent: snapshot?.lastEvent ?? null,
      lastCommand: snapshot?.lastCommand ?? null,
      lastProtocolError: snapshot?.lastProtocolError ?? null,
      updatedAt: snapshot?.updatedAt ?? adapter.updatedAt,
    };
  }

  private resolveDiagnosticState(
    adapter: SessionAdapterRecord,
    snapshot: SessionAdapterDebugSnapshot | null,
  ): AdapterDiagnosticState {
    if (!snapshot) {
      return adapter.status === "running" ? "unbound" : adapter.status;
    }

    if (snapshot.lastProtocolError) {
      return "protocol-invalid";
    }

    const bound = Boolean(snapshot.bind.contextId);
    if (!bound) {
      return "unbound";
    }

    if (snapshot.health.state === "running" && adapter.status === "running") {
      return "live";
    }

    if (snapshot.health.state === "broken" || adapter.status === "broken") {
      return "dead";
    }

    if (snapshot.health.state === "stopped") {
      return "stopped";
    }

    return adapter.status;
  }

  private printJson(payload: unknown): void {
    console.log(JSON.stringify(payload, null, 2));
  }
}
