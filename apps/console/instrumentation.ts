import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    if (process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres") {
      if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("workflow_postgres_url_required");
      const { getWorld } = await import("workflow/runtime");
      const world = await getWorld();
      await world.start?.();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
