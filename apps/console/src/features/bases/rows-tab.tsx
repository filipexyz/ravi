"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Download,
  EyeOff,
  Rows3,
  Search,
  SearchX,
  UserRound,
  UserRoundSearch,
  Wrench,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { useOrgKey } from "@/features/shell/workspace";
import type { BaseDetail, BaseRow, BaseSort, BaseUserRef, BaseViewColumn } from "@/shared/bases/types";
import { Button, IconButton } from "@/ui/button";
import { Input, Select } from "@/ui/form";
import { EmptyState, ErrorState, Notice, Skeleton } from "@/ui/states";
import { fetchViewRows, useViewRows, viewRowsKey, type ViewRowsOptions } from "./api";
import { CellValue } from "./cells";
import { buildCsv, collectExportRows, csvFileName, EXPORT_ROW_LIMIT } from "./csv";
import {
  defaultViewId,
  filterUsesViewer,
  filterWords,
  isFullView,
  isSortable,
  LAYOUT_LABELS,
  LOCALE,
  membersById,
  plural,
  sortDirectionWords,
  sortWords,
  viewColumns,
  type AnyView,
} from "./format";
import { RowDrawer } from "./row-drawer";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MAX_CHARS = 200;

export function RowsTab({ base, projectId }: { base: BaseDetail; projectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectId = useId();

  const readable = base.views.filter((view) => view.capabilities.read && !view.capabilities.aggregateOnly);
  const requested = searchParams.get("view");
  const view = readable.find((candidate) => candidate.id === requested) ?? readable.find((candidate) => candidate.id === defaultViewId(readable));
  // "Ver como" is for managers, and only names a member the base detail lists.
  const requestedAs = searchParams.get("as");
  const viewAs = base.capabilities.manage && requestedAs && base.members.some((member) => member.id === requestedAs) ? requestedAs : null;

  if (!view) {
    return (
      <EmptyState
        description={
          base.views.length
            ? "As views abertas para você só deixam adicionar linhas ou ver gráficos, então não há linhas para mostrar aqui."
            : "Esta base ainda não tem views. Um agente cria views na conversa."
        }
        icon={Rows3}
        title="Nenhuma view mostra linhas para você"
      />
    );
  }

  const replaceParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <label className="text-sm font-medium text-ink" htmlFor={selectId}>
          Linhas pela view
        </label>
        <Select className="sm:w-72" id={selectId} onChange={(event) => replaceParam("view", event.target.value)} value={view.id}>
          {readable.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </Select>
        <ViewSummary base={base} view={view} />
      </div>
      <ViewRows
        base={base}
        key={view.id}
        onViewAs={(userId) => replaceParam("as", userId)}
        projectId={projectId}
        view={view}
        viewAs={viewAs}
      />
    </div>
  );
}

function ViewSummary({ base, view }: { base: BaseDetail; view: AnyView }) {
  const columns = viewColumns(base, view).length;
  const parts = [plural(columns, "coluna")];
  if (view.layout.type !== "table") parts.push(`${LAYOUT_LABELS[view.layout.type].toLowerCase()} nas páginas, tabela aqui`);
  if (isFullView(view)) parts.push(view.query.filter ? "com filtro" : "todas as linhas");
  return <p className="text-[13px] text-ink-3">{parts.join(" · ")}</p>;
}

/** The search once typing pauses; clearing the box applies at once. */
function useDebouncedSearch(input: string) {
  const next = input.trim();
  const [settled, setSettled] = useState(next);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [next]);
  return next ? settled : "";
}

/** `for` names the search, sort and person an export ran with: a finished export's note goes away when they change. */
type ExportState =
  | { status: "idle" }
  | { status: "running"; count: number }
  | { status: "done"; count: number; fileName: string; truncated: boolean; for: string }
  | { status: "failed"; error: unknown; for: string };

function ViewRows({
  base,
  onViewAs,
  projectId,
  view,
  viewAs,
}: {
  base: BaseDetail;
  onViewAs: (userId: string | null) => void;
  projectId: string;
  view: AnyView;
  viewAs: string | null;
}) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<BaseSort | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedSearch(searchInput);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [cursorReset, setCursorReset] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const exportAbort = useRef<AbortController | null>(null);
  const options: ViewRowsOptions = { asUserId: viewAs, search, sort };
  const rows = useViewRows(projectId, base.slug, view.id, options);
  const members = useMemo(() => membersById(base), [base]);
  const describeCtx = useMemo(() => ({ base, members }), [base, members]);

  // Leaving the view stops a running export.
  useEffect(() => () => exportAbort.current?.abort(), []);
  const exportFor = JSON.stringify([search, sort, viewAs]);

  const descriptors = useMemo(() => viewColumns(base, view), [base, view]);
  const pages = rows.data?.pages ?? [];
  const keys = pages[0]?.columns ?? descriptors.map((column) => column.key);
  const columns: BaseViewColumn[] = keys.map(
    (key) => descriptors.find((column) => column.key === key) ?? { config: {}, key, name: key, required: false, type: "text" },
  );
  const allRows = pages.flatMap((page) => page.rows);
  const users = Object.assign({}, ...pages.map((page) => page.users)) as Record<string, BaseUserRef>;
  const openRow = openRowId ? (allRows.find((row) => row.rowId === openRowId) ?? null) : null;
  const viewingAs = pages[0]?.viewingAs;
  const notAdmitted = Boolean(viewAs) && viewingAs?.admitted === false;
  const viewAsName = viewAs ? members[viewAs]?.displayName?.trim() || "Esta pessoa" : null;

  // A cursor expires after 15 minutes or when the view changes: start over from the first page.
  const loadMore = async () => {
    const result = await rows.fetchNextPage();
    if (result.error instanceof ApiError && result.error.code === "cursor_invalid") {
      setCursorReset(true);
      await queryClient.resetQueries({ queryKey: viewRowsKey(orgKey, projectId, base.slug, view.id, options) });
    }
  };

  const toggleSort = (key: string) => {
    setCursorReset(false);
    setSort((current) => {
      if (!current || current.prop !== key) return { dir: "asc", prop: key };
      if (current.dir === "asc") return { dir: "desc", prop: key };
      return null;
    });
  };

  const runExport = async () => {
    exportAbort.current?.abort();
    const controller = new AbortController();
    exportAbort.current = controller;
    const runFor = exportFor;
    setExportState({ count: 0, status: "running" });
    try {
      const collected = await collectExportRows(
        (cursor, limit) => fetchViewRows(projectId, base.slug, view.id, { ...options, cursor, includeBody: true, limit }),
        { onProgress: (count) => setExportState({ count, status: "running" }), signal: controller.signal },
      );
      const exportColumns = collected.columns.map(
        (key) => descriptors.find((column) => column.key === key) ?? { config: {}, key, name: key, required: false, type: "text" as const },
      );
      const fileName = csvFileName(base.slug, view.name);
      saveCsv(fileName, buildCsv(exportColumns, collected.rows, collected.users, base.timezone));
      setExportState({ count: collected.rows.length, fileName, for: runFor, status: "done", truncated: collected.truncated });
    } catch (error) {
      if (controller.signal.aborted) return;
      setExportState({ error, for: runFor, status: "failed" });
    }
  };

  const viewerFilter = isFullView(view) && filterUsesViewer(view.query.filter);
  const invalid = !view.valid || (rows.error instanceof ApiError && rows.error.code === "view_invalid");

  if (invalid) {
    return (
      <Notice icon={Wrench} title="Esta view precisa de reparo antes de mostrar linhas" tone="warn">
        {isFullView(view) && view.invalidReason
          ? `${view.invalidReason} Peça a um agente para corrigir a view.`
          : "Uma propriedade que ela usa foi excluída ou mudou. Quem administra ou desenvolve o projeto pode pedir a um agente para corrigi-la."}
      </Notice>
    );
  }

  const sortText = sort
    ? ` · ordenadas por ${columns.find((column) => column.key === sort.prop)?.name ?? sort.prop}, ${sortDirectionWords(
        columns.find((column) => column.key === sort.prop)?.type ?? "text",
        sort.dir,
      )}`
    : isFullView(view)
      ? view.query.sort.length
        ? ` · ordenadas por ${sortWords(view.query.sort, describeCtx)}`
        : " · na ordem em que foram adicionadas"
      : "";

  return (
    <div className="space-y-3">
      <Toolbar
        base={base}
        exportBusy={exportState.status === "running"}
        exportDisabled={notAdmitted || rows.isPending || (rows.isSuccess && allRows.length === 0)}
        onExport={() => void runExport()}
        onSearch={setSearchInput}
        onViewAs={onViewAs}
        search={searchInput}
        viewAs={viewAs}
      />

      <ExportStatus
        onDismiss={() => setExportState({ status: "idle" })}
        state={"for" in exportState && exportState.for !== exportFor ? { status: "idle" } : exportState}
      />

      {viewAs && viewAsName ? (
        notAdmitted ? (
          <Notice icon={EyeOff} title="Esta pessoa não vê esta view" tone="warn">
            <p>
              {viewAsName} não está entre quem pode ler esta view, então não vê nenhuma linha por ela. Quem pode ler está na aba
              Views.
            </p>
            <BackToMe onClick={() => onViewAs(null)} />
          </Notice>
        ) : (
          <Notice icon={UserRoundSearch} title={`Vendo como ${viewAsName}`}>
            <p>
              Estas são as linhas e colunas que {viewAsName} vê por esta view
              {viewerFilter ? ", com o filtro aplicado a essa pessoa" : ""}. Nada é alterado.
            </p>
            <BackToMe onClick={() => onViewAs(null)} />
          </Notice>
        )
      ) : viewerFilter && isFullView(view) ? (
        <Notice icon={UserRound} title="Você está vendo as suas linhas">
          Esta view mostra a cada pessoa só as linhas dela ({filterWords(view.query.filter, describeCtx)}). Aqui essa pessoa é
          você, então quem abre uma página com esta view vê outras linhas. Use Ver como para ver as de outra pessoa.
        </Notice>
      ) : null}
      {cursorReset && !rows.isFetching ? (
        <Notice tone="info">A lista estava aberta havia um tempo, então foi carregada de novo desde o início.</Notice>
      ) : null}

      <p aria-live="polite" className="sr-only" role="status">
        {search && rows.isSuccess && !rows.isFetching
          ? `${plural(allRows.length, "linha encontrada", "linhas encontradas")}${rows.hasNextPage ? ", e há mais" : ""}`
          : ""}
      </p>

      {notAdmitted ? null : rows.isPending ? (
        <TableSkeleton columns={Math.min(columns.length, 5)} />
      ) : rows.isError && !rows.isFetchNextPageError ? (
        <ErrorState error={rows.error} onRetry={() => void rows.refetch()} title="As linhas não carregaram" />
      ) : allRows.length === 0 ? (
        search ? (
          <EmptyState
            action={
              <Button icon={X} onClick={() => setSearchInput("")} size="sm">
                Limpar busca
              </Button>
            }
            description={`Nenhuma linha desta view tem “${search}” nas colunas de texto, links, e-mails, telefones ou opções.`}
            icon={SearchX}
            title="Nenhuma linha encontrada"
          />
        ) : (
          <EmptyState
            description={
              viewAs
                ? `Nenhuma linha desta view aparece para ${viewAsName ?? "esta pessoa"} agora.`
                : viewerFilter
                  ? "Nenhuma linha desta view é sua."
                  : isFullView(view) && view.query.filter
                    ? "Nenhuma linha passa pelo filtro desta view agora."
                    : "Agentes adicionam linhas na conversa, e as pessoas adicionam pelas páginas feitas com esta base."
            }
            icon={Rows3}
            title="Nenhuma linha para mostrar"
          />
        )
      ) : (
        <>
          <RowsTable
            columns={columns}
            onOpen={setOpenRowId}
            onSort={toggleSort}
            rows={allRows}
            sort={sort}
            timezone={base.timezone}
            users={users}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-3">
            <span>
              {plural(allRows.length, "linha exibida", "linhas exibidas")}
              {search ? ` com “${search}”` : ""}
              {sortText}
            </span>
            {rows.isFetchNextPageError && !(rows.error instanceof ApiError && rows.error.code === "cursor_invalid") ? (
              <span className="text-err">Não foi possível carregar mais linhas.</span>
            ) : null}
            {rows.hasNextPage ? (
              <Button loading={rows.isFetchingNextPage} onClick={() => void loadMore()} size="sm">
                Carregar mais
              </Button>
            ) : null}
          </div>
        </>
      )}

      <RowDrawer
        base={base}
        columns={columns}
        onClose={() => setOpenRowId(null)}
        projectId={projectId}
        row={openRow}
        users={users}
        view={view}
        viewAs={viewAs}
        viewAsName={viewAsName}
      />
    </div>
  );
}

function BackToMe({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="mt-1.5 font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
      onClick={onClick}
      type="button"
    >
      Voltar a ver como eu
    </button>
  );
}

function Toolbar({
  base,
  exportBusy,
  exportDisabled,
  onExport,
  onSearch,
  onViewAs,
  search,
  viewAs,
}: {
  base: BaseDetail;
  exportBusy: boolean;
  exportDisabled: boolean;
  onExport: () => void;
  onSearch: (value: string) => void;
  onViewAs: (userId: string | null) => void;
  search: string;
  viewAs: string | null;
}) {
  const searchId = useId();
  const searchHintId = useId();
  const viewAsId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const members = useMemo(
    () =>
      [...base.members].sort((a, b) =>
        (a.displayName?.trim() || "￿").localeCompare(b.displayName?.trim() || "￿", LOCALE, { sensitivity: "base" }),
      ),
    [base.members],
  );
  const canViewAs = base.capabilities.manage && members.length > 0;

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <div className="relative min-w-0 md:w-80">
        <label className="sr-only" htmlFor={searchId}>
          Buscar linhas
        </label>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" size={15} />
        <Input
          aria-describedby={searchHintId}
          autoComplete="off"
          className="pr-9 pl-9"
          enterKeyHint="search"
          id={searchId}
          inputMode="search"
          maxLength={SEARCH_MAX_CHARS}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search) {
              event.preventDefault();
              onSearch("");
            }
          }}
          placeholder="Buscar linhas"
          ref={searchRef}
          spellCheck={false}
          type="text"
          value={search}
        />
        <span className="sr-only" id={searchHintId}>
          Procura nas colunas de texto, links, e-mails, telefones e opções desta view.
        </span>
        {search ? (
          <IconButton
            className="absolute top-1/2 right-0.5 -translate-y-1/2"
            icon={X}
            label="Limpar busca"
            onClick={() => {
              onSearch("");
              searchRef.current?.focus();
            }}
            size="sm"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {canViewAs ? (
          <div className="flex min-w-0 items-center gap-2">
            <label className="shrink-0 text-sm text-ink-2" htmlFor={viewAsId}>
              Ver como
            </label>
            <Select
              className="min-w-0 flex-1 sm:w-56 sm:flex-none"
              id={viewAsId}
              onChange={(event) => onViewAs(event.target.value || null)}
              value={viewAs ?? ""}
            >
              <option value="">Eu</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName?.trim() || "Pessoa sem nome"}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <Button disabled={exportDisabled} icon={Download} loading={exportBusy} onClick={onExport}>
          Exportar CSV
        </Button>
      </div>
    </div>
  );
}

function ExportStatus({ onDismiss, state }: { onDismiss: () => void; state: ExportState }) {
  const limit = EXPORT_ROW_LIMIT.toLocaleString(LOCALE);
  return (
    <div aria-live="polite" role="status">
      {state.status === "running" ? (
        <p className="text-[13px] text-ink-3">
          Exportando… {state.count ? plural(state.count, "linha lida", "linhas lidas") : "lendo as linhas"}
        </p>
      ) : state.status === "done" ? (
        <Notice icon={Download} tone={state.truncated ? "warn" : "ok"} title={state.truncated ? `O arquivo tem só as primeiras ${limit} linhas` : "CSV exportado"}>
          <p>
            {state.fileName} com {plural(state.count, "linha", "linhas")}
            {state.truncated
              ? `. A view tem mais linhas do que cabem num arquivo; busque ou ordene para exportar outras ${limit}.`
              : ", nas colunas e na ordem da tabela."}
          </p>
          <button
            className="mt-1.5 font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
            onClick={onDismiss}
            type="button"
          >
            Fechar aviso
          </button>
        </Notice>
      ) : state.status === "failed" ? (
        <Notice tone="err" title="A exportação falhou">
          <p>{state.error instanceof Error ? state.error.message : "Tente de novo em instantes."}</p>
          <button
            className="mt-1.5 font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
            onClick={onDismiss}
            type="button"
          >
            Fechar aviso
          </button>
        </Notice>
      ) : null}
    </div>
  );
}

/** Saves the CSV with a byte order mark, so spreadsheets read it as UTF-8. */
function saveCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Values rendered as links can't sit inside the button that opens the row. */
const LINK_TYPES = new Set<BaseViewColumn["type"]>(["url", "email", "phone"]);

function RowsTable({
  columns,
  onOpen,
  onSort,
  rows,
  sort,
  timezone,
  users,
}: {
  columns: BaseViewColumn[];
  onOpen: (rowId: string) => void;
  onSort: (key: string) => void;
  rows: BaseRow[];
  sort: BaseSort | null;
  timezone: string;
  users: Record<string, BaseUserRef>;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => {
                const active = sort?.prop === column.key ? sort.dir : null;
                const sortable = isSortable(column);
                return (
                  <th
                    aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
                    className={cn(
                      "h-10 px-3 text-left align-middle text-[13px] font-medium whitespace-nowrap text-ink-3 first:pl-4 last:pr-4",
                      column.type === "number" && "text-right",
                    )}
                    key={column.key}
                    scope="col"
                  >
                    {sortable ? (
                      <button
                        className={cn(
                          "group/sort -mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-hover hover:text-ink",
                          active && "text-ink",
                        )}
                        onClick={() => onSort(column.key)}
                        title={`Ordenar por ${column.name}`}
                        type="button"
                      >
                        {column.name}
                        {active === "asc" ? (
                          <ArrowUp aria-hidden size={13} />
                        ) : active === "desc" ? (
                          <ArrowDown aria-hidden size={13} />
                        ) : (
                          <ChevronsUpDown aria-hidden className="opacity-0 transition-opacity group-hover/sort:opacity-100" size={13} />
                        )}
                      </button>
                    ) : (
                      column.name
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr
                className="cursor-pointer transition-colors hover:bg-hover focus-within:bg-hover"
                key={row.rowId}
                onClick={() => onOpen(row.rowId)}
              >
                {columns.map((column, index) => {
                  const value = column.type === "body" ? (row.body ?? undefined) : row.values[column.key];
                  return (
                    <td
                      className={cn(
                        "h-11 max-w-[18rem] px-3 align-middle text-ink first:pl-4 last:pr-4",
                        column.type === "body" && "max-w-[22rem]",
                        column.type === "number" && "text-right",
                      )}
                      key={column.key}
                    >
                      {index === 0 && !LINK_TYPES.has(column.type) ? (
                        <button
                          className="flex w-full min-w-0 items-center text-left font-medium focus-visible:outline-offset-4"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen(row.rowId);
                          }}
                          type="button"
                        >
                          <CellValue column={column} timezone={timezone} users={users} value={value} />
                          {value === undefined || value === null || value === "" ? (
                            <span className="font-normal text-ink-3">Sem título</span>
                          ) : null}
                        </button>
                      ) : (
                        <div className={cn("flex min-w-0 items-center", column.type === "number" && "justify-end")}>
                          <CellValue column={column} timezone={timezone} users={users} value={value} />
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableSkeleton({ columns }: { columns: number }) {
  return (
    <div aria-busy aria-label="Carregando linhas" className="overflow-hidden rounded-lg border border-line bg-surface" role="status">
      <div className="flex gap-6 border-b border-line px-4 py-3">
        {Array.from({ length: Math.max(columns, 2) }, (_, index) => (
          <Skeleton className="h-3 w-20" key={index} />
        ))}
      </div>
      {Array.from({ length: 4 }, (_, row) => (
        <div className="flex gap-6 border-b border-line px-4 py-3.5 last:border-b-0" key={row}>
          {Array.from({ length: Math.max(columns, 2) }, (_, index) => (
            <Skeleton className={cn("h-3.5", index === 0 ? "w-32" : "w-20")} key={index} />
          ))}
        </div>
      ))}
    </div>
  );
}
