import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import {
  getSessionAdapterDebugSnapshot,
  listSessionAdapters,
  type SessionAdapterDebugSnapshot,
  type SessionAdapterRecord,
  type SessionAdapterStatus,
} from "../../adapters/index.js";
import { formatInspectionSection, printInspectionField } from "../inspection-output.js";

type AdapterDiagnosticState = "live" | "dead" | "unbound" | "protocol-invalid" | "stopped" | "configured";

const ADAPTER_DB_META = { source: "adapter-db", freshness: "persisted" } as const;
const SNAPSHOT_META = { source: "runtime-snapshot", freshness: "live" } as const;
const DERIVED_META = { source: "derived", freshness: "derived-now" } as const;

interface SerializedAdapterRecord {
  adapterId: string;
  adapterName: string;
  transport: SessionAdapterRecord["transport"];
  sessionKey: string;
  sessionName: string | null;
  status: SessionAdapterStatus;
  diagnosticState: AdapterDiagnosticState;
  bind: {
    bound: boolean;
    sessionKey: string;
    sessionName: string | null;
    agentId: string | null;
    contextId: string | null;
    cliName: string | null;
    contextKey?: undefined;
  };
  health: SessionAdapterDebugSnapshot["health"];
  lastEvent: SessionAdapterDebugSnapshot["lastEvent"] | null;
  lastCommand: SessionAdapterDebugSnapshot["lastCommand"] | null;
  lastProtocolError: SessionAdapterDebugSnapshot["lastProtocolError"] | null;
  updatedAt: number;
}

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
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const adapters = listSessionAdapters({ sessionKey, status });
    const payload = {
      count: adapters.length,
      adapters: adapters.map((adapter) => this.serializeAdapter(adapter)),
    };

    this.printPayload(payload, asJson, () => this.printAdapterList(payload.adapters));
  }

  @Command({ name: "show", description: "Show a session adapter debug snapshot" })
  show(
    @Arg("adapterId", { description: "Adapter ID to inspect" }) adapterId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const adapter = listSessionAdapters({}).find((entry) => entry.adapterId === adapterId);
    if (!adapter) {
      throw new Error(`Adapter not found: ${adapterId}`);
    }

    const payload = this.serializeAdapter(adapter);
    this.printPayload(payload, asJson, () => this.printAdapterRecord(payload));
  }

  private printPayload(payload: unknown, asJson: boolean, printer: () => void): void {
    if (asJson) {
      this.printJson(payload);
      return;
    }
    printer();
  }

  private printAdapterList(adapters: SerializedAdapterRecord[]): void {
    if (adapters.length === 0) {
      console.log(`\n${formatInspectionSection("Adapters (0)", ADAPTER_DB_META)}\n`);
      console.log("  (none)");
      return;
    }

    console.log(`\n${formatInspectionSection(`Adapters (${adapters.length})`, ADAPTER_DB_META)}\n`);
    for (const adapter of adapters) {
      console.log(`- ${adapter.adapterId} :: ${adapter.diagnosticState} :: ${adapter.status} :: ${adapter.transport}`);
      console.log(
        `  session=${adapter.sessionName ?? adapter.sessionKey} bind=${adapter.bind.bound ? (adapter.bind.contextId ?? "bound") : "unbound"} updated=${formatTimestamp(adapter.updatedAt)}`,
      );
      if (adapter.lastEvent?.event) {
        console.log(`  lastEvent=${adapter.lastEvent.event} @ ${formatTimestamp(adapter.lastEvent.publishedAt)}`);
      }
      if (adapter.lastCommand?.command) {
        console.log(
          `  lastCommand=${adapter.lastCommand.command} @ ${formatTimestamp(adapter.lastCommand.publishedAt)}`,
        );
      }
      if (adapter.lastProtocolError?.reason) {
        console.log(`  protocol=${adapter.lastProtocolError.reason}`);
      }
    }
  }

  private printAdapterRecord(adapter: SerializedAdapterRecord): void {
    console.log(`\nAdapter: ${adapter.adapterId}\n`);
    printInspectionField("Name", adapter.adapterName, ADAPTER_DB_META);
    printInspectionField("Transport", adapter.transport, ADAPTER_DB_META);
    printInspectionField("Session Key", adapter.sessionKey, ADAPTER_DB_META);
    printInspectionField("Session Name", adapter.sessionName ?? "-", ADAPTER_DB_META);
    printInspectionField("Status", adapter.status, ADAPTER_DB_META);
    printInspectionField("Diagnostic", adapter.diagnosticState, DERIVED_META);
    printInspectionField("Updated", formatTimestamp(adapter.updatedAt), SNAPSHOT_META);

    console.log(`\n${formatInspectionSection("  Bind", SNAPSHOT_META)}`);
    printInspectionField("Bound", adapter.bind.bound ? "yes" : "no", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Agent", adapter.bind.agentId ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Session Key", adapter.bind.sessionKey, SNAPSHOT_META, { indent: 4 });
    printInspectionField("Session Name", adapter.bind.sessionName ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Context", adapter.bind.contextId ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("CLI", adapter.bind.cliName ?? "-", SNAPSHOT_META, { indent: 4 });

    console.log(`\n${formatInspectionSection("  Health", SNAPSHOT_META)}`);
    printInspectionField("State", adapter.health.state, SNAPSHOT_META, { indent: 4 });
    printInspectionField("PID", adapter.health.pid ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Started", formatTimestamp(adapter.health.startedAt), SNAPSHOT_META, { indent: 4 });
    printInspectionField("Stopped", formatTimestamp(adapter.health.stoppedAt), SNAPSHOT_META, { indent: 4 });
    printInspectionField("Last Event", formatTimestamp(adapter.health.lastEventAt), SNAPSHOT_META, { indent: 4 });
    printInspectionField("Exit Code", adapter.health.lastExitCode ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Signal", adapter.health.lastSignal ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Last Error", adapter.health.lastError ?? "-", SNAPSHOT_META, { indent: 4 });
    printInspectionField("Pending", adapter.health.pendingCommands, SNAPSHOT_META, { indent: 4 });

    if (adapter.lastEvent) {
      console.log(`\n${formatInspectionSection("  Last Event", SNAPSHOT_META)}`);
      printInspectionField("Type", adapter.lastEvent.type, SNAPSHOT_META, { indent: 4 });
      printInspectionField("Event", adapter.lastEvent.event ?? "-", SNAPSHOT_META, { indent: 4 });
      printInspectionField("Topic", adapter.lastEvent.topic ?? "-", SNAPSHOT_META, { indent: 4 });
      printInspectionField("Published", formatTimestamp(adapter.lastEvent.publishedAt), SNAPSHOT_META, { indent: 4 });
    }

    if (adapter.lastCommand) {
      console.log(`\n${formatInspectionSection("  Last Command", SNAPSHOT_META)}`);
      printInspectionField("Command", adapter.lastCommand.command, SNAPSHOT_META, { indent: 4 });
      printInspectionField("Args", adapter.lastCommand.args?.join(" ") ?? "-", SNAPSHOT_META, { indent: 4 });
      printInspectionField("Topic", adapter.lastCommand.topic ?? "-", SNAPSHOT_META, { indent: 4 });
      printInspectionField("Published", formatTimestamp(adapter.lastCommand.publishedAt), SNAPSHOT_META, { indent: 4 });
    }

    if (adapter.lastProtocolError) {
      console.log(`\n${formatInspectionSection("  Protocol Error", SNAPSHOT_META)}`);
      printInspectionField(
        "Reason",
        adapter.lastProtocolError.reason ?? adapter.lastProtocolError.message,
        SNAPSHOT_META,
        {
          indent: 4,
        },
      );
      printInspectionField("Kind", adapter.lastProtocolError.kind ?? "-", SNAPSHOT_META, { indent: 4 });
      printInspectionField("Line", adapter.lastProtocolError.line ?? "-", SNAPSHOT_META, { indent: 4 });
      printInspectionField("Published", formatTimestamp(adapter.lastProtocolError.publishedAt), SNAPSHOT_META, {
        indent: 4,
      });
    }
  }

  private serializeAdapter(adapter: SessionAdapterRecord): SerializedAdapterRecord {
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
        sessionKey: snapshot?.bind.sessionKey ?? adapter.sessionKey,
        sessionName: snapshot?.bind.sessionName ?? adapter.sessionName ?? null,
        agentId: snapshot?.bind.agentId ?? adapter.agentId ?? null,
        contextId: snapshot?.bind.contextId ?? null,
        cliName: snapshot?.bind.cliName ?? null,
        contextKey: undefined,
      },
      health: snapshot?.health ?? {
        state: mapAdapterStatusToHealthState(adapter.status),
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
      return adapter.status === "running" ? "unbound" : mapAdapterStatusToDiagnosticState(adapter.status);
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

    return mapAdapterStatusToDiagnosticState(adapter.status);
  }

  private printJson(payload: unknown): void {
    console.log(JSON.stringify(payload, null, 2));
  }
}

function formatTimestamp(value: number | null | undefined): string {
  return typeof value === "number" ? new Date(value).toISOString() : "-";
}
function mapAdapterStatusToHealthState(status: SessionAdapterStatus): SessionAdapterDebugSnapshot["health"]["state"] {
  switch (status) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "broken":
      return "broken";
    case "configured":
    default:
      return "stopped";
  }
}

function mapAdapterStatusToDiagnosticState(status: SessionAdapterStatus): AdapterDiagnosticState {
  switch (status) {
    case "broken":
      return "dead";
    case "stopped":
      return "stopped";
    case "configured":
    case "running":
    default:
      return "configured";
  }
}
