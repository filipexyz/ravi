"use client";

import { diffLines } from "diff";
import { ArrowLeft, Check, MessageSquarePlus, Pencil, RotateCcw, Send, Undo2, X } from "lucide-react";
import { useOrgRouter } from "@/lib/org-href";
import { Fragment, useMemo, useState } from "react";

import type { Project } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { cn } from "@/lib/cn";
import { Badge, type Tone } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Textarea } from "@/ui/form";
import { DetailList, PageHeader, Panel, Section } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { ThemeProposalSections } from "@/features/widgets/theme-details";
import { WidgetProposalSections } from "@/features/widgets/widget-details";

import {
  libraryErrorText,
  useLibraryComment,
  useLibraryProposal,
  useLibraryProposalAction,
  useResolveLibraryComment,
  type ProposalAction,
} from "./api";
import { KIND_WORDS, useLibraryKind } from "./kind";
import { authorLabel, libraryHref, proposalPath, proposalStatus } from "./labels";
import { LibraryGate } from "./library-screen";
import type { LibraryComment, LibraryFile, LibraryItem, LibraryProposal, LibraryProposalDetail } from "./types";

export function LibraryProposalScreen({
  number,
  projectId,
  scope,
  slug,
}: {
  number: number;
  projectId?: string;
  scope: string;
  slug: string;
}) {
  return (
    <LibraryGate projectRef={projectId}>
      {(project) => <ProposalDetail number={number} project={project} scope={scope} slug={slug} />}
    </LibraryGate>
  );
}

function ProposalDetail({ number, project, scope, slug }: { number: number; project: Project | null; scope: string; slug: string }) {
  const { organization } = useWorkspace();
  const kind = useLibraryKind();
  const query = useLibraryProposal(scope, slug, number);
  const itemHref = libraryHref(project, kind, scope, slug);
  const listHref = libraryHref(project, kind);

  if (query.isPending) {
    return (
      <>
        <BackButton href={listHref} label="Library" />
        <div aria-busy aria-label="Loading" className="space-y-4" role="status">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }
  if (query.isError || !query.data) {
    return (
      <>
        <BackButton href={listHref} label="Library" />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} role={roleLabel(organization.role)} title="This proposal couldn't load" />
      </>
    );
  }

  const detail = query.data;
  const { item, proposal } = detail;
  const status = proposalStatus(proposal);
  return (
    <>
      <BackButton href={item.version ? itemHref : listHref} label={item.version ? item.slug : "Library"} />
      <PageHeader
        actions={<ProposalActions detail={detail} project={project} />}
        description={proposal.description}
        title={
          <span>
            {`Proposal ${proposal.number} to `}
            <span className="font-mono">{item.slug}</span>
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Badge tone={item.scope === "org" ? "neutral" : "info"}>{item.scope === "org" ? "Organization" : (item.project?.name ?? "Project")}</Badge>
          {proposal.round > 1 ? <Badge>{`Round ${proposal.round}`}</Badge> : null}
        </div>
      </PageHeader>

      <div className="space-y-8">
        <StateNotice detail={detail} />

        <Section title="Details">
          <Panel className="px-5">
            <DetailList
              items={[
                { label: "Author", value: authorLabel(proposal.author) },
                {
                  label: "Written against",
                  value: proposal.baseVersion ? `Version ${proposal.baseVersion}` : `Nothing published yet: ${KIND_WORDS[kind].fresh.toLowerCase()}`,
                },
                proposal.proposedAt ? { label: "Proposed", value: formatDate(proposal.proposedAt, true) } : null,
                proposal.note ? { label: "Note", value: proposal.note } : null,
                ...metadataChanges(item, proposal),
              ]}
            />
          </Panel>
        </Section>

        {kind === "theme" ? (
          <ThemeProposalSections files={detail.files} project={project} title={`${item.slug} (proposta ${proposal.number})`} />
        ) : kind === "widget" ? (
          <WidgetProposalSections files={detail.files} project={project} title={`Prévia da proposta ${proposal.number} do widget ${item.slug}`} />
        ) : null}

        <FilesDiff detail={detail} scope={scope} slug={slug} />

        <Conversation detail={detail} scope={scope} slug={slug} />
      </div>
    </>
  );
}

function metadataChanges(item: LibraryItem, proposal: LibraryProposal) {
  if (!item.version) return [];
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (proposal.name !== item.name) rows.push({ label: "Name", value: `${item.name} → ${proposal.name}` });
  if (proposal.description !== item.description) rows.push({ label: "Description", value: "Changed (shown above)" });
  if (proposal.externalAllowed !== item.externalAllowed) {
    rows.push({
      label: "Outside chats",
      value: proposal.externalAllowed ? "Now allowed in chats with people outside" : "No longer allowed in chats with people outside",
    });
  }
  return rows;
}

function StateNotice({ detail }: { detail: LibraryProposalDetail }) {
  const { proposal } = detail;
  if (proposal.stale && (proposal.status === "draft" || proposal.status === "proposed")) {
    return (
      <Notice title={`Version ${proposal.currentVersion} was published after this proposal started`} tone="warn">
        {proposal.author.self
          ? `Edit it, check what changed in version ${proposal.currentVersion}, and move it onto that version before it can be published.`
          : `Its author has to move it onto version ${proposal.currentVersion} before it can be published.`}
      </Notice>
    );
  }
  if (proposal.status === "rejected") {
    return (
      <Notice title={`Rejected${proposal.decidedBy?.name ? ` by ${proposal.decidedBy.name}` : ""}`} tone="err">
        {proposal.decisionReason}
      </Notice>
    );
  }
  if (proposal.status === "published" || proposal.status === "superseded") {
    return (
      <Notice title={`Published as version ${proposal.publishedVersion}`} tone="ok">
        {proposal.decidedBy?.name && proposal.decidedAt ? `By ${proposal.decidedBy.name}, ${formatDate(proposal.decidedAt, true)}.` : null}
      </Notice>
    );
  }
  if (proposal.status === "draft") {
    return (
      <Notice title="Draft">
        {proposal.author.self ? "Only you and the reviewers see it. Propose it when it's ready for review." : "Only its author and the reviewers see it."}
      </Notice>
    );
  }
  return null;
}

function ProposalActions({ detail, project }: { detail: LibraryProposalDetail; project: Project | null }) {
  const router = useOrgRouter();
  const toast = useToast();
  const { item, proposal } = detail;
  const [scope, slug] = proposal.ref.split("/") as [string, string];
  const action = useLibraryProposalAction(scope, slug, proposal.number);
  const [dialog, setDialog] = useState<"withdraw" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const kind = useLibraryKind();
  const itemHref = libraryHref(project, kind, scope, slug);

  function run(name: ProposalAction, extra?: { reason?: string }) {
    setError(null);
    action.mutate(
      { action: name, ...extra },
      {
        onError: (failure) => setError(libraryErrorText(failure) ?? "That didn't work. Try again."),
        onSuccess: (result) => {
          setDialog(null);
          if (name === "publish") {
            toast.show(`Published version ${result.item?.version ?? ""}.`);
            router.push(itemHref);
          } else if (name === "withdraw" && result.deleted) {
            toast.show("Draft deleted.");
            router.push(result.itemDeleted || !item.version ? libraryHref(project, kind) : itemHref);
          } else if (name === "withdraw") {
            toast.show("Proposal withdrawn.");
          } else if (name === "submit") {
            toast.show("Proposed. Reviewers were told.");
          } else {
            toast.show("Proposal rejected.");
          }
        },
      },
    );
  }

  const isDraft = proposal.status === "draft";
  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        {proposal.can.edit ? (
          <Button href={proposalPath(project, kind, proposal.ref, proposal.number, "edit")} icon={Pencil} variant="secondary">
            Edit
          </Button>
        ) : null}
        {proposal.can.withdraw ? (
          <Button icon={Undo2} onClick={() => setDialog("withdraw")} variant="ghost">
            {isDraft ? "Delete draft" : "Withdraw"}
          </Button>
        ) : null}
        {proposal.can.reject ? (
          <Button icon={X} onClick={() => setDialog("reject")} variant="secondary">
            Reject
          </Button>
        ) : null}
        {proposal.can.submit ? (
          <Button icon={Send} loading={action.isPending} onClick={() => run("submit")}>
            Propose
          </Button>
        ) : null}
        {proposal.can.publish ? (
          <Button icon={Check} loading={action.isPending} onClick={() => run("publish")} variant={proposal.can.submit ? "secondary" : "primary"}>
            Publish
          </Button>
        ) : null}
      </div>
      {error && !dialog ? <FormMessage>{error}</FormMessage> : null}

      <Dialog
        description={
          isDraft
            ? "The draft and its comments are deleted."
            : "It stays in the history as withdrawn, with its comments. Reviewers can no longer publish it."
        }
        footer={
          <>
            <Button onClick={() => setDialog(null)} variant="ghost">
              Keep it
            </Button>
            <Button loading={action.isPending} onClick={() => run("withdraw")} variant="danger">
              {isDraft ? "Delete draft" : "Withdraw"}
            </Button>
          </>
        }
        onClose={() => setDialog(null)}
        open={dialog === "withdraw"}
        title={isDraft ? "Delete this draft?" : "Withdraw this proposal?"}
      >
        {error ? <FormMessage>{error}</FormMessage> : null}
      </Dialog>

      <Dialog
        description="The author sees the reason. The proposal stays in the history."
        footer={
          <>
            <Button onClick={() => setDialog(null)} variant="ghost">
              Cancel
            </Button>
            <Button disabled={!reason.trim()} loading={action.isPending} onClick={() => run("reject", { reason: reason.trim() })} variant="danger">
              Reject
            </Button>
          </>
        }
        onClose={() => setDialog(null)}
        open={dialog === "reject"}
        title="Reject this proposal?"
      >
        <Field label="Reason">
          {(props) => <Textarea {...props} maxLength={500} onChange={(event) => setReason(event.target.value)} rows={3} value={reason} />}
        </Field>
        {error ? <FormMessage>{error}</FormMessage> : null}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files and line comments

const ENTRY_FILES = new Set(["SKILL.md", "AGENTS.md", "theme.json", "widget.html"]);

type DiffRow = { kind: "same" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null };
type FileDiff = { path: string; status: "added" | "removed" | "changed" | "same"; rows: DiffRow[] };

function diffFiles(base: LibraryFile[], next: LibraryFile[]): FileDiff[] {
  const before = new Map(base.map((file) => [file.path, file.content]));
  const after = new Map(next.map((file) => [file.path, file.content]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    ENTRY_FILES.has(a) ? -1 : ENTRY_FILES.has(b) ? 1 : a.localeCompare(b),
  );
  return paths.map((path) => {
    const oldText = before.get(path);
    const newText = after.get(path);
    const status = oldText === undefined ? "added" : newText === undefined ? "removed" : oldText === newText ? "same" : "changed";
    const rows: DiffRow[] = [];
    let oldLine = 1;
    let newLine = 1;
    for (const part of diffLines(oldText ?? "", newText ?? "")) {
      const lines = part.value.replace(/\n$/, "").split("\n");
      for (const text of lines) {
        if (part.added) rows.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
        else if (part.removed) rows.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
        else rows.push({ kind: "same", text, oldLine: oldLine++, newLine: newLine++ });
      }
    }
    return { path, status, rows };
  });
}

const FILE_STATUS: Record<FileDiff["status"], { label: string; tone: Tone }> = {
  added: { label: "New file", tone: "ok" },
  removed: { label: "Removed", tone: "err" },
  changed: { label: "Changed", tone: "warn" },
  same: { label: "No changes", tone: "neutral" },
};

function FilesDiff({ detail, scope, slug }: { detail: LibraryProposalDetail; scope: string; slug: string }) {
  const { base, files, comments, proposal } = detail;
  const diffs = useMemo(() => diffFiles(base?.files ?? [], files), [base, files]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<{ path: string; line: number } | null>(null);
  const anchored = useMemo(() => {
    const map = new Map<string, LibraryComment[]>();
    for (const comment of comments) {
      if (comment.parentId || comment.outdated || !comment.path || !comment.line) continue;
      const key = `${comment.path}:${comment.line}`;
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [comments]);
  const changed = diffs.filter((diff) => diff.status !== "same").length;
  const open = proposal.status === "draft" || proposal.status === "proposed";
  const kind = useLibraryKind();

  return (
    <Section
      description={
        base
          ? `${changed} of ${diffs.length} ${diffs.length === 1 ? "file differs" : "files differ"} from version ${base.number}.${open ? " Click a line number to comment on it." : ""}`
          : `${KIND_WORDS[kind].fresh}.${open ? " Click a line number to comment on it." : ""}`
      }
      title="Changes"
    >
      <div className="space-y-4">
        {diffs.map((diff) => {
          const collapsed = diff.status === "same" && !expanded.has(diff.path);
          const status = FILE_STATUS[diff.status];
          return (
            <Panel key={diff.path}>
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
                <span className="truncate font-mono text-[13px] text-ink">{diff.path}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {diff.status === "same" ? (
                    <Button
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(diff.path)) next.delete(diff.path);
                          else next.add(diff.path);
                          return next;
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      {collapsed ? "Show" : "Hide"}
                    </Button>
                  ) : null}
                </span>
              </div>
              {collapsed ? null : (
                <div className="max-h-[640px] overflow-auto">
                  <table className="w-full border-collapse font-mono text-[12.5px] leading-relaxed">
                    <tbody>
                      {diff.rows.map((row, index) => {
                        const key = row.newLine ? `${diff.path}:${row.newLine}` : null;
                        const thread = key ? (anchored.get(key) ?? []) : [];
                        const composing = composer && row.newLine && composer.path === diff.path && composer.line === row.newLine;
                        return (
                          <Fragment key={index}>
                            <tr className={cn(row.kind === "add" && "bg-ok-soft", row.kind === "del" && "bg-err-soft")}>
                              <td className="w-10 select-none px-2 text-right align-top text-ink-3">{row.oldLine ?? ""}</td>
                              <td className="w-10 select-none px-2 text-right align-top text-ink-3">
                                {row.newLine && open ? (
                                  <button
                                    aria-label={`Comment on line ${row.newLine} of ${diff.path}`}
                                    className="w-full text-right hover:text-accent hover:underline"
                                    onClick={() => setComposer({ path: diff.path, line: row.newLine! })}
                                    type="button"
                                  >
                                    {row.newLine}
                                  </button>
                                ) : (
                                  (row.newLine ?? "")
                                )}
                              </td>
                              <td className="w-4 select-none text-center align-top text-ink-3">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</td>
                              <td className="whitespace-pre-wrap break-all pr-4 text-ink-2">{row.text || " "}</td>
                            </tr>
                            {thread.length || composing ? (
                              <tr>
                                <td className="bg-canvas px-3 py-3 font-sans" colSpan={4}>
                                  <div className="space-y-3">
                                    {thread.map((comment) => (
                                      <CommentThread comment={comment} detail={detail} key={comment.id} scope={scope} slug={slug} />
                                    ))}
                                    {composing ? (
                                      <CommentComposer
                                        anchor={{ path: diff.path, line: row.newLine! }}
                                        onDone={() => setComposer(null)}
                                        scope={scope}
                                        slug={slug}
                                        number={proposal.number}
                                      />
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          );
        })}
      </div>
    </Section>
  );
}

function Conversation({ detail, scope, slug }: { detail: LibraryProposalDetail; scope: string; slug: string }) {
  const general = detail.comments.filter((comment) => !comment.parentId && (comment.outdated || !comment.path || !comment.line));
  return (
    <Section description="Comments on the whole proposal, and line comments from earlier rounds." title="Conversation">
      <div className="space-y-3">
        {general.length === 0 ? <p className="text-sm text-ink-3">No comments yet.</p> : null}
        {general.map((comment) => (
          <CommentThread comment={comment} detail={detail} key={comment.id} scope={scope} slug={slug} />
        ))}
        <CommentComposer number={detail.proposal.number} scope={scope} slug={slug} />
      </div>
    </Section>
  );
}

function CommentThread({
  comment,
  detail,
  scope,
  slug,
}: {
  comment: LibraryComment;
  detail: LibraryProposalDetail;
  scope: string;
  slug: string;
}) {
  const replies = detail.comments.filter((entry) => entry.parentId === comment.id);
  const [replying, setReplying] = useState(false);
  const resolve = useResolveLibraryComment(scope, slug, detail.proposal.number);
  const resolved = Boolean(comment.resolvedAt);
  return (
    <Panel className={cn("space-y-3 p-3", resolved && "opacity-70")}>
      <CommentBody comment={comment} />
      {replies.map((reply) => (
        <div className="border-l-2 border-line pl-3" key={reply.id}>
          <CommentBody comment={reply} />
        </div>
      ))}
      {replying ? (
        <CommentComposer number={detail.proposal.number} onDone={() => setReplying(false)} parentId={comment.id} scope={scope} slug={slug} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!replying ? (
          <Button icon={MessageSquarePlus} onClick={() => setReplying(true)} size="sm" variant="ghost">
            Reply
          </Button>
        ) : null}
        {comment.can.resolve ? (
          <Button
            icon={resolved ? RotateCcw : Check}
            loading={resolve.isPending}
            onClick={() => resolve.mutate({ id: comment.id, resolved: !resolved })}
            size="sm"
            variant="ghost"
          >
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        ) : null}
        {resolved ? <span className="text-[12px] text-ink-3">{`Resolved${comment.resolvedBy?.name ? ` by ${comment.resolvedBy.name}` : ""}`}</span> : null}
      </div>
    </Panel>
  );
}

function CommentBody({ comment }: { comment: LibraryComment }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
        <span className="font-medium text-ink">{authorLabel(comment.author)}</span>
        <RelativeTime value={comment.createdAt} />
        {comment.path && comment.line ? <span className="font-mono">{`${comment.path}:${comment.line}`}</span> : null}
        {comment.outdated ? <Badge>{`Outdated, round ${comment.round}`}</Badge> : null}
      </div>
      <p className="text-sm whitespace-pre-wrap text-ink-2">{comment.body}</p>
    </div>
  );
}

function CommentComposer({
  anchor,
  number,
  onDone,
  parentId,
  scope,
  slug,
}: {
  anchor?: { path: string; line: number };
  number: number;
  onDone?: () => void;
  parentId?: string;
  scope: string;
  slug: string;
}) {
  const [body, setBody] = useState("");
  const comment = useLibraryComment(scope, slug, number);
  const label = parentId ? "Reply" : anchor ? `Comment on ${anchor.path}:${anchor.line}` : "Comment";
  return (
    <div className="space-y-2">
      <Textarea
        aria-label={label}
        autoFocus={Boolean(anchor || parentId)}
        maxLength={4000}
        onChange={(event) => setBody(event.target.value)}
        placeholder={parentId ? "Write a reply" : anchor ? "What should change on this line?" : "Comment on the whole proposal"}
        rows={parentId || anchor ? 2 : 3}
        value={body}
      />
      {comment.isError ? <FormMessage>{libraryErrorText(comment.error) ?? "The comment couldn't be sent. Try again."}</FormMessage> : null}
      <div className="flex justify-end gap-2">
        {onDone ? (
          <Button onClick={onDone} size="sm" variant="ghost">
            Cancel
          </Button>
        ) : null}
        <Button
          disabled={!body.trim()}
          loading={comment.isPending}
          onClick={() =>
            comment.mutate(
              { body: body.trim(), ...(anchor ? { path: anchor.path, line: anchor.line } : {}), ...(parentId ? { parentId } : {}) },
              {
                onSuccess: () => {
                  setBody("");
                  onDone?.();
                },
              },
            )
          }
          size="sm"
          variant="secondary"
        >
          {parentId ? "Reply" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function BackButton({ href, label }: { href: string; label: string }) {
  return (
    <Button className="-ml-2.5 mb-3" href={href} icon={ArrowLeft} size="sm" variant="ghost">
      {label}
    </Button>
  );
}
