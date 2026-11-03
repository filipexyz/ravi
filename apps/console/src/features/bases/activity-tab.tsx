"use client";

import { BarChart3, BellRing, Columns3, Database, Eye, History, Rows3 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { BaseDetail, BaseSubscription } from "@/shared/bases/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { useArchivedNames, useBaseActivity, useSubscriptions } from "./api";
import { eventWords, listWords, membersById, nameForKey, plural, subscriptionEventWords, type EventEntity } from "./format";
import { When } from "./when";

const ENTITY_ICONS: Record<EventEntity, LucideIcon> = {
  base: Database,
  chart: BarChart3,
  property: Columns3,
  row: Rows3,
  subscription: BellRing,
  view: Eye,
};

export function ActivityTab({ base, projectId }: { base: BaseDetail; projectId: string }) {
  const { organization, projects } = useWorkspace();
  const projectSlug = projects.find((project) => project.id === projectId)?.slug ?? projectId;
  const activity = useBaseActivity(projectId, base.slug);
  const names = useArchivedNames(projectId, base.slug, true);
  const subscriptions = useSubscriptions(projectId, base.slug, true);
  const members = membersById(base);

  // Every id that belongs to this base, with the name to show next to its events.
  const targets = new Map<string, string | null>([[base.id, null]]);
  for (const property of base.properties) targets.set(property.id, property.name);
  for (const view of names.views.data ?? base.views) targets.set(view.id, view.name);
  for (const chart of names.charts.data ?? base.charts) targets.set(chart.id, chart.name);
  for (const subscription of subscriptions.data ?? []) targets.set(subscription.id, subscription.installationName);
  const viewNames = new Map((names.views.data ?? base.views).map((view) => [view.id, view.name]));

  const events = (activity.data?.pages ?? []).flatMap((page) => page.events);

  const actorName = (actor: string) => {
    if (actor === "anonymous") return "Anônimo";
    if (actor === "system") return "Sistema";
    return members[actor]?.displayName?.trim() || "Pessoa desconhecida";
  };

  return (
    <div className="space-y-8">
      <Section
        description="Mudanças nesta base, nas propriedades, views e gráficos dela, das mais novas para as mais antigas. Mudanças em linhas ficam no histórico de cada linha."
        title="Mudanças"
      >
        {activity.isPending ? (
          <ListSkeleton rows={4} />
        ) : activity.isError && !activity.isFetchNextPageError ? (
          <ErrorState
            error={activity.error}
            onRetry={() => void activity.refetch()}
            role={roleLabel(organization.role)}
            title="As mudanças não carregaram"
          />
        ) : events.length === 0 ? (
          <EmptyState description="Nada sobre esta base foi registrado ainda." icon={History} title="Nenhuma mudança para mostrar" />
        ) : (
          <>
            <List label="Mudanças nesta base">
              {events.map((event) => {
                const words = eventWords(event.type);
                const Icon = ENTITY_ICONS[words.entity];
                const name = targets.get(event.target);
                return (
                  <ListRow
                    description={
                      <>
                        {actorName(event.actor)}
                        {event.note ? <span className="break-words"> · {event.note}</span> : null}
                        <span className="md:hidden">
                          {" · "}
                          <When value={event.t} />
                        </span>
                      </>
                    }
                    key={event.id}
                    leading={
                      <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
                        <Icon aria-hidden size={15} />
                      </span>
                    }
                    meta={<When value={event.t} />}
                    title={
                      <>
                        {words.verb}
                        {name && words.entity !== "base" ? <span className="font-normal text-ink-2"> · {name}</span> : null}
                      </>
                    }
                  />
                );
              })}
            </List>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 text-[13px] text-ink-3">
              <span>{plural(events.length, "mudança exibida", "mudanças exibidas")}</span>
              {activity.isFetchNextPageError ? <span className="text-err">Não foi possível carregar mudanças mais antigas.</span> : null}
              {activity.hasNextPage ? (
                <Button loading={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()} size="sm">
                  Carregar mais
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Section>

      <Section
        description="Instalações do Ravi conectadas que recebem uma mensagem na caixa de entrada quando uma linha muda, para um agente reagir."
        title="Quem fica sabendo das mudanças em linhas"
      >
        {subscriptions.isPending ? (
          <ListSkeleton rows={1} />
        ) : subscriptions.isError ? (
          <ErrorState
            error={subscriptions.error}
            onRetry={() => void subscriptions.refetch()}
            role={roleLabel(organization.role)}
            title="As inscrições não carregaram"
          />
        ) : !subscriptions.data.length ? (
          <EmptyState
            description="Nenhuma instalação é avisada quando linhas mudam. Um agente liga isso da própria máquina."
            icon={BellRing}
            title="Ninguém é avisado"
          >
            <CodeBlock code={`ravi bases subscribe ${base.slug} --project ${projectSlug}`} label="Na instalação que deve ser avisada" />
          </EmptyState>
        ) : (
          <List label="Instalações avisadas sobre mudanças em linhas">
            {subscriptions.data.map((subscription) => (
              <ListRow
                description={
                  <>
                    {subscriptionFilterWords(subscription, base, viewNames)}
                    {" · desde "}
                    <When value={subscription.createdAt} />
                    {subscription.status === "revoked" && subscription.revokedAt ? (
                      <>
                        {" · desligada "}
                        <When value={subscription.revokedAt} />
                      </>
                    ) : null}
                  </>
                }
                key={subscription.id}
                leading={
                  <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
                    <BellRing aria-hidden size={15} />
                  </span>
                }
                actions={
                  subscription.status === "active" ? (
                    <Badge dot tone="ok">
                      Ligada
                    </Badge>
                  ) : (
                    <Badge>Desligada</Badge>
                  )
                }
                title={subscription.installationName ?? "Instalação sem nome"}
              />
            ))}
          </List>
        )}
      </Section>
    </div>
  );
}

/** "Todas as mudanças", or what a filtered subscription narrows to. */
function subscriptionFilterWords(subscription: BaseSubscription, base: BaseDetail, viewNames: Map<string, string>) {
  const parts: string[] = [];
  if (subscription.events.length) parts.push(subscriptionEventWords(subscription.events));
  if (subscription.properties.length) {
    parts.push(`em ${listWords(subscription.properties.map((key) => nameForKey(base, key)))}`);
  }
  if (subscription.viewId) parts.push(`nas linhas da view “${viewNames.get(subscription.viewId) ?? "arquivada"}”`);
  if (!parts.length) return "Todas as mudanças";
  const text = parts.join(", ");
  return `Só ${text}`;
}
