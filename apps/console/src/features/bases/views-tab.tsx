"use client";

import { AlertTriangle, BarChart3, Eye, Wrench } from "lucide-react";

import type {
  BaseDetail,
  BaseUserRef,
  BaseView,
  BaseViewPrincipal,
  BaseViewPublic,
  BaseViewWritePrincipal,
} from "@/shared/bases/types";
import { Badge } from "@/ui/badge";
import { CopyButton } from "@/ui/copy";
import { DetailList, Mono, Panel } from "@/ui/layout";
import { EmptyState, Notice } from "@/ui/states";
import { usePageSites } from "./api";
import {
  filterUsesViewer,
  filterWords,
  isFullView,
  LAYOUT_LABELS,
  layoutWords,
  listWords,
  membersById,
  nameForKey,
  optionById,
  sortWords,
  viewColumns,
  type AnyView,
  type DescribeContext,
} from "./format";

type SiteHosts = { loading: boolean; byId: Map<string, string> };

export function ViewsTab({ base, projectId }: { base: BaseDetail; projectId: string }) {
  const manage = base.capabilities.manage;
  const needsSites = base.views.some(
    (view) =>
      isFullView(view) &&
      (view.access.read.some((principal) => principal.kind === "page_viewer") ||
        view.access.write.principals.some((principal) => principal.kind === "page_viewer")),
  );
  const sites = usePageSites(projectId, needsSites);
  const hosts: SiteHosts = {
    byId: new Map((sites.data ?? []).map((site) => [site.id, site.defaultHostname])),
    loading: needsSites && sites.isPending,
  };
  const ctx: DescribeContext = { base, members: membersById(base) };

  if (!base.views.length) {
    return (
      <EmptyState
        description="Uma view escolhe as colunas e as linhas que as pessoas podem ler, e quem são essas pessoas. Peça a um agente para criar uma para a página ou as pessoas que precisam dela."
        icon={Eye}
        title="Nenhuma view ainda"
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-2">
        {manage
          ? "Cada view é um contrato: as colunas que mostra, as linhas que deixa passar e quem pode lê-las ou alterá-las. Quem administra ou desenvolve o projeto sempre lê e altera todas as linhas por todas as views; o que segue é o que as outras pessoas recebem."
          : "As views desta base abertas para você, e o que cada uma deixa você fazer."}
      </p>
      {sites.isError ? (
        <Notice tone="warn">As páginas do projeto não carregaram, então os endereços de página abaixo estão faltando.</Notice>
      ) : null}
      {base.views.map((view) =>
        isFullView(view) ? (
          <ManagedView base={base} ctx={ctx} hosts={hosts} key={view.id} view={view} />
        ) : (
          <PublicView base={base} key={view.id} view={view} />
        ),
      )}
    </div>
  );
}

function ViewHeader({ view }: { view: AnyView }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold text-ink">{view.name}</h3>
          <Badge>{LAYOUT_LABELS[view.layout.type] ?? view.layout.type}</Badge>
          {!view.valid ? (
            <Badge dot tone="err">
              Precisa de reparo
            </Badge>
          ) : null}
        </div>
        {view.description ? <p className="text-[13px] text-ink-2">{view.description}</p> : null}
      </div>
      <CopyButton label="Copiar id da view" value={view.id} />
    </div>
  );
}

function ColumnTags({ names }: { names: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {names.map((name, index) => (
        <span className="rounded bg-sunken px-1.5 py-0.5 text-[13px] text-ink-2" key={`${name}-${index}`}>
          {name}
        </span>
      ))}
    </span>
  );
}

function ChartNames({ base, view }: { base: BaseDetail; view: AnyView }) {
  const charts = base.charts.filter((chart) => chart.viewId === view.id);
  if (!charts.length) return <span className="text-ink-3">Nenhum</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {charts.map((chart) => (
        <span className="inline-flex items-center gap-1.5" key={chart.id}>
          <BarChart3 aria-hidden className="text-ink-3" size={14} />
          {chart.name}
        </span>
      ))}
    </span>
  );
}

function Sentences({ items }: { items: React.ReactNode[] }) {
  if (items.length === 1) return <p>{items[0]}</p>;
  return (
    <ul className="list-disc space-y-1 pl-4 marker:text-ink-3">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

const ROLE_WORDS = {
  developer: "Quem desenvolve ou administra o projeto",
  project_admin: "Quem administra o projeto",
  viewer: "Todo mundo no projeto",
} as const;

function Who({
  hosts,
  members,
  principal,
}: {
  hosts: SiteHosts;
  members: Record<string, BaseUserRef>;
  principal: BaseViewPrincipal | BaseViewWritePrincipal;
}) {
  switch (principal.kind) {
    case "project_role":
      return <>{ROLE_WORDS[principal.minRole]}</>;
    case "user":
      return <>{members[principal.userId]?.displayName?.trim() || "Uma pessoa que saiu ou é desconhecida"}</>;
    case "page_viewer": {
      const host = hosts.byId.get(principal.siteId);
      if (host) {
        return (
          <>
            Quem abre <Mono className="text-ink">{host}</Mono>
          </>
        );
      }
      return <>{hosts.loading ? "Quem abre um dos endereços de página deste projeto" : "Quem abre um endereço de página que não existe mais"}</>;
    }
  }
}

function joinNodes(nodes: React.ReactNode[]) {
  return nodes.map((node, index) => (
    <span key={index}>
      {index > 0 ? (index === nodes.length - 1 ? " e " : ", ") : null}
      {node}
    </span>
  ));
}

const PRESET_WORDS: Record<string, string> = {
  "$now": "o momento em que foi adicionada",
  "$today": "o dia em que foi adicionada",
  "$viewer.email": "o e-mail de quem a adiciona",
  "$viewer.raviUserId": "quem a adiciona",
};

function presetWords(base: BaseDetail, key: string, value: unknown) {
  const single = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof single === "string" && PRESET_WORDS[single]) return PRESET_WORDS[single];
  const property = base.properties.find((candidate) => candidate.key === key);
  if (property && typeof single === "string" && (property.type === "select" || property.type === "status")) {
    const option = optionById(property.config, single);
    if (option) return `“${option.name}”`;
  }
  if (typeof single === "boolean") return single ? "marcado" : "não marcado";
  return "um valor fixo";
}

function ManagedView({ base, ctx, hosts, view }: { base: BaseDetail; ctx: DescribeContext; hosts: SiteHosts; view: BaseView }) {
  const { access } = view;
  const hasFilter = Boolean(view.query.filter);
  const rowsPhrase = hasFilter ? (filterUsesViewer(view.query.filter) ? "as próprias linhas" : "as linhas que o filtro deixa passar") : "todas as linhas";
  const who = (principal: BaseViewPrincipal | BaseViewWritePrincipal) => <Who hosts={hosts} members={ctx.members} principal={principal} />;

  const readers: React.ReactNode[] = [];
  for (const principal of access.read.filter((item) => item.mode !== "aggregate")) {
    readers.push(
      <>
        {who(principal)} pode ler {rowsPhrase}.
      </>,
    );
  }
  for (const principal of access.read.filter((item) => item.mode === "aggregate")) {
    readers.push(<>{who(principal)} pode ver os gráficos desta view, não as linhas.</>);
  }
  if (!readers.length) readers.push("Ninguém mais. Só quem administra ou desenvolve o projeto lê linhas por esta view.");

  const writers: React.ReactNode[] = [];
  const columnNames = listWords(access.write.columns.map((key) => nameForKey(base, key)));
  const formLike = !access.read.length && access.write.create;
  const powers: string[] = [];
  if (formLike) {
    powers.push(access.write.columns.length ? `adicionar linhas, preenchendo ${columnNames}` : "adicionar linhas");
  } else {
    if (access.write.columns.length) powers.push(`alterar ${columnNames} em ${rowsPhrase}`);
    if (access.write.archive) powers.push(access.write.columns.length ? "arquivá-las" : `arquivar ${rowsPhrase}`);
    if (access.write.create) powers.push("adicionar linhas");
  }
  if (!access.write.principals.length) {
    writers.push("Ninguém mais. Só quem administra ou desenvolve o projeto altera linhas por esta view.");
  } else if (!powers.length) {
    const many = access.write.principals.length > 1;
    writers.push(
      <>
        {joinNodes(access.write.principals.map(who))} {many ? "aparecem" : "aparece"} entre quem escreve, mas ainda não{" "}
        {many ? "podem" : "pode"} alterar nada.
      </>,
    );
  } else {
    writers.push(
      <>
        {joinNodes(access.write.principals.map(who))} {access.write.principals.length > 1 ? "podem" : "pode"} {listWords(powers)}.
      </>,
    );
    const presets = Object.entries(access.write.set);
    if (access.write.create && presets.length) {
      writers.push(
        `Linhas novas recebem ${listWords(presets.map(([key, value]) => `${nameForKey(base, key)} igual a ${presetWords(base, key, value)}`))}.`,
      );
    }
    if (hasFilter) {
      writers.push(
        access.write.allowEscape
          ? "Uma alteração pode tirar a linha desta view; ela então some para quem alterou."
          : "Uma alteração que tiraria a linha desta view é recusada.",
      );
    }
    if (formLike) writers.push("Funciona como formulário: as pessoas adicionam linhas sem ler nenhuma.");
  }

  const hostSiteIds = Array.from(
    new Set(
      [...access.read, ...access.write.principals]
        .filter((principal): principal is Extract<BaseViewPrincipal, { kind: "page_viewer" }> => principal.kind === "page_viewer")
        .map((principal) => principal.siteId),
    ),
  );
  const siteUse = (siteId: string) => {
    const read = access.read.find((principal) => principal.kind === "page_viewer" && principal.siteId === siteId);
    const write = access.write.principals.some((principal) => principal.kind === "page_viewer" && principal.siteId === siteId);
    if (read && read.mode !== "aggregate") {
      return write ? "lê estas linhas como a pessoa que visita e pode alterá-las como permitido acima" : "lê estas linhas como a pessoa que visita";
    }
    if (read) return write ? "lê os gráficos desta view e pode alterar linhas como permitido acima" : "lê os gráficos desta view";
    return "escreve linhas como permitido acima, como a pessoa que visita";
  };

  return (
    <Panel as="article">
      <ViewHeader view={view} />
      <div className="space-y-3 px-5 pb-4">
        {!view.valid ? (
          <Notice className="mt-4" icon={Wrench} title="Esta view precisa de reparo" tone="err">
            {view.invalidReason ?? "Uma propriedade que ela usa foi excluída ou mudou."} Até um agente corrigi-la, páginas e
            pessoas que a usam recebem um erro.
          </Notice>
        ) : null}
        <DetailList
          items={[
            { key: "columns", label: "Colunas", value: <ColumnTags names={viewColumns(base, view).map((column) => column.name)} /> },
            { key: "rows", label: "Linhas", value: filterWords(view.query.filter, ctx) },
            { key: "order", label: "Ordem", value: sortWords(view.query.sort, ctx) },
            {
              key: "layout",
              label: "Páginas mostram como",
              value: (
                <>
                  {layoutWords(view.layout, ctx)}
                  {view.layout.type !== "table" ? <span className="text-ink-3"> (uma tabela no Console)</span> : null}
                </>
              ),
            },
            { key: "read", label: "Quem pode ler", value: <Sentences items={readers} /> },
            { key: "write", label: "Quem pode alterar", value: <Sentences items={writers} /> },
            { key: "charts", label: "Gráficos", value: <ChartNames base={base} view={view} /> },
          ]}
        />
        {hostSiteIds.map((siteId) => {
          const host = hosts.byId.get(siteId);
          return (
            <Notice icon={AlertTriangle} key={siteId} title="Um endereço de página inteiro usa esta view" tone="warn">
              Toda página publicada em {host ? <Mono className="text-ink">{host}</Mono> : "esse endereço"}, agora ou depois,{" "}
              {siteUse(siteId)}.
            </Notice>
          );
        })}
      </div>
    </Panel>
  );
}

function capitalize(text: string) {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function PublicView({ base, view }: { base: BaseDetail; view: BaseViewPublic }) {
  const caps = view.capabilities;
  const yours: string[] = [];
  if (caps.read && !caps.aggregateOnly) yours.push("ler as linhas dela");
  if (caps.aggregateOnly) yours.push("ver os gráficos dela, não as linhas");
  if (caps.writeColumns.length) {
    yours.push(`alterar ${listWords(caps.writeColumns.map((key) => view.columns.find((column) => column.key === key)?.name ?? key))}`);
  }
  if (caps.approve?.length) {
    yours.push(`aprovar ou recusar ${listWords(caps.approve.map((key) => view.columns.find((column) => column.key === key)?.name ?? key), "ou")}`);
  }
  if (caps.create) yours.push("adicionar linhas");
  if (caps.archive) yours.push("arquivar linhas");

  return (
    <Panel as="article">
      <ViewHeader view={view} />
      <div className="space-y-3 px-5 pb-4">
        {!view.valid ? (
          <Notice className="mt-4" icon={Wrench} title="Esta view precisa de reparo" tone="err">
            Quem administra ou desenvolve o projeto pode pedir a um agente para corrigi-la.
          </Notice>
        ) : null}
        <DetailList
          items={[
            { key: "columns", label: "Colunas", value: <ColumnTags names={view.columns.map((column) => column.name)} /> },
            {
              key: "layout",
              label: "Páginas mostram como",
              value: LAYOUT_LABELS[view.layout.type] ?? view.layout.type,
            },
            { key: "yours", label: "O que você pode fazer", value: yours.length ? capitalize(`${listWords(yours)}.`) : "Nada ainda." },
            { key: "charts", label: "Gráficos", value: <ChartNames base={base} view={view} /> },
          ]}
        />
      </div>
    </Panel>
  );
}
