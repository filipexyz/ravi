"use client";

import { Bot, History, UserRoundSearch } from "lucide-react";

import { ApiError } from "@/lib/api/client";
import type { BaseCellValue, BaseDetail, BaseLedgerEntry, BaseRow, BaseUserRef, BaseViewColumn } from "@/shared/bases/types";
import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { DetailList } from "@/ui/layout";
import { Drawer } from "@/ui/overlay";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { useRowHistory, useViewRow } from "./api";
import { CellValue } from "./cells";
import { isEmptyValue, membersById, plainValue, rowTitle, userName, type AnyView } from "./format";
import { When } from "./when";

export function RowDrawer({
  base,
  columns,
  onClose,
  projectId,
  row,
  users,
  view,
  viewAs,
  viewAsName,
}: {
  base: BaseDetail;
  columns: BaseViewColumn[];
  onClose: () => void;
  projectId: string;
  row: BaseRow | null;
  users: Record<string, BaseUserRef>;
  view: AnyView;
  viewAs: string | null;
  viewAsName: string | null;
}) {
  return (
    <Drawer
      actions={row ? <CopyButton label="Copiar id da linha" value={row.rowId} /> : null}
      description={viewAsName ? `Pela view “${view.name}”, como ${viewAsName}` : `Pela view “${view.name}”`}
      onClose={onClose}
      open={Boolean(row)}
      title={row ? rowTitle(columns, row.values) : "Linha"}
    >
      {row ? (
        <RowDetails
          base={base}
          columns={columns}
          listRow={row}
          listUsers={users}
          projectId={projectId}
          view={view}
          viewAs={viewAs}
          viewAsName={viewAsName}
        />
      ) : null}
    </Drawer>
  );
}

function RowDetails({
  base,
  columns,
  listRow,
  listUsers,
  projectId,
  view,
  viewAs,
  viewAsName,
}: {
  base: BaseDetail;
  columns: BaseViewColumn[];
  listRow: BaseRow;
  listUsers: Record<string, BaseUserRef>;
  projectId: string;
  view: AnyView;
  viewAs: string | null;
  viewAsName: string | null;
}) {
  // The row as the server returns it now (as the chosen member when viewing as one); the list's copy shows meanwhile.
  const fresh = useViewRow(projectId, base.slug, view.id, listRow.rowId, viewAs, {
    idempotentReplay: false,
    row: listRow,
    users: listUsers,
  });
  const gone = fresh.error instanceof ApiError && fresh.error.status === 404;
  const row = fresh.data?.row ?? listRow;
  const users = { ...listUsers, ...fresh.data?.users };
  const valueColumns = columns.filter((column) => column.type !== "body");
  const showsBody = columns.some((column) => column.type === "body");

  return (
    <div className="space-y-6">
      {gone ? (
        <Notice tone="warn" title="Esta linha saiu da view">
          Ela foi arquivada ou mudou e não passa mais pelo filtro{viewAsName ? ` para ${viewAsName}` : ""}. Os valores abaixo são
          os da lista.
        </Notice>
      ) : null}
      <DetailList
        className="-mt-3"
        items={valueColumns.map((column) => {
          const value = row.values[column.key];
          const empty = column.type !== "checkbox" && isEmptyValue(value);
          return {
            key: column.key,
            label: column.name,
            value: empty ? (
              <span className="text-ink-3">Vazio</span>
            ) : (
              <div className="flex min-w-0 flex-wrap items-center">
                <CellValue column={column} mode="full" timezone={base.timezone} users={users} value={value} />
              </div>
            ),
          };
        })}
      />

      {showsBody ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Corpo</h3>
          {row.body ? (
            <div className="max-h-80 overflow-y-auto rounded-md border border-line bg-sunken px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">
              {row.body}
            </div>
          ) : (
            <p className="text-sm text-ink-3">Esta linha não tem corpo.</p>
          )}
        </section>
      ) : null}

      <RowHistory base={base} columns={columns} knownUsers={users} projectId={projectId} rowId={row.rowId} view={view} viewAs={viewAs} />
    </div>
  );
}

const ACTION_WORDS: Record<BaseLedgerEntry["action"], string> = {
  archived: "Arquivada",
  created: "Criada",
  purged: "Excluída de vez",
  restored: "Restaurada",
  updated: "Alterada",
};

const SURFACE_WORDS: Record<NonNullable<BaseLedgerEntry["surface"]>, string> = {
  cli: "pelo CLI",
  console: "no Console",
  page: "numa página",
  system: "pelo sistema",
};

const ACTOR_TYPE_WORDS: Partial<Record<NonNullable<BaseLedgerEntry["actorType"]>, string>> = {
  agent: "um agente",
  anonymous: "alguém anônimo",
  api_key: "uma chave de API",
  system: "o sistema",
};

/** "por Ana pelo CLI". Null where the view hides who changed rows. */
export function actorWords(entry: Pick<BaseLedgerEntry, "actorId" | "actorType" | "surface">, users: Record<string, BaseUserRef>) {
  if (!entry.actorType) return null;
  const who =
    entry.actorType === "system" || entry.actorType === "api_key" || entry.actorType === "agent"
      ? ACTOR_TYPE_WORDS[entry.actorType]
      : entry.actorId && users[entry.actorId]
        ? userName(users, entry.actorId)
        : (ACTOR_TYPE_WORDS[entry.actorType] ?? "alguém");
  const where = entry.surface ? SURFACE_WORDS[entry.surface] : null;
  return [`por ${who}`, where].filter(Boolean).join(" ");
}

function RowHistory({
  base,
  columns,
  knownUsers,
  projectId,
  rowId,
  view,
  viewAs,
}: {
  base: BaseDetail;
  columns: BaseViewColumn[];
  /** People the row and the base already named: history `users` only covers the actors, not people in old values. */
  knownUsers: Record<string, BaseUserRef>;
  projectId: string;
  rowId: string;
  view: AnyView;
  viewAs: string | null;
}) {
  const history = useRowHistory(projectId, base.slug, view.id, rowId);
  const pages = history.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.entries);
  const users = Object.assign({}, membersById(base), knownUsers, ...pages.map((page) => page.users)) as Record<string, BaseUserRef>;
  const hidden = entries.some((entry) => entry.actorType === null || entry.createdAt === null);
  const columnFor = (key: string): BaseViewColumn =>
    columns.find((column) => column.key === key) ?? { config: {}, key, name: key, required: false, type: "text" };
  const valueText = (key: string, value: BaseCellValue | undefined) => {
    const text = plainValue(columnFor(key), value, users, base.timezone);
    return text || "vazio";
  };
  // History is always read as the manager: a row only the chosen member sees has none to show here.
  const hiddenFromMe = Boolean(viewAs) && history.error instanceof ApiError && history.error.status === 404;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <History aria-hidden className="text-ink-3" size={15} />
        <h3 className="text-sm font-semibold text-ink">Histórico</h3>
      </div>
      {history.isPending ? (
        <div aria-busy aria-label="Carregando histórico" className="space-y-3" role="status">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : hiddenFromMe ? (
        <p className="flex items-start gap-2 text-sm text-ink-3">
          <UserRoundSearch aria-hidden className="mt-0.5 shrink-0" size={15} />
          Você não vê esta linha por esta view como você mesmo, então o histórico dela não aparece aqui.
        </p>
      ) : history.isError && !history.isFetchNextPageError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} title="O histórico não carregou" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-3">Nenhuma alteração registrada nas colunas que esta view mostra.</p>
      ) : (
        <>
          <ol className="relative space-y-4 border-l border-line pl-4">
            {entries.map((entry) => {
              const actor = actorWords(entry, users);
              const order = (key: string) => {
                const index = columns.findIndex((column) => column.key === key);
                return index === -1 ? columns.length : index;
              };
              const visibleKeys = entry.changedKeys
                .filter((key) => key in entry.after || key in entry.before)
                .sort((a, b) => order(a) - order(b));
              return (
                <li className="relative" key={entry.id}>
                  <span aria-hidden className="absolute top-1.5 -left-[21.5px] size-2.5 rounded-full border-2 border-line-strong bg-surface" />
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-sm font-medium text-ink">{ACTION_WORDS[entry.action]}</span>
                    {entry.createdAt ? <When className="text-[13px] text-ink-3" value={entry.createdAt} /> : null}
                  </div>
                  {actor || entry.agent ? (
                    <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-ink-3">
                      {actor ? <span>{actor}</span> : null}
                      {entry.agent ? (
                        <span className="inline-flex items-center gap-1">
                          <Bot aria-hidden size={13} />
                          via agente <span className="font-mono text-[12px] text-ink-2">{entry.agent.id}</span>
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {visibleKeys.length || entry.bodyChanged ? (
                    <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
                      {visibleKeys.map((key) => (
                        <li className="break-words" key={key}>
                          <span className="font-medium text-ink">{columnFor(key).name}</span>{" "}
                          {entry.action === "created" ? (
                            valueText(key, entry.after[key])
                          ) : (
                            <>
                              <span className="text-ink-3">{valueText(key, entry.before[key])}</span>
                              <span aria-hidden className="px-1 text-ink-3">
                                →
                              </span>
                              <span className="sr-only"> mudou para </span>
                              {valueText(key, entry.after[key])}
                            </>
                          )}
                        </li>
                      ))}
                      {entry.bodyChanged ? <li className="text-ink-3">Corpo {entry.action === "created" ? "escrito" : "alterado"}</li> : null}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {hidden ? (
            <p className="text-[13px] text-ink-3">
              Esta view não mostra quem alterou as linhas nem quando, então o histórico deixa isso de fora.
            </p>
          ) : null}
          {history.isFetchNextPageError ? <p className="text-[13px] text-err">Não foi possível carregar alterações mais antigas.</p> : null}
          {history.hasNextPage ? (
            <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()} size="sm">
              Mostrar alterações mais antigas
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
