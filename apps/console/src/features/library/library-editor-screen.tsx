"use client";

import { ArrowLeft, FilePlus2, Trash2 } from "lucide-react";
import { useOrgRouter } from "@/lib/org-href";
import { useMemo, useRef, useState } from "react";

import type { Project } from "@/features/console/types";
import { roleCapabilities, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { cn } from "@/lib/cn";
import { Button, IconButton } from "@/ui/button";
import { Field, FormMessage, Input, Select, Switch, Textarea } from "@/ui/form";
import { PageHeader, Panel, Section } from "@/ui/layout";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { diagnosticsFromError } from "@/features/widgets/diagnostics";
import { ErrorSummary, type ErrorSummaryItem } from "@/features/widgets/diagnostics-list";
import { starterFiles, type EditorFile } from "@/features/widgets/kind-files";
import { ThemeFilesEditor } from "@/features/widgets/theme-editor";
import type { TokenDraft, TokenDrafts } from "@/features/widgets/theme-form";
import { auditAllowsPublish, type ScriptAuditOutcome } from "@/features/widgets/script-audit";
import { ScriptAuditReport } from "@/features/widgets/script-audit-panel";
import { WidgetFilesEditor, type KindEditorHandle } from "@/features/widgets/widget-editor";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";

import {
  libraryErrorText,
  useCreateLibraryProposal,
  useItemProposals,
  useLibraryItem,
  useLibraryProposal,
  useLibrarySearch,
  usePublishLibraryProposal,
  useRecordWidgetAudit,
  useUpdateLibraryProposal,
} from "./api";
import { isCompiledKind, KIND_WORDS, type LibraryKind, useLibraryKind } from "./kind";
import { libraryHref, proposalPath } from "./labels";
import { LibraryGate } from "./library-screen";
import { saveProblems, SLUG_FIELD_ID, useSaveSummary } from "./save-summary";
import type { LibraryCan, LibraryFile, LibraryProposal, LibraryProposalInput } from "./types";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PATH_PATTERN = /^[A-Za-z0-9._\-/]+$/;
const AGENT_FILES = ["AGENTS.md", "HEARTBEAT.md", "agent.json"];
/** Org roles that publish a widget with code (JS-CONTRACT J4); the server enforces it. */
const SCRIPT_PUBLISHER_ROLES = new Set(["owner", "admin"]);

type Draft = {
  slug: string;
  scope: "org" | "project";
  name: string;
  description: string;
  externalAllowed: boolean;
  note: string;
  files: EditorFile[];
};

/** What the editor writes: a new item, a change to a published one, or an edit of a proposal. */
export type LibraryEditorMode =
  | { kind: "new" }
  | { kind: "propose"; scope: string; slug: string }
  | { kind: "edit"; scope: string; slug: string; number: number };

export function LibraryEditorScreen({ mode, projectId }: { mode: LibraryEditorMode; projectId?: string }) {
  return <LibraryGate projectRef={projectId}>{(project) => <EditorLoader mode={mode} project={project} />}</LibraryGate>;
}

function EditorLoader({ mode, project }: { mode: LibraryEditorMode; project: Project | null }) {
  if (mode.kind === "new") return <NewItem project={project} />;
  if (mode.kind === "propose") return <ProposeChange project={project} scope={mode.scope} slug={mode.slug} />;
  return <EditProposal number={mode.number} project={project} scope={mode.scope} slug={mode.slug} />;
}

function NewItem({ project }: { project: Project | null }) {
  const { organization } = useWorkspace();
  const kind = useLibraryKind();
  const projectSearch = useLibrarySearch("", project?.id ?? null);
  const orgCan: LibraryCan = {
    propose: roleCapabilities(organization.role).canWriteProjects,
    review: roleCapabilities(organization.role).canAdminOrganization,
  };
  const initial = useMemo<Draft>(
    () => ({
      slug: "",
      scope: project ? "project" : "org",
      name: "",
      description: "",
      externalAllowed: false,
      note: "",
      files:
        kind === "agent"
          ? [
              { path: "AGENTS.md", content: AGENT_TEMPLATE },
              { path: "agent.json", content: AGENT_MANIFEST_TEMPLATE },
            ]
          : isCompiledKind(kind)
            ? starterFiles(kind)
            : [{ path: "SKILL.md", content: skillTemplate("", "") }],
    }),
    [kind, project],
  );
  if (project && projectSearch.isPending) return <EditorSkeleton project={project} />;
  const projectCan = projectSearch.data?.can ?? { propose: false, review: false };
  return (
    <Editor
      canFor={(scope) => (scope === "project" ? projectCan : orgCan)}
      initial={initial}
      isNew
      project={project}
      title={KIND_WORDS[kind].create}
    />
  );
}

function ProposeChange({ project, scope, slug }: { project: Project | null; scope: string; slug: string }) {
  const copy = editorCopy(useLibraryKind());
  const item = useLibraryItem(scope, slug, null);
  const proposals = useItemProposals(scope, slug);
  const initial = useMemo<Draft | null>(() => {
    if (!item.data) return null;
    return {
      slug: item.data.item.slug,
      scope: item.data.item.scope,
      name: item.data.item.name,
      description: item.data.item.description,
      externalAllowed: item.data.item.externalAllowed,
      note: "",
      files: item.data.version.files.map((file: LibraryFile) => ({ path: file.path, content: file.content })),
    };
  }, [item.data]);
  if (item.isError || proposals.isError) return <EditorError error={item.error ?? proposals.error} project={project} />;
  if (!initial || !proposals.data || !item.data) return <EditorSkeleton project={project} />;
  return (
    <Editor
      baseVersion={item.data.item.version ?? 0}
      canFor={() => proposals.data.can}
      initial={initial}
      project={project}
      refName={item.data.item.ref}
      title={copy.proposeTitle(item.data.item.slug)}
    />
  );
}

function EditProposal({ number, project, scope, slug }: { number: number; project: Project | null; scope: string; slug: string }) {
  const kind = useLibraryKind();
  const copy = editorCopy(kind);
  const query = useLibraryProposal(scope, slug, number);
  const initial = useMemo<Draft | null>(() => {
    if (!query.data) return null;
    const { proposal, item, files } = query.data;
    return {
      slug: item.slug,
      scope: item.scope,
      name: proposal.name,
      description: proposal.description,
      externalAllowed: proposal.externalAllowed,
      note: proposal.note ?? "",
      files: files.map((file) => ({ path: file.path, content: file.content })),
    };
  }, [query.data]);
  if (query.isError) return <EditorError error={query.error} project={project} />;
  if (!initial || !query.data) return <EditorSkeleton project={project} />;
  const { proposal, item } = query.data;
  if (!proposal.can.edit) {
    return (
      <>
        <BackButton href={proposalPath(project, kind, proposal.ref, number)} label={copy.proposalBack} />
        <Notice title={copy.cantEdit} tone="warn">
          {copy.cantEditBody}
        </Notice>
      </>
    );
  }
  return (
    <Editor
      baseVersion={proposal.baseVersion}
      canFor={() => ({ propose: true, review: proposal.can.publish || proposal.can.reject })}
      currentVersion={proposal.currentVersion}
      editing={proposal}
      initial={initial}
      project={project}
      refName={item.ref}
      title={copy.editTitle(number, item.slug)}
    />
  );
}

/** Editor words: the Console's English for skills and agents, PT-BR for themes and widgets. */
const EDITOR_COPY = {
  en: {
    about: "About",
    slug: "Slug",
    who: "Who gets it",
    onlyProject: (name: string) => `Only the ${name} project`,
    everyProject: "Every project in the organization",
    name: "Name",
    nameHint: "Defaults to the slug.",
    description: "Description",
    note: "Note",
    noteHint: "Shown to reviewers and kept with the version.",
    files: "Files",
    slugError: "Use a-z, 0-9 and -, starting and ending with a letter or digit.",
    saveDraft: "Save draft",
    publishNow: "Publish now",
    propose: "Propose",
    saveChanges: "Save changes",
    rebaseTitle: (version: number | undefined) => `Version ${version} was published after this proposal started`,
    rebase: (version: number | undefined) => `I checked version ${version}; move this proposal onto it.`,
    saveError: "It couldn't be saved. Try again.",
    proposalUpdated: "Proposal updated.",
    draftSaved: "Draft saved.",
    proposed: "Proposed. Reviewers were told.",
    published: (ref: string, version: number | null) => `Published ${ref} version ${version ?? ""}.`,
    publishFailed: (reason: string | null) => `Saved as a draft, but it couldn't be published: ${reason ?? "try again from the proposal."}`,
    newRound: "Saving starts a new round of review. Comments on the earlier round stay, marked as outdated.",
    proposalBack: "Proposal",
    proposeTitle: (slug: string) => `Propose a change to ${slug}`,
    editTitle: (number: number, slug: string) => `Edit proposal ${number} to ${slug}`,
    cantEdit: "This proposal can't be edited",
    cantEditBody: "Only its author edits it, and only while it is a draft or waiting for review.",
    cantPropose: (scope: string, role: string, many: string) => `Developers and admins of ${scope} propose ${many}. Your role is ${role}.`,
    theOrganization: "the organization",
    thisProject: "this project",
    auditing: "Auditing accessibility…",
    auditBlocked: "The accessibility audit failed, so nothing was published.",
    auditUnavailable: "The accessibility audit couldn't run.",
    auditNotStored: "Published, but the audit wasn't stored.",
    scriptNeedsAdmin: "Only organization owners and admins publish code.",
  },
  pt: {
    about: "Sobre",
    slug: "Slug",
    who: "Quem recebe",
    onlyProject: (name: string) => `Só o projeto ${name}`,
    everyProject: "Todos os projetos da organização",
    name: "Nome",
    nameHint: "",
    description: "Descrição",
    note: "Nota",
    noteHint: "Os revisores leem; fica guardada com a versão.",
    files: "Arquivos",
    slugError: "Use a-z, 0-9 e -, começando e terminando com letra ou número.",
    saveDraft: "Salvar rascunho",
    publishNow: "Publicar agora",
    propose: "Propor",
    saveChanges: "Salvar alterações",
    rebaseTitle: (version: number | undefined) => `A versão ${version} saiu depois que esta proposta começou`,
    rebase: (version: number | undefined) => `Conferi a versão ${version}; mover esta proposta para ela.`,
    saveError: "Não deu para salvar. Tente de novo.",
    proposalUpdated: "Proposta atualizada.",
    draftSaved: "Rascunho salvo.",
    proposed: "Proposta enviada. Os revisores foram avisados.",
    published: (ref: string, version: number | null) => `${ref} publicado, versão ${version ?? ""}.`,
    publishFailed: (reason: string | null) => `Salvo como rascunho, mas não deu para publicar: ${reason ?? "tente de novo pela proposta."}`,
    newRound: "Salvar começa uma nova rodada de revisão. Os comentários da rodada anterior ficam, marcados como antigos.",
    proposalBack: "Proposta",
    proposeTitle: (slug: string) => `Propor mudança em ${slug}`,
    editTitle: (number: number, slug: string) => `Editar a proposta ${number} de ${slug}`,
    cantEdit: "Esta proposta não pode ser editada",
    cantEditBody: "Só quem a escreveu edita, e só enquanto ela é rascunho ou espera revisão.",
    cantPropose: (scope: string, role: string, many: string) => `Quem desenvolve ou administra ${scope} propõe ${many}. Seu papel é ${role}.`,
    theOrganization: "a organização",
    thisProject: "este projeto",
    auditing: "Auditando a acessibilidade…",
    auditBlocked: "A auditoria de acessibilidade não passou, então nada foi publicado. Corrija o que ela aponta e publique de novo.",
    auditUnavailable: "Não deu para rodar a auditoria de acessibilidade. Confira os erros dos arquivos e tente de novo.",
    auditNotStored: "Publicado, mas a auditoria não foi gravada. Rode a auditoria na página do widget antes de usá-lo numa página.",
    scriptNeedsAdmin: "Widgets com código só são publicados por owner ou admin da organização. Proponha a mudança e uma dessas pessoas publica.",
  },
};

export function editorCopy(kind: LibraryKind) {
  return isCompiledKind(kind) ? EDITOR_COPY.pt : EDITOR_COPY.en;
}

function Editor({
  baseVersion,
  canFor,
  currentVersion,
  editing,
  initial,
  isNew = false,
  project,
  refName,
  title,
}: {
  baseVersion?: number;
  canFor: (scope: "org" | "project") => LibraryCan;
  currentVersion?: number;
  editing?: LibraryProposal;
  initial: Draft;
  isNew?: boolean;
  project: Project | null;
  refName?: string;
  title: string;
}) {
  const router = useOrgRouter();
  const toast = useToast();
  const { organization } = useWorkspace();
  const kind = useLibraryKind();
  const words = KIND_WORDS[kind];
  const copy = editorCopy(kind);
  const compiled = isCompiledKind(kind);
  const [draft, setDraft] = useState<Draft>(initial);
  const [selected, setSelected] = useState(0);
  const [newPath, setNewPath] = useState("");
  const [rebase, setRebase] = useState(false);
  const [templateTouched, setTemplateTouched] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  // Theme token fields holding text the form could not write to theme.json; they stop a save.
  const [tokenDrafts, setTokenDrafts] = useState<TokenDrafts>({});
  const kindEditor = useRef<KindEditorHandle>(null);
  const summaryElement = useRef<HTMLElement>(null);

  const scope = draft.scope;
  const can = canFor(scope);
  const create = useCreateLibraryProposal();
  const update = useUpdateLibraryProposal(editing ? (editing.ref.split("/")[0] ?? "") : "", draft.slug, editing?.number ?? 0);
  const publish = usePublishLibraryProposal();
  const recordAudit = useRecordWidgetAudit();
  // Widgets with code: the audit a publish ran first (shown when it blocks), and whether it is running.
  const [auditing, setAuditing] = useState(false);
  const [blockedAudit, setBlockedAudit] = useState<ScriptAuditOutcome | null>(null);
  const hasScript = kind === "widget" && draft.files.some((entry) => entry.path === WIDGET_SCRIPT_FILE);
  const scriptPublisher = SCRIPT_PUBLISHER_ROLES.has(organization.role);
  const busy = create.isPending || update.isPending || publish.isPending || auditing;
  const stale = editing ? editing.baseVersion !== (currentVersion ?? editing.baseVersion) : false;

  const file = draft.files[selected] ?? draft.files[0];
  const slugError = isNew && draft.slug && !SLUG_PATTERN.test(draft.slug) ? copy.slugError : null;
  const pathError =
    newPath && (!PATH_PATTERN.test(newPath) || newPath.split("/").some((part) => !part || part === "." || part === ".."))
      ? "Use letters, digits, . _ - and / between folder names."
      : newPath && draft.files.some((entry) => entry.path === newPath)
        ? "That file already exists."
        : newPath && kind === "agent" && !AGENT_FILES.includes(newPath)
          ? "An agent holds only AGENTS.md, HEARTBEAT.md and agent.json."
          : null;
  const valid = compiled
    ? true
    : (!isNew || SLUG_PATTERN.test(draft.slug)) && draft.description.trim().length > 0 && draft.files.some((entry) => entry.path === words.entry);

  // Themes and widgets: what stops a save, shown at the top after a save finds problems or the server refuses one.
  const summary = useSaveSummary(summaryElement, (server) =>
    isCompiledKind(kind)
      ? saveProblems({
          kind,
          files: draft.files,
          slugProblem: isNew && !SLUG_PATTERN.test(draft.slug) ? (draft.slug ? `Slug: ${copy.slugError}` : "Escolha o slug.") : null,
          tokenDrafts,
          server,
        })
      : [],
  );
  const summaryItems = summary.items;

  function selectProblem(item: ErrorSummaryItem) {
    if (item.diagnostic) kindEditor.current?.focusDiagnostic(item.diagnostic);
    else if (!kindEditor.current?.focusTarget?.(item.target)) document.querySelector<HTMLInputElement>(`#${item.target} input`)?.focus();
  }

  /** A theme or widget editor changed the files. */
  function setKindFiles(files: EditorFile[]) {
    setDraft((current) => ({ ...current, files }));
    summary.filesChanged();
  }

  function patch(next: Partial<Draft>) {
    setDraft((current) => {
      const merged = { ...current, ...next };
      // Keep a new skill's SKILL.md frontmatter in step with the slug and description until someone edits it.
      if (kind !== "skill" || templateTouched || (next.slug === undefined && next.description === undefined)) return merged;
      return {
        ...merged,
        files: merged.files.map((entry) =>
          entry.path === "SKILL.md" ? { ...entry, content: skillTemplate(merged.slug, merged.description) } : entry,
        ),
      };
    });
  }

  function publishSaved(proposal: LibraryProposal, audit: ScriptAuditOutcome | null) {
    publish.mutate(
      { ref: proposal.ref, number: proposal.number },
      {
        onError: (failure) => {
          toast.show(copy.publishFailed(libraryErrorText(failure)), "err");
          router.push(proposalPath(project, kind, proposal.ref, proposal.number));
        },
        onSuccess: async (result) => {
          const [scopePart, slugPart] = proposal.ref.split("/") as [string, string];
          let stored = true;
          if (audit && result.item.version !== null) {
            const { errors: _errors, ...body } = audit;
            stored = await recordAudit.mutateAsync({ ref: result.item.ref, version: result.item.version, audit: body }).then(
              () => true,
              () => false,
            );
          }
          toast.show(stored ? copy.published(proposal.ref, result.item.version) : copy.auditNotStored, stored ? undefined : "err");
          router.push(libraryHref(project, kind, scopePart, slugPart));
        },
      },
    );
  }

  /**
   * A widget with code is audited before anything is saved for a publish
   * (JS-CONTRACT J3): a failing audit or a thrown error stops it, and the
   * report shows next to the buttons.
   */
  async function auditForPublish(): Promise<{ ok: boolean; audit: ScriptAuditOutcome | null }> {
    setBlockedAudit(null);
    if (!hasScript) return { ok: true, audit: null };
    setAuditing(true);
    try {
      const audit = (await kindEditor.current?.audit?.()) ?? null;
      if (!audit) {
        setError(copy.auditUnavailable);
        return { ok: false, audit: null };
      }
      if (!auditAllowsPublish(audit)) {
        setBlockedAudit(audit);
        setError(copy.auditBlocked);
        return { ok: false, audit };
      }
      return { ok: true, audit };
    } catch {
      setError(copy.auditUnavailable);
      return { ok: false, audit: null };
    } finally {
      setAuditing(false);
    }
  }

  function setFileContent(content: string) {
    if (file?.path === words.entry) setTemplateTouched(true);
    setDraft((current) => ({
      ...current,
      files: current.files.map((entry, index) => (index === selected ? { ...entry, content } : entry)),
    }));
  }

  function addFile() {
    if (!newPath || pathError) return;
    setDraft((current) => ({ ...current, files: [...current.files, { path: newPath, content: "" }] }));
    setSelected(draft.files.length);
    setNewPath("");
  }

  function removeFile(index: number) {
    setDraft((current) => ({ ...current, files: current.files.filter((_, at) => at !== index) }));
    setSelected(0);
  }

  function input(submit: boolean): LibraryProposalInput {
    return {
      // Themes and widgets keep their name and description in their files; the server reads them from there.
      ...(compiled ? {} : { ...(draft.name.trim() ? { name: draft.name.trim() } : {}), description: draft.description.trim() }),
      externalAllowed: draft.externalAllowed,
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      files: draft.files,
      submit,
      ...(editing ? (rebase && currentVersion !== undefined ? { baseVersion: currentVersion } : {}) : { baseVersion: baseVersion ?? 0 }),
    };
  }

  async function save(intent: "draft" | "propose" | "publish") {
    setError(null);
    // Only this draft's own problems stop a save; what the server refused last time is for it to check again.
    if (compiled && !summary.check()) return;
    let audit: ScriptAuditOutcome | null = null;
    if (intent === "publish") {
      const checked = await auditForPublish();
      if (!checked.ok) return;
      audit = checked.audit;
    }
    const body = input(intent === "propose");
    const onError = (failure: unknown) => {
      const diagnostics = compiled ? diagnosticsFromError(failure) : null;
      if (diagnostics && summary.refused(diagnostics)) return;
      setError(libraryErrorText(failure) ?? copy.saveError);
    };
    if (editing) {
      update.mutate(body, {
        onError,
        onSuccess: ({ proposal }) => {
          if (intent === "publish") {
            publishSaved(proposal, audit);
            return;
          }
          toast.show(proposal.status === "proposed" ? copy.proposalUpdated : copy.draftSaved);
          router.push(proposalPath(project, kind, proposal.ref, proposal.number));
        },
      });
      return;
    }
    create.mutate(
      { ...body, scope, ...(scope === "project" && project ? { project: project.id } : {}), slug: draft.slug },
      {
        onError,
        onSuccess: ({ proposal }) => {
          if (intent === "publish") {
            publishSaved(proposal, audit);
            return;
          }
          toast.show(proposal.status === "proposed" ? copy.proposed : copy.draftSaved);
          router.push(proposalPath(project, kind, proposal.ref, proposal.number));
        },
      },
    );
  }

  const back = editing
    ? { href: proposalPath(project, kind, editing.ref, editing.number), label: copy.proposalBack }
    : refName
      ? { href: libraryHref(project, kind, ...refName.split("/")), label: refName }
      : { href: libraryHref(project, kind), label: "Library" };

  if (!can.propose) {
    return (
      <>
        <BackButton {...back} />
        <Notice title={words.cantPropose} tone="warn">
          {copy.cantPropose(scope === "org" ? copy.theOrganization : (project?.name ?? copy.thisProject), roleLabel(organization.role), words.many)}
        </Notice>
      </>
    );
  }

  const isDraft = !editing || editing.status === "draft";
  const filesDescription =
    kind === "agent"
      ? "AGENTS.md holds the agent's instructions. HEARTBEAT.md is optional. agent.json suggests a provider, model and permission profile, and lists the skills it needs."
      : kind === "theme"
        ? "theme.json guarda os tokens: edite pelo formulário ou direto no JSON. fields.json diz como cada tipo de campo aparece. A prévia ao lado usa só dados de exemplo."
        : kind === "widget"
          ? "widget.html é o template e widget.json declara os campos e as variantes. A prévia ao lado usa só dados de exemplo e o tema ativo."
          : "SKILL.md is required. Add references the skill points to as more files.";
  return (
    <>
      <BackButton {...back} />
      <PageHeader
        description={
          editing?.status === "proposed"
            ? copy.newRound
            : kind === "agent"
              ? "People only ever install published versions. A proposal waits for an admin of its scope to publish it."
              : compiled
                ? "As páginas só usam versões publicadas. Uma proposta espera um admin do escopo publicar."
                : "Agents only ever load published versions. A proposal waits for an admin of its scope to publish it."
        }
        title={title}
      />

      <div className="space-y-8">
        {summaryItems.length ? (
          <ErrorSummary items={summaryItems} onSelect={selectProblem} ref={summaryElement} title={`Corrija ${summaryItems.length === 1 ? "o problema" : `os ${summaryItems.length} problemas`} antes de salvar`} />
        ) : null}

        <Section title={copy.about}>
          <Panel className="space-y-5 p-5">
            {isNew ? (
              <div className="grid gap-5 sm:grid-cols-2">
                <div id={SLUG_FIELD_ID}>
                  <Field
                    error={slugError}
                    hint={
                      kind === "agent"
                        ? "People install it with ravi agents install <scope>/<slug>."
                        : kind === "theme"
                          ? "Fica no endereço do tema: <escopo>/<slug>."
                          : kind === "widget"
                            ? "As páginas usam com widget=\"<slug>\"."
                            : "Agents load it with ravi skills show <scope>/<slug>."
                    }
                    label={copy.slug}
                  >
                    {(props) => (
                      <Input
                        {...props}
                        autoComplete="off"
                        className="font-mono"
                        maxLength={64}
                        onChange={(event) => patch({ slug: event.target.value.toLowerCase() })}
                        placeholder={kind === "agent" ? "atendente" : kind === "theme" ? "marca-acme" : kind === "widget" ? "pedido-card" : "agenda-semanal"}
                        value={draft.slug}
                      />
                    )}
                  </Field>
                </div>
                <Field label={copy.who}>
                  {(props) => (
                    <Select
                      {...props}
                      disabled={!project}
                      onChange={(event) => patch({ scope: event.target.value as Draft["scope"] })}
                      value={draft.scope}
                    >
                      {project ? <option value="project">{copy.onlyProject(project.name)}</option> : null}
                      <option value="org">{copy.everyProject}</option>
                    </Select>
                  )}
                </Field>
              </div>
            ) : null}
            {compiled ? (
              <p className="text-[13px] text-ink-3">
                {kind === "theme" ? "O nome e a descrição ficam no próprio tema, na aba Tokens." : "O nome e a descrição ficam no widget.json."}
              </p>
            ) : (
              <>
                <Field hint={copy.nameHint} label={copy.name} optional>
                  {(props) => (
                    <Input {...props} maxLength={120} onChange={(event) => patch({ name: event.target.value })} value={draft.name} />
                  )}
                </Field>
                <Field
                  hint={kind === "agent" ? "People read this when they look for an agent, so say what it does." : "Agents read this when they search, so say when to use the skill."}
                  label={copy.description}
                >
                  {(props) => (
                    <Textarea
                      {...props}
                      maxLength={1024}
                      onChange={(event) => patch({ description: event.target.value })}
                      rows={3}
                      value={draft.description}
                    />
                  )}
                </Field>
              </>
            )}
            {kind === "skill" ? (
              <Switch
                checked={draft.externalAllowed}
                description="When off, agents load it only in the organization's own conversations."
                label="Allowed in chats with people outside"
                onChange={(externalAllowed) => patch({ externalAllowed })}
              />
            ) : null}
            <Field hint={copy.noteHint} label={compiled ? `${copy.note} (opcional)` : copy.note} optional={!compiled}>
              {(props) => (
                <Input {...props} maxLength={500} onChange={(event) => patch({ note: event.target.value })} value={draft.note} />
              )}
            </Field>
          </Panel>
        </Section>

        <Section description={filesDescription} title={copy.files}>
          {kind === "widget" ? (
            <WidgetFilesEditor
              files={draft.files}
              onChange={setKindFiles}
              project={project}
              ref={kindEditor}
              scaffoldSlug={isNew ? draft.slug : undefined}
            />
          ) : kind === "theme" ? (
            <ThemeFilesEditor
              files={draft.files}
              onChange={setKindFiles}
              onTokenDraft={(path: string, next: TokenDraft) => setTokenDrafts((current) => ({ ...current, [path]: next }))}
              ref={kindEditor}
              tokenDrafts={tokenDrafts}
            />
          ) : (
          <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">

            <Panel className="p-2">
              <ul className="space-y-0.5">
                {draft.files.map((entry, index) => (
                  <li className="flex items-center gap-1" key={entry.path}>
                    <button
                      className={cn(
                        "min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left font-mono text-[12.5px]",
                        index === selected ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover",
                      )}
                      onClick={() => setSelected(index)}
                      type="button"
                    >
                      {entry.path}
                    </button>
                    {entry.path !== words.entry ? (
                      <IconButton icon={Trash2} label={`Remove ${entry.path}`} onClick={() => removeFile(index)} size="sm" />
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="mt-2 space-y-1.5 border-t border-line px-1 pt-2">
                <div className="flex gap-1.5">
                  <Input
                    aria-label="New file path"
                    className="h-8 font-mono text-[12.5px]"
                    onChange={(event) => setNewPath(event.target.value.trim())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addFile();
                      }
                    }}
                    placeholder={kind === "agent" ? "HEARTBEAT.md" : "references/guide.md"}
                    value={newPath}
                  />
                  <IconButton disabled={!newPath || Boolean(pathError)} icon={FilePlus2} label="Add file" onClick={addFile} size="sm" />
                </div>
                {pathError ? <p className="text-[12px] text-err">{pathError}</p> : null}
              </div>
            </Panel>
            {file ? (
              <Textarea
                aria-label={`Contents of ${file.path}`}
                className="min-h-[420px] py-2 font-mono text-[12.5px] leading-relaxed"
                onChange={(event) => setFileContent(event.target.value)}
                spellCheck={false}
                value={file.content}
              />
            ) : null}
          </div>
          )}
        </Section>

        {stale ? (
          <Notice title={copy.rebaseTitle(currentVersion)} tone="warn">
            <label className="mt-1 flex items-center gap-2">
              <input checked={rebase} onChange={(event) => setRebase(event.target.checked)} type="checkbox" />
              {copy.rebase(currentVersion)}
            </label>
          </Notice>
        ) : null}

        {error ? <FormMessage>{error}</FormMessage> : null}
        {blockedAudit ? <ScriptAuditReport outcome={blockedAudit} /> : null}
        {auditing ? (
          <p className="text-[13px] text-ink-3" role="status">
            {copy.auditing}
          </p>
        ) : null}
        {can.review && isDraft && hasScript && !scriptPublisher ? <Notice tone="info">{copy.scriptNeedsAdmin}</Notice> : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {isDraft ? (
            <Button disabled={!valid || busy} loading={(create.isPending || update.isPending) && !publish.isPending} onClick={() => void save("draft")} variant="secondary">
              {copy.saveDraft}
            </Button>
          ) : null}
          {can.review && isDraft && (!hasScript || scriptPublisher) ? (
            <Button disabled={!valid || busy || (stale && !rebase)} loading={publish.isPending || auditing} onClick={() => void save("publish")} variant="secondary">
              {copy.publishNow}
            </Button>
          ) : null}
          <Button disabled={!valid || busy} onClick={() => void save("propose")}>
            {editing?.status === "proposed" ? copy.saveChanges : copy.propose}
          </Button>
        </div>
      </div>
    </>
  );
}

function skillTemplate(slug: string, description: string) {
  const oneLine = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${slug || "my-skill"}\ndescription: ${oneLine || "What this skill does and when to use it."}\n---\n\n# ${slug || "my-skill"}\n\nSteps the agent follows.\n`;
}

const AGENT_TEMPLATE = "# Agent\n\nWho this agent is, who it talks to, and how it works.\n";
const AGENT_MANIFEST_TEMPLATE = `${JSON.stringify({ provider: null, model: null, profile: null, skills: [] }, null, 2)}\n`;

function BackButton({ href, label }: { href: string; label: string }) {
  return (
    <Button className="-ml-2.5 mb-3" href={href} icon={ArrowLeft} size="sm" variant="ghost">
      {label}
    </Button>
  );
}

function EditorSkeleton({ project }: { project: Project | null }) {
  const kind = useLibraryKind();
  return (
    <>
      <BackButton href={libraryHref(project, kind)} label="Library" />
      <div aria-busy aria-label="Loading" className="space-y-4" role="status">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </>
  );
}

function EditorError({ error, project }: { error: unknown; project: Project | null }) {
  const { organization } = useWorkspace();
  const kind = useLibraryKind();
  return (
    <>
      <BackButton href={libraryHref(project, kind)} label="Library" />
      <ErrorState error={error} role={roleLabel(organization.role)} title={KIND_WORDS[kind].loadError} />
    </>
  );
}
