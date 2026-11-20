/**
 * Checks the update supervisor makes before it stops anything.
 *
 * A release that adopts the thread fence accepts a pre-fence state only in the
 * shape of 3.261113.2: the adoption's table inventory and the boot receipt it
 * reads both come from that release. A state last prepared by an older
 * release (3.261019.1, for example) has neither. Stopping its processes and
 * starting the new daemon on it leaves the host with a daemon that refuses to
 * adopt and nothing running.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./update-snapshot.js";

/** The oldest release whose pre-fence state a fence-adopting release accepts. */
export const FENCE_ADOPTION_MINIMUM_RELEASE = "3.261113.2";
export const UPDATE_WAYPOINT_REQUIRED = "UPDATE_WAYPOINT_REQUIRED";

/** Numeric comparison of Ravi release versions (`3.261113.2`); a prerelease suffix is ignored. */
export function compareRaviVersions(left: string, right: string): number {
  const parts = (value: string) =>
    value
      .trim()
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The release that last prepared `ravi.db`, read from its own readiness
 * markers (`state_schema_versions`, `1:<release>`). Null when there are none:
 * the markers exist since the schema-owner releases, so a state without them
 * was last prepared by an older release. Read only; never initializes state.
 */
export function readPreparedStateRelease(stateDir: string): string | null {
  const path = join(stateDir, "ravi.db");
  if (!existsSync(path)) return null;
  const database = new Database(path, { readonly: true, create: false });
  try {
    const table = database
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state_schema_versions'")
      .get();
    if (!table) return null;
    let latest: string | null = null;
    for (const row of database.query("SELECT version FROM state_schema_versions").all() as { version: unknown }[]) {
      const match = typeof row.version === "string" ? /^1:(\d+(?:\.\d+)+)/.exec(row.version) : null;
      if (match && (!latest || compareRaviVersions(match[1]!, latest) > 0)) latest = match[1]!;
    }
    return latest;
  } finally {
    database.close();
  }
}

export class UpdateWaypointRequiredError extends Error {
  readonly code = UPDATE_WAYPOINT_REQUIRED;
  constructor(
    readonly preparedRelease: string | null,
    readonly targetVersion: string,
    /** The checkout the runtime runs from; source installs do not accept `ravi update --version`. */
    readonly sourceCheckout: string | null = null,
  ) {
    const checkout = sourceCheckout ? shellQuote(sourceCheckout) : "";
    const steps = sourceCheckout
      ? `From a terminal, run \`git -C ${checkout} fetch --tags\` and ` +
        `\`git -C ${checkout} switch --detach v${FENCE_ADOPTION_MINIMUM_RELEASE}\`, ` +
        "`bun install` and `bun run build` in that checkout, then " +
        '`ravi daemon restart -m "waypoint"` and `ravi channels restart`; ' +
        "confirm both processes are online on it with `ravi daemon status`, then run `ravi update --next`."
      : `From a terminal, run \`ravi update --version ${FENCE_ADOPTION_MINIMUM_RELEASE}\` now, confirm both ` +
        "processes are online on it with `ravi daemon status`, then run `ravi update --next`. If that last " +
        "command says the runtime did not converge, run `ravi daemon status` and wait for the daemon to be ready " +
        "before you restart anything: the daemon adopts the state when it starts.";
    super(
      `${UPDATE_WAYPOINT_REQUIRED}: this state was last prepared by ` +
        `${preparedRelease ? `Ravi ${preparedRelease}` : `a Ravi release older than ${FENCE_ADOPTION_MINIMUM_RELEASE}`}, ` +
        `and Ravi ${targetVersion} adopts a state written before the thread fence only from ` +
        `${FENCE_ADOPTION_MINIMUM_RELEASE}. Nothing was stopped: the running daemon keeps serving, but the ` +
        `${sourceCheckout ? "checkout" : "installed package"} is already Ravi ${targetVersion}, and a restart ` +
        `before the waypoint would start it on this state. ${steps}`,
    );
    this.name = "UpdateWaypointRequiredError";
  }
}

/**
 * The release a pre-fence state must go through before the target can adopt it, or null: a state written before
 * the thread fence (`adopt-on-start`) that a release older than 3.261113.2 last prepared, or that has no readiness
 * markers, needs 3.261113.2 first.
 */
export function requiredFenceAdoptionWaypoint(input: {
  readiness: "ready" | "adopt-on-start";
  preparedRelease: string | null;
}): string | null {
  if (input.readiness !== "adopt-on-start") return null;
  if (input.preparedRelease && compareRaviVersions(input.preparedRelease, FENCE_ADOPTION_MINIMUM_RELEASE) >= 0)
    return null;
  return FENCE_ADOPTION_MINIMUM_RELEASE;
}

/** Throws before any stop when a pre-fence state needs the 3.261113.2 waypoint first. */
export function assertFenceAdoptionWaypoint(input: {
  readiness: "ready" | "adopt-on-start";
  preparedRelease: string | null;
  targetVersion: string;
  sourceCheckout?: string | null;
}): void {
  if (!requiredFenceAdoptionWaypoint(input)) return;
  throw new UpdateWaypointRequiredError(input.preparedRelease, input.targetVersion, input.sourceCheckout ?? null);
}
