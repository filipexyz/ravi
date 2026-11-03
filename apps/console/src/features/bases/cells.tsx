"use client";

import {
  AtSign,
  BadgeCheck,
  Bot,
  Calendar,
  Check,
  CircleAlert,
  CircleCheck,
  CircleChevronDown,
  CircleDot,
  CircleX,
  Clock,
  FileText,
  Hash,
  Hourglass,
  Link,
  Link2,
  LoaderCircle,
  MessageSquareText,
  Phone,
  Tags,
  Type,
  UserRound,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import type {
  BaseAgentState,
  BaseAgentValue,
  BaseApprovalState,
  BaseApprovalValue,
  BaseCellValue,
  BaseSelectOption,
  BaseUserRef,
  BaseViewColumn,
} from "@/shared/bases/types";
import { Badge, type Tone } from "@/ui/badge";
import {
  AGENT_STATE_LABELS,
  agentOutputColumn,
  APPROVAL_STATE_LABELS,
  approvalActor,
  asAgentValue,
  asApprovalValue,
  asDateValue,
  asRefArray,
  asStringArray,
  bodyExcerpt,
  formatDateValue,
  formatInstant,
  formatNumber,
  isEmptyValue,
  optionById,
  optionStyle,
  safeHttpUrl,
  userName,
  type ColumnType,
} from "./format";

const TYPE_ICONS: Record<ColumnType, LucideIcon> = {
  text: Type,
  number: Hash,
  checkbox: Check,
  date: Calendar,
  select: CircleChevronDown,
  multi_select: Tags,
  status: CircleDot,
  url: Link,
  email: AtSign,
  phone: Phone,
  person: Users,
  ref: Link2,
  approval: BadgeCheck,
  agent: Bot,
  created_time: Clock,
  updated_time: Clock,
  created_by: UserRound,
  updated_by: UserRound,
  body: FileText,
};

export function TypeIcon({ className, size = 14, type }: { className?: string; size?: number; type: ColumnType }) {
  const Icon = TYPE_ICONS[type] ?? Type;
  return <Icon aria-hidden className={cn("shrink-0 text-ink-3", className)} size={size} />;
}

export function OptionChip({ className, option }: { className?: string; option: BaseSelectOption }) {
  const style = optionStyle(option.color);
  return (
    <span
      className={cn("inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium", className)}
      style={{ backgroundColor: style.backgroundColor, color: style.color }}
      title={option.archived ? `${option.name} (opção arquivada)` : undefined}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: style.dot }} />
      <span className="truncate">{option.name}</span>
    </span>
  );
}

function UnknownOption() {
  return <span className="text-ink-3 italic">Opção desconhecida</span>;
}

function Person({ id, users }: { id: string | null; users: Record<string, BaseUserRef> }) {
  return <span className="whitespace-nowrap">{userName(users, id)}</span>;
}

/**
 * One value rendered by its column type. `mode="cell"` keeps it on one line
 * for the table; `mode="full"` lets text wrap and shows the whole body.
 */
export function CellValue({
  column,
  mode = "cell",
  timezone,
  users,
  value,
}: {
  column: BaseViewColumn;
  mode?: "cell" | "full";
  timezone: string;
  users: Record<string, BaseUserRef>;
  value: BaseCellValue | undefined;
}) {
  const full = mode === "full";
  if (column.type === "checkbox") {
    const checked = value === true;
    return (
      <span
        aria-label={checked ? "Marcado" : "Não marcado"}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded border",
          checked ? "border-ink bg-ink text-canvas" : "border-line-strong bg-surface",
        )}
        role="img"
      >
        {checked ? <Check aria-hidden size={12} strokeWidth={3} /> : null}
      </span>
    );
  }
  if (isEmptyValue(value)) return null;

  switch (column.type) {
    case "text":
      return typeof value === "string" ? (
        <span className={full ? "whitespace-pre-wrap break-words" : "truncate"}>{value}</span>
      ) : null;
    case "number":
      return typeof value === "number" ? <span className="tabular-nums">{formatNumber(value, column.config)}</span> : null;
    case "date": {
      const date = asDateValue(value);
      return date ? <span className="whitespace-nowrap">{formatDateValue(date, Boolean(column.config.includeTime), timezone)}</span> : null;
    }
    case "created_time":
    case "updated_time":
      return typeof value === "string" ? <span className="whitespace-nowrap">{formatInstant(value, timezone)}</span> : null;
    case "select":
    case "status": {
      const option = optionById(column.config, value);
      return option ? <OptionChip option={option} /> : <UnknownOption />;
    }
    case "multi_select":
      return (
        <span className={cn("flex gap-1", full ? "flex-wrap" : "min-w-0 overflow-hidden")}>
          {asStringArray(value).map((id) => {
            const option = optionById(column.config, id);
            return option ? <OptionChip key={id} option={option} /> : <UnknownOption key={id} />;
          })}
        </span>
      );
    case "person":
      return (
        <span className={cn("flex gap-x-2", full ? "flex-wrap" : "min-w-0 overflow-hidden")}>
          {asStringArray(value).map((id, index, all) => (
            <span key={id}>
              <Person id={id} users={users} />
              {index < all.length - 1 ? "," : null}
            </span>
          ))}
        </span>
      );
    case "created_by":
    case "updated_by":
      return <Person id={typeof value === "string" ? value : null} users={users} />;
    case "url": {
      if (typeof value !== "string") return null;
      const href = safeHttpUrl(value);
      return href ? (
        <a
          className={cn("text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink", full ? "break-all" : "truncate")}
          href={href}
          onClick={(event) => event.stopPropagation()}
          rel="noreferrer noopener"
          target="_blank"
        >
          {value}
        </a>
      ) : (
        <span className={full ? "break-all" : "truncate"}>{value}</span>
      );
    }
    case "email":
      return typeof value === "string" ? (
        <a
          className="truncate text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
          href={`mailto:${value}`}
          onClick={(event) => event.stopPropagation()}
        >
          {value}
        </a>
      ) : null;
    case "phone":
      return typeof value === "string" ? (
        <a
          className="whitespace-nowrap text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
          href={`tel:${value.replace(/[^\d+]/g, "")}`}
          onClick={(event) => event.stopPropagation()}
        >
          {value}
        </a>
      ) : null;
    case "ref":
      return (
        <span className={cn("flex gap-x-2 font-mono text-[12px]", full ? "flex-wrap" : "min-w-0 overflow-hidden")}>
          {asRefArray(value).map((ref) => (
            <span className="whitespace-nowrap" key={`${ref.type}:${ref.id}`}>
              {ref.type} {ref.id}
            </span>
          ))}
        </span>
      );
    case "approval": {
      const approval = asApprovalValue(value);
      if (!approval) return null;
      return full ? (
        <ApprovalDetails timezone={timezone} users={users} value={approval} />
      ) : (
        <ApprovalCell users={users} value={approval} />
      );
    }
    case "agent": {
      const agent = asAgentValue(value);
      if (!agent) return null;
      return <AgentValue column={column} mode={mode} timezone={timezone} users={users} value={agent} />;
    }
    case "body":
      return typeof value === "string" ? (
        full ? (
          <span className="whitespace-pre-wrap break-words">{value}</span>
        ) : (
          <span className="truncate text-ink-2">{bodyExcerpt(value)}</span>
        )
      ) : null;
    default:
      return <span className="truncate">{typeof value === "string" ? value : JSON.stringify(value)}</span>;
  }
}

// ---------------------------------------------------------------------------
// Approval and agent values

const APPROVAL_TONES: Record<BaseApprovalState, Tone> = { approved: "ok", pending: "warn", rejected: "err" };
const APPROVAL_ICONS: Record<BaseApprovalState, LucideIcon> = { approved: CircleCheck, pending: Hourglass, rejected: CircleX };

/** The state of an approval as a pill: icon and word, never color alone. */
export function ApprovalPill({ state }: { state: BaseApprovalState }) {
  const Icon = APPROVAL_ICONS[state];
  return (
    <Badge className="shrink-0 gap-1" tone={APPROVAL_TONES[state]}>
      <Icon aria-hidden size={12} strokeWidth={2.25} />
      {APPROVAL_STATE_LABELS[state]}
    </Badge>
  );
}

function ApprovalCell({ users, value }: { users: Record<string, BaseUserRef>; value: BaseApprovalValue }) {
  const actor = approvalActor(value, users);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ApprovalPill state={value.state} />
      {actor?.name ? (
        <span className="truncate text-[13px] text-ink-3">
          <span className="sr-only">{value.state === "pending" ? "pedido por" : "por"} </span>
          {actor.name}
        </span>
      ) : null}
      {value.note ? (
        <MessageSquareText aria-label={`Com nota: ${value.note}`} className="shrink-0 text-ink-3" role="img" size={13}>
          <title>{value.note}</title>
        </MessageSquareText>
      ) : null}
    </span>
  );
}

function Moment({ at, timezone }: { at: string | null; timezone: string }) {
  if (!at) return null;
  return (
    <>
      {" em "}
      <time dateTime={at}>{formatInstant(at, timezone)}</time>
    </>
  );
}

function ApprovalDetails({ timezone, users, value }: { timezone: string; users: Record<string, BaseUserRef>; value: BaseApprovalValue }) {
  const actor = approvalActor(value, users);
  const requested = value.state !== "pending" && (value.requestedBy || value.requestedAt);
  return (
    <div className="min-w-0 space-y-1.5">
      <ApprovalPill state={value.state} />
      {actor ? (
        <p className="text-[13px] text-ink-2">
          {actor.name ? (
            <>
              {actor.verb} <span className="font-medium text-ink">{actor.name}</span>
            </>
          ) : (
            actor.verb.replace(/ por$/, "")
          )}
          <Moment at={actor.at} timezone={timezone} />
        </p>
      ) : null}
      {requested ? (
        <p className="text-[13px] text-ink-3">
          Pedido{value.requestedBy ? ` por ${userName(users, value.requestedBy)}` : ""}
          <Moment at={value.requestedAt} timezone={timezone} />
        </p>
      ) : null}
      {value.note ? (
        <blockquote className="border-l-2 border-line-strong pl-3 text-[13px] whitespace-pre-wrap break-words text-ink-2">
          <span className="sr-only">Nota: </span>
          {value.note}
        </blockquote>
      ) : null}
    </div>
  );
}

const AGENT_TONES: Record<BaseAgentState, Tone> = { done: "ok", error: "err", pending: "info" };
const AGENT_LINE: Record<BaseAgentState, [named: string, unnamed: string]> = {
  done: ["Preenchida pelo agente", "Preenchida por um agente"],
  error: ["Falhou no agente", "Falhou num agente"],
  pending: ["Pedida ao agente", "Pedida a um agente"],
};

/** "Preenchendo…" or "Erro" beside an agent value; a filled value needs no badge. */
export function AgentStateBadge({ state }: { state: BaseAgentState }) {
  if (state === "done") return null;
  return (
    <Badge className="shrink-0 gap-1" tone={AGENT_TONES[state]}>
      {state === "pending" ? (
        <LoaderCircle aria-hidden className="motion-safe:animate-spin" size={12} strokeWidth={2.25} />
      ) : (
        <CircleAlert aria-hidden size={12} strokeWidth={2.25} />
      )}
      {AGENT_STATE_LABELS[state]}
    </Badge>
  );
}

function AgentValue({
  column,
  mode,
  timezone,
  users,
  value,
}: {
  column: BaseViewColumn;
  mode: "cell" | "full";
  timezone: string;
  users: Record<string, BaseUserRef>;
  value: BaseAgentValue;
}) {
  const output = agentOutputColumn(column);
  const filled = value.value !== null && (output.type === "checkbox" || !isEmptyValue(value.value));
  const inner = filled ? (
    <CellValue column={output} mode={mode} timezone={timezone} users={users} value={value.value as BaseCellValue} />
  ) : null;

  if (mode === "cell") {
    return (
      <span className="flex min-w-0 items-center gap-2" title={value.state === "error" && value.error ? value.error : undefined}>
        {inner ? <span className="flex min-w-0 items-center">{inner}</span> : null}
        <AgentStateBadge state={value.state} />
        {value.state === "error" && value.error && !inner ? (
          <span className="truncate text-[13px] text-ink-3">{value.error}</span>
        ) : null}
      </span>
    );
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {inner ?? <span className="text-ink-3">Sem valor</span>}
        <AgentStateBadge state={value.state} />
      </div>
      {value.state === "error" && value.error ? (
        <p className="text-[13px] whitespace-pre-wrap break-words text-err">{value.error}</p>
      ) : null}
      <p className="flex items-start gap-1.5 text-[13px] text-ink-3">
        <Bot aria-hidden className="mt-0.5 shrink-0" size={13} />
        <span>
          {column.config.agent ? (
            <>
              {AGENT_LINE[value.state][0]} <span className="font-mono text-[12px] text-ink-2">{column.config.agent}</span>
            </>
          ) : (
            AGENT_LINE[value.state][1]
          )}
          {value.updatedAt ? <Moment at={value.updatedAt} timezone={timezone} /> : null}
          {value.state === "pending" && filled ? ". O valor acima é o anterior." : null}
        </span>
      </p>
    </div>
  );
}
