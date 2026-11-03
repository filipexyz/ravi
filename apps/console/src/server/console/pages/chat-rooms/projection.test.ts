import { describe, expect, test } from "bun:test";

import type { BaseProjectRecord } from "@/server/console/bases/repository";
import type { BaseRow } from "@/shared/bases/types";

import { projectChatRoomIntoBase, projectionValues } from "./projection";
import { memoryChatRoomStore } from "./store-memory";

const loadProject = async () => ({ id: "project", organizationId: "org", status: "active" }) as unknown as BaseProjectRecord;

function memoryTarget() {
  const rows: BaseRow[] = [];
  const keys: string[] = [];
  return {
    rows,
    keys,
    target: {
      async lastSeq(roomId: string) {
        return Math.max(0, ...rows.filter((row) => row.values.sala === roomId).map((row) => row.values.seq as number));
      },
      async findRow(messageId: string) {
        return rows.find((row) => row.values.mensagem_id === messageId) ?? null;
      },
      async createRows(values: Array<Record<string, unknown>>, key: string) {
        keys.push(key);
        for (const value of values) rows.push({ rowId: String(rows.length + 1), version: 1, values: value } as unknown as BaseRow);
      },
      async updateRow(row: BaseRow, values: Record<string, unknown>) {
        row.values = values as BaseRow["values"];
      },
    },
  };
}

async function setup(kind: "shared" | "private" = "shared") {
  const store = memoryChatRoomStore();
  const room = await store.getOrCreateRoom({ organizationId: "org", projectId: "project", siteId: "site", routeId: "route", kind, ownerUserId: kind === "private" ? "u1" : null, path: "/vendas" });
  const write = (authorType: "user" | "agent", body: string, status: "complete" | "streaming" = "complete") =>
    store.insertMessage({
      room,
      authorType,
      authorUserId: authorType === "user" ? "u1" : null,
      authorName: authorType === "user" ? "Ana" : "Ravi",
      authorRole: authorType === "user" ? "member" : null,
      body,
      parts: [],
      status,
      source: "text",
      clientMessageId: null,
      anchor: null,
      turnId: null,
    });
  return { store, room, write };
}

describe("Page chat Base projection", () => {
  test("copies finished messages once, stopping at a reply still streaming", async () => {
    const { store, room, write } = await setup();
    const memory = memoryTarget();
    const deps = { store, loadProject, basesAvailable: async () => true, target: async () => memory.target };
    await write("user", "Quanto vendemos?");
    const reply = await write("agent", "", "streaming");
    await write("user", "E ontem?");

    expect(await projectChatRoomIntoBase({ roomId: room.id }, deps)).toEqual({ created: 1, updated: 0 });
    await store.updateMessage(reply.message.id, { status: "complete", body: "42 pedidos." });
    expect(await projectChatRoomIntoBase({ roomId: room.id }, deps)).toEqual({ created: 2, updated: 0 });
    expect(await projectChatRoomIntoBase({ roomId: room.id }, deps)).toEqual({ created: 0, updated: 0 });
    expect(memory.rows.map((row) => [row.values.papel, row.values.texto])).toEqual([
      ["membro", "Quanto vendemos?"],
      ["agente", "42 pedidos."],
      ["membro", "E ontem?"],
    ]);
  });

  test("a deleted message loses its text in the Base", async () => {
    const { store, room, write } = await setup();
    const memory = memoryTarget();
    const deps = { store, loadProject, basesAvailable: async () => true, target: async () => memory.target };
    const { message } = await write("user", "telefone 9999");
    await projectChatRoomIntoBase({ roomId: room.id }, deps);
    await store.updateMessage(message.id, { deletedAt: new Date(), body: "" });
    expect(await projectChatRoomIntoBase({ roomId: room.id, deletedMessageId: message.id }, deps)).toEqual({ created: 0, updated: 1 });
    expect(memory.rows[0]!.values).toMatchObject({ texto: "(apagada)", apagada: true });
  });

  test("private rooms and orgs without Bases are never copied", async () => {
    const memory = memoryTarget();
    const privateRoom = await setup("private");
    await privateRoom.write("user", "só meu");
    expect(await projectChatRoomIntoBase({ roomId: privateRoom.room.id }, { store: privateRoom.store, loadProject, basesAvailable: async () => true, target: async () => memory.target })).toBeNull();
    const shared = await setup();
    await shared.write("user", "oi");
    expect(await projectChatRoomIntoBase({ roomId: shared.room.id }, { store: shared.store, loadProject, basesAvailable: async () => false, target: async () => memory.target })).toBeNull();
    expect(memory.rows).toHaveLength(0);
  });

  test("values say who wrote, how, and where", async () => {
    const { write } = await setup();
    const { message } = await write("user", "oi");
    expect(projectionValues({ ...message, source: "voice", authorRole: "guest" }, "/vendas")).toMatchObject({ papel: "convidado", origem: "voz", pagina: "/vendas", apagada: false });
  });
});
