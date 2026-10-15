// Pure `permission:objectType:objectId` parser, the `fail()`-free twin of the
// parser in `src/cli/commands/context.ts`. The object id may itself contain
// colons (`read:task:abc:def` → objectId `abc:def`).

import type { ContextCapability } from "../router/router-db.js";

export function parseCapabilityString(input: unknown): ContextCapability | null {
  if (typeof input !== "string") return null;
  const firstColon = input.indexOf(":");
  const secondColon = input.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1 || secondColon === input.length - 1) return null;
  const permission = input.slice(0, firstColon).trim();
  const objectType = input.slice(firstColon + 1, secondColon).trim();
  const objectId = input.slice(secondColon + 1).trim();
  if (!permission || !objectType || !objectId) return null;
  return { permission, objectType, objectId };
}

/** Parses every entry; returns null when any entry is malformed, so a grant is all-or-nothing. */
export function parseCapabilityStrings(values: readonly unknown[]): ContextCapability[] | null {
  const parsed: ContextCapability[] = [];
  for (const value of values) {
    const capability = parseCapabilityString(value);
    if (!capability) return null;
    parsed.push(capability);
  }
  return parsed;
}
