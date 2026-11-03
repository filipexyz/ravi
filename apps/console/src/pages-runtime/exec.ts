// The exec client: `POST /_ravi/connectors/exec` on the page's own origin with
// `{ id, input }` and `x-ravi-runtime: <version>`. Bases ids are refused
// locally (`not_declared`) unless the kit declares the id for that view (or,
// for `ravi.bases.charts.data`, that chart).
// `busy` failures (429, 503, network) wait 2, 4 and 8 s with jitter and send
// the same input again, so a write keeps its idempotency key; nothing is
// resent once the error reaches the page. Every call counts against a budget
// of 60 per minute for the whole page (calls over it wait for a slot).

import type { PageKit } from "@/shared/widgets/types";

import { RaviError } from "./errors";

export const EXEC_PATH = "/_ravi/connectors/exec";
export const RETRY_DELAYS_MS = [2000, 4000, 8000] as const;
export const EXEC_BUDGET_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

export type ExecMeta = { attempts: number };

export type ExecDeps = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  version: string;
};

export type ExecClient = {
  exec: (id: string, input: unknown, meta?: ExecMeta) => Promise<unknown>;
  /** True when the kit declares `id` for the input's `viewId` or `chartId` (Bases ids without either by `uses`). */
  declared: (id: string, input?: unknown) => boolean;
  /** Calls made in the last minute. */
  used: () => number;
};

export function createExec(kit: PageKit, deps: ExecDeps): ExecClient {
  let stamps: number[] = [];
  const used = () => {
    const since = deps.now() - MINUTE_MS;
    stamps = stamps.filter((stamp) => stamp > since);
    return stamps.length;
  };
  const declared = (id: string, input?: unknown) => {
    const { viewId, chartId } = (input ?? {}) as { viewId?: unknown; chartId?: unknown };
    return (
      !id.startsWith("ravi.bases.") ||
      (typeof viewId == "string" || typeof chartId == "string"
        ? kit.actions.some((action) => action.id === id && (typeof viewId == "string" ? action.viewId === viewId : action.chartId === chartId))
        : kit.uses.includes(id))
    );
  };

  const exec = async (id: string, input: unknown, meta: ExecMeta = { attempts: 0 }): Promise<unknown> => {
    if (!declared(id, input)) throw new RaviError("not_declared");
    const body = JSON.stringify({ id, input: input ?? {} });
    for (let attempt = 0; ; attempt += 1) {
      while (used() >= EXEC_BUDGET_PER_MINUTE) await deps.sleep(Math.max(50, (stamps[0] as number) + MINUTE_MS - deps.now()));
      stamps.push(deps.now());
      meta.attempts = attempt + 1;
      let response: Response | null = null;
      let payload: Record<string, unknown> | null = null;
      try {
        response = await deps.fetch(EXEC_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-ravi-runtime": deps.version },
          body,
        });
        payload = await response.json().catch(() => null);
      } catch {
        response = null;
      }
      if (response?.ok && payload?.ok === true) return payload.output;
      const error = new RaviError(!response ? "network_error" : typeof payload?.error === "string" ? payload.error : "connector_unavailable", {
        status: response?.status,
        requestId: response?.headers?.get("x-request-id"),
        fieldErrors: payload?.fieldErrors as Record<string, string>,
        current: payload?.current as RaviError["current"],
      });
      const delay = RETRY_DELAYS_MS[attempt];
      if (!error.retryable || !delay) throw error;
      await deps.sleep(Math.round(delay * (0.75 + deps.random() * 0.5)));
    }
  };
  return { exec, declared, used };
}
