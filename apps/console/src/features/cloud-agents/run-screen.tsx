"use client";

import { ArrowLeft, Check, Download, FileText, Send, ShieldQuestion, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { CloudApproval, CloudRun, CloudRunEvent } from "@/server/console/cloud-agents/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyValue } from "@/ui/copy";
import { Field, FormMessage, Input, Textarea } from "@/ui/form";
import { PageHeader, Panel, Section } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";

import {
  cloudErrorText,
  outputHref,
  useCloudRun,
  useCloudRunEvents,
  useDecideCloudApproval,
  useSendCloudRunMessage,
  useStopCloudRun,
} from "./api";
import { CloudProjectGate, type CloudScope } from "./cloud-frame";
import {
  approvalStatus,
  canFollowUp,
  eventLine,
  formatBytes,
  formatSeconds,
  formatTokens,
  formatUsd,
  isActiveRun,
  runDuration,
  runStatus,
  triggerLabel,
} from "./format";

export function CloudRunScreen({ projectId, runId }: { projectId: string; runId: string }) {
  return <CloudProjectGate projectRef={projectId}>{(scope) => <RunDetail runId={runId} scope={scope} />}</CloudProjectGate>;
}

function RunDetail({ runId, scope }: { runId: string; scope: CloudScope }) {
  const { organization } = useWorkspace();
  const query = useCloudRun(runId);
  const run = query.data;
  const back = (
    <Button className="-ml-2.5 mb-3" href={`/p/${scope.project.id}/cloud/runs`} icon={ArrowLeft} size="sm" variant="ghost">
      All runs
    </Button>
  );

  if (query.isPending) {
    return (
      <>
        {back}
        <div aria-busy aria-label="Loading" className="space-y-4" role="status">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-48 w-full" />
        </div>
      </>
    );
  }
  if (query.isError || !run) {
    return (
      <>
        {back}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} role={roleLabel(organization.role)} title="This run couldn't load" />
      </>
    );
  }
  return (
    <>
      {back}
      <RunView canWrite={scope.availability.canWrite} canManageKey={scope.availability.canManageKey} run={run} viewerId={scope.viewerId} />
    </>
  );
}

function RunView({ canManageKey, canWrite, run, viewerId }: { canManageKey: boolean; canWrite: boolean; run: CloudRun; viewerId: string }) {
  const [stopOpen, setStopOpen] = useState(false);
  const status = runStatus(run.status);
  const active = isActiveRun(run);
  const events = useCloudRunEvents(run.id, active);
  const pending = run.approvals.filter((approval) => approval.status === "pending");
  const decided = run.approvals.filter((approval) => approval.status !== "pending");
  // Approvals are the run's actor's to decide, or an owner's or admin's.
  const canDecide = canWrite && (run.actor.id === viewerId || canManageKey);
  // Follow-ups too; an owner or admin who is not the actor takes the run over by sending.
  const canMessage = canDecide;

  return (
    <>
      <PageHeader
        actions={
          canWrite && active ? (
            <Button icon={Square} onClick={() => setStopOpen(true)} variant="danger">
              Stop run
            </Button>
          ) : null
        }
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words">{run.agentName}</span>
            <Badge dot={active} title={status.hint} tone={status.tone}>
              {status.label}
            </Badge>
          </span>
        }
      >
        <p className="text-[13px] text-ink-3">
          {triggerLabel(run.trigger)} · acts as {run.actor.name} · started <RelativeTime value={run.startedAt} />
        </p>
      </PageHeader>

      <StatusAnnouncer label={status.label} />

      {run.error && run.status === "failed" ? (
        <Notice className="mb-4" title="The run failed" tone="err">
          {run.error.message || run.error.code}
        </Notice>
      ) : run.error && active ? (
        <Notice className="mb-4" title="The latest update from Anthropic didn't arrive" tone="warn">
          {run.error.message || run.error.code} Ravi tries again on its own.
        </Notice>
      ) : null}
      {run.status === "budget_exceeded" && !run.error ? (
        <Notice className="mb-4" title="The run reached its budget" tone="warn">
          It spent {formatUsd(run.costUsd)} of {formatUsd(run.budgetUsd)} and was stopped. Start a new run with a larger budget to go on.
        </Notice>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          {pending.length ? (
            <Section
              description={
                canDecide
                  ? "The agent stopped to ask before it changes something outside its sandbox. It goes on once you decide."
                  : `The agent waits for ${run.actor.name}, or an owner or admin, to decide.`
              }
              title={pending.length === 1 ? "Waiting for approval" : `${pending.length} changes wait for approval`}
            >
              {pending.map((approval) => (
                <ApprovalCard approval={approval} canDecide={canDecide} key={approval.id} runId={run.id} />
              ))}
            </Section>
          ) : null}

          <Section title="Asked">
            <Panel padded>
              <p className="text-sm whitespace-pre-wrap break-words text-ink">{run.prompt}</p>
            </Panel>
          </Section>

          {run.result ? (
            <Section title={active ? "Latest answer" : "Result"}>
              <Panel padded>
                <p className="text-sm whitespace-pre-wrap break-words text-ink">{run.result}</p>
              </Panel>
            </Section>
          ) : null}

          <Section
            description={active ? "Updates on its own while the run works." : undefined}
            title="Activity"
          >
            <Timeline active={active} events={events.data?.events} error={events.isError ? events.error : null} onRetry={() => void events.refetch()} />
          </Section>

          {canMessage && canFollowUp(run) ? <FollowUp run={run} takesOver={run.actor.id !== viewerId} /> : null}

          {decided.length ? (
            <Section title="Decisions">
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {decided.map((approval) => {
                  const state = approvalStatus(approval.status);
                  return (
                    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm" key={approval.id}>
                      <span className="font-mono text-[13px] text-ink">{approval.tool}</span>
                      <Badge tone={state.tone}>{state.label}</Badge>
                      <span className="text-[13px] text-ink-3">
                        {approval.decidedBy ? `by ${approval.decidedBy.name} ` : ""}
                        {approval.decidedAt ? <RelativeTime value={approval.decidedAt} /> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ) : null}
        </div>

        <aside aria-label="Run details" className="space-y-6">
          <Panel className="px-4">
            <dl className="divide-y divide-line text-sm">
              <Fact label="Cost">
                {formatUsd(run.costUsd)} <span className="text-ink-3">of {formatUsd(run.budgetUsd)}</span>
              </Fact>
              <Fact label="Working time">{formatSeconds(run.runningSeconds)}</Fact>
              <Fact label="Duration">{runDuration(run) ?? "Unknown"}</Fact>
              <Fact label="Tokens in">{formatTokens(run.tokens.input)}</Fact>
              <Fact label="Tokens out">{formatTokens(run.tokens.output)}</Fact>
              <Fact label="Cache read / write">
                {formatTokens(run.tokens.cacheRead)} / {formatTokens(run.tokens.cacheWrite)}
              </Fact>
              <Fact label="Started">{formatDate(run.startedAt, true)}</Fact>
              {run.endedAt ? <Fact label="Ended">{formatDate(run.endedAt, true)}</Fact> : null}
              <Fact label="Run">
                <CopyValue display={`${run.id.slice(0, 8)}…`} value={run.id} />
              </Fact>
            </dl>
          </Panel>
          <Outputs run={run} />
        </aside>
      </div>

      <StopDialog onClose={() => setStopOpen(false)} open={stopOpen} run={run} />
    </>
  );
}

function Fact({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

/** Says the run's status to screen readers when it changes, not on first render. */
function StatusAnnouncer({ label }: { label: string }) {
  const [said, setSaid] = useState("");
  const first = useRef(label);
  useEffect(() => {
    if (label !== first.current) setSaid(`Run status: ${label}`);
  }, [label]);
  return (
    <p aria-live="polite" className="sr-only" role="status">
      {said}
    </p>
  );
}

function ApprovalCard({ approval, canDecide, runId }: { approval: CloudApproval; canDecide: boolean; runId: string }) {
  const toast = useToast();
  const decide = useDecideCloudApproval(runId);
  const [denyOpen, setDenyOpen] = useState(false);
  const [reason, setReason] = useState("");
  const approve = () =>
    decide.mutate(
      { approvalId: approval.id, decision: "approve" },
      { onError: (error) => toast.show(cloudErrorText(error), "err"), onSuccess: () => toast.show(`Approved ${approval.tool}. The agent goes on.`) },
    );
  const deny = () =>
    decide.mutate(
      { approvalId: approval.id, decision: "deny", reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setDenyOpen(false);
          setReason("");
          toast.show(`Denied ${approval.tool}. The agent hears why and goes on without it.`);
        },
      },
    );

  return (
    <Panel as="article" className="border-warn/40" padded>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <ShieldQuestion aria-hidden className="mt-0.5 shrink-0 text-warn" size={18} />
            <div className="min-w-0">
              <h3 className="text-sm font-medium break-words text-ink">
                <span className="font-mono text-[13px]">{approval.tool}</span>
                {approval.server ? <span className="font-normal text-ink-3"> on {approval.server}</span> : null}
              </h3>
              <p className="text-[13px] text-ink-3">
                Asked <RelativeTime value={approval.requestedAt} />
              </p>
            </div>
          </div>
          {canDecide ? (
            <div className="flex shrink-0 gap-2">
              <Button disabled={decide.isPending} icon={X} onClick={() => setDenyOpen(true)} variant="secondary">
                Deny
              </Button>
              <Button icon={Check} loading={decide.isPending && decide.variables?.decision === "approve"} onClick={approve} variant="primary">
                Approve
              </Button>
            </div>
          ) : null}
        </div>
        {approval.inputPreview ? (
          <pre
            aria-label={`What ${approval.tool} would receive`}
            className="max-h-64 overflow-auto rounded-md border border-line bg-sunken px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink"
            tabIndex={0}
          >
            {approval.inputPreview}
          </pre>
        ) : null}
      </div>

      <Dialog
        description="The agent is told you said no, with your reason if you give one, and goes on without this change."
        footer={
          <>
            <Button onClick={() => setDenyOpen(false)} variant="ghost">
              Cancel
            </Button>
            <Button loading={decide.isPending} onClick={deny} variant="danger">
              Deny
            </Button>
          </>
        }
        onClose={() => {
          decide.reset();
          setDenyOpen(false);
        }}
        open={denyOpen}
        title={`Deny ${approval.tool}?`}
      >
        <Field label="Reason" optional>
          {(props) => (
            <Input {...props} autoFocus maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Not this customer" value={reason} />
          )}
        </Field>
        {decide.isError ? (
          <div className="mt-3">
            <FormMessage>{cloudErrorText(decide.error)}</FormMessage>
          </div>
        ) : null}
      </Dialog>
    </Panel>
  );
}

function Timeline({
  active,
  error,
  events,
  onRetry,
}: {
  active: boolean;
  error: unknown;
  events: CloudRunEvent[] | undefined;
  onRetry: () => void;
}) {
  if (!events) {
    if (error) return <ErrorState error={error} onRetry={onRetry} title="The activity couldn't load" />;
    return (
      <div aria-busy aria-label="Loading activity" className="space-y-2" role="status">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  const lines = events.map((event) => ({ event, line: eventLine(event) })).filter((entry) => entry.line !== null);
  if (lines.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong bg-surface px-4 py-6 text-center text-sm text-ink-3">
        {active ? "Nothing yet. The agent's messages and tool calls show up here as they happen." : "This run recorded no activity."}
      </p>
    );
  }
  return (
    <ol aria-label="Run activity" className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {lines.map(({ event, line }) => (
        <li className="px-4 py-3" key={event.seq}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span
              className={cn(
                "text-[13px] font-medium",
                line!.tone === "err" ? "text-err" : line!.tone === "warn" ? "text-warn" : line!.tone === "info" ? "text-info" : "text-ink",
              )}
            >
              {line!.title}
            </span>
            <time className="text-xs text-ink-3" dateTime={event.at}>
              {formatDate(event.at, true)}
            </time>
          </div>
          {line!.body ? (
            <p
              className={cn(
                "mt-1 text-sm whitespace-pre-wrap break-words",
                event.type === "message" ? "text-ink-2" : "font-mono text-[12px] text-ink-3",
              )}
            >
              {line!.body}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function FollowUp({ run, takesOver }: { run: CloudRun; takesOver: boolean }) {
  const send = useSendCloudRunMessage(run.id);
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) {
      setError("Write the message first.");
      return;
    }
    setError(null);
    send.mutate(text.trim(), {
      onSuccess: () => {
        setText("");
        toast.show("Sent. The agent reads it next.");
      },
    });
  };
  return (
    <Section
      description={[
        run.status === "completed" ? "The run picks up where it stopped, with the same budget." : "The agent reads it after what it's doing now.",
        takesOver ? `Sending makes you the person this run acts for, instead of ${run.actor.name}: its Ravi tools and approvals become yours.` : null,
      ]
        .filter(Boolean)
        .join(" ")}
      title="Follow up"
    >
      <form className="space-y-2" noValidate onSubmit={submit}>
        <Field error={error} label="Message to the agent">
          {(props) => (
            <Textarea
              {...props}
              maxLength={100_000}
              onChange={(event) => {
                send.reset();
                setText(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Also include the numbers from last month."
              value={text}
            />
          )}
        </Field>
        {send.isError ? <FormMessage>{cloudErrorText(send.error)}</FormMessage> : null}
        <div className="flex justify-end">
          <Button icon={Send} loading={send.isPending} type="submit" variant="primary">
            Send
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Outputs({ run }: { run: CloudRun }) {
  return (
    <Section title="Files">
      {run.outputs.length === 0 ? (
        <p className="text-[13px] text-ink-3">
          {isActiveRun(run) ? "Files the agent saves as deliverables show up here." : "The agent saved no files."}
        </p>
      ) : (
        <ul aria-label="Files from this run" className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {run.outputs.map((output) => (
            <li className="flex items-center gap-3 px-3 py-2.5" key={output.id}>
              <FileText aria-hidden className="shrink-0 text-ink-3" size={16} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink" title={output.name}>
                  {output.name}
                </div>
                <div className="text-xs text-ink-3">{formatBytes(output.size)}</div>
              </div>
              <a
                aria-label={`Download ${output.name}`}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
                download={output.name}
                href={outputHref(run.id, output.id)}
                title={`Download ${output.name}`}
              >
                <Download aria-hidden size={16} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function StopDialog({ onClose, open, run }: { onClose: () => void; open: boolean; run: CloudRun }) {
  const stop = useStopCloudRun(run.id);
  const toast = useToast();
  const close = () => {
    stop.reset();
    onClose();
  };
  return (
    <Dialog
      description="The agent stops now and its access to Ravi ends. What it spent so far is kept, and so are its messages and files."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Keep running
          </Button>
          <Button
            loading={stop.isPending}
            onClick={() =>
              stop.mutate(undefined, {
                onSuccess: () => {
                  toast.show("The run is stopped.");
                  close();
                },
              })
            }
            variant="danger"
          >
            Stop run
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title="Stop this run?"
    >
      {stop.isError ? <FormMessage>{cloudErrorText(stop.error)}</FormMessage> : null}
    </Dialog>
  );
}
