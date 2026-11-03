"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { Button, Card, CardBody, CardHeader, PageHeader, SlashMark, Tag } from "@/components/ui";
import { BugDossier, BugFollowUps } from "@/features/console/bug-dossier-view";
import {
  ConsoleApiClientError,
  useAdminBugReport,
  useAdminBugReports,
  useApplyAdminBugTriage,
  useDeleteAdminBugReport,
  useEnqueueAdminBugTriage,
  useStoreAdminBugTriage,
  useUpdateAdminBugStatus,
} from "@/features/console/queries";
import {
  relTime,
  type AdminBugReportDetail,
  type AdminBugReportSummary,
  type AdminTriageState,
  type BugReportPriority,
  type BugReportSeverity,
  type BugReportStatus,
} from "@/features/console/types";

const STATUSES: BugReportStatus[] = ["submitted", "triaging", "in_progress", "resolved", "wontfix", "duplicate"];
const PRIORITIES: BugReportPriority[] = ["p0", "p1", "p2", "p3"];

export function BugOpsInboxScreen() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = useMemo(
    () => ({
      status: (searchParams.get("status") ?? "") as BugReportStatus | "",
      priority: (searchParams.get("priority") ?? "") as BugReportPriority | "",
      surface: searchParams.get("surface") ?? "",
      q: searchParams.get("q") ?? "",
    }),
    [searchParams],
  );
  const query = useAdminBugReports({
    status: filters.status || undefined,
    priority: filters.priority || undefined,
    surface: filters.surface || undefined,
    q: filters.q || undefined,
  });
  const items = query.data?.items ?? [];

  function setFilter(name: keyof typeof filters, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    const encoded = next.toString();
    router.replace(encoded ? `${pathname}?${encoded}` : pathname);
  }

  return (
    <>
      <PageHeader
        slashLabel="manage"
        slashNum={1}
        sub="Global inbox. Model suggestions stay suggestions until you confirm status, priority, or a duplicate."
        title="Bug ops"
        right={
          <Button disabled={query.isFetching} icon={RefreshCw} onClick={() => void query.refetch()} size="sm">
            Refresh
          </Button>
        }
      />
      <Card>
        <CardHeader
          right={
            <span className="t-tiny t-mute">
              {query.data ? `${query.data.total} matching · sorted by priority score` : "loading"}
            </span>
          }
        >
          <SlashMark label="inbox" num={1} />
        </CardHeader>
        <CardBody>
          <div className="col gap-16">
            <form
              className="grid grid-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setFilter("q", String(form.get("q") ?? "").trim());
                setFilter("surface", String(form.get("surface") ?? "").trim());
              }}
            >
              <div className="field">
                <label htmlFor="bugs-ops-q">Search</label>
                <input className="input" defaultValue={filters.q} id="bugs-ops-q" name="q" placeholder="title or summary" />
              </div>
              <div className="field">
                <label htmlFor="bugs-ops-surface">Surface</label>
                <input className="input" defaultValue={filters.surface} id="bugs-ops-surface" name="surface" placeholder="cli, pages, harness" />
              </div>
              <div className="field">
                <label htmlFor="bugs-ops-status">Status</label>
                <select
                  className="select"
                  id="bugs-ops-status"
                  onChange={(event) => setFilter("status", event.target.value)}
                  value={filters.status}
                >
                  <option value="">any status</option>
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="bugs-ops-priority">Priority</label>
                <select
                  className="select"
                  id="bugs-ops-priority"
                  onChange={(event) => setFilter("priority", event.target.value)}
                  value={filters.priority}
                >
                  <option value="">any priority</option>
                  {PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row gap-8" style={{ alignItems: "end" }}>
                <Button size="sm" type="submit">
                  Apply filters
                </Button>
              </div>
            </form>
            {query.data === undefined ? (
              <LoadingState label="Loading bug ops inbox" />
            ) : query.isError ? (
              <EmptyState title="Inbox unavailable" body="The staff inbox could not be loaded for this session." />
            ) : items.length === 0 ? (
              <EmptyState title="No matching reports" body="Adjust filters or wait for new reports. Reporter /bugs is unchanged." />
            ) : (
              <div className="col gap-12">
                {items.map((item) => (
                  <InboxRow item={item} key={item.id} />
                ))}
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </>
  );
}

function InboxRow({ item }: { item: AdminBugReportSummary }) {
  return (
    <Link
      className="col gap-8"
      href={`/manage/bugs/${item.id}`}
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--radius)",
        padding: 14,
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div className="row-between gap-12" style={{ alignItems: "flex-start" }}>
        <div className="col gap-4" style={{ minWidth: 0 }}>
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            <Tag tone={priorityTone(item.priority)}>{item.priority ?? "unranked"}</Tag>
            <Tag>{scoreLabel(item.priorityScore)}</Tag>
            <Tag tone={statusTone(item.status)}>{item.status}</Tag>
            <Tag dot tone={severityTone(item.severity)}>
              {item.severity}
            </Tag>
            {item.surface ? <Tag>{item.surface}</Tag> : null}
          </div>
          <div className="t-strong">{item.title}</div>
          <SuggestionLine item={item} />
        </div>
        <span className="t-mono t-tiny t-mute">{relTime(item.updatedAt)}</span>
      </div>
    </Link>
  );
}

function SuggestionLine({ item }: { item: AdminBugReportSummary }) {
  const state = inboxTriageState(item);
  if (state === "pending") {
    return <span className="t-tiny t-mute">triaging… suggestion not ready to confirm</span>;
  }
  if (state === "failed") {
    return <span className="t-tiny t-mute">triage failed · {item.triageJob?.lastError ?? "retry from detail"}</span>;
  }
  if (state === "idle") {
    return <span className="t-tiny t-mute">waiting for triage</span>;
  }
  if (!item.triage) {
    return <span className="t-tiny t-mute">no stored triage</span>;
  }
  const pendingPriority = item.triage.suggestedPriority !== item.priority;
  const pendingStatus = item.triage.suggestedStatus && item.triage.suggestedStatus !== item.status;
  return (
    <span className="t-tiny t-mute">
      suggested {item.triage.suggestedPriority}
      {item.triage.suggestedStatus ? ` / ${item.triage.suggestedStatus}` : ""}
      {pendingPriority || pendingStatus ? " · not confirmed" : " · matches confirmed fields"}
      {` · ${Math.round(item.triage.confidence * 100)}%`}
    </span>
  );
}

export function BugOpsDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const query = useAdminBugReport(id);
  const report = query.data;

  return (
    <>
      <PageHeader
        slashLabel="manage"
        slashNum={1}
        sub="Confirm model suggestions before they become product fields. Reporter /bugs never sees triage_json."
        title={report?.title ?? "Bug ops"}
        right={
          <div className="row gap-8">
            <Button disabled={query.isFetching} icon={RefreshCw} onClick={() => void query.refetch()} size="sm">
              Refresh
            </Button>
            <Button href="/manage/bugs" icon={ArrowLeft} size="sm">
              Inbox
            </Button>
          </div>
        }
      />
      {query.data === undefined ? (
        <LoadingState label="Loading bug report" />
      ) : query.isError || !report ? (
        <Card>
          <CardBody>
            <EmptyState title="Report not found" body="This report does not exist, or this session cannot access bug ops." />
          </CardBody>
        </Card>
      ) : (
        <BugOpsDetailBody onDeleted={() => router.push("/manage/bugs")} report={report} />
      )}
    </>
  );
}

function BugOpsDetailBody({
  onDeleted,
  report,
}: {
  onDeleted: () => void;
  report: AdminBugReportDetail;
}) {
  const queryClient = useQueryClient();
  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ["console", "manage", "bugs"] });
  }

  return (
    <div className="col gap-16">
      <div className="grid grid-2">
        <Card>
          <CardHeader>
            <SlashMark label="confirmed" num={1} />
          </CardHeader>
          <CardBody>
            <div className="col gap-12">
              <div className="row gap-8" style={{ flexWrap: "wrap" }}>
                <Tag tone={priorityTone(report.priority)}>{report.priority ?? "unranked"}</Tag>
                <Tag>{scoreLabel(report.priorityScore)}</Tag>
                <Tag tone={statusTone(report.status)}>{report.status}</Tag>
                <Tag dot tone={severityTone(report.severity)}>
                  {report.severity}
                </Tag>
                {report.surface ? <Tag>{report.surface}</Tag> : null}
              </div>
              <p className="t-body" style={{ margin: 0 }}>
                {report.summary}
              </p>
              {report.statusNote ? (
                <div className="col gap-4">
                  <span className="t-tiny t-mute">status note</span>
                  <p className="t-body" style={{ margin: 0 }}>
                    {report.statusNote}
                  </p>
                </div>
              ) : null}
              <div className="row gap-12" style={{ flexWrap: "wrap" }}>
                <Meta label="reporter" value={report.reporterUserId} />
                <Meta label="assignee" value={report.assigneeUserId ?? "unassigned"} />
                <Meta label="duplicate of" value={report.duplicateOfId ?? "none"} />
                <Meta label="updated" value={relTime(report.updatedAt)} />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <SlashMark label="model suggests" num={2} />
          </CardHeader>
          <CardBody>
            {report.triageJson ? (
              <div className="col gap-12">
                <TriageSuggestion triage={report.triageJson} />
                <RunTriageAgain onSaved={invalidate} report={report} />
              </div>
            ) : (
              <PendingTriageState onSaved={invalidate} report={report} />
            )}
          </CardBody>
        </Card>
      </div>
      <StatusForm onSaved={invalidate} report={report} />
      <ApplyTriageForm onSaved={invalidate} report={report} />
      <StoreTriageForm onSaved={invalidate} report={report} />
      <Card>
        <CardHeader>
          <SlashMark label="dossier" num={6} />
        </CardHeader>
        <CardBody>
          <BugDossier headerSummary={report.summary} payload={report.payload} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <SlashMark label="follow-ups" num={7} />
        </CardHeader>
        <CardBody>
          <BugFollowUps comments={report.comments} />
        </CardBody>
      </Card>
      <DeleteReportForm onDeleted={onDeleted} report={report} />
    </div>
  );
}

function TriageSuggestion({ triage }: { triage: NonNullable<AdminBugReportDetail["triageJson"]> }) {
  return (
    <div className="col gap-12">
      <div className="row gap-8" style={{ flexWrap: "wrap" }}>
        <Tag tone={priorityTone(triage.suggestedPriority)}>suggested {triage.suggestedPriority}</Tag>
        {triage.suggestedStatus ? <Tag tone={statusTone(triage.suggestedStatus)}>suggested {triage.suggestedStatus}</Tag> : null}
        <Tag>{`${Math.round(triage.confidence * 100)}%`}</Tag>
        <Tag>{triage.model}</Tag>
      </div>
      <p className="t-body" style={{ margin: 0 }}>
        {triage.summary}
      </p>
      {triage.similarBugIds.length > 0 ? (
        <div className="col gap-4">
          <span className="t-tiny t-mute">similar</span>
          <div className="col gap-4">
            {triage.similarBugIds.map((id) => (
              <Link className="t-mono t-tiny" href={`/manage/bugs/${id}`} key={id}>
                {id}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      {triage.missingEvidence.length > 0 ? <ListBlock label="missing evidence" items={triage.missingEvidence} /> : null}
      {triage.clarifyingQuestions.length > 0 ? <ListBlock label="questions" items={triage.clarifyingQuestions} /> : null}
      {triage.rawNotes ? (
        <div className="col gap-4">
          <span className="t-tiny t-mute">raw notes</span>
          <p className="t-body" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {triage.rawNotes}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function StatusForm({ onSaved, report }: { onSaved: () => Promise<void>; report: AdminBugReportDetail }) {
  const mutation = useUpdateAdminBugStatus(report.id);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const status = String(form.get("status")) as BugReportStatus;
    const statusNote = emptyToNull(String(form.get("statusNote") ?? ""));
    const priorityRaw = String(form.get("priority") ?? "");
    const duplicateOf = emptyToNull(String(form.get("duplicateOf") ?? ""));
    const assigneeUserId = emptyToNull(String(form.get("assigneeUserId") ?? ""));
    setError(null);
    setSaved(false);
    try {
      await mutation.mutateAsync({
        status,
        statusNote,
        ...(priorityRaw ? { priority: priorityRaw as BugReportPriority } : {}),
        ...(duplicateOf ? { duplicateOf } : {}),
        ...(assigneeUserId ? { assigneeUserId } : {}),
      });
      setSaved(true);
      await onSaved();
    } catch (caught) {
      setError(mutationError(caught));
    }
  }

  return (
    <Card>
      <CardHeader>
        <SlashMark label="set fields" num={3} />
      </CardHeader>
      <CardBody>
        <form className="col gap-12" onSubmit={(event) => void onSubmit(event)}>
          {error ? <div className="form-banner form-banner--err">{error}</div> : null}
          {saved ? <div className="form-banner">Status write saved.</div> : null}
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="ops-status">Status</label>
              <select className="select" defaultValue={report.status} id="ops-status" name="status">
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ops-priority">Priority</label>
              <select className="select" defaultValue={report.priority ?? ""} id="ops-priority" name="priority">
                <option value="">leave unchanged</option>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ops-assignee">Assignee user id</label>
              <input className="input t-mono" defaultValue={report.assigneeUserId ?? ""} id="ops-assignee" name="assigneeUserId" />
            </div>
            <div className="field">
              <label htmlFor="ops-duplicate">Duplicate of</label>
              <input className="input t-mono" defaultValue={report.duplicateOfId ?? ""} id="ops-duplicate" name="duplicateOf" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ops-note">Status note</label>
            <textarea className="textarea" defaultValue={report.statusNote ?? ""} id="ops-note" name="statusNote" rows={3} />
          </div>
          <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
            <Button disabled={mutation.isPending} size="sm" type="submit">
              Save confirmed fields
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function ApplyTriageForm({ onSaved, report }: { onSaved: () => Promise<void>; report: AdminBugReportDetail }) {
  const mutation = useApplyAdminBugTriage(report.id);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const triage = report.triageJson;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const applyPriority = form.get("applyPriority") === "on";
    const applyStatus = form.get("applyStatus") === "on";
    const applyDuplicate = form.get("applyDuplicate") === "on";
    const priorityRaw = String(form.get("priority") ?? "");
    const statusRaw = String(form.get("status") ?? "");
    const duplicateOf = emptyToNull(String(form.get("duplicateOf") ?? ""));
    setError(null);
    setSaved(false);
    try {
      await mutation.mutateAsync({
        applyPriority,
        applyStatus,
        applyDuplicate,
        ...(priorityRaw ? { priority: priorityRaw as BugReportPriority } : {}),
        ...(statusRaw ? { status: statusRaw as BugReportStatus } : {}),
        ...(duplicateOf ? { duplicateOf } : {}),
      });
      setSaved(true);
      await onSaved();
    } catch (caught) {
      setError(mutationError(caught));
    }
  }

  return (
    <Card>
      <CardHeader>
        <SlashMark label="confirm suggestions" num={4} />
      </CardHeader>
      <CardBody>
        <form className="col gap-12" onSubmit={(event) => void onSubmit(event)}>
          {error ? <div className="form-banner form-banner--err">{error}</div> : null}
          {saved ? <div className="form-banner">Selected suggestions applied.</div> : null}
          <p className="t-body t-mute" style={{ margin: 0 }}>
            Choose which stored suggestions to write. Overrides replace the model value for that flag only.
          </p>
          <label className="check-row">
            <input defaultChecked={Boolean(triage)} name="applyPriority" type="checkbox" />
            <span>
              Apply priority
              {triage ? ` (suggested ${triage.suggestedPriority})` : " — needs stored triage"}
            </span>
          </label>
          <label className="check-row">
            <input name="applyStatus" type="checkbox" />
            <span>
              Apply status
              {triage?.suggestedStatus ? ` (suggested ${triage.suggestedStatus})` : " — needs suggestedStatus or override"}
            </span>
          </label>
          <label className="check-row">
            <input name="applyDuplicate" type="checkbox" />
            <span>
              Apply duplicate
              {triage?.similarBugIds[0] ? ` (suggested ${triage.similarBugIds[0]})` : " — needs similarBugIds or override"}
            </span>
          </label>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="apply-priority">Priority override</label>
              <select className="select" id="apply-priority" name="priority">
                <option value="">use suggestion</option>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="apply-status">Status override</label>
              <select className="select" id="apply-status" name="status">
                <option value="">use suggestion</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="apply-duplicate">Duplicate override</label>
              <input className="input t-mono" id="apply-duplicate" name="duplicateOf" placeholder="uuid" />
            </div>
          </div>
          <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
            <Button disabled={mutation.isPending} size="sm" type="submit">
              Apply selected
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function DeleteReportForm({
  onDeleted,
  report,
}: {
  onDeleted: () => void;
  report: AdminBugReportDetail;
}) {
  const mutation = useDeleteAdminBugReport(report.id);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function onDelete() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    try {
      await mutation.mutateAsync();
      onDeleted();
    } catch (caught) {
      setError(mutationError(caught));
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <SlashMark label="danger" num={7} />
      </CardHeader>
      <CardBody>
        <div className="col gap-12">
          {error ? <div className="form-banner form-banner--err">{error}</div> : null}
          <p className="t-body t-mute" style={{ margin: 0 }}>
            Permanently remove this report and its triage jobs. The audit trail keeps
            the id, surface, and a truncated title — not the payload.
          </p>
          <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
            {confirming ? (
              <Button disabled={mutation.isPending} onClick={() => setConfirming(false)} size="sm">
                Cancel
              </Button>
            ) : null}
            <Button
              disabled={mutation.isPending}
              icon={Trash2}
              onClick={() => void onDelete()}
              size="sm"
              variant="danger"
            >
              {mutation.isPending ? "Deleting" : confirming ? "Confirm delete" : "Delete"}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function StoreTriageForm({ onSaved, report }: { onSaved: () => Promise<void>; report: AdminBugReportDetail }) {
  const mutation = useStoreAdminBugTriage(report.id);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = String(form.get("triage") ?? "").trim();
    setError(null);
    setSaved(false);
    let triage: unknown;
    try {
      triage = JSON.parse(raw) as unknown;
    } catch {
      setError("Triage document must be valid JSON.");
      return;
    }
    try {
      await mutation.mutateAsync(triage);
      setSaved(true);
      await onSaved();
    } catch (caught) {
      setError(mutationError(caught));
    }
  }

  return (
    <Card>
      <CardHeader>
          <SlashMark label="store triage" num={5} />
      </CardHeader>
      <CardBody>
        <form className="col gap-12" onSubmit={(event) => void onSubmit(event)}>
          {error ? <div className="form-banner form-banner--err">{error}</div> : null}
          {saved ? <div className="form-banner">Triage document stored. Priority and status were not auto-applied.</div> : null}
          <div className="field">
            <label htmlFor="ops-triage">ravi.bug_triage/v1 JSON</label>
            <textarea
              className="textarea t-mono"
              defaultValue={report.triageJson ? JSON.stringify(report.triageJson, null, 2) : ""}
              id="ops-triage"
              name="triage"
              rows={8}
            />
          </div>
          <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
            <Button disabled={mutation.isPending} size="sm" type="submit">
              Store document
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function PendingTriageState({ onSaved, report }: { onSaved: () => Promise<void>; report: AdminBugReportDetail }) {
  const state = inboxTriageState(report);
  if (state === "pending") {
    return (
      <div className="col gap-12">
        <EmptyState
          title="Triaging…"
          body="A job is queued or running. Suggestions will appear here when the worker stores ravi.bug_triage/v1. Confirmed priority and status stay unchanged."
        />
        <JobMeta job={report.triageJob} />
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="col gap-12">
        <EmptyState
          title="Triage failed"
          body={report.triageJob?.lastError === "triage_engine_not_configured"
            ? "The model host is not configured. Set RAVI_BUG_TRIAGE_API_BASE and RAVI_BUG_TRIAGE_API_KEY, then run triage again."
            : "The worker could not store a suggestion. Priority and status were not changed."}
        />
        <JobMeta job={report.triageJob} />
        <RunTriageAgain label="Run triage again" onSaved={onSaved} report={report} />
      </div>
    );
  }
  return (
    <div className="col gap-12">
      <EmptyState
        title="Waiting for triage"
        body="No stored suggestion yet. Enqueue a job to have the worker write ravi.bug_triage/v1. Apply-triage stays disabled until then."
      />
      <RunTriageAgain label="Run triage" onSaved={onSaved} report={report} />
    </div>
  );
}

function RunTriageAgain({
  label = "Run triage again",
  onSaved,
  report,
}: {
  label?: string;
  onSaved: () => Promise<void>;
  report: AdminBugReportDetail;
}) {
  const mutation = useEnqueueAdminBugTriage(report.id);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    try {
      await mutation.mutateAsync();
      await onSaved();
    } catch (caught) {
      setError(mutationError(caught));
    }
  }

  return (
    <div className="col gap-8">
      {error ? <div className="form-banner form-banner--err">{error}</div> : null}
      <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
        <Button disabled={mutation.isPending} size="sm" type="button" onClick={() => void onClick()}>
          {label}
        </Button>
      </div>
    </div>
  );
}

function JobMeta({ job }: { job: AdminBugReportDetail["triageJob"] }) {
  if (!job) return null;
  return (
    <div className="row gap-12" style={{ flexWrap: "wrap" }}>
      <Meta label="job" value={job.status} />
      <Meta label="trigger" value={job.trigger} />
      <Meta label="attempts" value={String(job.attempts)} />
      {job.lastError ? <Meta label="error" value={job.lastError} /> : null}
    </div>
  );
}

function inboxTriageState(item: {
  triage?: AdminBugReportSummary["triage"];
  triageJson?: AdminBugReportDetail["triageJson"];
  triageJob: AdminBugReportSummary["triageJob"];
}): AdminTriageState {
  if (item.triage || item.triageJson) return "ready";
  if (item.triageJob?.status === "queued" || item.triageJob?.status === "running") return "pending";
  if (item.triageJob?.status === "failed") return "failed";
  return "idle";
}

function ListBlock({ items, label }: { items: string[]; label: string }) {
  return (
    <div className="col gap-4">
      <span className="t-tiny t-mute">{label}</span>
      <ul className="col gap-4" style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((item) => (
          <li className="t-body" key={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="row gap-4">
      <span className="t-tiny t-mute">{label}</span>
      <span className="t-mono t-tiny">{value}</span>
    </span>
  );
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="col gap-8" style={{ padding: 24, textAlign: "center" }}>
      <span className="t-strong">{title}</span>
      <span className="t-body t-mute">{body}</span>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="col gap-8" style={{ padding: 24 }}>
      <span className="t-body t-mute">{label}…</span>
    </div>
  );
}

function severityTone(severity: BugReportSeverity): "ok" | "warn" | "err" | "info" | "default" {
  if (severity === "critical") return "err";
  if (severity === "high") return "warn";
  if (severity === "medium") return "info";
  return "default";
}

function statusTone(status: BugReportStatus): "ok" | "warn" | "err" | "info" | "default" {
  if (status === "resolved") return "ok";
  if (status === "in_progress" || status === "triaging") return "info";
  if (status === "wontfix" || status === "duplicate") return "default";
  return "warn";
}

function priorityTone(priority: BugReportPriority | null): "ok" | "warn" | "err" | "info" | "default" {
  if (priority === "p0") return "err";
  if (priority === "p1") return "warn";
  if (priority === "p2") return "info";
  return "default";
}

function scoreLabel(score: number | null) {
  return score === null ? "score —" : `score ${score}`;
}

function emptyToNull(value: string) {
  const text = value.trim();
  return text ? text : null;
}

function mutationError(error: unknown) {
  if (error instanceof ConsoleApiClientError) {
    const fields = error.payload.fieldErrors
      ? Object.values(error.payload.fieldErrors).filter(Boolean).join(" · ")
      : "";
    return fields ? `${error.payload.error}: ${fields}` : error.payload.error;
  }
  return "Request failed.";
}
