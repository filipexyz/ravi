// The page kit the ship put in `#ravi-kit` (CONTRACT section 5.2). Its own
// module so the theme-live script reads it without the rest of the runtime.

import type { PageKit } from "@/shared/widgets/types";

import { RUNTIME_VERSION } from "./version";

/** The kit in `#ravi-kit`; missing or unreadable, an empty kit (no widgets, nothing declared). */
export function readKit(doc: Document): PageKit {
  let kit: Partial<PageKit> | null = null;
  try {
    kit = JSON.parse(doc.getElementById("ravi-kit")?.textContent || "null");
  } catch {
    // An unreadable kit: no widgets, nothing declared.
  }
  const list = <T,>(value: T[] | undefined) => (Array.isArray(value) ? value : []);
  return {
    v: 1,
    runtime: RUNTIME_VERSION,
    locale: "",
    theme: null,
    ...kit,
    widgets: kit?.widgets ?? {},
    instances: kit?.instances ?? {},
    actions: list(kit?.actions),
    uses: list(kit?.uses),
  };
}
