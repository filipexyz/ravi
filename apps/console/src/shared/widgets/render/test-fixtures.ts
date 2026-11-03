// Fixtures for the renderer tests: the proposta's order card ("Cartão de
// pedido") compiled by hand, a Bases-shaped record for it, and a context
// builder. Kept out of `*.test.ts` so several suites share them.

import type { BaseUserRef } from "@/shared/bases/types";

import type { CompiledWidget, FieldDisplayRules, RenderColumn, RenderContext, RenderRecord, TemplateNode } from "../types";

export const DEFAULT_RULES: FieldDisplayRules = {
  types: {
    status: "pill",
    select: "pill",
    multi_select: "pills",
    number: "number",
    currency: "currency",
    percent: "percent",
    date: "date",
    person: "avatar-name",
    url: "link",
    checkbox: "check",
  },
  roles: { image: "cover", avatar: "circle", highlight: "big", progress: "bar", rating: "stars" },
};

/** Collapses the no-break spaces Intl puts in currency and times. */
export function norm(text: string): string {
  return text.replace(/[  ]/g, " ");
}

const text = (v: string): TemplateNode => ({ k: "text", v });
const expr = (path: string, ...filters: Extract<TemplateNode, { k: "expr" }>["filters"]): TemplateNode => ({
  k: "expr",
  path: path.split("."),
  filters,
});
export function el(piece: string, attrs: Record<string, string | string[]> = {}, ...children: TemplateNode[]): TemplateNode {
  return {
    k: "el",
    piece,
    attrs: Object.fromEntries(Object.entries(attrs).map(([name, value]) => [name, Array.isArray(value) ? { ref: value } : { lit: value }])),
    children,
    line: 1,
  };
}
export { expr, text };

/**
 * The proposta's widget.html:
 *
 * <ravi-card>
 *   <ravi-row justify="between"><ravi-title>{titulo}</ravi-title><ravi-field name="status"></ravi-field></ravi-row>
 *   <ravi-text tone="secondary">{cliente} · {prazo | relative}</ravi-text>
 *   <ravi-row justify="between"><ravi-field name="responsavel"></ravi-field><ravi-field name="valor"></ravi-field></ravi-row>
 *   <ravi-button action="update" set="status=@done">Concluir</ravi-button>
 * </ravi-card>
 */
export const ORDER_TEMPLATE: TemplateNode[] = [
  el(
    "ravi-card",
    {},
    text("\n  "),
    el("ravi-row", { justify: "between" }, text("\n    "), el("ravi-title", {}, expr("titulo")), text("\n    "), el("ravi-field", { name: "status" }), text("\n  ")),
    text("\n  "),
    el("ravi-text", { tone: "secondary" }, expr("cliente"), text(" · "), expr("prazo", "relative")),
    text("\n  "),
    el("ravi-row", { justify: "between" }, el("ravi-field", { name: "responsavel" }), el("ravi-field", { name: "valor" })),
    text("\n  "),
    el("ravi-button", { action: "update", set: "status=@done" }, text("Concluir")),
    text("\n"),
  ),
];

export const ORDER_COMPACT: TemplateNode[] = [
  el(
    "ravi-card",
    { tone: "subtle" },
    el("ravi-row", { justify: "between", wrap: "true" }, el("ravi-title", { size: "sm" }, expr("titulo")), el("ravi-field", { name: "status" })),
  ),
];

export function orderWidget(overrides: Partial<CompiledWidget> = {}): CompiledWidget {
  return {
    v: 1,
    ref: { itemId: "00000000-0000-4000-8000-000000000001", ref: "org/pedido-card", version: 1 },
    name: "Cartão de pedido",
    description: "Pedido com status, cliente, prazo, responsável e valor.",
    fields: {
      titulo: { type: "text", required: true, label: "Pedido" },
      status: { type: "status" },
      cliente: { type: "text" },
      prazo: { type: "date" },
      responsavel: { type: "person", label: "Responsável" },
      valor: { type: "number", role: "highlight" },
      capa: { type: "url", role: "image" },
    },
    variants: { default: ORDER_TEMPLATE, compact: ORDER_COMPACT },
    actions: [{ verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: false, label: "Concluir" }],
    hash: "0".repeat(64),
    ...overrides,
  };
}

export const STATUS_OPTIONS = [
  { id: "k1a2b3c4", name: "A fazer", color: "gray" as const, group: "todo" as const },
  { id: "k5d6e7f8", name: "Em produção", color: "blue" as const, group: "in_progress" as const },
  { id: "k9g0h1i2", name: "Entregue", color: "green" as const, group: "done" as const },
];

export const ORDER_COLUMNS: Record<string, RenderColumn> = {
  titulo: { key: "titulo", name: "Título", type: "text", config: {} },
  status: { key: "status", name: "Status", type: "status", config: { options: STATUS_OPTIONS } },
  cliente: { key: "cliente", name: "Cliente", type: "text", config: {} },
  prazo: { key: "prazo", name: "Prazo", type: "date", config: {} },
  responsavel: { key: "responsavel", name: "Responsável", type: "person", config: {} },
  valor: { key: "valor", name: "Valor", type: "number", config: { format: "currency", currency: "BRL" } },
  capa: { key: "capa", name: "Capa", type: "url", config: {} },
};

export const USERS: Record<string, BaseUserRef> = {
  user_ana: { id: "user_ana", displayName: "Ana Souza", avatarUrl: null },
  user_bia: { id: "user_bia", displayName: "Bia Lima", avatarUrl: "https://example.test/bia.png" },
};

export function orderRecord(values: Partial<Record<string, unknown>> = {}): RenderRecord {
  return {
    id: "6f1c2a90-0000-4000-8000-0000000000aa",
    version: 3,
    values: {
      titulo: "Pedido 123",
      status: "k5d6e7f8",
      cliente: "Cliente Exemplo",
      prazo: { start: "2026-10-18", end: null },
      responsavel: ["user_ana"],
      valor: 12400,
      capa: "https://example.test/capa.png",
      ...values,
    },
  };
}

/** 2026-10-16 12:00 in São Paulo (15:00 UTC). */
export const NOW = new Date("2026-10-16T15:00:00Z");

export function makeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    locale: "pt-BR",
    timeZone: "America/Sao_Paulo",
    now: NOW,
    fields: DEFAULT_RULES,
    users: USERS,
    columns: ORDER_COLUMNS,
    can: { write: new Set(), create: false, archive: false },
    variant: "default",
    headingLevel: 3,
    idPrefix: "r1",
    interactive: true,
    ...overrides,
  };
}
