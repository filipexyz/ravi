import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OverlayQuery } from "./model.js";

const BINDINGS_PATH = join(homedir(), ".ravi", "whatsapp-overlay-bindings.json");

export interface OverlayBindingRecord {
  title?: string | null;
  chatId?: string | null;
  session: string;
  updatedAt: number;
}

export function getBindingForQuery(query: OverlayQuery): OverlayBindingRecord | null {
  const bindings = loadBindings();
  const chatId = normalize(query.chatId);
  if (chatId) {
    const match = bindings
      .filter((binding) => normalize(binding.chatId) === chatId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (match) return match;
  }

  const title = normalize(query.title);
  if (title) {
    const match = bindings
      .filter((binding) => normalize(binding.title) === title)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (match) return match;
  }

  return null;
}

export function upsertBinding(input: {
  title?: string | null;
  chatId?: string | null;
  session: string;
}): OverlayBindingRecord {
  const bindings = loadBindings();
  const next: OverlayBindingRecord = {
    title: clean(input.title),
    chatId: clean(input.chatId),
    session: input.session,
    updatedAt: Date.now(),
  };

  const filtered = bindings.filter((binding) => {
    if (next.chatId && normalize(binding.chatId) === normalize(next.chatId)) {
      return false;
    }
    if (next.title && normalize(binding.title) === normalize(next.title)) {
      return false;
    }
    return true;
  });

  filtered.unshift(next);
  saveBindings(filtered.slice(0, 200));
  return next;
}

function loadBindings(): OverlayBindingRecord[] {
  try {
    if (!existsSync(BINDINGS_PATH)) {
      return [];
    }
    const raw = JSON.parse(readFileSync(BINDINGS_PATH, "utf-8"));
    return Array.isArray(raw) ? raw.filter(isBindingRecord) : [];
  } catch {
    return [];
  }
}

function saveBindings(bindings: OverlayBindingRecord[]): void {
  mkdirSync(join(homedir(), ".ravi"), { recursive: true });
  writeFileSync(BINDINGS_PATH, JSON.stringify(bindings, null, 2));
}

function isBindingRecord(value: unknown): value is OverlayBindingRecord {
  if (!value || typeof value !== "object") return false;
  const binding = value as OverlayBindingRecord;
  return typeof binding.session === "string" && typeof binding.updatedAt === "number";
}

function normalize(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  return cleaned ? cleaned.normalize("NFKC").trim().toLowerCase() : null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
