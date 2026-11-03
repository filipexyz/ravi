import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { loadBasesCallerAccess } from "@/server/console/bases/access";
import { createBase } from "@/server/console/bases/bases";
import { basesJobCaller } from "@/server/console/bases/service-principal";
import { createProperty } from "@/server/console/bases/properties";
import { findBaseRecord, type BaseProjectRecord } from "@/server/console/bases/repository";
import { createRowsDirect, queryRowsDirect, updateRowDirect } from "@/server/console/bases/rows";
import { resolveBaseScope, type BaseScope, type BasesProjectScope } from "@/server/console/bases/scope";
import { createView, listViews, updateView } from "@/server/console/bases/views";
import { db, schema } from "@/server/db";
import type { BaseRow, BaseView, BaseViewPrincipal } from "@/shared/bases/types";

import {
  computeDailyMetrics,
  computePeopleUsage,
  localDay,
  METRICS_AREAS,
  METRICS_TIMEZONE,
  shiftDay,
  type DailyMetrics,
  type MetricsFilter,
  type PersonUsage,
} from "./compute";

// Writes the usage metrics into two Bases of the metrics project
// (`RAVI_METRICS_PROJECT`) as the system: one row per day and one row per
// person. Creates the bases, their missing properties and the "Painel" views
// on first run. The views admit the project's members and, once the project
// has a default Pages site, that site's viewers, so a data page can read them.

/** First run fills this many days; later runs recompute the last `REFRESH_DAYS`. */
export const METRICS_BACKFILL_DAYS = 120;
export const METRICS_REFRESH_DAYS = 3;
export const METRICS_VIEW_NAME = "Painel";

type PropertyDef = {
  key: string;
  name: string;
  type: "text" | "number" | "checkbox" | "date" | "multi_select" | "email";
  description?: string;
  required?: boolean;
  config?: Record<string, unknown>;
};

type BaseDef = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  properties: PropertyDef[];
  /** Hidden from the view: the row key and the content fingerprint. */
  hidden: string[];
  keyProp: string;
  sort: { prop: string; dir: "asc" | "desc" };
};

export const DAYS_BASE: BaseDef = {
  slug: "uso-dias",
  name: "Uso do Console por dia",
  description:
    "Uma linha por dia (fuso America/Sao_Paulo), gravada pelo Console. Janelas de 7 e 30 dias terminam no dia. Pessoas não contam a equipe Ravi (platform operators). Fonte: auditoria, escritas em Bases, publicações e tráfego do Pages.",
  icon: "📈",
  keyProp: "dia",
  sort: { prop: "dia", dir: "desc" },
  hidden: ["assinatura"],
  properties: [
    { key: "dia", name: "Dia", type: "date", required: true },
    { key: "pessoas_ativas", name: "Pessoas ativas no dia", type: "number" },
    { key: "pessoas_7d", name: "Pessoas ativas em 7 dias", type: "number" },
    { key: "pessoas_30d", name: "Pessoas ativas em 30 dias", type: "number" },
    { key: "orgs_7d", name: "Orgs ativas em 7 dias", type: "number" },
    { key: "pessoas_novas", name: "Pessoas novas", type: "number", description: "Contas criadas no dia." },
    { key: "publicadores_7d", name: "Quem publicou em 7 dias", type: "number" },
    { key: "publicacoes", name: "Publicações no dia", type: "number" },
    { key: "leitores_7d", name: "Quem abriu página privada em 7 dias", type: "number" },
    { key: "req_publicas", name: "Requisições públicas", type: "number", description: "Arquivos servidos em rotas públicas do Pages; não são visitantes." },
    { key: "req_privadas", name: "Requisições privadas", type: "number" },
    { key: "sites_visitados", name: "Sites com visita", type: "number" },
    { key: "instalacoes_7d", name: "Instalações ativas em 7 dias", type: "number", description: "Ravis ligados ao Console vistos na semana." },
    { key: "assinatura", name: "Assinatura", type: "text", description: "Uso interno: evita regravar a linha sem mudança." },
  ],
};

export const PEOPLE_BASE: BaseDef = {
  slug: "uso-pessoas",
  name: "Pessoas que usam o Console",
  description:
    "Uma linha por pessoa com atividade nos últimos 90 dias, gravada pelo Console. Atividade é ação própria no Console ou no Pages, ou do CLI e dos agentes com o login dela.",
  icon: "👥",
  keyProp: "user_id",
  sort: { prop: "ultima_atividade", dir: "desc" },
  hidden: ["user_id", "assinatura"],
  properties: [
    { key: "nome", name: "Nome", type: "text", required: true },
    { key: "email", name: "Email", type: "email" },
    { key: "orgs", name: "Orgs", type: "text" },
    { key: "areas", name: "Áreas em 30 dias", type: "multi_select", config: { options: METRICS_AREAS.map((name) => ({ name })) } },
    { key: "ultima_atividade", name: "Última atividade", type: "date", config: { includeTime: true } },
    { key: "entrou_em", name: "Entrou em", type: "date" },
    { key: "acoes_30d", name: "Ações em 30 dias", type: "number" },
    { key: "publicacoes_30d", name: "Publicações em 30 dias", type: "number" },
    { key: "aberturas_30d", name: "Páginas privadas abertas em 30 dias", type: "number" },
    { key: "usa_cli", name: "Usou CLI ou agente em 30 dias", type: "checkbox" },
    { key: "ativa_7d", name: "Ativa em 7 dias", type: "checkbox" },
    { key: "equipe_ravi", name: "Equipe Ravi", type: "checkbox" },
    { key: "user_id", name: "Id do usuário", type: "text" },
    { key: "assinatura", name: "Assinatura", type: "text", description: "Uso interno: evita regravar a linha sem mudança." },
  ],
};

export type MetricsSyncResult = {
  project: { id: string; organizationId: string; slug: string };
  siteId: string | null;
  days: { baseId: string; viewId: string; created: number; updated: number; from: string; to: string };
  people: { baseId: string; viewId: string; created: number; updated: number };
};

export class MetricsConfigError extends Error {
  constructor(readonly code: "metrics_project_not_configured" | "metrics_project_not_found" | "metrics_project_not_active") {
    super(code);
    this.name = "MetricsConfigError";
  }
}

/** `RAVI_METRICS_PROJECT`: a project uuid or `<org-slug>/<project-slug>`. */
export async function resolveMetricsProject(ref: string | undefined): Promise<BaseProjectRecord> {
  const value = ref?.trim();
  if (!value) throw new MetricsConfigError("metrics_project_not_configured");
  let project: BaseProjectRecord | undefined;
  if (/^[0-9a-f-]{36}$/i.test(value)) {
    [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, value.toLowerCase())).limit(1);
  } else {
    const [orgSlug, projectSlug, ...rest] = value.split("/");
    if (orgSlug && projectSlug && rest.length === 0) {
      const [row] = await db
        .select({ project: schema.projects })
        .from(schema.projects)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.projects.organizationId))
        .where(and(eq(schema.organizations.slug, orgSlug), eq(schema.projects.slug, projectSlug)))
        .limit(1);
      project = row?.project;
    }
  }
  if (!project || project.status === "deleted") throw new MetricsConfigError("metrics_project_not_found");
  if (project.status !== "active") throw new MetricsConfigError("metrics_project_not_active");
  return project;
}

export type MetricsSetup = {
  siteId: string | null;
  days: BaseScope;
  daysViewId: string;
  people: BaseScope;
  peopleViewId: string;
};

/** Creates what is missing (bases, properties, "Painel" views) and returns their ids. */
export async function ensureMetricsSetup(input: { project: BaseProjectRecord; requestId: string }): Promise<MetricsSetup> {
  const caller = basesJobCaller("usage-metrics", input.project, input.requestId);
  const projectScope: BasesProjectScope = {
    caller,
    project: input.project,
    access: await loadBasesCallerAccess(db, caller, input.project),
    projectReadOnly: false,
  };
  const siteId = await defaultSiteId(input.project.id);
  const days = await ensureBase(projectScope, DAYS_BASE);
  const daysViewId = await ensureView(days, DAYS_BASE, siteId);
  const people = await ensureBase(projectScope, PEOPLE_BASE);
  const peopleViewId = await ensureView(people, PEOPLE_BASE, siteId);
  return { siteId, days, daysViewId, people, peopleViewId };
}

export async function syncUsageMetrics(input: MetricsFilter & { project: BaseProjectRecord; now: Date; requestId: string }): Promise<MetricsSyncResult> {
  const { siteId, days, daysViewId, people, peopleViewId } = await ensureMetricsSetup(input);

  const today = localDay(input.now);
  const existingDays = await rowsByKey(days, DAYS_BASE.keyProp);
  const from = shiftDay(today, -(existingDays.size === 0 ? METRICS_BACKFILL_DAYS - 1 : METRICS_REFRESH_DAYS - 1));
  const daily = await computeDailyMetrics({ fromDay: from, toDay: today, excludeOrgIds: input.excludeOrgIds });
  const dayWrites = await upsertRows(days, DAYS_BASE, existingDays, daily.map(dayValues), input.requestId);

  const usage = await computePeopleUsage({ now: input.now, excludeOrgIds: input.excludeOrgIds });
  const peopleWrites = await upsertRows(people, PEOPLE_BASE, await rowsByKey(people, PEOPLE_BASE.keyProp), usage.map(personValues), input.requestId);

  return {
    project: { id: input.project.id, organizationId: input.project.organizationId, slug: input.project.slug },
    siteId,
    days: { baseId: days.base.id, viewId: daysViewId, ...dayWrites, from, to: today },
    people: { baseId: people.base.id, viewId: peopleViewId, ...peopleWrites },
  };
}

export function dayValues(day: DailyMetrics): Record<string, unknown> {
  return {
    dia: day.day,
    pessoas_ativas: day.activePeople,
    pessoas_7d: day.activePeople7d,
    pessoas_30d: day.activePeople30d,
    orgs_7d: day.activeOrgs7d,
    pessoas_novas: day.newPeople,
    publicadores_7d: day.publishers7d,
    publicacoes: day.publishes,
    leitores_7d: day.readers7d,
    req_publicas: day.publicRequests,
    req_privadas: day.privateRequests,
    sites_visitados: day.visitedSites,
    instalacoes_7d: day.activeInstallations7d,
  };
}

export function personValues(person: PersonUsage): Record<string, unknown> {
  return {
    nome: person.name.slice(0, 200),
    email: person.email,
    orgs: person.organizations.join(", ").slice(0, 2000),
    areas: person.areas30d,
    ultima_atividade: person.lastActiveAt,
    entrou_em: localDay(new Date(person.joinedAt)),
    acoes_30d: person.actions30d,
    publicacoes_30d: person.publishes30d,
    aberturas_30d: person.pageOpens30d,
    usa_cli: person.usesCli30d,
    ativa_7d: person.active7d,
    equipe_ravi: person.staff,
    user_id: person.userId,
  };
}

/** Stable short hash of the values a row would get. */
export function fingerprint(values: Record<string, unknown>): string {
  const ordered = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 24);
}

async function defaultSiteId(projectId: string): Promise<string | null> {
  const [site] = await db
    .select({ id: schema.pageSites.id })
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.projectId, projectId), eq(schema.pageSites.isDefault, true), eq(schema.pageSites.status, "active")))
    .limit(1);
  return site?.id ?? null;
}

async function ensureBase(projectScope: BasesProjectScope, def: BaseDef): Promise<BaseScope> {
  const found = await findBaseRecord(db, { organizationId: projectScope.project.organizationId, projectId: projectScope.project.id, ref: def.slug });
  if (!found) {
    await createBase(projectScope, {
      slug: def.slug,
      name: def.name,
      description: def.description,
      icon: def.icon,
      timezone: METRICS_TIMEZONE,
      properties: def.properties,
    });
  }
  let scope = await resolveBaseScope(projectScope, def.slug);
  for (const property of def.properties) {
    if (scope.properties.some((existing) => existing.key === property.key && !existing.deletedAt)) continue;
    await createProperty(scope, { ...property, expectedSchemaVersion: scope.base.schemaVersion });
    scope = await resolveBaseScope(projectScope, def.slug);
  }
  return scope;
}

function viewSpec(def: BaseDef, siteId: string | null) {
  const read: BaseViewPrincipal[] = [{ kind: "project_role", minRole: "viewer" }];
  if (siteId) read.push({ kind: "page_viewer", siteId });
  return {
    columns: def.properties.map((property) => property.key).filter((key) => !def.hidden.includes(key)),
    query: { filter: null, sort: [def.sort] },
    layout: { type: "table" as const },
    access: { read, write: { principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false } },
  };
}

function sameReaders(view: BaseView, wanted: BaseViewPrincipal[]) {
  const key = (principal: BaseViewPrincipal) => JSON.stringify([principal.kind, "siteId" in principal ? principal.siteId : "", "minRole" in principal ? principal.minRole : ""]);
  const have = new Set(view.access.read.map(key));
  return have.size === wanted.length && wanted.every((principal) => have.has(key(principal)));
}

async function ensureView(scope: BaseScope, def: BaseDef, siteId: string | null): Promise<string> {
  const spec = viewSpec(def, siteId);
  const { views } = await listViews(scope);
  const existing = views.find((view): view is BaseView => view.name === METRICS_VIEW_NAME && "access" in view);
  if (!existing) {
    const created = await createView(scope, { name: METRICS_VIEW_NAME, description: "Lida pelo painel de métricas no Pages.", ...spec });
    return created.payload.id;
  }
  const sameColumns = existing.columns.length === spec.columns.length && spec.columns.every((column, index) => existing.columns[index] === column);
  if (!sameColumns || !sameReaders(existing, spec.access.read)) {
    await updateView(scope, existing.id, { expectedVersion: existing.version, ...spec });
  }
  return existing.id;
}

function rowKey(row: BaseRow, keyProp: string): string | null {
  const value = row.values[keyProp] as unknown;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "start" in value && typeof (value as { start: unknown }).start === "string") {
    return (value as { start: string }).start;
  }
  return null;
}

async function rowsByKey(scope: BaseScope, keyProp: string): Promise<Map<string, BaseRow>> {
  const rows = new Map<string, BaseRow>();
  let cursor: string | null = null;
  do {
    const page = await queryRowsDirect(scope, { limit: 500, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      const key = rowKey(row, keyProp);
      if (key) rows.set(key, row);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

async function upsertRows(
  scope: BaseScope,
  def: BaseDef,
  existing: Map<string, BaseRow>,
  wanted: Array<Record<string, unknown>>,
  requestId: string,
): Promise<{ created: number; updated: number }> {
  const creates: Array<{ values: Record<string, unknown> }> = [];
  let updated = 0;
  for (const values of wanted) {
    const signature = fingerprint(values);
    const key = String(values[def.keyProp]);
    const row = existing.get(key);
    if (!row) {
      creates.push({ values: { ...values, assinatura: signature } });
      continue;
    }
    if (row.values.assinatura === signature) continue;
    await updateRowDirect(
      scope,
      row.rowId,
      { values: { ...values, assinatura: signature }, expectedVersion: row.version, idempotencyKey: `metrics:${def.slug}:${row.rowId}:${signature}` },
      null,
    );
    updated += 1;
  }
  for (let index = 0; index < creates.length; index += 500) {
    const batch = creates.slice(index, index + 500);
    const batchKey = fingerprint({ requestId, rows: batch.map((row) => row.values.assinatura) });
    await createRowsDirect(scope, { rows: batch, idempotencyKey: `metrics:${def.slug}:create:${batchKey}` }, null);
  }
  return { created: creates.length, updated };
}
