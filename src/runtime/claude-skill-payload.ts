import { z } from "zod";
import { assertObservedSkillExposure } from "./skill-exposure-contract.js";
import type { ObservedSkillExposure } from "./skill-exposure-contract.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

const CATALOG_MARKER = "The following skills are available for use with the Skill tool:";
const INVALID_PAYLOAD = "Claude skill payload observation is invalid.";
const textBlockSchema = z
  .object({ type: z.string().min(1), text: z.string().optional() })
  .passthrough()
  .refine((block) => block.type !== "text" || typeof block.text === "string");
const requestSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(textBlockSchema).min(1)]),
      }),
    )
    .min(1),
});

export function observeClaudeSkillPayload(
  body: Uint8Array,
  snapshot: SkillPolicySnapshot,
  nativeNames: Readonly<Record<string, string>>,
  untrustedPrompt?: string,
): ObservedSkillExposure {
  try {
    if (untrustedPrompt?.includes(CATALOG_MARKER)) throw new Error(INVALID_PAYLOAD);
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    const request = requestSchema.parse(raw);
    const canonicalNames = new Map<string, string>();
    for (const [id, name] of Object.entries(nativeNames)) {
      if (!id || !name || /\s/.test(name) || canonicalNames.has(name)) throw new Error(INVALID_PAYLOAD);
      canonicalNames.set(name, id);
    }
    assertAuthorizedCommandExpansions(request.messages, canonicalNames);
    const markerCount = countCatalogMarkers(raw);
    if (markerCount > 1) throw new Error(INVALID_PAYLOAD);
    const ids: string[] = [];
    if (markerCount === 1) {
      // The verified native transport prepends one dedicated reminder here.
      // A matching historical/user/tool block elsewhere is not native evidence.
      const message = request.messages[0];
      const block = message && Array.isArray(message.content) ? message.content[0] : undefined;
      if (message?.role !== "user" || block?.type !== "text" || !block.text?.includes(CATALOG_MARKER)) {
        throw new Error(INVALID_PAYLOAD);
      }
      ids.push(...parseCatalogBlock(block.text, canonicalNames));
    }
    const observed: ObservedSkillExposure = {
      snapshotId: snapshot.id,
      mode: "native-restricted",
      advertisedIds: ids,
      discoverableIds: [...ids],
      evidence: "effective-prompt",
    };
    assertObservedSkillExposure(snapshot, observed);
    return observed;
  } catch {
    // Parser errors can contain user text or schema values. Never expose them.
    throw new Error(INVALID_PAYLOAD);
  }
}

function assertAuthorizedCommandExpansions(messages: unknown, canonicalNames: ReadonlyMap<string, string>): void {
  const pending: unknown[] = [messages];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const openingCount = value.split("<command-name>").length - 1;
      const closingCount = value.split("</command-name>").length - 1;
      const names = [...value.matchAll(/<command-name>([^<]*)<\/command-name>/g)];
      if (names.length !== openingCount || names.length !== closingCount) throw new Error(INVALID_PAYLOAD);
      for (const match of names) {
        const name = match[1]?.trim().replace(/^\//, "");
        if (!name || !canonicalNames.has(name)) throw new Error(INVALID_PAYLOAD);
      }
    } else if (Array.isArray(value)) pending.push(...value);
    else if (typeof value === "object" && value !== null) pending.push(...Object.values(value));
  }
}

function parseCatalogBlock(text: string, canonicalNames: ReadonlyMap<string, string>): string[] {
  const block = text.trim().replace(/\r\n/g, "\n");
  const prefix = `<system-reminder>\n${CATALOG_MARKER}\n\n`;
  const suffix = "\n</system-reminder>";
  if (
    !block.startsWith(prefix) ||
    !block.endsWith(suffix) ||
    block.split("<system-reminder>").length !== 2 ||
    block.split("</system-reminder>").length !== 2
  ) {
    throw new Error(INVALID_PAYLOAD);
  }
  const ids: string[] = [];
  for (const line of block.slice(prefix.length, -suffix.length).split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith("- ")) {
      if (ids.length === 0) throw new Error(INVALID_PAYLOAD);
      continue;
    }
    const nativeName = /^- (\S+):(?:[\t ]|$)/.exec(line)?.[1];
    const id = nativeName ? canonicalNames.get(nativeName) : undefined;
    if (!id) throw new Error(INVALID_PAYLOAD);
    ids.push(id);
  }
  if (ids.length === 0) throw new Error(INVALID_PAYLOAD);
  return ids;
}

function countCatalogMarkers(value: unknown): number {
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") count += current.split(CATALOG_MARKER).length - 1;
    else if (Array.isArray(current)) pending.push(...current);
    else if (typeof current === "object" && current !== null) pending.push(...Object.values(current));
    if (count > 1) return count;
  }
  return count;
}
