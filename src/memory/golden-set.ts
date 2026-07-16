/**
 * R24 — golden-set loader for memory curation.
 *
 * Fixtures live as JSON files under `./golden-set/*.json`. Loading is
 * deterministic and free of I/O side effects — this module reads the
 * fixtures at import time via `readdirSync`/`readFileSync` from the source
 * tree, letting the eval suite iterate them without embedding literals.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type GoldenSetInvariant = "R4" | "R5" | "R7" | "R14" | "R15" | "R16" | "R20";

export type GoldenSetAction = "save" | "skip" | "stage-hitl";

export type GoldenSetType = "user" | "feedback" | "project" | "reference";

export interface GoldenSetFixture {
  id: string;
  invariant: GoldenSetInvariant;
  description: string;
  transcript_excerpt: string;
  candidate: {
    title: string;
    content: string;
    type: GoldenSetType;
    identity_key: string;
  };
  existing_entry: {
    title: string;
    identity_key: string;
    content: string;
  } | null;
  expected: {
    action: GoldenSetAction;
    reason: string;
    note?: string;
  };
}

const INVARIANTS: readonly GoldenSetInvariant[] = ["R4", "R5", "R7", "R14", "R15", "R16", "R20"];
const ACTIONS: readonly GoldenSetAction[] = ["save", "skip", "stage-hitl"];
const TYPES: readonly GoldenSetType[] = ["user", "feedback", "project", "reference"];

function fixturesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "golden-set");
}

/**
 * Load and validate every fixture in the golden-set directory.
 *
 * Throws if any file fails the schema check — the eval CLI + the
 * `golden-set.test.ts` guard use this as a lint pass at build time.
 */
export function loadGoldenSetFixtures(): GoldenSetFixture[] {
  const dir = fixturesDir();
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name));

  const fixtures: GoldenSetFixture[] = [];
  const seenIds = new Set<string>();
  for (const path of entries) {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const fixture = validateFixture(parsed, path);
    if (seenIds.has(fixture.id)) {
      throw new Error(`Duplicate golden-set fixture id "${fixture.id}" at ${path}`);
    }
    seenIds.add(fixture.id);
    fixtures.push(fixture);
  }
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return fixtures;
}

function validateFixture(value: unknown, path: string): GoldenSetFixture {
  if (!value || typeof value !== "object") {
    throw new Error(`Golden-set fixture at ${path} is not an object`);
  }
  const obj = value as Record<string, unknown>;
  requireString(obj, "id", path);
  requireEnum(obj, "invariant", INVARIANTS, path);
  requireString(obj, "description", path);
  requireString(obj, "transcript_excerpt", path);

  const candidate = obj.candidate as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Golden-set fixture ${path} is missing "candidate"`);
  }
  requireString(candidate, "title", path);
  requireString(candidate, "content", path);
  requireEnum(candidate, "type", TYPES, path);
  requireString(candidate, "identity_key", path);

  if (obj.existing_entry !== null && obj.existing_entry !== undefined) {
    const existing = obj.existing_entry as Record<string, unknown>;
    requireString(existing, "title", path);
    requireString(existing, "identity_key", path);
    requireString(existing, "content", path);
  }

  const expected = obj.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected !== "object") {
    throw new Error(`Golden-set fixture ${path} is missing "expected"`);
  }
  requireEnum(expected, "action", ACTIONS, path);
  requireString(expected, "reason", path);

  return {
    id: obj.id as string,
    invariant: obj.invariant as GoldenSetInvariant,
    description: obj.description as string,
    transcript_excerpt: obj.transcript_excerpt as string,
    candidate: {
      title: candidate.title as string,
      content: candidate.content as string,
      type: candidate.type as GoldenSetType,
      identity_key: candidate.identity_key as string,
    },
    existing_entry:
      obj.existing_entry === null || obj.existing_entry === undefined
        ? null
        : {
            title: (obj.existing_entry as Record<string, unknown>).title as string,
            identity_key: (obj.existing_entry as Record<string, unknown>).identity_key as string,
            content: (obj.existing_entry as Record<string, unknown>).content as string,
          },
    expected: {
      action: expected.action as GoldenSetAction,
      reason: expected.reason as string,
      ...(typeof expected.note === "string" ? { note: expected.note } : {}),
    },
  };
}

function requireString(obj: Record<string, unknown>, key: string, path: string): void {
  if (typeof obj[key] !== "string" || (obj[key] as string).trim() === "") {
    throw new Error(`Golden-set fixture at ${path} is missing string field "${key}"`);
  }
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): void {
  if (!allowed.includes(obj[key] as T)) {
    throw new Error(
      `Golden-set fixture at ${path} field "${key}" must be one of ${allowed.join("|")}, got ${JSON.stringify(obj[key])}`,
    );
  }
}
