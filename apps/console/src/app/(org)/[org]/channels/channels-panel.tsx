"use client";

import QRCode from "qrcode";
import {
  KeyRound,
  LogOut,
  MessageCircle,
  Plug,
  Power,
  QrCode,
  RefreshCw,
  RotateCcw,
  Shield,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Button, Card, CardBody, CardHeader, Metric, PageHeader, SlashMark, Tag, statusTone } from "@/components/ui";
import { organizationHeaders } from "@/lib/api/organization";

type ChannelInstance = {
  id: string;
  organizationId: string;
  hostId: string;
  channel: "whatsapp";
  provider: "omni";
  displayName: string;
  phoneE164: string | null;
  phoneDisplay: string | null;
  status: string;
  connectionState: string | null;
  externalInstanceId: string | null;
  externalInstanceName: string;
  createdByUserId: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastHealthAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApiOk<T extends Record<string, unknown>> = T & { status: "ok" };
type ApiError = { status: "error"; code: string };
type QrState = { instanceId: string; payload: unknown; qrText: string | null };
type PairState = { instanceId: string; payload: unknown; pairingCode: string | null };

const INSTANCE_PATH = "/api/internal/channels/whatsapp/instances";
const HEALTH_PATH = "/api/internal/channels/hosts/health";

export function ChannelsPanel() {
  const [instances, setInstances] = useState<ChannelInstance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("WhatsApp principal");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [qrState, setQrState] = useState<QrState | null>(null);
  const [pairState, setPairState] = useState<PairState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selected = useMemo(
    () => instances.find((instance) => instance.id === selectedId) ?? instances[0] ?? null,
    [instances, selectedId],
  );
  const activeCount = instances.filter((instance) => instance.status === "connected").length;
  const degradedCount = instances.filter((instance) => ["degraded", "disabled", "deleted"].includes(instance.status)).length;

  async function refreshAll(nextSelectedId = selectedId) {
    setBusy((current) => current ?? "refresh");
    try {
      const [{ instances: nextInstances }, nextHealth] = await Promise.all([
        apiGet<{ instances: ChannelInstance[] }>(INSTANCE_PATH),
        apiGet<Record<string, unknown>>(HEALTH_PATH).catch(() => null),
      ]);
      setInstances(nextInstances);
      setSelectedId(nextSelectedId ?? nextInstances[0]?.id ?? null);
      setHealth(nextHealth);
      setError(null);
    } catch (err) {
      setError(friendlyError(codeFromError(err)));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshAll(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createInstance() {
    const name = displayName.trim();
    if (!name) {
      setError("Name the WhatsApp instance before creating it.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const result = await apiPost<{ instance: ChannelInstance }>(INSTANCE_PATH, { displayName: name });
      setQrState(null);
      setPairState(null);
      setInstances((current) => upsertInstance(current, result.instance));
      setSelectedId(result.instance.id);
      if (isWaitingForScan(result.instance)) {
        setBusy(`qr:${result.instance.id}`);
        await loadQr(result.instance.id);
      }
      startTransition(() => void refreshAll(result.instance.id));
    } catch (err) {
      setError(friendlyError(codeFromError(err)));
    } finally {
      setBusy(null);
    }
  }

  async function refreshInstance(instanceId: string) {
    setBusy(`show:${instanceId}`);
    try {
      const result = await apiGet<{ instance: ChannelInstance }>(`${INSTANCE_PATH}/${instanceId}`);
      setInstances((current) => upsertInstance(current, result.instance));
      setSelectedId(result.instance.id);
      setError(null);
    } catch (err) {
      setError(friendlyError(codeFromError(err)));
    } finally {
      setBusy(null);
    }
  }

  async function requestQr(instanceId: string) {
    setBusy(`qr:${instanceId}`);
    setQrState(null);
    setError(null);
    try {
      await loadQr(instanceId);
      startTransition(() => void refreshInstance(instanceId));
    } catch (err) {
      setError(friendlyError(codeFromError(err)));
    } finally {
      setBusy(null);
    }
  }

  async function loadQr(instanceId: string) {
    const payload = await apiPost<Record<string, unknown>>(`${INSTANCE_PATH}/${instanceId}/qr`, {});
    setQrState({ instanceId, payload, qrText: findCodeValue(payload, ["qr", "qrcode", "qr_code"]) });
    setPairState(null);
  }

  async function requestPair(instanceId: string) {
    setBusy(`pair:${instanceId}`);
    setPairState(null);
    setError(null);
    try {
      const payload = await apiPost<Record<string, unknown>>(`${INSTANCE_PATH}/${instanceId}/pair`, {
        phoneNumber: phoneNumber.trim() || undefined,
      });
      setPairState({
        instanceId,
        payload,
        pairingCode: findCodeValue(payload, ["pairingcode", "pairing_code", "code"]),
      });
      setQrState(null);
      startTransition(() => void refreshInstance(instanceId));
    } catch (err) {
      setError(friendlyError(codeFromError(err)));
    } finally {
      setBusy(null);
    }
  }

  async function runAction(instanceId: string, action: ChannelAction) {
    if (action === "delete" && !window.confirm("Delete this WhatsApp instance? This removes only this organization channel instance.")) {
      return;
    }
    setBusy(`${action}:${instanceId}`);
    setError(null);
    try {
      const result = await apiPost<Record<string, unknown>>(`${INSTANCE_PATH}/${instanceId}/${action}`, {});
      const nextInstance = isRecord(result.instance) ? result.instance as ChannelInstance : null;
      if (nextInstance) setInstances((current) => upsertInstance(current, nextInstance));
      startTransition(() => void refreshAll(instanceId));
    } catch (err) {
      setError(friendlyError(codeFromError(err)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        right={
          <Button disabled={busy === "refresh" || isPending} icon={RefreshCw} onClick={() => refreshAll()} size="sm" variant="ghost">
            Refresh
          </Button>
        }
        slashLabel="organization / channels"
        slashNum={2}
        sub="Organization-owned communication accounts managed by Ravi Cloud. Runtime routing comes later."
        title="Channels"
      />

      <div className="metric-grid">
        <Metric label="whatsapp" sub="instances" value={instances.length} />
        <Metric label="connected" sub="active" value={activeCount} />
        <Metric label="attention" sub="degraded" value={degradedCount} />
        <Metric label="host" sub="omni" value={<Tag tone={health ? "ok" : "warn"}>{health ? "reachable" : "unknown"}</Tag>} />
      </div>

      {error ? <div className="form-banner form-banner--err" style={{ marginBottom: 18 }}>{error}</div> : null}

      <div className="grid grid-2">
        <Card>
          <CardHeader
            right={
              <Button disabled={busy === "create"} icon={MessageCircle} onClick={createInstance} size="sm" variant="primary">
                {busy === "create" ? "Creating..." : "Create"}
              </Button>
            }
          >
            <SlashMark label="new whatsapp instance" num={1} />
          </CardHeader>
          <CardBody>
            <div className="col gap-16">
              <div className="form-banner">
                <div className="row gap-8">
                  <Shield size={14} />
                  <span>Owner/admin only. Instances belong to the organization, not to one project.</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="channel-display-name">Display name</label>
                <input
                  className="input"
                  id="channel-display-name"
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </div>
              <div className="field">
                <label htmlFor="channel-phone-number">Phone for pairing code</label>
                <input
                  className="input t-mono"
                  id="channel-phone-number"
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  placeholder="+5511999999999"
                  value={phoneNumber}
                />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SlashMark label="selected instance" num={2} />
          </CardHeader>
          <CardBody>
            {selected ? (
              <div className="col gap-12">
                <div className="row-between gap-12">
                  <div className="col gap-4">
                    <span className="t-strong">{selected.displayName}</span>
                    <span className="t-mono t-tiny t-mute">{selected.id}</span>
                  </div>
                  <Tag dot tone={instanceStatusTone(selected)}>{instanceStatusLabel(selected)}</Tag>
                </div>
                {isWaitingForScan(selected) ? (
                  <div className="form-banner">
                    <div className="row gap-8">
                      <QrCode size={14} />
                      <span>Waiting for WhatsApp scan</span>
                    </div>
                  </div>
                ) : null}
                <MetaRow label="phone" value={selected.phoneDisplay ?? selected.phoneE164 ?? "not connected"} />
                <MetaRow label="state" value={selected.connectionState ?? "-"} />
                <MetaRow label="omni" value={selected.externalInstanceId ?? selected.externalInstanceName} />
                <MetaRow label="health" value={selected.lastHealthAt ? new Date(selected.lastHealthAt).toLocaleString() : "not checked"} />
              </div>
            ) : (
              <p className="t-body t-mute">Create the first WhatsApp instance to connect a phone.</p>
            )}
          </CardBody>
        </Card>

        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="instances" num={3} />
          </CardHeader>
          <CardBody flush>
            {instances.length === 0 ? <div className="empty">No WhatsApp channel instances yet.</div> : null}
            {instances.map((instance, index) => (
              <InstanceRow
                busy={busy}
                instance={instance}
                isLast={index === instances.length - 1}
                isSelected={selected?.id === instance.id}
                key={instance.id}
                onAction={runAction}
                onPair={requestPair}
                onQr={requestQr}
                onRefresh={refreshInstance}
                onSelect={setSelectedId}
              />
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SlashMark label="qr connect" num={4} />
          </CardHeader>
          <CardBody>
            {qrState ? (
              <div className="col gap-12">
                <QrCanvas value={qrState.qrText} />
                <span className="t-mono t-tiny t-mute">instance {qrState.instanceId}</span>
                {!qrState.qrText ? <JsonPreview value={qrState.payload} /> : null}
              </div>
            ) : (
              <p className="t-body t-mute">Request QR on an instance and scan it from WhatsApp.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SlashMark label="pairing code" num={5} />
          </CardHeader>
          <CardBody>
            {pairState ? (
              <div className="col gap-12">
                <div className="form-banner">
                  <span className="t-mono">{pairState.pairingCode ?? "Pairing response received"}</span>
                </div>
                <span className="t-mono t-tiny t-mute">instance {pairState.instanceId}</span>
                {!pairState.pairingCode ? <JsonPreview value={pairState.payload} /> : null}
              </div>
            ) : (
              <p className="t-body t-mute">Enter a phone number, then request pairing code on an instance.</p>
            )}
          </CardBody>
        </Card>

        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="host health" num={6} />
          </CardHeader>
          <CardBody>
            {health ? <JsonPreview value={health} /> : <p className="t-body t-mute">Host health has not been checked yet.</p>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

type ChannelAction = "connect" | "disconnect" | "restart" | "logout" | "rotate-key" | "disable" | "delete";

function InstanceRow({
  busy,
  instance,
  isLast,
  isSelected,
  onAction,
  onPair,
  onQr,
  onRefresh,
  onSelect,
}: {
  busy: string | null;
  instance: ChannelInstance;
  isLast: boolean;
  isSelected: boolean;
  onAction: (instanceId: string, action: ChannelAction) => void;
  onPair: (instanceId: string) => void;
  onQr: (instanceId: string) => void;
  onRefresh: (instanceId: string) => void;
  onSelect: (instanceId: string) => void;
}) {
  const isDeleted = instance.status === "deleted";
  const isDisabled = instance.status === "disabled";
  const isProvisioned = Boolean(instance.externalInstanceId);
  const canOperate = isProvisioned && !isDeleted && !isDisabled && instance.status !== "degraded";
  const canRefresh = isProvisioned && !isDeleted;
  const waitingForScan = isWaitingForScan(instance);
  return (
    <div
      className="card-hover"
      style={{
        borderBottom: isLast ? 0 : "1px solid var(--line)",
        background: isSelected ? "var(--bg-2)" : undefined,
        padding: "14px 18px",
      }}
    >
      <div className="row gap-12" style={{ alignItems: "flex-start" }}>
        <button
          className="icon-btn"
          onClick={() => onSelect(instance.id)}
          title="Select instance"
          type="button"
        >
          <MessageCircle size={14} />
        </button>
        <div className="col gap-8 grow truncate">
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            <span className="t-strong">{instance.displayName}</span>
            <Tag dot tone={instanceStatusTone(instance)}>{instanceStatusLabel(instance)}</Tag>
            {instance.connectionState ? <Tag>{instance.connectionState}</Tag> : null}
            {waitingForScan ? <Tag tone="warn">scan QR</Tag> : null}
            {!isProvisioned ? <Tag tone="warn">not provisioned</Tag> : null}
            {instance.phoneDisplay || instance.phoneE164 ? <Tag tone="ok">{instance.phoneDisplay ?? instance.phoneE164}</Tag> : null}
          </div>
          <span className="t-mono t-tiny t-mute truncate">{instance.externalInstanceName}</span>
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            <Button disabled={!canRefresh || busy === `show:${instance.id}`} icon={RefreshCw} onClick={() => onRefresh(instance.id)} size="sm" variant="ghost">
              Check
            </Button>
            <Button disabled={!canOperate || busy === `connect:${instance.id}`} icon={Plug} onClick={() => onAction(instance.id, "connect")} size="sm">
              Connect
            </Button>
            <Button disabled={!canOperate || busy === `qr:${instance.id}`} icon={QrCode} onClick={() => onQr(instance.id)} size="sm">
              {waitingForScan ? "Show QR" : "QR"}
            </Button>
            <Button disabled={!canOperate || busy === `pair:${instance.id}`} icon={KeyRound} onClick={() => onPair(instance.id)} size="sm">
              Pair
            </Button>
            <Button disabled={!canOperate || busy === `restart:${instance.id}`} icon={RotateCcw} onClick={() => onAction(instance.id, "restart")} size="sm" variant="ghost">
              Restart
            </Button>
            <Button disabled={!canOperate || busy === `disconnect:${instance.id}`} icon={Power} onClick={() => onAction(instance.id, "disconnect")} size="sm" variant="ghost">
              Disconnect
            </Button>
            <Button disabled={!canOperate || busy === `logout:${instance.id}`} icon={LogOut} onClick={() => onAction(instance.id, "logout")} size="sm" variant="ghost">
              Logout
            </Button>
            <Button disabled={!isProvisioned || isDeleted || busy === `rotate-key:${instance.id}`} icon={KeyRound} onClick={() => onAction(instance.id, "rotate-key")} size="sm" variant="ghost">
              Rotate key
            </Button>
            <Button disabled={isDeleted || busy === `disable:${instance.id}`} onClick={() => onAction(instance.id, "disable")} size="sm" variant="danger">
              Disable
            </Button>
            <Button disabled={isDeleted || busy === `delete:${instance.id}`} icon={Trash2} onClick={() => onAction(instance.id, "delete")} size="sm" variant="danger">
              Delete
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QrCanvas({ value }: { value: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!value || !canvasRef.current || value.startsWith("data:image/")) return;
    QRCode.toCanvas(canvasRef.current, value, {
      color: { dark: "#f4f4f3", light: "#0a0a0a" },
      margin: 2,
      scale: 5,
      width: 240,
    }).then(() => setRenderError(null)).catch(() => setRenderError("QR rendering failed."));
  }, [value]);

  if (!value) return <div className="empty">QR payload not found in provider response.</div>;
  if (value.startsWith("data:image/")) {
    return (
      <div
        aria-label="WhatsApp QR"
        role="img"
        style={{
          backgroundImage: `url(${value})`,
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          backgroundSize: "contain",
          height: 240,
          width: 240,
        }}
      />
    );
  }
  return (
    <div className="col gap-8">
      <canvas ref={canvasRef} style={{ height: 240, width: 240 }} />
      {renderError ? <Tag tone="err">{renderError}</Tag> : null}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mail-meta-row">
      <span>{label}</span>
      <strong className="t-mono t-tiny">{value}</strong>
    </div>
  );
}

function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre
      className="t-mono t-tiny"
      style={{
        margin: 0,
        maxHeight: 260,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

async function apiGet<T extends Record<string, unknown>>(path: string): Promise<ApiOk<T>> {
  const response = await fetch(path, {
    headers: { Accept: "application/json", ...organizationHeaders() },
  });
  return parseApiResponse<T>(response);
}

async function apiPost<T extends Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<ApiOk<T>> {
  const clientRequestId = crypto.randomUUID();
  const response = await fetch(path, {
    body: JSON.stringify({ ...body, clientRequestId }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": clientRequestId,
      ...organizationHeaders(),
    },
    method: "POST",
  });
  return parseApiResponse<T>(response);
}

async function parseApiResponse<T extends Record<string, unknown>>(response: Response): Promise<ApiOk<T>> {
  const payload = await response.json().catch(() => ({ status: "error", code: "invalid_response" } as ApiError));
  if (!response.ok || !isRecord(payload) || payload.status !== "ok") {
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : `http_${response.status}`;
    throw new Error(code);
  }
  return payload as ApiOk<T>;
}

function upsertInstance(instances: ChannelInstance[], next: ChannelInstance) {
  const index = instances.findIndex((instance) => instance.id === next.id);
  if (index === -1) return [next, ...instances];
  const copy = [...instances];
  copy[index] = next;
  return copy;
}

function isWaitingForScan(instance: ChannelInstance): boolean {
  const state = (instance.connectionState ?? "").toLowerCase();
  return instance.status === "qr_pending" || (instance.status === "provisioning" && state.includes("connect"));
}

function instanceStatusLabel(instance: ChannelInstance): string {
  if (isWaitingForScan(instance)) return "waiting for scan";
  return instance.status;
}

function instanceStatusTone(instance: ChannelInstance): ReturnType<typeof statusTone> {
  if (isWaitingForScan(instance)) return "warn";
  return statusTone(instance.status);
}

function findCodeValue(value: unknown, keys: string[]): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (keys.some((candidate) => candidate.replace(/[-_]/g, "").toLowerCase() === normalizedKey) && typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") queue.push(item);
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codeFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

function friendlyError(code: string): string {
  switch (code) {
    case "unauthorized":
      return "Session expired. Refresh the page.";
    case "channel_permission_required":
      return "Only organization owners and admins can manage channels.";
    case "server_not_configured":
      return "Channels are not configured in this environment.";
    case "channel_host_unavailable":
      return "The Omni host is unavailable.";
    case "channel_instance_not_found":
      return "The Omni channel instance was not found. Delete this row and create a new instance.";
    case "channel_instance_unavailable":
      return "This channel instance is not ready yet. Delete degraded rows and create a new instance.";
    case "channel_qr_unavailable":
      return "QR is unavailable for this instance right now.";
    case "channel_pairing_unavailable":
      return "Pairing is unavailable for this instance right now.";
    case "channel_idempotency_required":
      return "The operation needs an idempotency key.";
    case "payload_invalid":
    case "channel_payload_invalid":
      return "The request payload is invalid.";
    default:
      return `Channel operation failed (${code}).`;
  }
}
