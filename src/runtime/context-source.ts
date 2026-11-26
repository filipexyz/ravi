import type { ContextRecord } from "../router/router-db.js";

/** An approval origin is not an implicit destination for commands or durable grants. */
export function runtimeCommandSource(context: Pick<ContextRecord, "source" | "metadata">) {
  return context.metadata?.approvalSourceOnly === true ? undefined : context.source;
}
