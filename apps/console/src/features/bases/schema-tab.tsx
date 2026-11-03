"use client";

import { ChevronRight, Columns3 } from "lucide-react";

import type { BaseDetail, BaseProperty, BaseSelectOption } from "@/shared/bases/types";
import { Badge } from "@/ui/badge";
import { CopyValue } from "@/ui/copy";
import { Section } from "@/ui/layout";
import { EmptyState } from "@/ui/states";
import { OptionChip, TypeIcon } from "./cells";
import { listWords, nameForKey, plural, STATUS_GROUP_LABELS, typeDetail } from "./format";
import { When } from "./when";

const APPROVER_ROLE_WORDS = {
  developer: "quem desenvolve ou administra o projeto",
  project_admin: "quem administra o projeto",
  viewer: "qualquer pessoa do projeto",
} as const;

/** Who decides an approval and what sends it back to pending, or what an agent column reads. */
function configWords(base: BaseDetail, property: BaseProperty) {
  const members = new Map(base.members.map((member) => [member.id, member.displayName?.trim() || "uma pessoa sem nome"]));
  if (property.type === "approval") {
    const approvers = (property.config.approvers ?? []).map((approver) =>
      approver.kind === "project_role" ? APPROVER_ROLE_WORDS[approver.minRole] : (members.get(approver.userId) ?? "uma ex-integrante"),
    );
    const reset = (property.config.resetOn ?? []).map((key) => nameForKey(base, key));
    return [
      approvers.length ? `Decide: ${listWords(approvers, "ou")}.` : null,
      reset.length ? `Volta a pendente quando muda ${listWords(reset, "ou")}.` : null,
    ].filter(Boolean) as string[];
  }
  if (property.type === "agent") {
    const inputs = (property.config.inputs ?? []).map((key) => nameForKey(base, key));
    return [inputs.length ? `Lê ${listWords(inputs)}.` : null, property.config.instructions ?? null].filter(Boolean) as string[];
  }
  return [];
}

export function SchemaTab({ base }: { base: BaseDetail }) {
  const ordered = [...base.properties].sort((a, b) => a.position - b.position);
  const active = ordered.filter((property) => !property.deletedAt);
  const deleted = ordered.filter((property) => property.deletedAt);

  return (
    <div className="space-y-8">
      <Section
        description="Cada linha também guarda quando foi criada e editada pela última vez, por quem, e um corpo de texto."
        title={plural(active.length, "propriedade", "propriedades")}
      >
        {active.length ? (
          <ul aria-label="Propriedades" className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {active.map((property) => (
              <PropertyRow base={base} key={property.id} property={property} />
            ))}
          </ul>
        ) : (
          <EmptyState
            description="As linhas desta base só têm corpo. Peça a um agente para adicionar propriedades."
            icon={Columns3}
            title="Nenhuma propriedade ainda"
          />
        )}
      </Section>

      {deleted.length ? (
        <details className="group rounded-lg border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-ink select-none [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="text-ink-3 transition-transform group-open:rotate-90" size={16} />
            Propriedades excluídas
            <span className="rounded-full bg-sunken px-1.5 text-xs font-normal text-ink-3">{deleted.length}</span>
          </summary>
          <div className="border-t border-line">
            <p className="px-4 pt-3 text-[13px] text-ink-3">
              Os valores delas ficam guardados, mas escondidos de todas as views. Um agente pode restaurá-las.
            </p>
            <ul aria-label="Propriedades excluídas" className="divide-y divide-line">
              {deleted.map((property) => (
                <PropertyRow base={base} key={property.id} property={property} />
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function PropertyRow({ base, property }: { base: BaseDetail; property: BaseProperty }) {
  const options = property.config.options ?? [];
  const config = configWords(base, property);
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken">
        <TypeIcon size={15} type={property.type} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink">{property.name}</span>
          {property.required ? <Badge>Obrigatória</Badge> : null}
          {property.deletedAt ? (
            <span className="text-[13px] text-ink-3">
              Excluída <When value={property.deletedAt} />
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-3">
          <span>{typeDetail(property.type, property.config)}</span>
          <span aria-hidden>·</span>
          <CopyValue className="-my-1.5" value={property.key} />
        </div>
        {property.description ? <p className="text-[13px] text-ink-2">{property.description}</p> : null}
        {config.map((line, index) => (
          <p className="line-clamp-3 text-[13px] whitespace-pre-wrap break-words text-ink-3" key={index}>
            {line}
          </p>
        ))}
        {options.length ? <Options options={options} status={property.type === "status"} /> : null}
      </div>
    </li>
  );
}

function OptionList({ options }: { options: BaseSelectOption[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <span className={option.archived ? "opacity-60" : undefined} key={option.id}>
          <OptionChip option={option} />
          {option.archived ? <span className="sr-only"> (arquivada)</span> : null}
        </span>
      ))}
    </span>
  );
}

function Options({ options, status }: { options: BaseSelectOption[]; status: boolean }) {
  const archived = options.some((option) => option.archived);
  if (!status) {
    return (
      <div className="space-y-1 pt-1">
        <OptionList options={options} />
        {archived ? <p className="text-xs text-ink-3">{ARCHIVED_HINT}</p> : null}
      </div>
    );
  }
  const groups = (Object.keys(STATUS_GROUP_LABELS) as Array<keyof typeof STATUS_GROUP_LABELS>)
    .map((group) => ({ group, options: options.filter((option) => (option.group ?? "todo") === group) }))
    .filter((entry) => entry.options.length);
  return (
    <div className="space-y-1.5 pt-1">
      {groups.map((entry) => (
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3" key={entry.group}>
          <span className="w-24 shrink-0 text-xs text-ink-3">{STATUS_GROUP_LABELS[entry.group]}</span>
          <OptionList options={entry.options} />
        </div>
      ))}
      {archived ? <p className="text-xs text-ink-3">{ARCHIVED_HINT}</p> : null}
    </div>
  );
}

const ARCHIVED_HINT = "Opções apagadas estão arquivadas: linhas antigas continuam com elas, novas não podem escolhê-las.";
