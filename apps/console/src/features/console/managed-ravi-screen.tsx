"use client";

import {
  AlertTriangle,
  ArchiveRestore,
  Bot,
  CircleStop,
  Copy,
  DatabaseBackup,
  History,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  MessageSquareText,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { Button, PageHeader, Progress, StatusDot, Tag, statusTone } from "@/components/ui";
import {
  ConsoleApiClientError,
  useCreateManagedRavi,
  useInterruptRaviControlTurn,
  useManagedRavi,
  useManagedRaviOperation,
  useRaviControlChat,
  useRaviControlInstallations,
  useSendRaviControlMessage,
  useSyncRaviControlChat,
} from "./queries";
import {
  managedRaviFailureDiagnostic,
  managedRaviLifecycleActions,
  managedRaviReadableState,
  readableCode,
} from "./managed-ravi-view";
import type {
  ManagedRaviAggregate,
  ManagedRaviOperationAction,
  RaviControlChatMessage,
} from "./types";
import { relTime } from "./types";

const ACTIVE_MESSAGE_STATUSES = new Set(["queued", "accepted"]);
const CONTROL_AREAS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, available: true },
  { id: "chat", label: "Chat", icon: MessageSquareText, available: true },
  { id: "agents", label: "Agents", icon: Users, available: false },
  { id: "operations", label: "Operations", icon: ListTodo, available: true },
  { id: "connections", label: "Connections", icon: Plug, available: false },
  { id: "access", label: "Access", icon: ShieldCheck, available: false },
  { id: "activity", label: "Activity", icon: History, available: true },
] as const;
type ControlArea = (typeof CONTROL_AREAS)[number]["id"];

export function RaviControlWorkspaceScreen() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const installationsQuery = useRaviControlInstallations();
  const projects = useMemo(
    () => installationsQuery.data?.projects ?? [],
    [installationsQuery.data?.projects],
  );
  const [projectFilterOverride, setProjectFilterOverride] = useState<string | null>(null);
  const requestedProject = searchParams.get("project");
  const projectFilter =
    projectFilterOverride ??
    projects.find(
      (item) => item.id === requestedProject || item.slug === requestedProject,
    )?.id ??
    "all";
  const [activeArea, setActiveArea] = useState<ControlArea>("overview");
  const visibleInstances = useMemo(
    () =>
      (installationsQuery.data?.items ?? []).filter(
        (item) =>
          item.instance.observedState !== "deleted" &&
          (projectFilter === "all" || item.project.id === projectFilter),
      ),
    [installationsQuery.data?.items, projectFilter],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const createMutation = useCreateManagedRavi(createProjectId);

  const effectiveSelected =
    visibleInstances.find((item) => item.instance.id === selectedId) ??
    visibleInstances[0] ??
    null;

  function toggleCreate() {
    const next = !createOpen;
    setCreateOpen(next);
    if (next && !createProjectId) {
      setCreateProjectId(
        projectFilter === "all" ? (projects[0]?.id ?? "") : projectFilter,
      );
    }
  }

  async function createInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || !createProjectId) {
      setFormError(!name ? "Name is required." : "Project is required.");
      return;
    }
    setFormError(null);
    try {
      const created = await createMutation.mutateAsync({
        displayName: name,
        idempotencyKey: `create:${crypto.randomUUID()}`,
      });
      await queryClient.invalidateQueries({
        queryKey: ["console", "ravi-control", "installations"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["console", "projects", createProjectId, "managed-ravis"],
      });
      if (projectFilter !== "all" && projectFilter !== createProjectId) {
        setProjectFilterOverride(createProjectId);
      }
      setSelectedId(created.instance.id);
      setDisplayName("");
      setCreateOpen(false);
    } catch (error) {
      setFormError(managedRaviError(error));
    }
  }

  return (
    <>
      <PageHeader
        right={
          <div className="row gap-8">
            {projects.length > 1 ? (
              <select
                aria-label="Filter installations by project"
                className="input"
                onChange={(event) => {
                  setProjectFilterOverride(event.target.value);
                  setSelectedId(null);
                }}
                value={projectFilter}
              >
                <option value="all">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            ) : null}
            <Button
              disabled={projects.length === 0}
              icon={Plus}
              onClick={toggleCreate}
              size="sm"
              variant="primary"
            >
              New installation
            </Button>
          </div>
        }
        slashLabel="governance"
        slashNum={1}
        sub="Operate persistent Codex installations through canonical Ravi surfaces."
        title="Ravi Control"
      />

      <nav aria-label="Ravi Control areas" className="ravi-control-areas">
        {CONTROL_AREAS.map(({ available, icon: Icon, id, label }) => (
          <button
            aria-current={activeArea === id ? "page" : undefined}
            className={activeArea === id ? "is-active" : undefined}
            disabled={!available}
            key={id}
            onClick={() => setActiveArea(id)}
            title={available ? label : `${label} is planned`}
            type="button"
          >
            <Icon aria-hidden="true" size={14} />
            <span>{label}</span>
            {!available ? <span className="ravi-control-area-state">Planned</span> : null}
          </button>
        ))}
      </nav>

      {createOpen ? (
        <form className="managed-ravi-create" onSubmit={createInstance}>
          <div className="field grow">
            <label htmlFor="managed-ravi-name">Name</label>
            <input
              autoFocus
              className="input"
              id="managed-ravi-name"
              maxLength={160}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Research installation"
              value={displayName}
            />
          </div>
          {projects.length > 1 ? (
            <div className="field">
              <label htmlFor="managed-ravi-project">Project</label>
              <select
                className="input"
                id="managed-ravi-project"
                onChange={(event) => setCreateProjectId(event.target.value)}
                value={createProjectId}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="managed-ravi-create-actions row gap-8">
            <Button disabled={createMutation.isPending} type="submit" variant="primary">
              {createMutation.isPending ? "Creating..." : "Create installation"}
            </Button>
            <Button onClick={() => setCreateOpen(false)} type="button" variant="ghost">
              Cancel
            </Button>
          </div>
          {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
        </form>
      ) : null}

      <div className="managed-ravi-workspace">
        <aside className="managed-ravi-list" aria-label="Ravi installations">
          <div className="managed-ravi-list-head row-between">
            <span className="t-label">Installations</span>
            <span className="t-mono t-tiny t-mute">{visibleInstances.length}</span>
          </div>
          {installationsQuery.isLoading ? (
            <div className="managed-ravi-list-empty">Loading instances...</div>
          ) : null}
          {!installationsQuery.isLoading && visibleInstances.length === 0 ? (
            <div className="managed-ravi-list-empty">
              <Bot size={18} />
              <span>No installations yet.</span>
            </div>
          ) : null}
          {visibleInstances.map((aggregate) => (
            <InstanceListItem
              aggregate={aggregate}
              isSelected={aggregate.instance.id === effectiveSelected?.instance.id}
              key={aggregate.instance.id}
              onSelect={() => setSelectedId(aggregate.instance.id)}
              projectLabel={aggregate.project.name}
            />
          ))}
        </aside>

        <section className="managed-ravi-detail" aria-live="polite">
          {effectiveSelected ? (
            <ManagedRaviDetail
              activeArea={activeArea}
              instanceId={effectiveSelected.instance.id}
              projectId={effectiveSelected.project.id}
            />
          ) : (
            <div className="managed-ravi-empty-detail">
              <Bot size={24} />
              <div className="t-h3">Create the first installation.</div>
              <div className="t-small t-mute">Provisioning and host setup run asynchronously.</div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function InstanceListItem({
  aggregate,
  isSelected,
  onSelect,
  projectLabel,
}: {
  aggregate: ManagedRaviAggregate;
  isSelected: boolean;
  onSelect: () => void;
  projectLabel?: string;
}) {
  const progress = aggregate.latestOperation?.progressPercent ?? 0;
  return (
    <button
      className={`managed-ravi-list-item${isSelected ? " is-active" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <div className="row-between gap-8">
        <span className="truncate t-mono">{aggregate.instance.displayName}</span>
        <StatusDot status={aggregate.instance.observedState} />
      </div>
      <div className="row-between gap-8 t-tiny t-mute">
        <span>{managedRaviReadableState(aggregate)}</span>
        <span>{relTime(new Date(aggregate.instance.updatedAt))}</span>
      </div>
      {projectLabel ? <div className="t-tiny t-mute truncate">{projectLabel}</div> : null}
      {isTransitioning(aggregate) ? <Progress value={progress} /> : null}
    </button>
  );
}

function ManagedRaviDetail({
  activeArea,
  projectId,
  instanceId,
}: {
  activeArea: ControlArea;
  projectId: string;
  instanceId: string;
}) {
  const queryClient = useQueryClient();
  const aggregateQuery = useManagedRavi(projectId, instanceId);
  const aggregate = aggregateQuery.data;
  const chatQuery = useRaviControlChat(projectId, instanceId, {
    enabled: Boolean(aggregate && aggregate.instance.observedState !== "deleted"),
  });
  const operationMutation = useManagedRaviOperation(projectId, instanceId);
  const sendMutation = useSendRaviControlMessage(projectId, instanceId);
  const syncMutation = useSyncRaviControlChat(projectId, instanceId);
  const interruptMutation = useInterruptRaviControlTurn(projectId, instanceId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [selectedBackupRef, setSelectedBackupRef] = useState("");
  const [prompt, setPrompt] = useState("");

  const messages = useMemo(
    () => chatQuery.data?.messages.filter(raviControlMessageText) ?? [],
    [chatQuery.data?.messages],
  );
  const activeTurn = [...messages]
    .reverse()
    .find(
      (message) =>
        message.operationId &&
        raviControlMessageRole(message) === "user" &&
        ACTIVE_MESSAGE_STATUSES.has(message.status),
    );
  const chatBusy = Boolean(activeTurn) || sendMutation.isPending || syncMutation.isPending;
  const online = aggregate?.connections.some(
    (connection) => connection.kind === "private_ravi_sdk" && connection.status === "online",
  ) ?? false;
  const canChat = aggregate?.instance.observedState === "ready" && online;
  const chatQueryKey = [
    "console",
    "projects",
    projectId,
    "ravi-control",
    instanceId,
    "chat",
  ] as const;

  async function runOperation(
    action: ManagedRaviOperationAction,
    backupRef?: string,
  ) {
    setActionError(null);
    try {
      await operationMutation.mutateAsync({
        action,
        ...(backupRef ? { backupRef } : {}),
        idempotencyKey: `${action}:${instanceId}:${crypto.randomUUID()}`,
      });
      setDeleteOpen(false);
      setRestoreOpen(false);
      await invalidateManagedRavi(queryClient, projectId, instanceId);
    } catch (error) {
      setActionError(managedRaviError(error));
    }
  }

  async function runChatAction(action: "sync" | "interrupt") {
    setActionError(null);
    try {
      if (action === "interrupt") {
        if (!activeTurn?.operationId) return;
        await interruptMutation.mutateAsync({
          idempotencyKey: `interrupt:${instanceId}:${crypto.randomUUID()}`,
          targetCommandId: activeTurn.operationId,
        });
      } else {
        await syncMutation.mutateAsync({
          idempotencyKey: `sync:${instanceId}:${crypto.randomUUID()}`,
        });
      }
      await queryClient.invalidateQueries({ queryKey: chatQueryKey });
    } catch (error) {
      setActionError(managedRaviError(error));
    }
  }

  async function sendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || !canChat || chatBusy) return;
    const nonce = crypto.randomUUID();
    setActionError(null);
    try {
      await sendMutation.mutateAsync({
        clientMessageId: `console:${nonce}`,
        idempotencyKey: `message:${instanceId}:${nonce}`,
        text: value,
      });
      setPrompt("");
      await queryClient.invalidateQueries({ queryKey: chatQueryKey });
    } catch (error) {
      setActionError(managedRaviError(error));
    }
  }

  if (aggregateQuery.isLoading || !aggregate) {
    return <div className="managed-ravi-empty-detail">Loading Ravi...</div>;
  }

  const actions = managedRaviLifecycleActions(aggregate);
  const operation = aggregate.latestOperation;
  const failureDiagnostic = managedRaviFailureDiagnostic(aggregate);

  return (
    <div className="managed-ravi-detail-grid">
      <header className="managed-ravi-detail-head">
        <div className="col gap-8 grow">
          <div className="row gap-8">
            <h2 className="t-h2 truncate">{aggregate.instance.displayName}</h2>
            <Tag dot tone={statusTone(aggregate.instance.observedState)}>
              {managedRaviReadableState(aggregate)}
            </Tag>
          </div>
          <div className="row gap-12 t-mono t-tiny t-mute managed-ravi-meta">
            <span>Codex</span>
            <span>{aggregate.instance.runtimeModel ?? "default model"}</span>
            <span>{online ? "SDK online" : "SDK offline"}</span>
          </div>
        </div>
        {activeArea === "overview" ? <div className="row gap-8 managed-ravi-actions">
          {actions.includes("start") ? (
            <Button disabled={operationMutation.isPending} icon={Play} onClick={() => runOperation("start")} size="sm">Start</Button>
          ) : null}
          {actions.includes("stop") ? (
            <Button disabled={operationMutation.isPending} icon={Square} onClick={() => runOperation("stop")} size="sm">Stop</Button>
          ) : null}
          {actions.includes("restart") ? (
            <Button disabled={operationMutation.isPending} icon={RotateCw} onClick={() => runOperation("restart")} size="sm">Restart</Button>
          ) : null}
          {actions.includes("backup") ? (
            <Button
              disabled={operationMutation.isPending}
              icon={DatabaseBackup}
              onClick={() => runOperation("backup")}
              size="sm"
            >
              Backup
            </Button>
          ) : null}
          {actions.includes("restore") ? (
            <Button
              disabled={operationMutation.isPending}
              icon={ArchiveRestore}
              onClick={() => {
                setDeleteOpen(false);
                setSelectedBackupRef(aggregate.backups[0]?.backupRef ?? "");
                setRestoreOpen(true);
              }}
              size="sm"
            >
              Restore
            </Button>
          ) : null}
          {actions.includes("retry") ? (
            <Button disabled={operationMutation.isPending} icon={RefreshCw} onClick={() => runOperation("retry")} size="sm">Retry</Button>
          ) : null}
          {actions.includes("delete") ? (
            <button
              aria-label="Delete Ravi"
              className="icon-btn"
              onClick={() => {
                setRestoreOpen(false);
                setDeleteOpen(true);
              }}
              title="Delete Ravi"
              type="button"
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div> : null}
      </header>

      {activeArea === "overview" && restoreOpen ? (
        <div className="managed-ravi-confirm managed-ravi-restore-confirm row-between gap-12">
          <div className="col gap-6 grow">
            <div className="row gap-8">
              <ArchiveRestore size={15} />
              <strong>Restore from backup</strong>
            </div>
            <span className="t-tiny t-mute">
              Replaces the physical VM, rotates controller access, and leaves the Ravi stopped.
            </span>
          </div>
          <select
            aria-label="Backup to restore"
            className="input managed-ravi-backup-select"
            onChange={(event) => setSelectedBackupRef(event.target.value)}
            value={selectedBackupRef}
          >
            {aggregate.backups.map((backup) => (
              <option key={backup.backupRef} value={backup.backupRef}>
                {formatBackupLabel(backup.createdAt, backup.sizeBytes)}
              </option>
            ))}
          </select>
          <div className="row gap-8">
            <Button
              disabled={operationMutation.isPending || !selectedBackupRef}
              onClick={() => runOperation("restore", selectedBackupRef)}
              size="sm"
              variant="danger"
            >
              Restore
            </Button>
            <Button onClick={() => setRestoreOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {activeArea === "overview" && deleteOpen ? (
        <div className="managed-ravi-confirm row-between gap-12">
          <div className="row gap-8">
            <AlertTriangle size={15} />
            <span>Delete this Ravi and its persistent VM?</span>
          </div>
          <div className="row gap-8">
            <Button disabled={operationMutation.isPending} onClick={() => runOperation("delete")} size="sm" variant="danger">
              Delete
            </Button>
            <Button onClick={() => setDeleteOpen(false)} size="sm" variant="ghost">Cancel</Button>
          </div>
        </div>
      ) : null}

      {operation && isTransitioning(aggregate) && ["overview", "operations"].includes(activeArea) ? (
        <div className="managed-ravi-progress col gap-8">
          <div className="row-between t-tiny t-mono">
            <span>{readableCode(operation.phase ?? aggregate.instance.provisioningPhase ?? operation.action)}</span>
            <span className="t-mute">{operation.progressPercent}%</span>
          </div>
          <Progress value={operation.progressPercent} />
        </div>
      ) : null}

      {failureDiagnostic && ["overview", "operations"].includes(activeArea) ? (
        <section className="managed-ravi-failure" role="alert">
          <div className="managed-ravi-failure-summary">
            <AlertTriangle aria-hidden="true" size={16} />
            <div className="col gap-4 grow">
              <strong>{failureDiagnostic.summary}</strong>
              <code>{failureDiagnostic.code}</code>
            </div>
          </div>
          <dl className="managed-ravi-failure-details">
            <div>
              <dt>Operation</dt>
              <dd>
                <span>{failureDiagnostic.action ? readableCode(failureDiagnostic.action) : "Unknown"}</span>
                {failureDiagnostic.operationId ? (
                  <button
                    aria-label="Copy operation reference"
                    className="managed-ravi-copy-operation"
                    onClick={() => void navigator.clipboard.writeText(failureDiagnostic.operationId ?? "")}
                    title="Copy operation reference"
                    type="button"
                  >
                    <span>{failureDiagnostic.operationId.slice(0, 8)}</span>
                    <Copy size={12} />
                  </button>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Phase</dt>
              <dd>{failureDiagnostic.phase ? readableCode(failureDiagnostic.phase) : "Not reported"}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{formatManagedRaviTimestamp(failureDiagnostic.completedAt)}</dd>
            </div>
          </dl>
          <p>{failureDiagnostic.guidance}</p>
        </section>
      ) : null}

      {actionError ? <div className="form-banner form-banner--err">{actionError}</div> : null}

      {activeArea === "overview" ? (
        <section className="ravi-control-panel" aria-label="Installation overview">
          <div className="ravi-control-panel-head">
            <h3 className="t-h3">Installation</h3>
            <span className="t-tiny t-mute">Managed · Codex</span>
          </div>
          <dl className="ravi-control-facts">
            <div><dt>Desired</dt><dd>{aggregate.instance.desiredState}</dd></div>
            <div><dt>Observed</dt><dd>{managedRaviReadableState(aggregate)}</dd></div>
            <div><dt>Connection</dt><dd>{online ? "Online" : "Offline"}</dd></div>
            <div><dt>Runtime</dt><dd>{aggregate.instance.runtimeVersion ?? "Not reported"}</dd></div>
            <div><dt>Model</dt><dd>{aggregate.instance.runtimeModel ?? "Default"}</dd></div>
            <div><dt>Backups</dt><dd>{aggregate.backups.length}</dd></div>
          </dl>
        </section>
      ) : null}

      {activeArea === "operations" ? (
        <section className="ravi-control-panel" aria-label="Installation operations">
          <div className="ravi-control-panel-head">
            <h3 className="t-h3">Latest operation</h3>
            <span className="t-tiny t-mute">Durable Console ledger</span>
          </div>
          {operation ? (
            <dl className="ravi-control-facts">
              <div><dt>Action</dt><dd>{readableCode(operation.action)}</dd></div>
              <div><dt>Status</dt><dd>{readableCode(operation.status)}</dd></div>
              <div><dt>Phase</dt><dd>{readableCode(operation.phase ?? "not_reported")}</dd></div>
              <div><dt>Progress</dt><dd>{operation.progressPercent}%</dd></div>
              <div><dt>Attempts</dt><dd>{operation.attemptCount}</dd></div>
              <div><dt>Updated</dt><dd>{relTime(new Date(operation.updatedAt))}</dd></div>
            </dl>
          ) : (
            <div className="ravi-control-panel-empty">No operation has been recorded.</div>
          )}
          {aggregate.backups.length > 0 ? (
            <div className="ravi-control-backups">
              <div className="t-label">Backups</div>
              {aggregate.backups.map((backup) => (
                <div className="row-between gap-12" key={backup.backupRef}>
                  <span>{formatManagedRaviTimestamp(backup.createdAt)}</span>
                  <span className="t-mono t-mute">{formatBytes(backup.sizeBytes)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {activeArea === "activity" ? (
        <section className="ravi-control-panel" aria-label="Installation activity">
          <div className="ravi-control-panel-head">
            <h3 className="t-h3">Activity</h3>
            <span className="t-tiny t-mute">Safe operational projection</span>
          </div>
          <div className="ravi-control-activity">
            {operation ? (
              <div className="ravi-control-activity-row">
                <StatusDot status={operation.status} />
                <div className="grow">
                  <div>{readableCode(operation.action)}</div>
                  <div className="t-tiny t-mute">{readableCode(operation.status)} · {readableCode(operation.phase ?? "not_reported")}</div>
                </div>
                <time className="t-tiny t-mute">{relTime(new Date(operation.updatedAt))}</time>
              </div>
            ) : null}
            {aggregate.backups.map((backup) => (
              <div className="ravi-control-activity-row" key={backup.backupRef}>
                <DatabaseBackup aria-hidden="true" size={13} />
                <div className="grow">
                  <div>Backup completed</div>
                  <div className="t-tiny t-mute">{formatBytes(backup.sizeBytes)}</div>
                </div>
                <time className="t-tiny t-mute">{relTime(new Date(backup.createdAt))}</time>
              </div>
            ))}
            {!operation && aggregate.backups.length === 0 ? (
              <div className="ravi-control-panel-empty">No activity has been recorded.</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {activeArea === "chat" ? <section className="managed-ravi-chat" aria-label="Ravi conversation">
        <div className="managed-ravi-chat-head row-between">
          <div className="row gap-8">
            <MessageSquareText size={14} />
            <span className="t-h3">Conversation</span>
            {chatQuery.data?.binding ? (
              <span className="t-tiny t-mute">
                {chatQuery.data.binding.status === "active" ? "Canonical" : "Connecting"}
              </span>
            ) : null}
          </div>
          <div className="row gap-8">
            {activeTurn ? (
              <Button
                disabled={interruptMutation.isPending}
                icon={CircleStop}
                onClick={() => runChatAction("interrupt")}
                size="sm"
                variant="danger"
              >
                Interrupt
              </Button>
            ) : null}
            <button
              aria-label="Sync history"
              className="icon-btn"
              disabled={
                !canChat ||
                chatBusy ||
                chatQuery.data?.binding?.status !== "active" ||
                interruptMutation.isPending
              }
              onClick={() => runChatAction("sync")}
              title="Sync history"
              type="button"
            >
              <RefreshCw className={syncMutation.isPending ? "managed-ravi-spin" : undefined} size={14} />
            </button>
          </div>
        </div>

        <div className="managed-ravi-messages">
          {chatQuery.isLoading ? (
            <div className="managed-ravi-chat-empty">Loading canonical history...</div>
          ) : null}
          {!chatQuery.isLoading && messages.length === 0 ? (
            <div className="managed-ravi-chat-empty">
              {canChat ? "Send the first message." : "Conversation becomes available when this installation is ready."}
            </div>
          ) : null}
          {messages.map((message) => {
            const role = raviControlMessageRole(message);
            return (
            <div className={`managed-ravi-message managed-ravi-message--${role}`} key={message.mirrorId}>
              <div className="t-label">{role === "assistant" ? "Ravi" : "You"}</div>
              <div className="managed-ravi-message-text">{raviControlMessageText(message)}</div>
              {message.status === "failed" ? (
                <div className="t-tiny t-danger">
                  {readableCode(message.failureCode ?? "message_delivery_failed")}
                </div>
              ) : null}
            </div>
            );
          })}
          {activeTurn ? (
            <div className="managed-ravi-chat-activity row gap-8 t-tiny t-mute" role="status">
              <LoaderCircle className="managed-ravi-spin" size={12} />
              <span>Ravi is working</span>
            </div>
          ) : null}
        </div>

        <form className="managed-ravi-composer" onSubmit={sendPrompt}>
          <textarea
            aria-label="Message Ravi"
            className="textarea"
            disabled={!canChat || chatBusy}
            maxLength={32_000}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={canChat ? "Message Ravi" : "Installation is not ready"}
            rows={2}
            value={prompt}
          />
          <button
            aria-label="Send message"
            className="managed-ravi-send"
            disabled={!canChat || chatBusy || !prompt.trim()}
            title="Send message"
            type="submit"
          >
            <Send size={15} />
          </button>
        </form>
      </section> : null}
    </div>
  );
}

function raviControlMessageText(message: RaviControlChatMessage) {
  const text = message.content.text;
  return typeof text === "string" && text.trim() ? text : null;
}

function raviControlMessageRole(
  message: RaviControlChatMessage,
): "assistant" | "user" {
  return message.actorType === "agent" || message.actorType === "assistant"
    ? "assistant"
    : "user";
}

function isTransitioning(aggregate: ManagedRaviAggregate) {
  return ["provisioning", "starting", "stopping", "restarting", "deleting"].includes(
    aggregate.instance.observedState,
  );
}

async function invalidateManagedRavi(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  instanceId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "managed-ravis"] }),
    queryClient.invalidateQueries({
      queryKey: ["console", "projects", projectId, "managed-ravis", instanceId],
    }),
  ]);
}

function managedRaviError(error: unknown) {
  if (error instanceof ConsoleApiClientError) return readableCode(error.payload.error);
  return "Ravi Control request failed.";
}

function formatBackupLabel(createdAt: string, sizeBytes: number) {
  const date = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(createdAt));
  return `${date} · ${formatBytes(sizeBytes)}`;
}

function formatManagedRaviTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
