"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { Copy, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import { DataTable } from "@/components/data-table";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Metric,
  PageHeader,
  SlashMark,
  Tag,
  statusTone,
} from "@/components/ui";
import type { McpBridgeDetail, McpBridgeListItem } from "@/server/mcp/read-model";
import { organizationHeaders } from "@/lib/api/organization";

interface BridgesPanelProps {
  initialBridges: McpBridgeListItem[];
  projectId: string;
  projectName: string;
  projectSlug: string;
}

type CreatedBridge = {
  id: string;
  name: string;
  projectId: string;
  status: string;
  createdAt: string;
};

export function BridgesPanel({
  initialBridges,
  projectId,
  projectName,
  projectSlug,
}: BridgesPanelProps) {
  const [bridges, setBridges] = useState(initialBridges);
  const [selectedBridgeId, setSelectedBridgeId] = useState(initialBridges[0]?.id ?? null);
  const [selectedBridge, setSelectedBridge] = useState<McpBridgeDetail | null>(null);
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null);
  const [name, setName] = useState("Default MCP bridge");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const activeCount = bridges.filter((bridge) => bridge.status === "active").length;
  const calls24h = bridges.reduce((sum, bridge) => sum + bridge.calls24h, 0);
  const cost24h = bridges.reduce((sum, bridge) => sum + Number(bridge.costEstimate24hUsd), 0);

  async function refreshList(nextSelectedId = selectedBridgeId) {
    const response = await fetch("/api/internal/mcp/bridges/list", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...organizationHeaders() },
      body: JSON.stringify({ projectRef: projectId }),
    });
    const body = (await response.json()) as
      | { status: "ok"; bridges: McpBridgeListItem[] }
      | { status: "error"; code: string };
    if (response.ok && body.status === "ok") {
      setBridges(body.bridges);
      setError(null);
      const selected = nextSelectedId ?? body.bridges[0]?.id ?? null;
      setSelectedBridgeId(selected);
      if (selected) void loadDetail(selected);
      return;
    }
    if (body.status === "error") setError(body.code);
  }

  async function loadDetail(bridgeId: string) {
    setSelectedBridgeId(bridgeId);
    setRevealedUrl(null);
    const response = await fetch("/api/internal/mcp/bridges/detail", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...organizationHeaders() },
      body: JSON.stringify({ projectRef: projectId, bridgeId }),
    });
    const body = (await response.json()) as
      | { status: "ok"; bridge: McpBridgeDetail }
      | { status: "error"; code: string };
    if (response.ok && body.status === "ok") {
      setSelectedBridge(body.bridge);
      setError(null);
    } else if (body.status === "error") {
      setError(body.code);
    }
  }

  async function createBridge() {
    setCreating(true);
    setError(null);
    setRevealedUrl(null);
    try {
      const response = await fetch("/api/internal/mcp/bridges/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...organizationHeaders() },
        body: JSON.stringify({
          projectRef: projectId,
          name,
          description: description || undefined,
          allowedCapabilityClasses: ["read", "write"],
        }),
      });
      const body = (await response.json()) as
        | { status: "ok"; bridge: CreatedBridge; bridgeUrl: string }
        | { status: "error"; code: string };
      if (!response.ok || body.status !== "ok") {
        setError(body.status === "error" ? body.code : "create_failed");
        return;
      }
      setRevealedUrl(body.bridgeUrl);
      startTransition(() => {
        void refreshList(body.bridge.id);
      });
    } catch {
      setError("network_error");
    } finally {
      setCreating(false);
    }
  }

  async function revokeBridge(bridgeId: string) {
    const ok = window.confirm("Revoke this MCP bridge? Existing clients and tokens stop working.");
    if (!ok) return;
    setRevoking(bridgeId);
    setError(null);
    try {
      const response = await fetch("/api/internal/mcp/bridges/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...organizationHeaders() },
        body: JSON.stringify({ bridgeId }),
      });
      const body = (await response.json()) as
        | { status: "ok"; revoked: boolean }
        | { status: "error"; code: string };
      if (!response.ok || body.status !== "ok") {
        setError(body.status === "error" ? body.code : "revoke_failed");
        return;
      }
      startTransition(() => {
        void refreshList(selectedBridgeId === bridgeId ? null : selectedBridgeId);
      });
    } catch {
      setError("network_error");
    } finally {
      setRevoking(null);
    }
  }

  const columns = useMemo<ColumnDef<McpBridgeListItem>[]>(
    () => [
      {
        header: "Bridge",
        accessorKey: "name",
        cell: ({ row }) => (
          <div className="col gap-4">
            <span className="t-strong">{row.original.name}</span>
            <span className="t-tiny t-mute t-mono">{row.original.id}</span>
          </div>
        ),
      },
      {
        header: "Status",
        accessorKey: "status",
        cell: ({ row }) => (
          <Tag dot tone={statusTone(row.original.status)}>
            {row.original.status}
          </Tag>
        ),
      },
      {
        header: "Last used",
        accessorKey: "lastUsedAt",
        cell: ({ row }) => (
          <span className="t-mono t-mute t-tiny">
            {row.original.lastUsedAt ? new Date(row.original.lastUsedAt).toLocaleString() : "never"}
          </span>
        ),
      },
      {
        header: "24h",
        accessorKey: "calls24h",
        cell: ({ row }) => (
          <span className="t-mono t-tiny">{row.original.calls24h} calls</span>
        ),
      },
      {
        header: "",
        id: "actions",
        cell: ({ row }) => (
          <div className="row gap-8">
            <Button onClick={() => loadDetail(row.original.id)} size="sm" variant="ghost">
              Details
            </Button>
            <Button
              disabled={revoking === row.original.id || row.original.status === "revoked"}
              icon={Trash2}
              onClick={() => revokeBridge(row.original.id)}
              size="sm"
              variant="danger"
            >
              {revoking === row.original.id ? "Revoking…" : "Revoke"}
            </Button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revoking],
  );

  return (
    <>
      <PageHeader
        right={
          <Button icon={RefreshCw} onClick={() => refreshList()} size="sm" variant="ghost">
            Refresh
          </Button>
        }
        slashLabel={`project / ${projectName}`}
        slashNum={5}
        sub={`Hosted MCP URLs for external clients against ${projectSlug}. Plaintext tokens are only shown once.`}
        title="MCP Bridges"
      />

      <div className="metric-grid">
        <Metric label="bridges" sub="active" value={activeCount} />
        <Metric label="calls" sub="24h" value={calls24h} />
        <Metric label="cost" mono sub="24h est" value={`$${cost24h.toFixed(4)}`} />
        <Metric label="clients" sub="oauth" value={selectedBridge?.clients.length ?? 0} />
      </div>

      <div className="grid grid-2">
        <Card>
          <CardHeader
            right={
              <Button disabled={creating} icon={Plus} onClick={createBridge} size="sm" variant="primary">
                {creating ? "Creating…" : "Create bridge"}
              </Button>
            }
          >
            <SlashMark label="create bridge" num={1} />
          </CardHeader>
          <CardBody>
            <div className="col gap-16">
              <div className="field">
                <label htmlFor="bridge-name">Name</label>
                <input
                  className="input"
                  id="bridge-name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </div>
              <div className="field">
                <label htmlFor="bridge-description">Description</label>
                <textarea
                  className="textarea"
                  id="bridge-description"
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  value={description}
                />
              </div>
              {revealedUrl ? (
                <div className="col gap-8">
                  <Tag tone="warn">
                    <Shield size={11} /> copy now; hidden after refresh
                  </Tag>
                  <div className="row gap-8">
                    <code className="t-mono t-tiny grow" style={{ overflowWrap: "anywhere" }}>
                      {revealedUrl}
                    </code>
                    <Button
                      icon={Copy}
                      onClick={() => navigator.clipboard.writeText(revealedUrl)}
                      size="sm"
                      variant="ghost"
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SlashMark label="selected bridge" num={2} />
          </CardHeader>
          <CardBody>
            {selectedBridge ? (
              <div className="col gap-12">
                <div className="row-between">
                  <span className="t-strong">{selectedBridge.name}</span>
                  <Tag dot tone={statusTone(selectedBridge.status)}>
                    {selectedBridge.status}
                  </Tag>
                </div>
                <MetaRow label="session" value={selectedBridge.sessionRef} />
                <MetaRow label="channel" value={selectedBridge.channelId} />
                <MetaRow label="tools cached" value={selectedBridge.cachedToolsAt ?? "not yet"} />
              </div>
            ) : (
              <p className="t-body t-mute">Select a bridge to inspect clients, events, and usage.</p>
            )}
          </CardBody>
        </Card>

        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="bridges" num={3} />
          </CardHeader>
          {error ? (
            <div className="card-bd">
              <Tag tone="err">{friendlyError(error)}</Tag>
            </div>
          ) : null}
          <CardBody flush>
            <DataTable
              columns={columns}
              data={bridges}
              empty="No MCP bridges yet. Create one above to generate a connect URL."
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SlashMark label="oauth clients" num={4} />
          </CardHeader>
          <CardBody flush>
            <DataTable
              columns={clientColumns}
              data={selectedBridge?.clients ?? []}
              empty="No OAuth clients have registered yet."
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SlashMark label="event tail" num={5} />
          </CardHeader>
          <CardBody flush>
            <DataTable
              columns={eventColumns}
              data={selectedBridge?.recentEvents ?? []}
              empty="No bridge events yet."
            />
          </CardBody>
        </Card>

        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="usage" num={6} />
          </CardHeader>
          <CardBody>
            <div className="col gap-8">
              {(selectedBridge?.usage ?? []).slice(0, 14).map((day) => (
                <div className="row gap-12" key={day.day}>
                  <span className="t-mono t-tiny" style={{ width: 92 }}>
                    {day.day}
                  </span>
                  <div className="progress grow">
                    <span style={{ width: `${Math.min(day.callsTotal, 100)}%` }} />
                  </div>
                  <span className="t-mono t-tiny t-mute" style={{ width: 84 }}>
                    {day.callsTotal} calls
                  </span>
                </div>
              ))}
              {selectedBridge?.usage.length ? null : (
                <p className="t-body t-mute">Usage appears after the daily 03:00 UTC roll-up.</p>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

const clientColumns: ColumnDef<McpBridgeDetail["clients"][number]>[] = [
  {
    header: "Client",
    accessorKey: "clientName",
    cell: ({ row }) => (
      <div className="col gap-4">
        <span>{row.original.clientName}</span>
        <span className="t-mono t-tiny t-mute">{row.original.clientId}</span>
      </div>
    ),
  },
  {
    header: "Created",
    accessorKey: "createdAt",
    cell: ({ row }) => <span className="t-mono t-tiny">{new Date(row.original.createdAt).toLocaleString()}</span>,
  },
];

const eventColumns: ColumnDef<McpBridgeDetail["recentEvents"][number]>[] = [
  {
    header: "Event",
    accessorKey: "eventType",
    cell: ({ row }) => (
      <div className="row gap-8">
        <Tag tone={statusTone(row.original.statusClass)}>{row.original.statusClass}</Tag>
        <span>{row.original.eventType}</span>
      </div>
    ),
  },
  {
    header: "When",
    accessorKey: "occurredAt",
    cell: ({ row }) => <span className="t-mono t-tiny">{new Date(row.original.occurredAt).toLocaleString()}</span>,
  },
  {
    header: "Latency",
    accessorKey: "durationMs",
    cell: ({ row }) => <span className="t-mono t-tiny">{row.original.durationMs}ms</span>,
  },
];

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mail-meta-row">
      <span>{label}</span>
      <strong className="t-mono t-tiny">{value}</strong>
    </div>
  );
}

function friendlyError(code: string): string {
  switch (code) {
    case "unauthorized":
      return "Session expired. Refresh the page.";
    case "network_error":
      return "Network error. Try again.";
    case "project_not_found":
      return "Project not found or access denied.";
    case "bridge_not_found":
      return "Bridge not found or access denied.";
    default:
      return `Action failed (${code}).`;
  }
}
