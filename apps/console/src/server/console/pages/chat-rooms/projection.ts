// Read-only Base projection of the shared Page chat rooms (V5 of the study):
// one row per message in the Base `conversas-pages` of the site's project, so
// people and agents can search and chart conversations like any other Base.
// Console tables stay the record; this copy is rebuilt from them, written as
// the system, and read only by the project's members (never by page guests,
// never private rooms). It runs only when the organization has Bases.

import { eq } from "drizzle-orm";

import { loadBasesCallerAccess } from "@/server/console/bases/access";
import { createBase } from "@/server/console/bases/bases";
import { basesJobCaller } from "@/server/console/bases/service-principal";
import { createProperty } from "@/server/console/bases/properties";
import { findBaseRecord, type BaseProjectRecord } from "@/server/console/bases/repository";
import { createRowsDirect, queryRowsDirect, updateRowDirect } from "@/server/console/bases/rows";
import { resolveBaseScope, type BaseScope, type BasesProjectScope } from "@/server/console/bases/scope";
import { createView, listViews } from "@/server/console/bases/views";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { db, schema } from "@/server/db";
import type { BaseRow, BaseView } from "@/shared/bases/types";

import { chatRoomStoreForDb, type ChatMessageRecord, type ChatRoomStore } from "./store";

export const CHAT_PROJECTION_BASE_SLUG = "conversas-pages";
export const CHAT_PROJECTION_VIEW_NAME = "Conversas";
/** Messages copied per run; a longer backlog continues on the next message. */
export const CHAT_PROJECTION_BATCH = 200;

type PropertyDef = { key: string; name: string; type: "text" | "number" | "checkbox" | "date"; config?: Record<string, unknown>; required?: boolean };

export const CHAT_PROJECTION_PROPERTIES: PropertyDef[] = [
  { key: "texto", name: "Mensagem", type: "text", required: true },
  { key: "autor", name: "Quem escreveu", type: "text" },
  { key: "papel", name: "Papel", type: "text" },
  { key: "origem", name: "Origem", type: "text" },
  { key: "pagina", name: "Página", type: "text" },
  { key: "enviada_em", name: "Enviada em", type: "date", config: { includeTime: true } },
  { key: "apagada", name: "Apagada", type: "checkbox" },
  { key: "sala", name: "Sala", type: "text" },
  { key: "seq", name: "Ordem na sala", type: "number" },
  { key: "mensagem_id", name: "Id da mensagem", type: "text" },
];
const HIDDEN = new Set(["sala", "seq", "mensagem_id"]);

export type ChatProjectionJob = { roomId: string; deletedMessageId?: string };

export type ChatProjectionDeps = {
  store?: ChatRoomStore;
  basesAvailable?: (organizationId: string) => Promise<boolean>;
  loadProject?: (projectId: string) => Promise<BaseProjectRecord | null>;
  target?: (project: BaseProjectRecord, requestId: string) => Promise<ChatProjectionTarget>;
};

/** Where rows go; the default writes the project's `conversas-pages` Base. */
export type ChatProjectionTarget = {
  lastSeq(roomId: string): Promise<number>;
  findRow(messageId: string): Promise<BaseRow | null>;
  createRows(rows: Array<Record<string, unknown>>, key: string): Promise<void>;
  updateRow(row: BaseRow, values: Record<string, unknown>, key: string): Promise<void>;
};

/** The values one message becomes. Pure, so the projection is easy to test. */
export function projectionValues(message: ChatMessageRecord, path: string): Record<string, unknown> {
  const shown = message.parts.filter((part) => part.type === "ui").length;
  const text = message.deletedAt ? "" : [message.body.trim(), shown ? `[${shown} bloco${shown === 1 ? "" : "s"} de interface]` : ""].filter(Boolean).join("\n");
  return {
    texto: text || (message.deletedAt ? "(apagada)" : "…"),
    autor: message.authorName,
    papel: message.authorType === "agent" ? "agente" : message.authorType === "system" ? "sistema" : message.authorRole === "guest" ? "convidado" : "membro",
    origem: message.source === "voice" ? "voz" : message.source === "comment" ? "comentário" : "texto",
    pagina: path,
    enviada_em: message.createdAt.toISOString(),
    apagada: Boolean(message.deletedAt),
    sala: message.roomId,
    seq: message.seq,
    mensagem_id: message.id,
  };
}

/**
 * Copies the room's new finished messages into the Base, or marks one deleted
 * message. Stops at the first message still streaming, so an agent reply is
 * copied once, with its final text. Best effort: errors are logged only.
 */
export async function projectChatRoomIntoBase(job: ChatProjectionJob, deps: ChatProjectionDeps = {}): Promise<{ created: number; updated: number } | null> {
  try {
    const store = deps.store ?? chatRoomStoreForDb();
    const room = await store.findRoom(job.roomId);
    if (!room || room.kind !== "shared") return null;
    if (!(await (deps.basesAvailable ?? basesAvailableFor)(room.organizationId))) return null;
    const project = await (deps.loadProject ?? loadProject)(room.projectId);
    if (!project || project.status !== "active") return null;
    const requestId = `page-chat-projection:${room.id}`;
    const target = await (deps.target ?? baseTarget)(project, requestId);

    let updated = 0;
    if (job.deletedMessageId) {
      const row = await target.findRow(job.deletedMessageId);
      const message = await store.getMessage(job.deletedMessageId);
      if (row && message && row.values.apagada !== true) {
        await target.updateRow(row, projectionValues(message, room.path), `page-chat:delete:${message.id}`);
        updated += 1;
      }
    }

    const after = await target.lastSeq(room.id);
    const pending = await store.listMessages(room.id, { afterSeq: after, limit: CHAT_PROJECTION_BATCH });
    const ready: ChatMessageRecord[] = [];
    for (const message of pending) {
      if (message.status === "streaming") break;
      ready.push(message);
    }
    if (ready.length) {
      await target.createRows(
        ready.map((message) => projectionValues(message, room.path)),
        `page-chat:${room.id}:${ready[0]!.seq}-${ready[ready.length - 1]!.seq}`,
      );
    }
    return { created: ready.length, updated };
  } catch (error) {
    console.error("Page chat room was not projected into its Base", { roomId: job.roomId, error: error instanceof Error ? error.message : "error" });
    return null;
  }
}

async function loadProject(projectId: string): Promise<BaseProjectRecord | null> {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return project ?? null;
}

async function basesAvailableFor(organizationId: string) {
  const access = await getConsoleFeatureAccessForOrganizationRole({ organizationId, role: "owner" });
  return Boolean(access.byKey["console.bases"]?.available);
}

async function baseTarget(project: BaseProjectRecord, requestId: string): Promise<ChatProjectionTarget> {
  const caller = basesJobCaller("shared-chat-projection", project, requestId);
  const projectScope: BasesProjectScope = {
    caller,
    project,
    access: await loadBasesCallerAccess(db, caller, project),
    projectReadOnly: false,
  };
  const scope = await ensureProjectionBase(projectScope);
  const first = async (filter: unknown) => (await queryRowsDirect(scope, { filter, sort: [{ prop: "seq", dir: "desc" }], limit: 1 })).rows[0] ?? null;
  return {
    async lastSeq(roomId) {
      const row = await first({ prop: "sala", op: "eq", value: roomId });
      return typeof row?.values.seq === "number" ? row.values.seq : 0;
    },
    findRow: (messageId) => first({ prop: "mensagem_id", op: "eq", value: messageId }),
    async createRows(rows, key) {
      await createRowsDirect(scope, { rows: rows.map((values) => ({ values })), idempotencyKey: key }, null);
    },
    async updateRow(row, values, key) {
      await updateRowDirect(scope, row.rowId, { values, expectedVersion: row.version, idempotencyKey: key }, null);
    },
  };
}

async function ensureProjectionBase(projectScope: BasesProjectScope): Promise<BaseScope> {
  const found = await findBaseRecord(db, { organizationId: projectScope.project.organizationId, projectId: projectScope.project.id, ref: CHAT_PROJECTION_BASE_SLUG });
  if (!found) {
    await createBase(projectScope, {
      slug: CHAT_PROJECTION_BASE_SLUG,
      name: "Conversas das páginas",
      description:
        "Cópia somente leitura das conversas compartilhadas do chat do Ravi nas páginas deste projeto, uma linha por mensagem, gravada pelo Console. Conversas privadas não entram.",
      icon: "💬",
      properties: CHAT_PROJECTION_PROPERTIES,
    });
  }
  let scope = await resolveBaseScope(projectScope, CHAT_PROJECTION_BASE_SLUG);
  for (const property of CHAT_PROJECTION_PROPERTIES) {
    if (scope.properties.some((existing) => existing.key === property.key && !existing.deletedAt)) continue;
    await createProperty(scope, { ...property, expectedSchemaVersion: scope.base.schemaVersion });
    scope = await resolveBaseScope(projectScope, CHAT_PROJECTION_BASE_SLUG);
  }
  const { views } = await listViews(scope);
  if (!views.some((view): view is BaseView => view.name === CHAT_PROJECTION_VIEW_NAME && "access" in view)) {
    await createView(scope, {
      name: CHAT_PROJECTION_VIEW_NAME,
      description: "Mensagens das conversas compartilhadas, mais novas primeiro.",
      columns: CHAT_PROJECTION_PROPERTIES.map((property) => property.key).filter((key) => !HIDDEN.has(key)),
      query: { filter: null, sort: [{ prop: "enviada_em", dir: "desc" }] },
      layout: { type: "table" },
      // Members of the project read it; nobody writes through it.
      access: { read: [{ kind: "project_role", minRole: "viewer" }], write: { principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false } },
    });
  }
  return scope;
}
