// STUB (wave A, K-O1). Owner: K-O7. Contract §13.9: the local mirror of pages
// marked for contacts. The signatures below are the contract; the bodies are
// replaced by the owner.

import type { ConsoleMirror } from "../types.js";

/** Atomic; rebuilds knowledge_marked_fts; stores raviHosts in knowledge_meta.ravi_hosts. */
export function replaceMarkedPages(_mirror: Pick<ConsoleMirror, "pages" | "raviHosts">, _now: number): void {
  throw new Error("not implemented: replaceMarkedPages");
}

/** [] once the mirror expired. */
export function listRaviHosts(_now?: number): string[] {
  throw new Error("not implemented: listRaviHosts");
}

export function listMarkedSectionsForInstance(_input: {
  instanceId: string;
  query: string;
  limit: number;
  now?: number;
}): Array<{ id: number; url: string; anchor: string | null; heading: string | null; text: string; version: number }> {
  throw new Error("not implemented: listMarkedSectionsForInstance");
}

export function listMarkedUrlsForInstance(_instanceId: string, _now?: number): Array<{ host: string; path: string }> {
  throw new Error("not implemented: listMarkedUrlsForInstance");
}
